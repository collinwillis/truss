import { createFileRoute, useParams, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import * as React from "react";
import { format } from "date-fns";
import { Save, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { DatePicker } from "@truss/ui/components/date-picker";
import { Button } from "@truss/ui/components/button";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@truss/ui/components/breadcrumb";
import { EntryTree, type DetailItemState } from "@truss/features/progress-tracking";
import { Skeleton } from "@truss/ui/components/skeleton";
import type { Id } from "@truss/backend/convex/_generated/dataModel";

/**
 * Daily quantity entry route component (project-specific).
 *
 * Primary workflow for field supervisors to enter completed quantities:
 * - Date picker (defaults to today)
 * - Collapsible tree of WBS > Phase > Detail items
 * - Quantity inputs with validation
 * - Real-time progress feedback
 * - Save functionality with Convex persistence
 *
 * WHY: This route is project-specific to maintain proper context.
 * All entries are associated with the project in the URL.
 */
export const Route = createFileRoute("/project/$projectId/entry")({
  component: EntryPage,
});

function EntryPage() {
  const { projectId } = useParams({ from: "/project/$projectId/entry" });

  // Selected date (defaults to today)
  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());
  const dateStr = format(selectedDate, "yyyy-MM-dd");

  // State for each detail item (checked, quantity, validation)
  const [itemStates, setItemStates] = React.useState<Record<string, DetailItemState>>({});

  const data = useQuery(api.momentum.getEntryFormData, {
    projectId: projectId as Id<"momentumProjects">,
    entryDate: dateStr,
  });

  const saveEntries = useMutation(api.momentum.saveProgressEntries);

  // Pre-populate item states from existing entries when data loads
  React.useEffect(() => {
    if (!data?.todaysEntries) return;

    setItemStates((prev) => {
      const next = { ...prev };
      for (const [activityId, qty] of Object.entries(data.todaysEntries)) {
        // Only set if the user hasn't already modified this field
        if (!next[activityId]?.checked) {
          next[activityId] = {
            checked: true,
            quantity: String(qty),
            validation: null,
          };
        }
      }
      return next;
    });
  }, [data?.todaysEntries]);

  // Update item state with validation
  const handleItemStateChange = React.useCallback(
    (itemId: string, updates: Partial<DetailItemState>) => {
      setItemStates((prev) => {
        const current = prev[itemId] || {
          checked: false,
          quantity: "",
          validation: null,
        };

        const newState = { ...current, ...updates };

        // Validate quantity if it changed and item is checked
        if ("quantity" in updates && newState.checked && data) {
          const detail = Object.values(data.detailsByPhase)
            .flat()
            .find((d) => d.id === itemId);

          if (detail) {
            const qty = parseFloat(newState.quantity);
            if (!isNaN(qty) && qty > 0) {
              if (qty < 0) {
                newState.validation = { type: "error", message: "Quantity cannot be negative" };
              } else if (
                qty >
                detail.quantity - detail.quantityComplete + (data.todaysEntries[itemId] ?? 0)
              ) {
                newState.validation = {
                  type: "warning",
                  message: `Exceeds remaining quantity (${detail.quantityRemaining} ${detail.unit})`,
                };
              } else {
                newState.validation = null;
              }
            } else {
              newState.validation = null;
            }
          }
        }

        return { ...prev, [itemId]: newState };
      });
    },
    [data]
  );

  // Save progress entries to Convex
  const handleSave = React.useCallback(async () => {
    const entries = Object.entries(itemStates)
      .filter(([, state]) => state.checked && state.quantity)
      .map(([itemId, state]) => ({
        activityId: itemId as Id<"activities">,
        quantityCompleted: parseFloat(state.quantity),
      }))
      .filter((entry) => !isNaN(entry.quantityCompleted) && entry.quantityCompleted > 0);

    if (entries.length === 0) {
      toast.error("No entries to save", {
        description: "Please enter quantities for at least one item.",
      });
      return;
    }

    // Check for validation errors
    const hasErrors = entries.some((entry) => {
      const state = itemStates[entry.activityId as string];
      return state?.validation?.type === "error";
    });

    if (hasErrors) {
      toast.error("Cannot save entries", {
        description: "Please fix validation errors before saving.",
      });
      return;
    }

    try {
      await saveEntries({
        projectId: projectId as Id<"momentumProjects">,
        entryDate: dateStr,
        entries,
      });

      toast.success("Progress saved successfully", {
        description: `Saved ${entries.length} ${entries.length === 1 ? "entry" : "entries"} for ${format(selectedDate, "PPP")}`,
      });
    } catch (error) {
      toast.error("Failed to save", {
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  }, [itemStates, dateStr, selectedDate, projectId, saveEntries]);

  // Count checked items
  const checkedCount = Object.values(itemStates).filter((state) => state.checked).length;

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <h2 className="text-2xl font-bold">Project Not Found</h2>
        <p className="text-muted-foreground mt-2">The project you're looking for doesn't exist.</p>
        <Link to="/projects">
          <Button className="mt-4 gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  // Build suggested quantities (suggest 25% of remaining for in-progress items)
  const suggestedQuantities: Record<string, number | null> = {};
  for (const details of Object.values(data.detailsByPhase)) {
    for (const detail of details) {
      if (detail.quantityRemaining > 0 && detail.percentComplete > 0) {
        suggestedQuantities[detail.id] = Math.ceil(detail.quantityRemaining * 0.25);
      } else {
        suggestedQuantities[detail.id] = null;
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
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
                Dashboard
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Enter Progress</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Enter Progress for {format(selectedDate, "MMMM d, yyyy")}
          </h1>
          <p className="text-muted-foreground mt-2">Record completed quantities</p>
        </div>
        <Button onClick={handleSave} size="lg" className="gap-2">
          <Save className="h-4 w-4" />
          Save Progress
          {checkedCount > 0 && (
            <span className="ml-1 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-xs font-medium">
              {checkedCount}
            </span>
          )}
        </Button>
      </div>

      {/* Date Picker */}
      <div className="flex items-center gap-4">
        <div className="w-[280px]">
          <DatePicker
            date={selectedDate}
            onDateChange={(date) => date && setSelectedDate(date)}
            placeholder="Select date"
            toDate={new Date()}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {format(selectedDate, "EEEE")} • Week {format(selectedDate, "w")}
        </p>
      </div>

      {/* Entry Tree */}
      <div className="rounded-lg border bg-card">
        <div className="p-6">
          <EntryTree
            wbsItems={data.wbsItems}
            phasesByWBS={data.phasesByWBS}
            detailsByPhase={data.detailsByPhase}
            metricsById={data.metricsById}
            suggestedQuantities={suggestedQuantities}
            itemStates={itemStates}
            onItemStateChange={handleItemStateChange}
          />
        </div>
      </div>

      {/* Footer Actions (sticky on mobile) */}
      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4 -mx-6 md:hidden">
        <Button onClick={handleSave} className="w-full gap-2" size="lg">
          <Save className="h-4 w-4" />
          Save Progress
          {checkedCount > 0 && (
            <span className="ml-1 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-xs font-medium">
              {checkedCount}
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}
