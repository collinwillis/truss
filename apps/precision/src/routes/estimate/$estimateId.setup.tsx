import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useStableQuery } from "../../lib/use-stable-query";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { cn } from "@truss/ui/lib/utils";
import { Input } from "@truss/ui/components/input";
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
import { Switch } from "@truss/ui/components/switch";
import { RATE_FIELD_CONFIG, type ProposalRates } from "@truss/features/estimation/types";
import { proposalStatusBarClasses } from "@truss/features/estimation/proposal-status";
import { useWorkspace } from "@truss/features/organizations/workspace-context";
import { canEditPrecision } from "../../lib/permissions";
import { toast } from "sonner";
import { useState, useCallback, useEffect, useRef } from "react";
import { format } from "date-fns";
import { Check, Lock, Trash2 } from "lucide-react";

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

const SECTIONS = [
  { id: "details", label: "Details" },
  { id: "rates", label: "Rates" },
  { id: "wbs", label: "Work breakdown" },
  { id: "danger", label: "Danger zone" },
] as const;

/**
 * Setup — the deliberate editing surface for an estimate.
 *
 * Anatomy (Stripe/Linear settings conventions, tuned to this app's density):
 * a sticky in-page section nav with scrollspy, one card per concern with a
 * header that says what editing it does, label-left rows for scannability,
 * and two save models chosen by blast radius — details autosave on blur
 * with a per-row saved flash; rates accumulate in a draft and apply
 * atomically from a sticky save bar (⌘S). No debounced keystroke writes for
 * anything that re-prices the bid.
 */
