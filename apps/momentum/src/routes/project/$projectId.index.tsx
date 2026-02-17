import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { format, parseISO } from "date-fns";
import { CalendarDays, X, Clock } from "lucide-react";
import { toast } from "sonner";
import { DatePicker } from "@truss/ui/components/date-picker";
import { Badge } from "@truss/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@truss/ui/components/breadcrumb";
import { Button } from "@truss/ui/components/button";
import { WorkbookTable, EntryHistoryPanel } from "@truss/features/progress-tracking";
import type { ColumnMode, HistoryDay } from "@truss/features/progress-tracking";
import { WorkbookSkeleton } from "../../components/skeletons";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Project index route — the primary workbook-first work surface.
 *
 * WHY: Merges the old dashboard and workbook into a single page.
 * When collapsed, WBS rows serve as a dashboard overview.
 * When expanded (via filters), it becomes the data entry surface.
 */
export const Route = createFileRoute("/project/$projectId/")({
  component: ProjectWorkbookPage,
  validateSearch: (search: Record<string, unknown>) => ({
    wbs: (search.wbs as string) || undefined,
  }),
});

function ProjectWorkbookPage() {
  const { projectId } = useParams({ from: "/project/$projectId/" });
  const { wbs: wbsFilter } = useSearch({ from: "/project/$projectId/" });

  const data = useQuery(api.momentum.getBrowseData, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const dateLabel = format(selectedDate, "MMM d");

  const rawEntries = useQuery(api.momentum.getEntriesForDate, {
    projectId: projectId as Id<"momentumProjects">,
    entryDate: dateStr,
  });

  const saveEntries = useMutation(api.momentum.saveProgressEntries);

  const [entryValues, setEntryValues] = React.useState<Record<string, string>>({});
  const [columnMode, setColumnMode] = React.useState<ColumnMode>("entry");
  const [historyOpen, setHistoryOpen] = React.useState(false);

  // Derive quantity and notes maps from the new return shape
  const existingEntries = React.useMemo(() => {
    if (!rawEntries) return undefined;
    const result: Record<string, number> = {};
    for (const [id, entry] of Object.entries(rawEntries)) {
      result[id] = entry.quantity;
    }
    return result;
  }, [rawEntries]);

  const existingNotes = React.useMemo(() => {
    if (!rawEntries) return undefined;
    const result: Record<string, string> = {};
    for (const [id, entry] of Object.entries(rawEntries)) {
      if (entry.notes) result[id] = entry.notes;
    }
    return result;
  }, [rawEntries]);

  // Only query history when panel is open
  const historyData = useQuery(
    api.momentum.getEntryHistory,
    historyOpen ? { projectId: projectId as Id<"momentumProjects"> } : "skip"
  );

  /* Reset local edits when date changes */
  React.useEffect(() => {
    setEntryValues({});
  }, [dateStr]);

  /* Cmd+H toggle for history panel */
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "h") {
        e.preventDefault();
        setHistoryOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleEntryChange = React.useCallback((activityId: string, value: string) => {
    setEntryValues((prev) => ({ ...prev, [activityId]: value }));
  }, []);

  /** Auto-save a single entry on cell blur. */
  const handleAutoSave = React.useCallback(
    async (activityId: string, value: number) => {
      try {
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [{ activityId: activityId as Id<"activities">, quantityCompleted: value }],
        });
        setEntryValues((prev) => {
          const next = { ...prev };
          delete next[activityId];
          return next;
        });
      } catch (error) {
        toast.error("Failed to save", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [dateStr, projectId, saveEntries]
  );

  /** Discard a local edit (Escape key), reverting to server value. */
  const handleEntryDiscard = React.useCallback((activityId: string) => {
    setEntryValues((prev) => {
      const next = { ...prev };
      delete next[activityId];
      return next;
    });
  }, []);

  /** Save a note for an activity. */
  const handleNoteSave = React.useCallback(
    async (activityId: string, notes: string) => {
      try {
        const currentQty = existingEntries?.[activityId] ?? 0;
        await saveEntries({
          projectId: projectId as Id<"momentumProjects">,
          entryDate: dateStr,
          entries: [
            {
              activityId: activityId as Id<"activities">,
              quantityCompleted: currentQty,
              notes: notes || undefined,
            },
          ],
        });
      } catch (error) {
        toast.error("Failed to save note", {
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [dateStr, projectId, saveEntries, existingEntries]
  );

  /** Load a date from the history panel into the date picker. */
  const handleHistoryDateSelect = React.useCallback((date: string) => {
    setSelectedDate(parseISO(date));
    setHistoryOpen(false);
  }, []);

  if (data === undefined) return <WorkbookSkeleton />;

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <p className="text-lg font-semibold text-muted-foreground">Project not found</p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const filteredRows = wbsFilter ? data.rows.filter((r) => r.wbsCode === wbsFilter) : data.rows;

  return (
    <div className="flex flex-col h-full gap-4 min-w-0 overflow-hidden">
      {/* ── Breadcrumb ── */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/projects">Projects</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{data.project.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* ── Metadata bar ── */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="tabular-nums">{filteredRows.length} items</span>
          <span className="text-border">&middot;</span>
          <span>{data.project.proposalNumber}</span>
          {wbsFilter && (
            <>
              <span className="text-border">&middot;</span>
              <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-[11px]">
                WBS {wbsFilter}
                <Link
                  to="/project/$projectId"
                  params={{ projectId }}
                  search={{ wbs: undefined }}
                  className="ml-0.5 rounded-sm hover:bg-foreground/10"
                >
                  <X className="h-3 w-3" />
                </Link>
              </Badge>
            </>
          )}
        </div>

        {/* Date picker group + History button */}
        <div className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setHistoryOpen(true)}
          >
            <Clock className="h-3.5 w-3.5" />
            History
          </Button>
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <div className="w-[170px]">
            <DatePicker
              date={selectedDate}
              onDateChange={(date) => date && setSelectedDate(date)}
              placeholder="Entry date"
              toDate={new Date()}
            />
          </div>
          <span className="text-xs font-medium text-muted-foreground">
            {format(selectedDate, "EEEE")}
          </span>
        </div>
      </div>

      {/* ── Workbook table ── */}
      <div className="flex-1 min-h-0 min-w-0">
        <WorkbookTable
          rows={filteredRows}
          wbsSummaries={data.wbsSummaries}
          phaseSummaries={data.phaseSummaries}
          entryDateLabel={dateLabel}
          existingEntries={existingEntries}
          entryValues={entryValues}
          onEntryChange={handleEntryChange}
          onAutoSave={handleAutoSave}
          onEntryDiscard={handleEntryDiscard}
          existingNotes={existingNotes}
          onNoteSave={handleNoteSave}
          projectStats={{
            totalMH: data.project.totalMH,
            earnedMH: data.project.earnedMH,
            percentComplete: data.project.percentComplete,
            status: data.project.status,
          }}
          columnMode={columnMode}
          onColumnModeChange={setColumnMode}
        />
      </div>

      {/* ── Entry history panel ── */}
      <EntryHistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        history={historyData as HistoryDay[] | null | undefined}
        onDateSelect={handleHistoryDateSelect}
      />
    </div>
  );
}
