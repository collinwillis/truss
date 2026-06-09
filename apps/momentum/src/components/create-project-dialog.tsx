/**
 * Dialog for creating a Momentum project from an existing proposal.
 *
 * WHY borderless rows: Professional pickers (Slack channel browser, Linear project
 * picker, Figma file selector) use borderless rows with subtle hover/selected states.
 * Individual borders on every row create visual noise at scale.
 *
 * WHY a live import panel: creating a project pulls the proposal's full estimate
 * tree from Precision (Firestore → Convex) on demand. For large estimates that
 * takes real time, so the dialog subscribes to a server-reported progress job and
 * renders a staged importing indicator instead of a frozen "Creating…" button.
 *
 * WHY "show already imported": one project per estimate is the safe default, but
 * teams occasionally need a second snapshot (a revision/working copy). Revealing
 * imported estimates behind a toggle keeps duplicates deliberate, not accidental.
 */

import { useState, useMemo } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { useNavigate } from "@tanstack/react-router";
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
import { Switch } from "@truss/ui/components/switch";
import { Progress } from "@truss/ui/components/progress";
import { Skeleton } from "@truss/ui/components/skeleton";
import { AlertCircle, Check, Layers, Loader2, Search } from "lucide-react";
import { cn } from "@truss/ui/lib/utils";

interface CreateProjectDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
}

/** Live import-progress row, as returned by `api.momentum.getImportJob`. */
type ImportJob = NonNullable<ReturnType<typeof useImportJob>>;

/** Thin wrapper so the `ImportJob` type can be inferred from the query. */
function useImportJob(token: string | null) {
  return useQuery(api.momentum.getImportJob, token ? { token } : "skip");
}

const fmt = (n: number) => n.toLocaleString();

/**
 * Map a job to a single forward-only bar percentage. Network-bound phases hold
 * at a fixed value (the spinner conveys activity); the import phase fills its
 * band by activities processed, so the bar genuinely tracks the long part.
 */
function progressPct(job: ImportJob | null | undefined): number {
  if (!job) return 8;
  switch (job.status) {
    case "preparing":
      return 8;
    case "fetching":
      return 24;
    case "importing":
      return job.total > 0 ? 32 + Math.round(56 * (job.processed / job.total)) : 60;
    case "finalizing":
      return 92;
    case "completed":
      return 100;
    default:
      return 8;
  }
}

/** Secondary, human detail beneath the progress bar for the current phase. */
function progressDetail(job: ImportJob | null | undefined): string {
  if (!job) return "Getting things ready…";
  switch (job.status) {
    case "preparing":
      return "Getting things ready…";
    case "fetching":
      return "Connecting to Precision…";
    case "importing":
      return `${job.wbsCount} WBS · ${job.phaseCount} phases · ${fmt(job.activityCount)} activities`;
    case "finalizing":
      return "Assembling your workbook…";
    case "completed":
      return "Done — opening your project…";
    default:
      return "";
  }
}

type StepState = "done" | "active" | "pending";

/** Derive the three-step indicator state from the job status. */
function stepStates(status: ImportJob["status"] | undefined): {
  connect: StepState;
  importing: StepState;
  finalize: StepState;
} {
  const isDone = (...s: string[]) => (status ? s.includes(status) : false);
  return {
    connect: isDone("importing", "finalizing", "completed")
      ? "done"
      : isDone("preparing", "fetching")
        ? "active"
        : "pending",
    importing: isDone("finalizing", "completed")
      ? "done"
      : isDone("importing")
        ? "active"
        : "pending",
    finalize: isDone("completed") ? "done" : isDone("finalizing") ? "active" : "pending",
  };
}

/** Single dot in the import stepper. */
function StepDot({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary">
        <Check className="h-2.5 w-2.5 text-primary-foreground" />
      </div>
    );
  }
  if (state === "active") {
    return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  }
  return <div className="h-4 w-4 rounded-full border border-border" />;
}