function EstimateSetupPage() {
  const { estimateId } = Route.useParams();
  const proposalId = estimateId as Id<"proposals">;
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const canEdit = canEditPrecision(workspace);

  const proposal = useStableQuery(api.precision.getProposal, { proposalId });
  const wbsItems = useStableQuery(api.precision.getWBSListWithCosts, { proposalId });
  const updateProposal = useMutation(api.precision.updateProposal);
  const updateRates = useMutation(api.precision.updateProposalRates);
  const deleteProposal = useMutation(api.precision.deleteProposal);
  const setWBSHidden = useMutation(api.precision.setWBSHidden);

  // ── Per-row saved flash: confirmation lives next to the field, not in a
  // toast — toast-per-blur would be noise for routine metadata edits.
  const [savedField, setSavedField] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashSaved = useCallback((field: string) => {
    clearTimeout(savedTimer.current);
    setSavedField(field);
    savedTimer.current = setTimeout(() => setSavedField(null), 1600);
  }, []);

  const saveField = useCallback(
    async (field: string, write: () => Promise<unknown>) => {
      if (!canEdit) return;
      try {
        await write();
        flashSaved(field);
      } catch (error) {
        toast.error("Failed to save estimate", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [canEdit, flashSaved]
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
          void saveField(field, () =>
            updateProposal({ proposalId, [field]: value === "" ? undefined : value })
          );
        }, 400)
      );
    },
    [proposalId, updateProposal, saveField]
  );

  // ── Scrollspy for the section nav ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>("details");
  // Re-observe once real content replaces the skeleton.
  const proposalLoaded = proposal !== undefined;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target.id;
        if (first) setActiveSection(first);
      },
      { root, rootMargin: "0px 0px -60% 0px" }
    );
    for (const section of SECTIONS) {
      const el = root.querySelector(`#${section.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [proposalLoaded]);

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

  const visibleSections = SECTIONS.filter((s) => s.id !== "danger" || canEdit);

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <div className="mx-auto max-w-[880px] px-6 py-6">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Setup</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">#{proposal.proposalNumber}</span> · {proposal.description}
            </p>
          </div>
          {!canEdit && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-fill-quaternary px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" /> Read-only — ask an admin for edit access
            </span>
          )}
        </header>

        <div className="flex gap-8">
          {/* ── Section nav ── */}
          <nav className="sticky top-4 hidden w-36 shrink-0 self-start md:block">
            <ul className="space-y-0.5">
              {visibleSections.map((section) => (
                <li key={section.id}>
                  <button
                    type="button"
                    onClick={() =>
                      scrollRef.current
                        ?.querySelector(`#${section.id}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    className={cn(
                      "w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                      activeSection === section.id
                        ? "bg-fill-quaternary font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                      section.id === "danger" && "text-destructive/80"
                    )}
                  >
                    {section.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* ── Content ── */}
          <div className="min-w-0 flex-1 space-y-6 pb-24">
            {/* ── Details ── */}
            <SettingsCard
              id="details"
              title="Details"
              description="Identity, client, and schedule. Changes save as you edit."
            >
              <SettingRow label="Proposal #" savedFlash={savedField === "proposalNumber"}>
                <TextField
                  defaultValue={proposal.proposalNumber}
                  mono
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("proposalNumber", v)}
                />
              </SettingRow>
              <SettingRow label="Job #" savedFlash={savedField === "jobNumber"}>
                <TextField
                  defaultValue={proposal.jobNumber ?? ""}
                  placeholder="—"
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("jobNumber", v)}
                />
              </SettingRow>
              <SettingRow label="CO #" savedFlash={savedField === "changeOrderNumber"}>
                <TextField
                  defaultValue={proposal.changeOrderNumber ?? ""}
                  placeholder="—"
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("changeOrderNumber", v)}
                />
              </SettingRow>
              <SettingRow label="Description" savedFlash={savedField === "description"}>
                <TextField
                  defaultValue={proposal.description}
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("description", v)}
                />
              </SettingRow>
              <SettingRow label="Owner / Client" savedFlash={savedField === "ownerName"}>
                <TextField
                  defaultValue={proposal.ownerName}
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("ownerName", v)}
                />
              </SettingRow>
              <SettingRow label="Estimators" savedFlash={savedField === "estimators"}>
                <TextField
                  defaultValue={(proposal.estimators ?? []).join(", ")}
                  placeholder="Initials, comma-separated — JPK, LS"
                  readOnly={!canEdit}
                  onCommit={(v) => {
                    const list = v
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    void saveField("estimators", () =>
                      updateProposal({ proposalId, estimators: list.length > 0 ? list : undefined })
                    );
                  }}
                />
              </SettingRow>
              <SettingRow label="Job-site address" savedFlash={savedField === "jobSiteAddress"}>
                <TextField
                  defaultValue={proposal.jobSiteAddress ?? ""}
                  placeholder="—"
                  readOnly={!canEdit}
                  onCommit={(v) => patchField("jobSiteAddress", v)}
                />
              </SettingRow>
              <SettingRow label="Status" savedFlash={savedField === "status"}>
                <SelectField
                  value={proposal.status ?? ""}
                  options={STATUS_OPTIONS}
                  readOnly={!canEdit}
                  dotFor={proposalStatusBarClasses}
                  onChange={(v) =>
                    void saveField("status", () =>
                      updateProposal({ proposalId, status: v as ProposalStatus })
                    )
                  }
                />
              </SettingRow>
              <SettingRow label="Bid type" savedFlash={savedField === "bidType"}>
                <SelectField
                  value={proposal.bidType ?? ""}
                  options={BID_TYPE_OPTIONS}
                  readOnly={!canEdit}
                  onChange={(v) =>
                    void saveField("bidType", () =>
                      updateProposal({ proposalId, bidType: v as ProposalBidType })
                    )
                  }
                />
              </SettingRow>
              <SettingRow label="Date received" savedFlash={savedField === "dateReceived"}>
                <DateField
                  value={proposal.dateReceived}
                  readOnly={!canEdit}
                  onChange={(v) => patchField("dateReceived", v)}
                />
              </SettingRow>
              <SettingRow label="Date due" savedFlash={savedField === "dateDue"} last>
                <DateField
                  value={proposal.dateDue}
                  readOnly={!canEdit}
                  onChange={(v) => patchField("dateDue", v)}
                />
              </SettingRow>
            </SettingsCard>

            {/* ── Rates ── */}
            <RatesCard
              key={proposal._id as string}
              rates={proposal.rates}
              readOnly={!canEdit}
              onSave={async (rates) => {
                await updateRates({ proposalId, rates });
              }}
            />

            {/* ── Work breakdown ── */}
            <WorkBreakdownCard
              wbsItems={wbsItems}
              readOnly={!canEdit}
              savedField={savedField}
              onToggle={(wbsId, hidden) =>
                saveField(`wbs-${wbsId}`, () => setWBSHidden({ wbsId: wbsId as Id<"wbs">, hidden }))
              }
            />

            {/* ── Danger zone ── */}
            {canEdit && (
              <section
                id="danger"
                className="scroll-mt-4 rounded-lg border border-destructive/30 bg-destructive/[0.03]"
              >
                <div className="border-b border-destructive/20 px-5 py-4">
                  <h2 className="text-[13px] font-medium text-destructive">Danger zone</h2>
                </div>
                <div className="flex items-center justify-between gap-6 px-5 py-4">
                  <div>
                    <p className="text-xs font-medium">Delete this estimate</p>
                    <p className="mt-1 max-w-md text-[11px] leading-relaxed text-muted-foreground">
                      Removes the estimate and every WBS, phase, and activity in it. A deleted
                      estimate stays deleted — the estimator sync will not restore it. If a Momentum
                      project was created from it, the delete is refused instead.
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="lg"
                        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" /> Delete estimate
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Delete estimate #{proposal.proposalNumber}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          This permanently removes “{proposal.description}” and everything in it.
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
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Card + row primitives
// ═══════════════════════════════════════════════════════════════════════════

function SettingsCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 rounded-lg border bg-card">
      <div className="border-b px-5 py-4">
        <h2 className="text-[13px] font-medium">{title}</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
      </div>
      <div className="px-5">{children}</div>
    </section>
  );
}

