import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { cn } from "@truss/ui/lib/utils";
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
import { Separator } from "@truss/ui/components/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@truss/ui/components/tabs";
import { Button } from "@truss/ui/components/button";
import { BottomPanel } from "@truss/features/estimation/bottom-panel";
import { RATE_FIELD_CONFIG, type ProposalRates } from "@truss/features/estimation/types";
import { DuplicateEstimateDialog } from "../../components/duplicate-estimate-dialog";
import { exportEstimateWorkbook, type EstimateExportData } from "../../lib/export-excel";
import { useState, useCallback, useRef } from "react";
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
];

const BID_TYPE_OPTIONS = [
  { value: "lump_sum", label: "Lump Sum" },
  { value: "time_and_materials", label: "Time & Materials" },
  { value: "budgetary", label: "Budgetary" },
  { value: "rates", label: "Rates" },
  { value: "cost_plus", label: "Cost Plus" },
];

const STATUS_COLORS: Record<string, string> = {
  bidding: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  submitted: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  awarded: "bg-green-500/10 text-green-600 dark:text-green-400",
  rejected: "bg-red-500/10 text-red-600 dark:text-red-400",
  declined: "bg-muted text-muted-foreground",
  open: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  closed: "bg-muted text-muted-foreground",
};

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
  const proposal = useQuery(api.precision.getProposal, { proposalId: estimateId as never });
  const wbsItems = useQuery(api.precision.getWBSListWithCosts, { proposalId: estimateId as never });
  const summary = useQuery(api.precision.getProposalSummary, { proposalId: estimateId as never });
  const exportData = useQuery(api.precision.getExportData, { proposalId: estimateId as never });

  const updateProposal = useMutation(api.precision.updateProposal);
  const updateRates = useMutation(api.precision.updateProposalRates);

  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const patchField = useCallback(
    (field: string, value: string | number | undefined) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateProposal({
          proposalId: estimateId as never,
          [field]: value === "" ? undefined : value,
        });
      }, 400);
    },
    [estimateId, updateProposal]
  );

  const rateRef = useRef<ReturnType<typeof setTimeout>>();
  const patchRates = useCallback(
    (rates: ProposalRates) => {
      clearTimeout(rateRef.current);
      rateRef.current = setTimeout(() => {
        updateRates({ proposalId: estimateId as never, rates });
      }, 400);
    },
    [estimateId, updateRates]
  );

  const handleExport = useCallback(async () => {
    if (!exportData) return;
    setExporting(true);
    try {
      const blob = await exportEstimateWorkbook(exportData as EstimateExportData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Estimate_${exportData.proposal.proposalNumber}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    } finally {
      setExporting(false);
    }
  }, [exportData]);

  if (!proposal || !wbsItems || !summary) return <OverviewSkeleton />;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex h-10 items-center justify-between gap-4 shrink-0 px-1">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight truncate">
            <span className="font-mono text-muted-foreground">#{proposal.proposalNumber}</span>
            <span className="mx-1.5 text-muted-foreground/40">—</span>
            {proposal.description}
            {proposal.status && (
              <span
                className={cn(
                  "ml-2 inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium capitalize",
                  STATUS_COLORS[proposal.status] ?? ""
                )}
              >
                {proposal.status}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => setDuplicateOpen(true)}
          >
            <Copy className="h-3 w-3" /> Duplicate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleExport}
            disabled={exporting || !exportData}
          >
            <Download className="h-3 w-3" /> {exporting ? "Exporting..." : "Export"}
          </Button>
        </div>
      </div>

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
                  onBlur={(v) => patchField("proposalNumber", v)}
                />
                <FormField
                  label="Job #"
                  defaultValue={proposal.jobNumber ?? ""}
                  onBlur={(v) => patchField("jobNumber", v)}
                />
                <FormField
                  label="CO #"
                  defaultValue={proposal.changeOrderNumber ?? ""}
                  onBlur={(v) => patchField("changeOrderNumber", v)}
                />
              </div>
              <FormField
                label="Description"
                defaultValue={proposal.description}
                onBlur={(v) => patchField("description", v)}
              />
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <FormField
                  label="Owner / Client"
                  defaultValue={proposal.ownerName}
                  onBlur={(v) => patchField("ownerName", v)}
                />
                <FormField
                  label="Estimators"
                  defaultValue={(proposal.estimators ?? []).join(", ")}
                  onBlur={(v) => {
                    const list = v
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    updateProposal({
                      proposalId: estimateId as never,
                      estimators: list.length > 0 ? list : undefined,
                    });
                  }}
                />
              </div>
              <FormField
                label="Job-Site Address"
                defaultValue={proposal.jobSiteAddress ?? ""}
                onBlur={(v) => patchField("jobSiteAddress", v)}
              />
            </FormSection>

            <FormSection title="Status & Dates">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <FormSelect
                  label="Status"
                  value={proposal.status ?? ""}
                  options={STATUS_OPTIONS}
                  onChange={(v) =>
                    updateProposal({ proposalId: estimateId as never, status: v as never })
                  }
                />
                <FormSelect
                  label="Bid Type"
                  value={proposal.bidType ?? ""}
                  options={BID_TYPE_OPTIONS}
                  onChange={(v) =>
                    updateProposal({ proposalId: estimateId as never, bidType: v as never })
                  }
                />
                <FormDate
                  label="Date Received"
                  value={proposal.dateReceived}
                  onChange={(v) => patchField("dateReceived", v)}
                />
                <FormDate
                  label="Date Due"
                  value={proposal.dateDue}
                  onChange={(v) => patchField("dateDue", v)}
                />
              </div>
            </FormSection>
          </div>
        </TabsContent>

        {/* ── Rates Tab ── */}
        <TabsContent value="rates" className="flex-1 overflow-auto py-4 px-1">
          <RatesGrid rates={proposal.rates} onChange={patchRates} />
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

      <DuplicateEstimateDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        sourceProposalId={estimateId}
        sourceProposalNumber={proposal.proposalNumber}
        sourceDescription={proposal.description}
      />
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
  onBlur,
}: {
  label: string;
  defaultValue: string;
  mono?: boolean;
  onBlur: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        defaultValue={defaultValue}
        className={cn(
          "h-8 text-sm rounded-md border-border bg-background",
          "hover:border-border focus-visible:ring-2 focus-visible:ring-primary/30",
          "transition-colors",
          mono && "font-mono"
        )}
        onBlur={(e) => onBlur(e.target.value)}
      />
    </div>
  );
}

function FormSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange}>
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
  onChange,
}: {
  label: string;
  value?: number | null;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="date"
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
  onChange,
}: {
  rates: ProposalRates;
  onChange: (r: ProposalRates) => void;
}) {
  const [local, setLocal] = useState<ProposalRates>(rates);

  const set = (key: keyof ProposalRates, raw: string) => {
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
                    "flex h-8 items-center justify-between px-3 hover:bg-muted/40 transition-colors",
                    i > 0 && "border-t"
                  )}
                >
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      step="any"
                      defaultValue={local[f.key]}
                      className="h-6 w-16 rounded border-0 bg-transparent px-1 text-right text-xs font-mono tabular-nums outline-none focus:ring-2 focus:ring-inset focus:ring-primary/30 focus:bg-primary/5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      onBlur={(e) => set(f.key, e.target.value)}
                    />
                    <span className="w-6 text-right text-[10px] text-muted-foreground/50">
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
  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">
        No WBS categories initialized.
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 z-10 bg-muted">
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
        {items.map((wbs, i) => (
          <tr
            key={wbs._id}
            className={cn(
              "h-[30px] transition-colors hover:bg-accent/50 group",
              i % 2 !== 0 && "bg-muted/30"
            )}
          >
            <td className="px-3 border-b border-border/40">
              <Link
                to="/estimate/$estimateId/wbs/$wbsId"
                params={{ estimateId, wbsId: wbs._id }}
                className="flex items-center gap-2 text-sm font-medium text-foreground hover:underline"
              >
                <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-foreground transition-colors" />
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