/** Compact horizontal stepper: Connect → Import → Finalize. */
function ImportStepper({ status }: { status: ImportJob["status"] | undefined }) {
  const s = stepStates(status);
  const steps: Array<{ key: keyof typeof s; label: string }> = [
    { key: "connect", label: "Connect" },
    { key: "importing", label: "Import" },
    { key: "finalize", label: "Finalize" },
  ];
  return (
    <div className="flex items-center">
      {steps.map((step, i) => (
        <div key={step.key} className="flex flex-1 items-center last:flex-none">
          <div className="flex items-center gap-1.5">
            <StepDot state={s[step.key]} />
            <span
              className={cn(
                "text-footnote",
                s[step.key] === "pending" ? "text-label-quaternary" : "text-foreground"
              )}
            >
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={cn(
                "mx-2 h-px flex-1 transition-colors",
                s[steps[i + 1]!.key] === "pending" ? "bg-border" : "bg-primary/40"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** The importing state — staged indicator while the estimate tree is pulled. */
function ImportProgressPanel({ job }: { job: ImportJob | null | undefined }) {
  const pct = progressPct(job);
  const readout =
    job && job.status === "importing" && job.total > 0
      ? `${fmt(job.processed)} / ${fmt(job.total)}`
      : null;

  return (
    <div className="px-5 py-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          {job?.status === "completed" ? (
            <Check className="h-5 w-5 text-primary" />
          ) : (
            <Layers className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-body font-medium">Importing estimate</div>
          <div className="text-subheadline text-muted-foreground">
            Pulling the latest data from Precision
          </div>
        </div>
      </div>

      <div className="mt-6">
        <ImportStepper status={job?.status} />
      </div>

      <div className="mt-6 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-subheadline font-medium">{job?.stage ?? "Preparing import"}</span>
          {readout && (
            <span className="text-subheadline tabular-nums text-muted-foreground">{readout}</span>
          )}
        </div>
        <Progress value={pct} />
        <div className="text-footnote text-label-quaternary">{progressDetail(job)}</div>
      </div>

      <p className="mt-6 text-footnote text-label-quaternary">
        Large estimates can take a moment. Keep this window open — we'll open your project
        automatically when it's ready.
      </p>
    </div>
  );
}

/**
 * Create project dialog component.
 *
 * Lists proposals sorted by proposal number (descending) with search. Estimates
 * that already have a project are hidden unless "Show already imported" is on.
 */
export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const navigate = useNavigate();
  const proposals = useQuery(api.momentum.listProposalsForImport);
  // Pulls the proposal's latest estimate tree from Firestore, then snapshots it.
  const createProject = useAction(api.momentum.createProjectFromProposal);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showImported, setShowImported] = useState(false);

  // Import lifecycle: a "select" picker, an "importing" progress view, or an
  // "error" view. The token links this run to its server-reported progress job.
  const [phase, setPhase] = useState<"select" | "importing" | "error">("select");
  const [importToken, setImportToken] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const job = useImportJob(importToken);

  const importedCount = useMemo(
    () => (proposals ?? []).filter((p) => p.existingProjectCount > 0).length,
    [proposals]
  );

  const selectedProposal = useMemo(
    () => (proposals ?? []).find((p) => p.id === selectedProposalId) ?? null,
    [proposals, selectedProposalId]
  );

  const filteredProposals = useMemo(() => {
    if (!proposals) return undefined;

    const visible = showImported
      ? proposals
      : proposals.filter((p) => p.existingProjectCount === 0);

    const sorted = [...visible].sort((a, b) =>
      b.proposalNumber.localeCompare(a.proposalNumber, undefined, { numeric: true })
    );

    if (!searchQuery) return sorted;

    const q = searchQuery.toLowerCase();
    return sorted.filter(
      (p) =>
        p.description.toLowerCase().includes(q) ||
        p.proposalNumber.toLowerCase().includes(q) ||
        (p.jobNumber && p.jobNumber.toLowerCase().includes(q)) ||
        (p.ownerName && p.ownerName.toLowerCase().includes(q))
    );
  }, [proposals, searchQuery, showImported]);

  const resetState = () => {
    setSelectedProposalId(null);
    setSearchQuery("");
    setShowImported(false);
    setPhase("select");
    setImportToken(null);
    setErrorMessage(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    // Don't let the dialog be dismissed mid-import — the pull is in flight and
    // the user should see it land (or fail) rather than lose the window.
    if (!nextOpen && phase === "importing") return;
    if (!nextOpen) resetState();
    onOpenChange(nextOpen);
  };

  const runImport = async () => {
    if (!selectedProposal) return;

    const token = crypto.randomUUID();
    const allowDuplicate = selectedProposal.existingProjectCount > 0;

    setImportToken(token);
    setErrorMessage(null);
    setPhase("importing");

    try {
      const projectId = await createProject({
        proposalId: selectedProposal.id as Id<"proposals">,
        allowDuplicate,
        importToken: token,
      });
      toast.success("Project created", {
        description: "Navigate to the project workbook to start tracking.",
      });
      resetState();
      onOpenChange(false);
      navigate({
        to: "/project/$projectId",
        params: { projectId: projectId as string },
        search: { wbs: undefined },
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "An unexpected error occurred during import."
      );
      setPhase("error");
    }
  };

  const isImported = (selectedProposal?.existingProjectCount ?? 0) > 0;

  const header = {
    select: {
      title: "New Project",
      description: "Select an estimate to create a tracking project.",
    },
    importing: {
      title: job?.proposalNumber
        ? `${job.proposalNumber} — ${job.proposalDescription}`
        : (selectedProposal?.description ?? "Importing"),
      description: "This usually takes a few seconds.",
    },
    error: {
      title: "Import failed",
      description: "We couldn't import this estimate.",
    },
  }[phase];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] gap-0 p-0 overflow-hidden"
        // Block outside-click / escape close while importing.
        onPointerDownOutside={(e) => phase === "importing" && e.preventDefault()}
        onEscapeKeyDown={(e) => phase === "importing" && e.preventDefault()}
      >
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-base truncate">{header.title}</DialogTitle>
          <DialogDescription className="text-body">{header.description}</DialogDescription>
        </DialogHeader>

        {phase === "importing" ? (
          <ImportProgressPanel job={job} />
        ) : phase === "error" ? (
          <div className="px-5 py-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10">
                <AlertCircle className="h-5 w-5 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">Something went wrong</div>
                <p className="text-subheadline text-muted-foreground mt-1 break-words">
                  {errorMessage}
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPhase("select")}>
                Back
              </Button>
              <Button size="sm" onClick={runImport}>
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Search — pinned above scrollable list */}
            <div className="px-5 pb-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-label-quaternary" />
                <Input
                  placeholder="Search estimates..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-6 pl-8 text-body"
                />
              </div>
            </div>

            {/* Already-imported toggle — only shown when there are any */}
            {importedCount > 0 && (
              <div className="px-5 pb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-subheadline font-medium">Show already imported</div>
                  <div className="text-footnote text-label-quaternary">
                    {importedCount} {importedCount === 1 ? "estimate has" : "estimates have"} a
                    project — reveal to create a revision copy.
                  </div>
                </div>
                <Switch
                  checked={showImported}
                  onCheckedChange={(next) => {
                    setShowImported(next);
                    // Drop a selection that's about to be hidden.
                    if (!next && isImported) setSelectedProposalId(null);
                  }}
                />
              </div>
            )}

            {/* Proposal list */}
            <div className="border-t max-h-[340px] overflow-y-auto">
              {filteredProposals === undefined ? (
                <div className="px-5 py-3 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="space-y-1.5">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  ))}
                </div>
              ) : filteredProposals.length === 0 ? (
                <div className="text-center py-10 px-5">
                  <p className="text-body font-medium text-muted-foreground">
                    {searchQuery ? "No matching estimates" : "No estimates available"}
                  </p>
                  <p className="text-subheadline text-foreground-subtle mt-1">
                    {searchQuery
                      ? "Try a different search term."
                      : "Create estimates in Precision first."}
                  </p>
                </div>
              ) : (
                <div className="py-1">
                  {filteredProposals.map((proposal) => {
                    const isSelected = selectedProposalId === proposal.id;
                    const imported = proposal.existingProjectCount > 0;

                    return (
                      <button
                        key={proposal.id}
                        type="button"
                        onClick={() => setSelectedProposalId(proposal.id)}
                        className={cn(
                          "w-full text-left px-5 py-2.5 transition-colors",
                          "hover:bg-fill-tertiary",
                          isSelected && "bg-fill-tertiary"
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-body font-medium truncate">
                                {proposal.description}
                              </span>
                              {imported && (
                                <span className="shrink-0 rounded-full bg-fill-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  {proposal.existingProjectCount > 1
                                    ? `Imported · ${proposal.existingProjectCount}`
                                    : "Imported"}
                                </span>
                              )}
                            </div>
                            <div className="text-subheadline text-muted-foreground mt-0.5">
                              <span className="font-mono tabular-nums">
                                {proposal.proposalNumber}
                              </span>
                              {proposal.ownerName && (
                                <>
                                  <span className="mx-1.5 text-foreground-subtle">&middot;</span>
                                  {proposal.ownerName}
                                </>
                              )}
                            </div>
                          </div>
                          {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t px-5 py-3 flex justify-end gap-2 bg-fill-quaternary/30">
              <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={runImport} disabled={!selectedProposalId}>
                {isImported ? "Create Copy" : "Create Project"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
