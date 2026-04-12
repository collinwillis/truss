import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { ChevronLeft, Shield, ShieldCheck, Crown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@truss/ui/components/card";
import { Button } from "@truss/ui/components/button";
import { Badge } from "@truss/ui/components/badge";
import { Skeleton } from "@truss/ui/components/skeleton";
import { Separator } from "@truss/ui/components/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { useWorkspace } from "@truss/features/organizations/workspace-context";

export const Route = createFileRoute("/admin/member/$memberId")({
  component: MemberDetailPage,
});

/**
 * Individual member management page.
 *
 * WHY: Provides fine-grained control over a member's role and
 * per-app permission levels (Precision and Momentum).
 */
function MemberDetailPage() {
  const { memberId } = Route.useParams();
  const { workspace } = useWorkspace();
  const isAdmin = workspace?.role === "owner" || workspace?.role === "admin";

  const member = useQuery(api.adminUsers.getMemberDetail, { memberId });
  const updateRole = useMutation(api.adminUsers.updateMemberRole);
  const setPermission = useMutation(api.appPermissions.setPermission);

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Shield className="h-8 w-8 text-foreground-subtle mb-4" />
        <p className="text-sm font-medium">Admin access required</p>
      </div>
    );
  }

  if (member === undefined) {
    return (
      <div className="max-w-xl space-y-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (!member) {
    return <p className="text-sm text-muted-foreground">Member not found.</p>;
  }

  return (
    <div className="max-w-xl space-y-6 flex-1 overflow-auto">
      {/* Back link */}
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        All Members
      </Link>

      {/* Member header */}
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-full bg-fill-secondary flex items-center justify-center text-lg font-semibold text-muted-foreground">
          {(member.name || "?").charAt(0).toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{member.name}</h1>
            {member.banned && (
              <Badge variant="destructive" className="text-[10px]">
                Suspended
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{member.email}</p>
        </div>
      </div>

      {/* Role & Permissions */}
      <div className="space-y-3">
        <h2 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-wider">
          Role & Permissions
        </h2>
        <Card>
          <CardContent className="py-4 space-y-4">
            {/* Organization role */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Organization Role</p>
                <p className="text-xs text-muted-foreground">
                  Controls admin access across all apps
                </p>
              </div>
              {member.role === "owner" ? (
                <Badge className="gap-1">
                  <Crown className="h-3 w-3" /> Owner
                </Badge>
              ) : (
                <Select
                  value={member.role}
                  onValueChange={(val) => updateRole({ memberId, role: val as "admin" | "member" })}
                >
                  <SelectTrigger className="w-[120px] h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>

            <Separator />

            {/* Precision permission */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Precision</p>
                <p className="text-xs text-muted-foreground">Estimation access level</p>
              </div>
              <Select
                value={member.precisionPermission ?? "none"}
                onValueChange={(val) =>
                  setPermission({
                    memberId,
                    app: "precision",
                    permission: val as "none" | "read" | "write" | "admin",
                  })
                }
              >
                <SelectTrigger className="w-[120px] h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="write">Write</SelectItem>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Momentum permission */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Momentum</p>
                <p className="text-xs text-muted-foreground">Progress tracking access level</p>
              </div>
              <Select
                value={member.momentumPermission ?? "none"}
                onValueChange={(val) =>
                  setPermission({
                    memberId,
                    app: "momentum",
                    permission: val as "none" | "read" | "write" | "admin",
                  })
                }
              >
                <SelectTrigger className="w-[120px] h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="write">Write</SelectItem>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
