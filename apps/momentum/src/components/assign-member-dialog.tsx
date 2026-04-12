/**
 * Dialog for assigning an organization member to a project scope.
 *
 * WHY: Admins need a clean multi-field form to assign members to
 * a project with fine-grained scope control (entire project, specific
 * WBS, or specific phase) and a project role.
 *
 * Follows the create-project-dialog pattern: gap-0 p-0 overflow-hidden,
 * pinned search, borderless selection rows, footer with save/cancel.
 */

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Skeleton } from "@truss/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Check, Search, Globe, Layers, FileText } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import {
  getProjectRoleLabel,
  getProjectRolesForDisplay,
  getProjectRoleDescription,
} from "@truss/features/project-assignments/scope-utils";
import type { ProjectRole, AssignmentScopeType } from "@truss/features/project-assignments/types";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

interface AssignMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

/** Get initials from name for avatar fallback. */
function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function AssignMemberDialog({ open, onOpenChange, projectId }: AssignMemberDialogProps) {
  const { workspace } = useWorkspace();
  const orgId = workspace?.organization_id;

  // Data queries
  const orgMembers = useQuery(
    api.adminUsers.listOrganizationMembers,
    orgId ? { organizationId: orgId } : "skip"
  );
  const scopeTree = useQuery(api.projectAssignments.getProjectScopeTree, {
    projectId: projectId as Id<"momentumProjects">,
  });
  const existingAssignments = useQuery(api.projectAssignments.listProjectAssignments, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const assignMutation = useMutation(api.projectAssignments.assignUserToProject);

  // Form state
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [scopeType, setScopeType] = useState<AssignmentScopeType>("project");
  const [scopeId, setScopeId] = useState<string | undefined>(undefined);
  const [selectedWbsForPhase, setSelectedWbsForPhase] = useState<string | undefined>(undefined);
  const [role, setRole] = useState<ProjectRole>("foreman");
  const [isAssigning, setIsAssigning] = useState(false);

  // Filter members by search
  const filteredMembers = useMemo(() => {
    if (!orgMembers) return undefined;
    if (!memberSearch) return orgMembers;
    const q = memberSearch.toLowerCase();
    return orgMembers.filter(
      (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
    );
  }, [orgMembers, memberSearch]);

  // Group phases by WBS for the phase picker
  const phasesByWbs = useMemo(() => {
    if (!scopeTree) return new Map<string, typeof scopeTree.phases>();
    const map = new Map<string, typeof scopeTree.phases>();
    for (const phase of scopeTree.phases) {
      const list = map.get(phase.wbsId) ?? [];
      list.push(phase);
      map.set(phase.wbsId, list);
    }
    return map;
  }, [scopeTree]);

  const selectedMember = orgMembers?.find((m) => m.userId === selectedUserId);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Reset form
      setSelectedUserId(null);
      setMemberSearch("");
      setScopeType("project");
      setScopeId(undefined);
      setSelectedWbsForPhase(undefined);
      setRole("foreman");
    }
    onOpenChange(nextOpen);
  };

  const handleScopeTypeChange = (value: string) => {
    setScopeType(value as AssignmentScopeType);
    setScopeId(undefined);
    setSelectedWbsForPhase(undefined);
  };

  const handleAssign = useCallback(async () => {
    if (!selectedUserId) return;

    setIsAssigning(true);
    try {
      await assignMutation({
        projectId: projectId as Id<"momentumProjects">,
        userId: selectedUserId,
        scopeType,
        scopeId: scopeType === "project" ? undefined : scopeId,
        role,
      });
      toast.success("Member assigned", {
        description: `${selectedMember?.name ?? "Member"} assigned as ${getProjectRoleLabel(role)}.`,
      });
      handleOpenChange(false);
    } catch (error) {
      toast.error("Failed to assign member", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setIsAssigning(false);
    }
  }, [
    selectedUserId,
    projectId,
    scopeType,
    scopeId,
    role,
    assignMutation,
    selectedMember,
    handleOpenChange,
  ]);

  const canSubmit = selectedUserId && role && (scopeType === "project" || scopeId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px] gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-base">Assign Member</DialogTitle>
          <DialogDescription className="text-body">
            Add a team member to this project with a specific scope and role.
          </DialogDescription>
        </DialogHeader>

        <div className="border-t">
          {/* ── Step 1: Select Member ── */}
          <div className="px-5 pt-4 pb-3">
            <Label className="text-body font-medium mb-2 block">Member</Label>
            {selectedMember ? (
              <div className="flex items-center justify-between rounded-lg border bg-fill-tertiary/30 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <Avatar className="h-7 w-7">
                    {selectedMember.image && (
                      <AvatarImage src={selectedMember.image} alt={selectedMember.name} />
                    )}
                    <AvatarFallback className="text-footnote font-medium">
                      {getInitials(selectedMember.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="text-body font-medium">{selectedMember.name}</div>
                    <div className="text-subheadline text-muted-foreground">
                      {selectedMember.email}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-subheadline text-muted-foreground"
                  onClick={() => setSelectedUserId(null)}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-label-quaternary" />
                  <Input
                    placeholder="Search members..."
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="h-6 pl-8 text-body"
                  />
                </div>
                <div className="max-h-[160px] overflow-y-auto rounded-lg border">
                  {filteredMembers === undefined ? (
                    <div className="p-3 space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Skeleton className="h-7 w-7 rounded-full" />
                          <Skeleton className="h-3.5 w-28" />
                        </div>
                      ))}
                    </div>
                  ) : filteredMembers.length === 0 ? (
                    <div className="py-6 text-center">
                      <p className="text-callout text-muted-foreground">No members found</p>
                    </div>
                  ) : (
                    <div className="py-1">
                      {filteredMembers.map((member) => (
                        <button
                          key={member.userId}
                          type="button"
                          onClick={() => {
                            setSelectedUserId(member.userId);
                            setMemberSearch("");
                          }}
                          className={cn(
                            "w-full text-left px-3 py-2 transition-colors flex items-center gap-2.5",
                            "hover:bg-fill-tertiary"
                          )}
                        >
                          <Avatar className="h-7 w-7 shrink-0">
                            {member.image && <AvatarImage src={member.image} alt={member.name} />}
                            <AvatarFallback className="text-footnote font-medium">
                              {getInitials(member.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="text-body font-medium truncate">{member.name}</div>
                            <div className="text-subheadline text-muted-foreground truncate">
                              {member.email}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Step 2: Scope Type ── */}
          <div className="px-5 pb-3">
            <Label className="text-body font-medium mb-2 block">Scope</Label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { value: "project", label: "Entire Project", icon: Globe },
                  { value: "wbs", label: "Specific WBS", icon: Layers },
                  { value: "phase", label: "Specific Phase", icon: FileText },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleScopeTypeChange(option.value)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-2.5 text-center transition-colors",
                    scopeType === option.value
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:bg-fill-quaternary text-muted-foreground"
                  )}
                >
                  <option.icon className="h-4 w-4" />
                  <span className="text-subheadline font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Step 3: Scope Target (WBS or Phase) ── */}
          {scopeType === "wbs" && (
            <div className="px-5 pb-3">
              <Label className="text-body font-medium mb-2 block">Select WBS</Label>
              {!scopeTree ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={scopeId ?? ""} onValueChange={setScopeId}>
                  <SelectTrigger className="h-6 text-body">
                    <SelectValue placeholder="Choose a WBS..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeTree.wbs.map((wbs) => (
                      <SelectItem key={wbs.id} value={wbs.id} className="text-callout">
                        <span className="font-mono text-muted-foreground mr-1.5">{wbs.code}</span>
                        {wbs.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {scopeType === "phase" && (
            <div className="px-5 pb-3 space-y-3">
              <div>
                <Label className="text-body font-medium mb-2 block">Select WBS</Label>
                {!scopeTree ? (
                  <Skeleton className="h-9 w-full" />
                ) : (
                  <Select
                    value={selectedWbsForPhase ?? ""}
                    onValueChange={(v) => {
                      setSelectedWbsForPhase(v);
                      setScopeId(undefined);
                    }}
                  >
                    <SelectTrigger className="h-6 text-body">
                      <SelectValue placeholder="Choose a WBS first..." />
                    </SelectTrigger>
                    <SelectContent>
                      {scopeTree.wbs.map((wbs) => (
                        <SelectItem key={wbs.id} value={wbs.id} className="text-callout">
                          <span className="font-mono text-muted-foreground mr-1.5">{wbs.code}</span>
                          {wbs.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {selectedWbsForPhase && (
                <div>
                  <Label className="text-body font-medium mb-2 block">Select Phase</Label>
                  {(() => {
                    const phases = phasesByWbs.get(selectedWbsForPhase) ?? [];
                    if (phases.length === 0) {
                      return (
                        <p className="text-callout text-muted-foreground py-2">
                          No phases in this WBS.
                        </p>
                      );
                    }
                    return (
                      <Select value={scopeId ?? ""} onValueChange={setScopeId}>
                        <SelectTrigger className="h-6 text-body">
                          <SelectValue placeholder="Choose a phase..." />
                        </SelectTrigger>
                        <SelectContent>
                          {phases.map((phase) => (
                            <SelectItem key={phase.id} value={phase.id} className="text-callout">
                              <span className="font-mono text-muted-foreground mr-1.5">
                                {phase.code}
                              </span>
                              {phase.description}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ── Step 4: Role ── */}
          <div className="px-5 pb-4">
            <Label className="text-body font-medium mb-2 block">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
              <SelectTrigger className="h-6 text-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getProjectRolesForDisplay().map((r) => (
                  <SelectItem key={r} value={r} className="text-callout">
                    <div>
                      <span className="font-medium">{getProjectRoleLabel(r)}</span>
                      <span className="ml-2 text-muted-foreground">
                        {getProjectRoleDescription(r)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex justify-end gap-2 bg-fill-quaternary/30">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleAssign} disabled={!canSubmit || isAssigning}>
            {isAssigning ? "Assigning..." : "Assign Member"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
