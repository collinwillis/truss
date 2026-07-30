import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@truss/ui/components/alert-dialog";
import { Button } from "@truss/ui/components/button";
import { Skeleton } from "@truss/ui/components/skeleton";
import { RATE_FIELD_CONFIG, type ProposalRates } from "@truss/features/estimation/types";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { canEditPrecision } from "../../lib/permissions";
import { toast } from "sonner";
import { useState, useCallback, useRef } from "react";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/estimate/$estimateId/setup")({
  component: EstimateSetupPage,
});

const STATUS_OPTIONS = [
  { value: "bidding", label: "Bidding" },
  { value: "submitted", label: "Submitted" },
  { value: "awarded", label: "Awarded" },
  { value: "rejected", label: "Rejected" },
  { value: "declined", label: "Declined" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
] as const;

const BID_TYPE_OPTIONS = [
  { value: "lump_sum", label: "Lump Sum" },
  { value: "time_and_materials", label: "Time & Materials" },
  { value: "budgetary", label: "Budgetary" },
  { value: "rates", label: "Rates" },
  { value: "cost_plus", label: "Cost Plus" },
] as const;

type ProposalStatus = (typeof STATUS_OPTIONS)[number]["value"];
type ProposalBidType = (typeof BID_TYPE_OPTIONS)[number]["value"];

/**
 * Setup — the deliberate editing surface for an estimate (Collin's IA
 * decision: Details and Rates are configuration, not overview content).
 *
 * Two save models, chosen by blast radius:
 *  - DETAILS autosave on blur — metadata edits are low-stakes and frequent.
 *  - RATES require an explicit Save. A rate re-prices the entire bid, so
 *    edits accumulate in a draft and apply atomically; the dirty bar makes
 *    the pending state unmissable. No debounced keystroke writes.
 */
function EstimateSetupPage() {
  const { estimateId } = Route.useParams();
  const proposalId = estimateId as Id<"proposals">;
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  const proposal = useQuery(api.precision.getProposal, { proposalId });
  const updateProposal = useMutation(api.precision.updateProposal);
  const updateRates = useMutation(api.precision.updateProposalRates);
  const deleteProposal = useMutation(api.precision.deleteProposal);

  const runSave = useCallback(
    async (whatFailed: string, write: () => Promise<unknown>) => {
      if (!canEdit) return;
      try {
        await write();
      } catch (error) {
        toast.error(whatFailed, {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit]
  );

  // Debounce timers are keyed by field: a single shared timer let a second
  // field edited inside the debounce window cancel the first field's write.
  const debounceRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const patchField = useCallback(
    (field: string, value: string | number | undefined) => {
      const timers = debounceRef.current;
      clearTimeout(timers.get(field));
      timers.set(
        field,
        setTimeout(() => {
          timers.delete(field);
          void runSave("Failed to save estimate", () =>
            updateProposal({ proposalId, [field]: value === "" ? undefined : value })
          );
        }, 400)
      );
    },
    [proposalId, updateProposal, runSave]
  );

  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteProposal({ proposalId });
      toast.success("Estimate deleted");
      void navigate({ to: "/estimates" });
    } catch (error) {
      setDeleting(false);
      toast.error("Couldn't delete this estimate", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  };

  if (!proposal) return <SetupSkeleton />;

  return (
    <div className="h-full overflow-auto py-4 px-1">
      <div className="max-w-2xl space-y-8">
        <header>
          <h1 className="text-sm font-semibold tracking-tight">Setup</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Details save as you edit. Rate changes re-price the whole estimate and apply when you
            save them.
          </p>
        </header>

        {/* ── Details ── */}
        <section className="space-y-4">
          <SectionHeading title="Details" />
          <div className="grid grid-cols-3 gap-x-4 gap-y-3">
            <FormField
              label="Proposal #"
              defaultValue={proposal.proposalNumber}
              mono
              readOnly={!canEdit}
              onBlur={(v) => patchField("proposalNumber", v)}
            />
            <FormField
              label="Job #"
              defaultValue={proposal.jobNumber ?? ""}
              readOnly={!canEdit}
              onBlur={(v) => patchField("jobNumber", v)}
            />
            <FormField
              label="CO #"
              defaultValue={proposal.changeOrderNumber ?? ""}
              readOnly={!canEdit}
              onBlur={(v) => patchField("changeOrderNumber", v)}
            />
          </div>
          <FormField
            label="Description"
            defaultValue={proposal.description}
            readOnly={!canEdit}
            onBlur={(v) => patchField("description", v)}
          />
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <FormField
              label="Owner / Client"
              defaultValue={proposal.ownerName}
              readOnly={!canEdit}
              onBlur={(v) => patchField("ownerName", v)}
            />
            <FormField
              label="Estimators"
              defaultValue={(proposal.estimators ?? []).join(", ")}
              readOnly={!canEdit}
              onBlur={(v) => {
                const list = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                void runSave("Failed to save estimators", () =>
                  updateProposal({ proposalId, estimators: list.length > 0 ? list : undefined })
                );
              }}
            />
          </div>
          <FormField
            label="Job-Site Address"
            defaultValue={proposal.jobSiteAddress ?? ""}
            readOnly={!canEdit}
            onBlur={(v) => patchField("jobSiteAddress", v)}
          />
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <FormSelect
              label="Status"
              value={proposal.status ?? ""}
              options={STATUS_OPTIONS}
              readOnly={!canEdit}
              onChange={(v) =>
                void runSave("Failed to update status", () =>
                  updateProposal({ proposalId, status: v as ProposalStatus })
                )
              }
            />
            <FormSelect
              label="Bid Type"
              value={proposal.bidType ?? ""}
              options={BID_TYPE_OPTIONS}
              readOnly={!canEdit}
              onChange={(v) =>
                void runSave("Failed to update bid type", () =>
                  updateProposal({ proposalId, bidType: v as ProposalBidType })
                )
              }
            />
            <FormDate
              label="Date Received"
              value={proposal.dateReceived}
              readOnly={!canEdit}
              onChange={(v) => patchField("dateReceived", v)}
            />
            <FormDate
              label="Date Due"
              value={proposal.dateDue}
              readOnly={!canEdit}
              onChange={(v) => patchField("dateDue", v)}
            />
          </div>
        </section>

        {/* ── Rates ── */}
        <section className="space-y-4">
          <SectionHeading
            title="Rates"
            hint="Applied to every activity in the estimate when saved."
          />
          <RatesEditor
            key={proposal._id as string}
            rates={proposal.rates}
            readOnly={!canEdit}
            onSave={async (rates) => {
              await updateRates({ proposalId, rates });
            }}
          />
        </section>

        {/* ── Danger zone ── */}
        {canEdit && (
          <section className="space-y-4">
            <SectionHeading title="Danger zone" />
            <div className="flex items-center justify-between rounded-md border border-red-500/25 px-4 py-3">
              <div>
                <p className="text-xs font-medium">Delete this estimate</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Removes the estimate and every WBS, phase, and activity in it. A deleted estimate
                  stays deleted — the estimator sync will not restore it.
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="h-7 gap-1 text-xs shrink-0">
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete estimate #{proposal.proposalNumber}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes “{proposal.description}” and everything in it. If a
                      Momentum project was created from it, the delete will be refused instead.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={deleting}
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete estimate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-[11px] text-foreground-subtle">{hint}</p>}
    </div>
  );
}

/**
 * Rates draft editor — explicit save, atomic apply.
 *
 * WHY not autosave: a rate re-prices the whole bid, and the old
 * debounce-per-keystroke writes were also what made the D1 over-claiming
 * hazard real. Edits build a local draft; the dirty bar appears with
 * Save/Discard; Save applies all changed rates in one mutation.
 */
function RatesEditor({
  rates,
  readOnly,
  onSave,
}: {
  rates: ProposalRates;
  readOnly: boolean;
  onSave: (rates: ProposalRates) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProposalRates>(rates);
  const [saving, setSaving] = useState(false);
  const dirty = RATE_FIELD_CONFIG.some((f) => draft[f.key] !== rates[f.key]);

  const set = (key: keyof ProposalRates, raw: string) => {
    if (readOnly) return;
    const n = parseFloat(raw);
    setDraft((prev) => ({ ...prev, [key]: isNaN(n) ? 0 : n }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      toast.success("Rates saved", { description: "The whole estimate has been re-priced." });
    } catch (error) {
      toast.error("Failed to save rates", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSaving(false);
    }
  };

  const groups = [
    { title: "Labor Rates", id: "labor" as const, unit: "$/hr" },
    { title: "Overhead & Burden", id: "overhead" as const, unit: "%" },
    { title: "Profit Margins", id: "profit" as const, unit: "%" },
    { title: "Tax Rates", id: "tax" as const, unit: "%" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-6">
        {groups.map((g) => {
          const fields = RATE_FIELD_CONFIG.filter((f) => f.group === g.id);
          return (
            <div key={g.id}>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.title}
              </h4>
              <div className="overflow-hidden rounded-md border">
                {fields.map((f, i) => {
                  const changed = draft[f.key] !== rates[f.key];
                  return (
                    <div
                      key={f.key}
                      className={cn(
                        "flex h-8 items-center justify-between px-3 transition-colors",
                        i > 0 && "border-t",
                        changed ? "bg-primary/5" : "hover:bg-fill-quaternary"
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {changed && <span className="h-1 w-1 rounded-full bg-primary" />}
                        {f.label}
                      </span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="any"
                          value={draft[f.key]}
                          readOnly={readOnly}
                          onChange={(e) => set(f.key, e.target.value)}
                          className={cn(
                            "h-6 w-16 rounded border-0 bg-transparent px-1 text-right text-xs font-mono tabular-nums outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                            readOnly
                              ? "text-muted-foreground"
                              : "focus:bg-primary/5 focus:ring-2 focus:ring-inset focus:ring-primary/30"
                          )}
                        />
                        <span className="w-6 text-right text-[10px] text-foreground-subtle">
                          {g.unit}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Dirty bar — appears only when there is something to apply. */}
      {dirty && !readOnly && (
        <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Unsaved rate changes — saving re-prices the whole estimate.
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={saving}
              onClick={() => setDraft(rates)}
            >
              Discard
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={handleSave}>
              {saving ? "Saving…" : "Save rates"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Form primitives (moved from the old overview tabs) ──

function FormField({
  label,
  defaultValue,
  mono,
  readOnly,
  onBlur,
}: {
  label: string;
  defaultValue: string;
  mono?: boolean;
  readOnly?: boolean;
  onBlur: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        defaultValue={defaultValue}
        readOnly={readOnly}
        className={cn(
          "h-8 rounded-md border-border bg-background text-sm transition-colors",
          readOnly
            ? "bg-fill-quaternary/50 text-muted-foreground focus-visible:ring-0"
            : "hover:border-border focus-visible:ring-2 focus-visible:ring-primary/30",
          mono && "font-mono"
        )}
        onBlur={readOnly ? undefined : (e) => onBlur(e.target.value)}
      />
    </div>
  );
}

function FormSelect({
  label,
  value,
  options,
  readOnly,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={readOnly}>
        <SelectTrigger className="h-8 border-border text-sm transition-colors hover:border-border">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FormDate({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value?: number | null;
  readOnly?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="date"
        disabled={readOnly}
        defaultValue={value ? format(new Date(value), "yyyy-MM-dd") : ""}
        className="h-8 border-border bg-background text-sm transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-primary/30"
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : undefined)}
      />
    </div>
  );
}

function SetupSkeleton() {
  return (
    <div className="max-w-2xl space-y-6 px-1 py-4">
      <Skeleton className="h-5 w-24" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
