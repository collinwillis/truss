import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
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
import { RATE_FIELD_CONFIG, type ProposalRates } from "@truss/features/estimation/types";
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

  const proposal = useQuery(api.precision.getProposal, { proposalId });
  const updateProposal = useMutation(api.precision.updateProposal);
  const updateRates = useMutation(api.precision.updateProposalRates);
  const deleteProposal = useMutation(api.precision.deleteProposal);

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
      <div className="mx-auto flex max-w-4xl gap-10 px-2 py-6">
        {/* ── Section nav ── */}
        <nav className="sticky top-0 hidden w-36 shrink-0 self-start pt-14 md:block">
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
                    section.id === "danger" && "text-red-600/80 dark:text-red-400/80"
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
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">Setup</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">#{proposal.proposalNumber}</span> ·{" "}
                {proposal.description}
              </p>
            </div>
            {!canEdit && (
              <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-fill-quaternary px-2.5 py-1.5 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" /> Read-only — ask an admin for edit access
              </span>
            )}
          </header>

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
            <SettingRow
              label="Estimators"
              hint="Comma-separated initials"
              savedFlash={savedField === "estimators"}
            >
              <TextField
                defaultValue={(proposal.estimators ?? []).join(", ")}
                placeholder="JPK, LS"
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

          {/* ── Danger zone ── */}
          {canEdit && (
            <section
              id="danger"
              className="scroll-mt-4 rounded-lg border border-red-500/30 bg-red-500/[0.03]"
            >
              <div className="border-b border-red-500/20 px-5 py-4">
                <h2 className="text-[13px] font-medium text-red-700 dark:text-red-400">
                  Danger zone
                </h2>
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
                      size="sm"
                      className="h-7 shrink-0 gap-1 border-red-500/40 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
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
        "flex min-h-[44px] items-center gap-4 py-1.5",
        !last && "border-b border-border/60"
      )}
    >
      <div className="w-36 shrink-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        {hint && <p className="text-[10px] text-foreground-subtle">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        <span
          aria-hidden
          className={cn(
            "flex items-center gap-1 text-[10px] text-emerald-600 transition-opacity duration-300 dark:text-emerald-400",
            savedFlash ? "opacity-100" : "opacity-0"
          )}
        >
          <Check className="h-3 w-3" /> Saved
        </span>
        {children}
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
  return (
    <Input
      defaultValue={defaultValue}
      placeholder={placeholder}
      readOnly={readOnly}
      className={cn(
        "h-8 w-64 rounded-md border-border bg-background text-[13px] transition-colors",
        readOnly
          ? "border-transparent bg-transparent text-muted-foreground focus-visible:ring-0"
          : "hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary/30",
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
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={readOnly}>
      <SelectTrigger
        className={cn(
          "h-8 w-64 rounded-md border-border text-[13px] transition-colors",
          readOnly ? "border-transparent bg-transparent" : "hover:border-border-strong"
        )}
      >
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
        "h-8 w-64 rounded-md border-border bg-background text-[13px] transition-colors",
        !readOnly && "hover:border-border-strong focus-visible:ring-2 focus-visible:ring-primary/30"
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
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
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
                          "flex h-8 w-32 items-center rounded-md border bg-background transition-colors",
                          readOnly
                            ? "border-transparent bg-transparent"
                            : changed
                              ? "border-primary/40 bg-primary/[0.04]"
                              : "border-border hover:border-border-strong focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20"
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
                            "h-full w-full min-w-0 flex-1 bg-transparent px-2.5 text-right font-mono text-[13px] tabular-nums outline-none",
                            readOnly && "text-muted-foreground"
                          )}
                        />
                        <span className="shrink-0 pr-2.5 text-[10px] text-foreground-subtle">
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
                size="sm"
                className="h-7 text-xs"
                disabled={saving}
                onClick={() => setDraft(toDraft(rates))}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={saving}
                onClick={handleSave}
              >
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

function SetupSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-2 py-6">
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
