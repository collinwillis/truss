import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@truss/ui/lib/utils";
import { ProposalStatusChip } from "@truss/features/estimation/proposal-status";
import { SyncOriginBadge } from "@truss/features/estimation/sync-origin";
import {
  compareNullableNumbers,
  compareProposalNumbers,
  compareText,
  proposalBase,
} from "./comparators";

/**
 * The proposal log's columns.
 *
 * Every column here exists in InDemand's own "Proposal Log.xlsx", and the
 * order is theirs. Widths are measured against the real strings: the p90 of
 * each field at the kit's grid type size, not round numbers.
 */

export interface ProposalRow {
  _id: string;
  proposalNumber: string;
  description: string;
  ownerName: string;
  status: string | null;
  bidType: string | null;
  dateDue: number | null;
  dateReceived: number | null;
  jobNumber: string | null;
  estimators: string[];
  location: string | null;
  projectStartDate: number | null;
  projectEndDate: number | null;
  precisionOwnedAt: number | null;
  /** Reserved: no field feeds this yet. See visibility.ts::autoVisibility. */
  amount?: number | null;
}

/** Their words, not the schema's. Nobody says "time_and_materials" out loud. */
const BID_TYPE_LABELS: Record<string, string> = {
  lump_sum: "Lump Sum",
  time_and_materials: "T&M",
  budgetary: "Budgetary",
  rates: "Rates",
  cost_plus: "Cost Plus",
};

export function bidTypeLabel(value: string | null): string {
  if (!value) return "";
  return BID_TYPE_LABELS[value] ?? value;
}

/** Menu labels — headers are elements, so they cannot be reused. */
export const LOG_COLUMN_LABELS: Record<string, string> = {
  number: "No.",
  description: "Description",
  client: "Client",
  location: "Location",
  estimators: "Estimators",
  bidType: "Type",
  received: "Received",
  due: "Due",
  status: "Status",
  jobNumber: "Job No.",
  startDate: "Start",
  endDate: "Finish",
  amount: "Amount",
};

const DAY = 86_400_000;
/**
 * Where "overdue" stops being a call to action and starts being archaeology.
 *
 * Measured: 331 live proposals are past due, but 310 of them by more than 90
 * days and 240 by more than a year. Painting all 331 red would put a warning
 * colour on 45% of the log, which is the same as having no warning colour.
 * The client's sheet solves this with a manual Closed status (238 rows); our
 * import carries 12. So the log separates the two populations instead:
 * OVERDUE is the 21 rows someone can still act on, DORMANT is the backlog.
 */
export const DORMANT_AFTER_DAYS = 90;

/** Statuses where a due date is still a deadline someone owes. */
const LIVE_STATUSES = new Set(["bidding", "open"]);

export type DueTier = "overdue" | "soon" | "dormant" | "none";

/** Today as the stored dates express it — a UTC calendar day boundary. */
function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * How a due date should read.
 *
 * `submitted` is deliberately NOT live: the deadline was met, so its 104
 * past-due rows are nobody's problem and must not be coloured as though
 * they were.
 */
export function dueTier(row: ProposalRow, now: number): DueTier {
  if (row.dateDue === null) return "none";
  if (!LIVE_STATUSES.has(row.status ?? "")) return "none";
  // Day-to-day, not instant-to-day: comparing a local `Date.now()` against a
  // UTC-midnight date makes something due today read as already past.
  const daysPast = (utcDayStart(now) - row.dateDue) / DAY;
  if (daysPast > DORMANT_AFTER_DAYS) return "dormant";
  if (daysPast > 0) return "overdue";
  if (daysPast > -7) return "soon";
  return "none";
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  // ⚠️ UTC IS LOAD-BEARING. Every one of the 1,714 date values in the live
  // database sits exactly at UTC midnight — these are calendar dates, not
  // instants (the importer builds them with `new Date("M/D/YYYY")`). Format
  // them in local time and every date west of Greenwich renders A DAY EARLY.
  timeZone: "UTC",
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
});

/** Same instant, same zone — so the clipboard cannot disagree with the grid. */
const tsvDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

export function fmtDateForCopy(ms: number | null | undefined): string {
  return ms == null ? "" : tsvDateFmt.format(new Date(ms));
}

/**
 * Dates carry the year, always.
 *
 * The screen this replaces formatted due dates as `MM/dd`, which renders
 * 2023 and 2026 identically — in a log whose live rows span four years, that
 * turns the most important column into a guess.
 */