/**
 * Label-left setting row (macOS System Settings / Linear preferences
 * convention): scannable labels in a fixed column, controls right-aligned,
 * hairline separators, and the saved flash confirms exactly the row that
 * persisted.
 */
/**
 * Label-left setting row. The control lives in a FIXED right-anchored column
 * (the macOS System Settings grid): every control shares one left edge and
 * one width, so the page reads as two clean columns instead of a wall of
 * full-width fields sized by nothing. The saved flash sits just left of the
 * control it confirms.
 */
function SettingRow({
  label,
  hint,
  savedFlash,
  last,
  children,
}: {
  label: string;
  hint?: string;
  savedFlash?: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[40px] items-center justify-between gap-6 py-1",
        !last && "border-b border-border/60"
      )}
    >
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        {hint && <p className="text-[10px] text-foreground-subtle">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex items-center gap-1 text-[10px] text-emerald-600 transition-opacity duration-300 dark:text-emerald-400",
            savedFlash ? "opacity-100" : "opacity-0"
          )}
        >
          <Check className="h-3 w-3" /> Saved
        </span>
        <div className="w-[300px]">{children}</div>
      </div>
    </div>
  );
}

function TextField({
  defaultValue,
  placeholder,
  mono,
  readOnly,
  onCommit,
}: {
  defaultValue: string;
  placeholder?: string;
  mono?: boolean;
  readOnly?: boolean;
  onCommit: (v: string) => void;
}) {
  // Commit on blur only when the value actually changed — a click-through
  // must not fire a write (or a saved flash).
  //
  // QUIET INPUT: idle it reads as plain text; hover reveals the editable
  // surface; focus becomes a real field. A settings page full of idle
  // chrome is what made this screen read as a scaffold.
  return (
    <Input
      defaultValue={defaultValue}
      placeholder={placeholder}
      readOnly={readOnly}
      className={cn(
        "h-7 w-full border-transparent bg-transparent px-2 text-[13px] shadow-none transition-colors",
        readOnly ? "text-muted-foreground" : "hover:bg-fill-quaternary focus-visible:bg-background",
        mono && "font-mono"
      )}
      onBlur={
        readOnly
          ? undefined
          : (e) => {
              if (e.target.value !== defaultValue) onCommit(e.target.value);
            }
      }
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = defaultValue;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function SelectField({
  value,
  options,
  readOnly,
  onChange,
  dotFor,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (v: string) => void;
  /** Optional colour-dot class per value — the status select's identity. */
  dotFor?: (value: string) => string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={readOnly}>
      <SelectTrigger
        className={cn(
          "h-7 w-full border-transparent bg-transparent text-[13px] shadow-none transition-colors",
          !readOnly && "hover:bg-fill-quaternary data-[state=open]:bg-fill-quaternary"
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {dotFor && value && (
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotFor(value))} />
          )}
          <SelectValue placeholder="—" />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex items-center gap-1.5">
              {dotFor && <span className={cn("h-1.5 w-1.5 rounded-full", dotFor(o.value))} />}
              {o.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DateField({
  value,
  readOnly,
  onChange,
}: {
  value?: number | null;
  readOnly?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <Input
      type="date"
      disabled={readOnly}
      defaultValue={value ? format(new Date(value), "yyyy-MM-dd") : ""}
      className={cn(
        "h-7 w-full rounded-md border-transparent bg-transparent px-2 text-[13px] tabular-nums transition-colors",
        !readOnly && "hover:bg-fill-quaternary focus-visible:bg-background"
      )}
      onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : undefined)}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Rates
// ═══════════════════════════════════════════════════════════════════════════

const RATE_GROUPS = [
  { title: "Labor rates", id: "labor" as const, unit: "$/hr" },
  { title: "Overhead & burden", id: "overhead" as const, unit: "%" },
  { title: "Profit margins", id: "profit" as const, unit: "%" },
  { title: "Tax rates", id: "tax" as const, unit: "%" },
];

/**
 * Rates draft editor.
 *
 * Drafts are STRINGS: parsing on every keystroke made "40.5" impossible to
 * type (the trailing dot was normalized away mid-entry). Values parse at
 * comparison and save time; dirty rows get a marker and a tinted field; the
 * sticky bar applies everything atomically. ⌘S saves while dirty.
 */
function RatesCard({
  rates,
  readOnly,
  onSave,
}: {
  rates: ProposalRates;
  readOnly: boolean;
  onSave: (rates: ProposalRates) => Promise<void>;
}) {
  const toDraft = useCallback(
    (source: ProposalRates): Record<string, string> =>
      Object.fromEntries(RATE_FIELD_CONFIG.map((f) => [f.key, String(source[f.key])])),
    []
  );
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(rates));
  const [saving, setSaving] = useState(false);

  const parsed = (key: keyof ProposalRates): number => {
    const n = parseFloat(draft[key] ?? "");
    return isNaN(n) ? 0 : n;
  };
  const changedKeys = RATE_FIELD_CONFIG.filter((f) => parsed(f.key) !== rates[f.key]).map(
    (f) => f.key
  );
  const dirty = changedKeys.length > 0;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = { ...rates };
      for (const f of RATE_FIELD_CONFIG) next[f.key] = parsed(f.key);
      await onSave(next);
      setDraft(toDraft(next));
      toast.success("Rates saved", { description: "The whole estimate has been re-priced." });
    } catch (error) {
      toast.error("Failed to save rates", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSaving(false);
    }
  };

  // ⌘S applies the draft — the doc's "keyboard first" rule, and the muscle
  // memory every estimator already has. The ref keeps the listener's identity
  // stable while the handler closes over fresh state each render.
  const handleSaveRef = useRef<() => void>(() => {});
  handleSaveRef.current = () => void handleSave();
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSaveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty]);

  return (
    <section id="rates" className="scroll-mt-4 rounded-lg border bg-card">
      <div className="border-b px-5 py-4">
        <h2 className="text-[13px] font-medium">Rates</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Applied to every activity when saved — rate changes re-price the whole estimate.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 px-5 py-4 sm:grid-cols-2">
        {RATE_GROUPS.map((group) => {
          const fields = RATE_FIELD_CONFIG.filter((f) => f.group === group.id);
          return (
            <div key={group.id}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h3>
              <div className="space-y-1.5">
                {fields.map((f) => {
                  const changed = parsed(f.key) !== rates[f.key];
                  return (
                    <div key={f.key} className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className={cn(
                            "h-1 w-1 rounded-full transition-colors",
                            changed ? "bg-primary" : "bg-transparent"
                          )}
                        />
                        {f.label}
                      </span>
                      <label
                        className={cn(
                          "flex h-7 w-28 items-center rounded-lg border transition-colors",
                          readOnly
                            ? "border-transparent bg-transparent"
                            : changed
                              ? "border-primary/40 bg-primary/[0.06] focus-within:border-primary focus-within:ring-2 focus-within:ring-ring"
                              : "border-transparent bg-fill-quaternary/40 hover:bg-fill-quaternary focus-within:border-primary focus-within:bg-background focus-within:ring-2 focus-within:ring-ring"
                        )}
                      >
                        <input
                          type="text"
                          inputMode="decimal"
                          value={draft[f.key] ?? ""}
                          readOnly={readOnly}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))
                          }
                          className={cn(
                            // appearance-none (not [appearance:textfield]):
                            // both hide number spinners, but on WKWebView the
                            // textfield appearance draws the NATIVE macOS
                            // focus ring around this inner input — the border
                            // through the unit suffix — and outline-none
                            // cannot suppress it.
                            "h-full w-full min-w-0 flex-1 appearance-none bg-transparent px-2.5 text-right font-mono text-[13px] tabular-nums outline-none",
                            readOnly && "text-muted-foreground"
                          )}
                        />
                        <span className="shrink-0 pr-2 text-[10px] text-muted-foreground">
                          {group.unit}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky save bar — visible wherever you are on the page while dirty. */}
      {dirty && !readOnly && (
        <div className="sticky bottom-3 z-10 px-5 pb-4">
          <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-background/95 px-4 py-2.5 shadow-lg backdrop-blur">
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {changedKeys.length} unsaved {changedKeys.length === 1 ? "change" : "changes"}
              </span>{" "}
              — saving re-prices the whole estimate
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="lg"
                disabled={saving}
                onClick={() => setDraft(toDraft(rates))}
              >
                Discard
              </Button>
              <Button size="lg" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save rates"}
                <kbd className="rounded bg-primary-foreground/20 px-1 font-mono text-[9px]">⌘S</kbd>
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Work breakdown
// ═══════════════════════════════════════════════════════════════════════════

const wbsCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

interface WorkBreakdownItem {
  _id: string;
  name: string;
  wbsPoolId: number;
  isHidden: boolean;
  phaseCount: number;
  costs: { totalCost: number };
}

/**
 * Per-WBS visibility toggles — which sections this estimate actually uses.
 *
 * Off means hidden from the rail, the landing redirect, `[` / `]` paging and
 * Overview's bars; the section keeps its data and can be turned back on at
 * any time. THE INVARIANT THE COPY LEANS ON: hiding never moves the bid —
 * a hidden section's work stays in every total, and a row that hides real
 * cost says so inline rather than letting the toggle look like a delete.
 */
function WorkBreakdownCard({
  wbsItems,
  readOnly,
  savedField,
  onToggle,
}: {
  wbsItems: WorkBreakdownItem[] | undefined;
  readOnly: boolean;
  savedField: string | null;
  onToggle: (wbsId: string, hidden: boolean) => Promise<void>;
}) {
  // Optimistic per-row state: the switch flips the instant it is clicked and
  // ignores further clicks until the write settles — without this the flip
  // waited a round-trip and a rapid second click re-sent the same value.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const toggle = (wbsId: string, hidden: boolean) => {
    setPending((prev) => ({ ...prev, [wbsId]: hidden }));
    void onToggle(wbsId, hidden).finally(() =>
      setPending((prev) => {
        const { [wbsId]: _settled, ...rest } = prev;
        return rest;
      })
    );
  };
  return (
    <section id="wbs" className="scroll-mt-4 rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 className="text-[13px] font-medium">Work breakdown</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Choose which sections this estimate uses — the rest leave the menus. Hidden sections
            keep their data, and any work in them still counts toward the total.
          </p>
        </div>
        {wbsItems && (
          <span className="shrink-0 rounded-md bg-fill-quaternary px-2 py-1 text-[11px] tabular-nums text-muted-foreground">
            {wbsItems.filter((w) => !w.isHidden).length} of {wbsItems.length} in use
          </span>
        )}
      </div>
      <div className="px-5">
        {wbsItems === undefined ? (
          <div className="space-y-2 py-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : (
          wbsItems.map((wbs, i) => {
            const shownHidden = pending[wbs._id] ?? wbs.isHidden;
            const hiddenCost = shownHidden && wbs.costs.totalCost !== 0;
            return (
              <div
                key={wbs._id}
                className={cn(
                  "flex min-h-[38px] items-center gap-3 py-1",
                  i < wbsItems.length - 1 && "border-b border-border/60"
                )}
              >
                <Switch
                  checked={!shownHidden}
                  disabled={readOnly || pending[wbs._id] !== undefined}
                  onCheckedChange={(checked) => toggle(wbs._id, !checked)}
                  aria-label={`${shownHidden ? "Show" : "Hide"} ${wbs.name}`}
                />
                <span
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    shownHidden ? "text-foreground-subtle" : "text-muted-foreground"
                  )}
                >
                  {wbs.wbsPoolId}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs font-medium",
                    shownHidden && "text-muted-foreground"
                  )}
                >
                  {wbs.name}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "flex items-center gap-1 text-[10px] text-emerald-600 transition-opacity duration-300 dark:text-emerald-400",
                    savedField === `wbs-${wbs._id}` ? "opacity-100" : "opacity-0"
                  )}
                >
                  <Check className="h-3 w-3" /> Saved
                </span>
                <span className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {wbs.phaseCount > 0
                    ? `${wbs.phaseCount} ${wbs.phaseCount === 1 ? "phase" : "phases"}`
                    : "empty"}
                  {wbs.costs.totalCost !== 0 && (
                    <>
                      {" · "}
                      <span className="font-mono">{wbsCurrency.format(wbs.costs.totalCost)}</span>
                    </>
                  )}
                  {hiddenCost && (
                    <span className="ml-1.5 text-amber-700 dark:text-amber-400">in totals</span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function SetupSkeleton() {
  return (
    <div className="mx-auto max-w-[880px] space-y-6 px-6 py-6">
      <Skeleton className="h-6 w-32" />
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg border p-5">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: 4 }).map((_, j) => (
            <Skeleton key={j} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
