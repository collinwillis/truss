import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { format } from "date-fns";
import { CalendarDays, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
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
import { Skeleton } from "@truss/ui/components/skeleton";
import { WorkbookTable } from "@truss/features/progress-tracking";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Workbook route — the primary work surface for Momentum.
 *
 * WHY: Combines browse and entry into a single view. Entry column is
 * always visible when a date is selected. Pre-populates existing entries.
 */
export const Route = createFileRoute("/project/$projectId/workbook")({
  component: WorkbookPage,
  validateSearch: (search: Record<string, unknown>) => ({
    wbs: (search.wbs as string) || undefined,
  }),
});

function WorkbookPage() {
  const { projectId } = useParams({ from: "/project/$projectId/workbook" });
  const { wbs: wbsFilter } = useSearch({ from: "/project/$projectId/workbook" });

  const data = useQuery(api.momentum.getBrowseData, {
    projectId: projectId as Id<"momentumProjects">,
  });

  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  const dateLabel = format(selectedDate, "MMM d");

  const existingEntries = useQuery(api.momentum.getEntriesForDate, {
    projectId: projectId as Id<"momentumProjects">,
    entryDate: dateStr,
  });

  const saveEntries = useMutation(api.momentum.saveProgressEntries);

  const [entryValues, setEntryValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (existingEntries) {
      const prefilled: Record<string, string> = {};
      for (const [activityId, qty] of Object.entries(existingEntries)) {
        if (qty > 0) {
          prefilled[activityId] = String(qty);
        }
      }
      setEntryValues(prefilled);
    }
  }, [existingEntries]);

  const handleEntryChange = React.useCallback((activityId: string, value: string) => {
    setEntryValues((prev) => ({ ...prev, [activityId]: value }));
  }, []);

  const dirtyCount = React.useMemo(() => {
    let count = 0;
    for (const [activityId, value] of Object.entries(entryValues)) {
      const existingVal = existingEntries?.[activityId] ?? 0;
      const newVal = parseFloat(value) || 0;
      if (newVal !== existingVal) count++;
    }
    return count;
  }, [entryValues, existingEntries]);

  const handleSave = React.useCallback(async () => {
    const entries = Object.entries(entryValues)
      .map(([activityId, value]) => ({
        activityId: activityId as Id<"activities">,
        quantityCompleted: parseFloat(value) || 0,
      }))
      .filter((e) => {
        const existingVal = existingEntries?.[e.activityId as string] ?? 0;
        return e.quantityCompleted !== existingVal;
      });

    if (entries.length === 0) {
      toast.error("No changes to save");
      return;
    }

    setSaving(true);
    try {
      await saveEntries({
        projectId: projectId as Id<"momentumProjects">,
        entryDate: dateStr,
        entries,
      });
      toast.success(`Saved ${entries.length} entries for ${format(selectedDate, "PPP")}`);
    } catch (error) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSaving(false);
    }
  }, [entryValues, existingEntries, dateStr, selectedDate, projectId, saveEntries]);

  const handleDiscard = React.useCallback(() => {
    if (existingEntries) {
      const prefilled: Record<string, string> = {};
      for (const [activityId, qty] of Object.entries(existingEntries)) {
        if (qty > 0) {
          prefilled[activityId] = String(qty);
        }
      }
      setEntryValues(prefilled);
    } else {
      setEntryValues({});
    }
  }, [existingEntries]);

  /* ── Loading state ── */
  if (data === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-48" />
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-8 w-44" />
        </div>
        <div className="space-y-1">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-[400px] w-full rounded-lg" />
        </div>
      </div>
    );
  }

  /* ── Not found ── */
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
            <BreadcrumbLink asChild>
              <Link to="/project/$projectId" params={{ projectId }}>
                {data.project.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Workbook</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* ── Header bar ── */}
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-0.5">
          <h1 className="text-xl font-bold tracking-tight">Workbook</h1>
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
                    to="/project/$projectId/workbook"
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
        </div>

        {/* Date picker group */}
        <div className="flex items-center gap-2.5">
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
          existingEntries={existingEntries ?? undefined}
          entryValues={entryValues}
          onEntryChange={handleEntryChange}
          dirtyCount={dirtyCount}
          onSave={handleSave}
          onDiscard={handleDiscard}
          saving={saving}
        />
      </div>
    </div>
  );
}