function fmtDate(ms: number | null): string {
  return ms === null ? "" : dateFmt.format(new Date(ms));
}

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Highlight the matched substrings without dangerously setting HTML. */
function Highlighted({ text, query }: { text: string; query: string }): React.ReactElement {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return <>{text}</>;

  const ranges: Array<[number, number]> = [];
  const lower = text.toLowerCase();
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at === -1) break;
      ranges.push([at, at + token.length]);
      from = at + token.length;
    }
  }
  if (ranges.length === 0) return <>{text}</>;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={i} className="rounded-[2px] bg-primary/15 text-inherit">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export interface ColumnContext {
  /** Evaluated once per render so every row agrees on what "today" is. */
  now: number;
  /** The live search, for highlighting matches in the description. */
  query: string;
}

/**
 * Build the column defs ONCE, reading volatile values through a ref.
 *
 * ⚠️ THE RETURNED ARRAY MUST BE STABLE. TanStack's flexRender treats each
 * column's `cell` function as a React COMPONENT TYPE, so rebuilding the array
 * gives every cell a new type and React unmounts and remounts all of them.
 * With `now` and the search query as direct arguments, that happened on every
 * keystroke and once a minute — roughly 7,300 cells thrown away each time.
 * The same defect (and the same fix) as the phase grid's navigation hook.
 */
