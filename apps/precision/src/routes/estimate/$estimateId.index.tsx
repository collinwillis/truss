import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";
import { SyncOriginNotice } from "@truss/features/estimation/sync-origin";
import { ProposalStatusChip } from "@truss/features/estimation/proposal-status";
import { Layers, ChevronRight, Copy, Download } from "lucide-react";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import { Skeleton } from "@truss/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@truss/ui/components/tabs";
import { Button } from "@truss/ui/components/button";
import { BottomPanel } from "@truss/features/estimation/bottom-panel";
import { RATE_FIELD_CONFIG, type ProposalRates } from "@truss/features/estimation/types";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { DuplicateEstimateDialog } from "../../components/duplicate-estimate-dialog";
import { canEditPrecision } from "../../lib/permissions";
import { formatWbsLabel } from "../../config/shell-config-estimate";
import { toast } from "sonner";
import { useState, useCallback, useRef, useMemo } from "react";
import { format } from "date-fns";

export const Route = createFileRoute("/estimate/$estimateId/")({
  component: EstimateOverviewPage,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

/**
 * The literal unions the selects may produce, derived from the option arrays
 * so the cast at each select boundary cannot drift from what is offered.
 * Both mirror the server's validators in precision.ts.
 */
type ProposalStatus = (typeof STATUS_OPTIONS)[number]["value"];
type ProposalBidType = (typeof BID_TYPE_OPTIONS)[number]["value"];

const cfmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const mhfmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function EstimateOverviewPage() {
  const { estimateId } = Route.useParams();
  // The one route-param cast; every call below stays fully checked.
  const proposalId = estimateId as Id<"proposals">;
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);
  const proposal = useQuery(api.precision.getProposal, { proposalId });
  const wbsItems = useQuery(api.precision.getWBSListWithCosts, { proposalId });
  const summary = useQuery(api.precision.getProposalSummary, { proposalId });

  const updateProposal = useMutation(api.precision.updateProposal);
  const updateRates = useMutation(api.precision.updateProposalRates);

  const [duplicateOpen, setDuplicateOpen] = useState(false);

  // Saves on this page are debounced and have no other confirmation, so a
  // rejected write used to be indistinguishable from a successful one.
  //
  // WHY the canEdit guard sits here: every write on this page — 9 detail
  // fields, ~16 rate inputs, two selects, two dates — funnels through this
  // one function, so refusing here is defense in depth behind the read-only
  // form controls. The server refuses regardless; this just avoids sending a
  // call known to fail.
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
          runSave("Failed to save estimate", () =>
            updateProposal({
              proposalId,
              [field]: value === "" ? undefined : value,
            })
          );
        }, 400)
      );
    },
    [proposalId, updateProposal, runSave]
  );

  const rateRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const patchRates = useCallback(
    (rates: ProposalRates) => {
      clearTimeout(rateRef.current);
      rateRef.current = setTimeout(() => {
        runSave("Failed to save rates", () => updateRates({ proposalId, rates }));
      }, 400);
    },
    [proposalId, updateRates, runSave]
  );

  // Delegated to the estimate layout route, which owns the single export
  // implementation shared with the ⌘K entry and ⌘⇧E. Keeping it there also drops
  // a standing subscription to the full export payload from this screen.
  const handleExport = useCallback(() => {
    document.dispatchEvent(new CustomEvent("export-estimate"));
  }, []);

  if (!proposal || !wbsItems || !summary) return <OverviewSkeleton />;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-1">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight truncate">
            <span className="font-mono text-muted-foreground">#{proposal.proposalNumber}</span>
            <span className="mx-1.5 text-foreground-subtle">—</span>
            {proposal.description}
            <ProposalStatusChip status={proposal.status} className="ml-2" />
          </h1>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setDuplicateOpen(true)}
            >
              <Copy className="h-3 w-3" /> Duplicate
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleExport}>
            <Download className="h-3 w-3" /> Export
          </Button>
        </div>
      </div>

      {/*
        Provenance, on its own line rather than crowded into the 40px header row.
        Answers "will my edits survive?" outright, which the list deliberately
        answers only by the absence of a badge.
      */}
      <SyncOriginNotice
        precisionOwnedAt={proposal.precisionOwnedAt ?? null}
        className="shrink-0 px-1 pb-2"
      />

      {/* ── Tabs ── */}
      <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
        <TabsList className="shrink-0 justify-start border-b rounded-none bg-transparent h-9 px-1">
          <TabsTrigger
            value="details"
            className="text-xs data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
          >
            Details
          </TabsTrigger>
          <TabsTrigger
            value="rates"
            className="text-xs data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
          >
            Rates
          </TabsTrigger>
          <TabsTrigger
            value="wbs"
            className="text-xs data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-primary"
          >
            WBS <span className="ml-1 text-muted-foreground tabular-nums">{wbsItems.length}</span>
          </TabsTrigger>
        </TabsList>

        {/* ── Details Tab ── */}
        <TabsContent value="details" className="flex-1 overflow-auto py-4 px-1">
          <div className="max-w-2xl space-y-6">
            <FormSection title="Project">
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
                    runSave("Failed to save estimators", () =>
                      updateProposal({
                        proposalId,
                        estimators: list.length > 0 ? list : undefined,
                      })
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
            </FormSection>

            <FormSection title="Status & Dates">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <FormSelect
                  label="Status"
                  value={proposal.status ?? ""}
                  options={STATUS_OPTIONS}
                  readOnly={!canEdit}
                  onChange={(v) =>
                    runSave("Failed to update status", () =>
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
                    runSave("Failed to update bid type", () =>
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
            </FormSection>
          </div>
        </TabsContent>

        {/* ── Rates Tab ── */}
        <TabsContent value="rates" className="flex-1 overflow-auto py-4 px-1">
          <RatesGrid rates={proposal.rates} readOnly={!canEdit} onChange={patchRates} />
        </TabsContent>

        {/* ── WBS Tab ── */}
        <TabsContent value="wbs" className="flex-1 overflow-auto py-0 px-0">
          <WBSTable items={wbsItems} estimateId={estimateId} />
        </TabsContent>
      </Tabs>

      {/* ── Bottom Panel ── */}
      <div className="shrink-0">
        <BottomPanel costs={summary} scope="Activity" itemCount={summary.activityCount} />
      </div>

      {canEdit && (
        <DuplicateEstimateDialog
          open={duplicateOpen}
          onOpenChange={setDuplicateOpen}
          sourceProposalId={proposalId}
          sourceProposalNumber={proposal.proposalNumber}
          sourceDescription={proposal.description}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Form primitives — consistent sizing: 32px inputs, 11px labels, 8px grid
// ═══════════════════════════════════════════════════════════════════════════

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

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
  /** Below "write" the value stays visible and copyable; only editing is withheld. */
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
          "h-8 text-sm rounded-md border-border bg-background",
          "transition-colors",
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
  /** Radix Select has no read-only mode, so below "write" it is disabled. */
  readOnly?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={readOnly}>
        <SelectTrigger className="h-8 text-sm border-border hover:border-border transition-colors">
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
  /** `readOnly` on a date input does not block the native picker, so disable. */
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
        className="h-8 text-sm border-border bg-background hover:border-border focus-visible:ring-2 focus-visible:ring-primary/30 transition-colors"
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : undefined)}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Rates grid — 2×2 groups, compact rows
// ═══════════════════════════════════════════════════════════════════════════

function RatesGrid({
  rates,
  readOnly,
  onChange,
}: {
  rates: ProposalRates;
  /** Below "write": rates stay visible (a viewer prices from them) but locked. */
  readOnly?: boolean;
  onChange: (r: ProposalRates) => void;
}) {
  const [local, setLocal] = useState<ProposalRates>(rates);

  const set = (key: keyof ProposalRates, raw: string) => {
    if (readOnly) return;
    const n = parseFloat(raw) || 0;
    const next = { ...local, [key]: n };
    setLocal(next);
    onChange(next);
  };

  const groups = [
    { title: "Labor Rates", id: "labor" as const, unit: "$/hr" },
    { title: "Overhead & Burden", id: "overhead" as const, unit: "%" },
    { title: "Profit Margins", id: "profit" as const, unit: "%" },
    { title: "Tax Rates", id: "tax" as const, unit: "%" },
  ];

  return (
    <div className="max-w-2xl grid grid-cols-2 gap-6">
      {groups.map((g) => {
        const fields = RATE_FIELD_CONFIG.filter((f) => f.group === g.id);
        return (
          <div key={g.id}>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {g.title}
            </h4>
            <div className="rounded-md border overflow-hidden">
              {fields.map((f, i) => (
                <div
                  key={f.key}
                  className={cn(
                    "flex h-8 items-center justify-between px-3 hover:bg-fill-quaternary transition-colors",
                    i > 0 && "border-t"
                  )}
                >
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      step="any"
                      defaultValue={local[f.key]}
                      readOnly={readOnly}
                      className={cn(
                        "h-6 w-16 rounded border-0 bg-transparent px-1 text-right text-xs font-mono tabular-nums outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                        readOnly
                          ? "text-muted-foreground"
                          : "focus:ring-2 focus:ring-inset focus:ring-primary/30 focus:bg-primary/5"
                      )}
                      onBlur={readOnly ? undefined : (e) => set(f.key, e.target.value)}
                    />
                    <span className="w-6 text-right text-[10px] text-foreground-subtle">
                      {g.unit}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// WBS table — dense rows, consistent with phase grid styling
// ═══════════════════════════════════════════════════════════════════════════

function WBSTable({
  items,
  estimateId,
}: {
  items: Array<{
    _id: string;
    name: string;
    wbsPoolId: number;
    sortOrder: number;
    phaseCount: number;
    activityCount: number;
    costs: {
      craftManHours: number;
      welderManHours: number;
      totalCost: number;
      materialCost: number;
      equipmentCost: number;
      craftCost: number;
      welderCost: number;
      subcontractorCost: number;
      costOnlyCost: number;
    };
  }>;
  estimateId: string;
}) {
  // Defence in depth: Convex does not guarantee that a query's ordering survives
  // serialization (Momentum lost its WBS order that way, see the `#36` note in
  // workbook-table.tsx), so order by the numeric code on the client.
  const ordered = useMemo(() => [...items].sort((a, b) => a.wbsPoolId - b.wbsPoolId), [items]);

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">
        No WBS categories initialized.
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-fill-secondary">
        <tr>
          <th className="h-8 px-3 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b">
            WBS Category
          </th>
          <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
            Phases
          </th>
          <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-16">
            Items
          </th>
          <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
            Craft MH
          </th>
          <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-20">
            Weld MH
          </th>
          <th className="h-8 px-2 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b w-24">
            Total
          </th>
          <th className="h-8 w-8 border-b" />
        </tr>
      </thead>
      <tbody>
        {ordered.map((wbs, i) => (
          <tr
            key={wbs._id}
            className={cn(
              "h-[30px] transition-colors hover:bg-fill-quaternary group",
              i % 2 !== 0 && "bg-fill-quaternary"
            )}
          >
            <td className="px-3 border-b border-border/40">
              <Link
                to="/estimate/$estimateId/wbs/$wbsId"
                params={{ estimateId, wbsId: wbs._id }}
                title={formatWbsLabel(wbs.wbsPoolId, wbs.name)}
                className="flex items-center gap-2 text-sm font-medium text-foreground hover:underline"
              >
                <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs text-muted-foreground shrink-0 tabular-nums">
                  {wbs.wbsPoolId}
                </span>
                <span className="truncate">{wbs.name}</span>
              </Link>
            </td>
            <td className="px-2 text-right tabular-nums text-muted-foreground border-b border-border/40">
              {wbs.phaseCount}
            </td>
            <td className="px-2 text-right tabular-nums text-muted-foreground border-b border-border/40">
              {wbs.activityCount}
            </td>
            <td className="px-2 text-right tabular-nums font-mono border-b border-border/40">
              {wbs.costs.craftManHours > 0 ? mhfmt.format(wbs.costs.craftManHours) : "—"}
            </td>
            <td className="px-2 text-right tabular-nums font-mono border-b border-border/40">
              {wbs.costs.welderManHours > 0 ? mhfmt.format(wbs.costs.welderManHours) : "—"}
            </td>
            <td className="px-2 text-right tabular-nums font-mono font-medium border-b border-border/40">
              {wbs.costs.totalCost > 0 ? cfmt.format(wbs.costs.totalCost) : "—"}
            </td>
            <td className="border-b border-border/40">
              <Link to="/estimate/$estimateId/wbs/$wbsId" params={{ estimateId, wbsId: wbs._id }}>
                <ChevronRight className="h-3.5 w-3.5 text-foreground-subtle group-hover:text-foreground transition-colors" />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Skeleton
// ═══════════════════════════════════════════════════════════════════════════

function OverviewSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex h-10 items-center justify-between px-1">
        <Skeleton className="h-4 w-64" />
        <div className="flex gap-1.5">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-16" />
        </div>
      </div>
      <Skeleton className="h-9 w-48 mb-0" />
      <Skeleton className="flex-1 rounded-lg mt-4" />
      <Skeleton className="h-10 rounded-none" />
    </div>
  );
}
