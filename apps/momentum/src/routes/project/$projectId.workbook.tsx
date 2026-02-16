import { createFileRoute, Link, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@truss/ui/components/button";
import { DatePicker } from "@truss/ui/components/date-picker";
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
 * WHY: Combines the old browse page and entry page into a single view.
 * Entry column is always visible when a date is selected. Pre-populates
 * existing entries for the selected date.
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

  // Pre-populate entry values from existing entries when they load or date changes
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

  // Count changes relative to existing entries
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

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <h2 className="text-2xl font-bold">Project Not Found</h2>
        <p className="text-muted-foreground mt-2">
          The project you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link to="/projects">
          <Button className="mt-4 gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  // Apply WBS filter from search params
  const filteredRows = wbsFilter ? data.rows.filter((r) => r.wbsCode === wbsFilter) : data.rows;

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Breadcrumb */}
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

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Workbook</h1>
          <p className="text-sm text-muted-foreground">
            {filteredRows.length} work items &bull; {data.project.proposalNumber}
            {wbsFilter && ` &bull; WBS ${wbsFilter}`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-[180px]">
            <DatePicker
              date={selectedDate}
              onDateChange={(date) => date && setSelectedDate(date)}
              placeholder="Entry date"
              toDate={new Date()}
            />
          </div>
          <p className="text-sm text-muted-foreground">{format(selectedDate, "EEEE")}</p>
        </div>
      </div>

      {/* Workbook table */}
      <div className="flex-1">
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