export function buildLogColumns(ctx: { current: ColumnContext }): ColumnDef<ProposalRow>[] {
  return [
    {
      id: "number",
      // `undefined`, not "", for a number that cannot be parsed: it is the
      // only signal TanStack applies BEFORE its descending flip, so it is the
      // only way blanks stay last in both directions.
      accessorFn: (r) => (proposalBase(r.proposalNumber) === null ? undefined : r.proposalNumber),
      header: "No.",
      size: 78,
      enableHiding: false,
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareProposalNumbers(a.original.proposalNumber, b.original.proposalNumber),
      cell: ({ row }) => {
        const raw = row.original.proposalNumber.trim();
        const match = /^(\d+)(.*)$/.exec(raw);
        return (
          <span className="truncate font-semibold tabular-nums text-foreground" title={raw}>
            {match ? (
              <>
                {match[1]}
                {match[2] && <span className="font-normal text-foreground-muted">{match[2]}</span>}
              </>
            ) : (
              raw
            )}
          </span>
        );
      },
    },
    {
      id: "description",
      accessorFn: (r) => r.description || undefined,
      header: "Description",
      sortUndefined: "last",
      // Absorbs the window's slack — see grid-geometry::cellWidth.
      size: 320,
      minSize: 260,
      enableHiding: false,
      sortingFn: (a, b) => compareText(a.original.description, b.original.description),
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-foreground" title={row.original.description}>
            <Highlighted text={row.original.description} query={ctx.current.query} />
          </span>
          <SyncOriginBadge precisionOwnedAt={row.original.precisionOwnedAt} iconOnly />
        </span>
      ),
    },
    {
      id: "client",
      accessorFn: (r) => r.ownerName || undefined,
      // Their word. The screen this replaces said "Owner", which nobody says.
      header: "Client",
      size: 160,
      sortUndefined: "last",
      sortingFn: (a, b) => compareText(a.original.ownerName, b.original.ownerName),
      cell: ({ row }) => (
        <span className="truncate text-muted-foreground" title={row.original.ownerName}>
          {row.original.ownerName}
        </span>
      ),
    },
    {
      id: "location",
      accessorFn: (r) => r.location || undefined,
      header: "Location",
      size: 116,
      sortUndefined: "last",
      sortingFn: (a, b) => compareText(a.original.location ?? "", b.original.location ?? ""),
      cell: ({ row }) => (
        <span className="truncate text-muted-foreground" title={row.original.location ?? ""}>
          {row.original.location ?? ""}
        </span>
      ),
    },
    {
      id: "estimators",
      accessorFn: (r) => r.estimators.join(", ") || undefined,
      header: "Est.",
      size: 84,
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareText(a.original.estimators.join(", "), b.original.estimators.join(", ")),
      cell: ({ row }) => {
        const all = row.original.estimators;
        if (all.length === 0) return null;
        // 47 of the 50 distinct tokens are initials; the outliers (one is
        // "michael lee-meisch") would otherwise blow the cell open.
        const shown = all.slice(0, 2).map((e) => (e.length > 3 ? e.slice(0, 3) : e));
        const extra = all.length - shown.length;
        return (
          <span
            className="truncate font-mono text-footnote tracking-wide text-foreground-muted"
            title={all.join(", ")}
          >
            {shown.join(", ")}
            {extra > 0 && <span className="text-foreground-subtle"> +{extra}</span>}
          </span>
        );
      },
    },
    {
      id: "bidType",
      accessorFn: (r) => bidTypeLabel(r.bidType) || undefined,
      header: "Type",
      size: 76,
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareText(bidTypeLabel(a.original.bidType), bidTypeLabel(b.original.bidType)),
      cell: ({ row }) => (
        // No colour: status owns colour on this screen. Contract type is a
        // fact about the contract, not a state to scan for.
        <span className="truncate text-footnote text-muted-foreground">
          {bidTypeLabel(row.original.bidType)}
        </span>
      ),
    },
    {
      id: "received",
      accessorFn: (r) => r.dateReceived ?? undefined,
      header: "Received",
      size: 76,
      meta: { align: "right" as const },
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareNullableNumbers(a.original.dateReceived ?? 0, b.original.dateReceived ?? 0),
      cell: ({ row }) => (
        // Blank, not an em-dash: a missing date cannot be mistaken for a zero
        // the way a missing dollar amount can, so 183 dashes would be noise.
        <span className="tabular-nums text-muted-foreground">
          {fmtDate(row.original.dateReceived)}
        </span>
      ),
    },
    {
      id: "due",
      accessorFn: (r) => r.dateDue ?? undefined,
      header: "Due",
      size: 80,
      meta: { align: "right" as const },
      sortUndefined: "last",
      sortingFn: (a, b) => compareNullableNumbers(a.original.dateDue ?? 0, b.original.dateDue ?? 0),
      cell: ({ row }) => {
        const tier = dueTier(row.original, ctx.current.now);
        return (
          <span
            className={cn(
              "inline-flex items-center gap-1 tabular-nums",
              // ONE accent on this screen, spent on the 21 rows that are
              // genuinely late. The amber "due soon" tier served 2 rows and
              // cost a third colour, so it now reads as an ordinary date —
              // its urgency is a day away and the row is right there.
              tier === "overdue" ? "font-medium text-red-600 dark:text-red-400" : null,
              // Quieter than an ordinary date: these are the backlog, and
              // they must not compete with the rows that are still live.
              tier === "dormant" && "text-foreground-subtle",
              tier !== "overdue" && tier !== "dormant" && "text-muted-foreground"
            )}
            title={
              tier === "overdue"
                ? "Past due and still bidding"
                : tier === "dormant"
                  ? `More than ${DORMANT_AFTER_DAYS} days past due and still marked bidding`
                  : undefined
            }
          >
            {/* Survives greyscale and colour-blindness — the colour is not
                the only carrier of "this one is late". */}
            {tier === "overdue" && (
              <span className="h-1 w-1 shrink-0 rounded-full bg-current" aria-hidden="true" />
            )}
            {fmtDate(row.original.dateDue)}
          </span>
        );
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status || undefined,
      header: "Status",
      size: 82,
      sortUndefined: "last",
      sortingFn: (a, b) => compareText(a.original.status ?? "", b.original.status ?? ""),
      cell: ({ row }) => <ProposalStatusChip status={row.original.status} variant="dot" />,
    },
    {
      id: "jobNumber",
      accessorFn: (r) => r.jobNumber || undefined,
      header: "Job No.",
      size: 84,
      sortUndefined: "last",
      sortingFn: (a, b) => compareText(a.original.jobNumber ?? "", b.original.jobNumber ?? ""),
      cell: ({ row }) => (
        // 92% blank by design: "did this turn into a job" is a question worth
        // answering across the whole log, and here the blank IS the answer.
        <span
          className="truncate font-mono tabular-nums text-muted-foreground"
          title={row.original.jobNumber ?? ""}
        >
          {row.original.jobNumber ?? ""}
        </span>
      ),
    },
    {
      id: "startDate",
      accessorFn: (r) => r.projectStartDate ?? undefined,
      header: "Start",
      size: 76,
      meta: { align: "right" as const },
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareNullableNumbers(a.original.projectStartDate ?? 0, b.original.projectStartDate ?? 0),
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {fmtDate(row.original.projectStartDate)}
        </span>
      ),
    },
    {
      id: "endDate",
      accessorFn: (r) => r.projectEndDate ?? undefined,
      header: "Finish",
      size: 76,
      meta: { align: "right" as const },
      sortUndefined: "last",
      sortingFn: (a, b) =>
        compareNullableNumbers(a.original.projectEndDate ?? 0, b.original.projectEndDate ?? 0),
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {fmtDate(row.original.projectEndDate)}
        </span>
      ),
    },
    {
      id: "amount",
      accessorFn: (r) => r.amount ?? undefined,
      header: "Amount",
      size: 96,
      meta: { align: "right" as const },
      sortUndefined: "last",
      sortingFn: (a, b) => compareNullableNumbers(a.original.amount ?? 0, b.original.amount ?? 0),
      cell: ({ row }) => {
        const value = row.original.amount;
        return (
          <span className="tabular-nums text-foreground">
            {value == null || value === 0 ? "—" : currencyFmt.format(value)}
          </span>
        );
      },
    },
  ];
}
