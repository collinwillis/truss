import { createFileRoute, useParams, Link } from "@tanstack/react-router";
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
import {
  mockWBSItems,
  mockPhaseItems,
  mockDetailItems,
  getProjectById,
  getPhasesByWBS,
  getDetailsByPhase,
  calculateProgress,
  getSuggestedQuantity,
  validateQuantityEntry,
  type DetailItem,
  type ProgressMetrics,
} from "../../data/mock-progress-data";

/**
 * Daily quantity entry route component (project-specific).
 *
 * Primary workflow for field supervisors to enter completed quantities:
 * - Date picker (defaults to today)
 * - Collapsible tree of WBS → Phase → Detail items
 * - Quantity inputs with validation
 * - Real-time progress feedback
 * - Save functionality with confirmation
 *
 * WHY: This route is now project-specific to maintain proper context.
 * All entries are associated with the project in the URL.
 */
export const Route = createFileRoute("/project/$projectId/entry")({
  component: EntryPage,
});

function EntryPage() {
  const { projectId } = useParams({ from: "/project/$projectId/entry" });
  const project = getProjectById(projectId);

  // Selected date (defaults to today)
  const [selectedDate, setSelectedDate] = React.useState<Date>(new Date());

  // State for each detail item (checked, quantity, validation)
  const [itemStates, setItemStates] = React.useState<Record<string, DetailItemState>>({});

  // ISO date string for calculations
  const dateStr = format(selectedDate, "yyyy-MM-dd");

  // Group phases by WBS
  const phasesByWBS = React.useMemo(() => {
    const grouped: Record<string, typeof mockPhaseItems> = {};
    mockPhaseItems.forEach((phase) => {
      if (!grouped[phase.wbsId]) {
        grouped[phase.wbsId] = [];
      }
      grouped[phase.wbsId].push(phase);
    });
    return grouped;
  }, []);

  // Group details by phase
  const detailsByPhase = React.useMemo(() => {
    const grouped: Record<string, typeof mockDetailItems> = {};
    mockDetailItems.forEach((detail) => {
      if (!grouped[detail.phaseId]) {
        grouped[detail.phaseId] = [];
      }
      grouped[detail.phaseId].push(detail);
    });
    return grouped;
  }, []);

  // Calculate metrics for all detail items
  const metricsById = React.useMemo(() => {
    const metrics: Record<string, ProgressMetrics> = {};
    mockDetailItems.forEach((detail) => {
      metrics[detail.id] = calculateProgress(detail, dateStr);
    });
    return metrics;
  }, [dateStr]);

  // Calculate suggested quantities for all detail items
  const suggestedQuantities = React.useMemo(() => {
    const suggested: Record<string, number | null> = {};
    mockDetailItems.forEach((detail) => {
      suggested[detail.id] = getSuggestedQuantity(detail, dateStr);
    });
    return suggested;
  }, [dateStr]);

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

        // Validate quantity if it changed
        if ("quantity" in updates && newState.checked) {
          const detail = mockDetailItems.find((d) => d.id === itemId);
          if (detail) {
            const qty = parseFloat(newState.quantity);
            if (!isNaN(qty) && qty > 0) {
              newState.validation = validateQuantityEntry(qty, detail, dateStr);
            } else {
              newState.validation = null;
            }
          }
        }

        return {
          ...prev,
          [itemId]: newState,
        };
      });
    },
    [dateStr]
  );

  // Save progress entries
  const handleSave = React.useCallback(() => {
    // Get all checked items with valid quantities
    const entries = Object.entries(itemStates)
      .filter(([, state]) => state.checked && state.quantity)
      .map(([itemId, state]) => ({
        itemId,
        quantity: parseFloat(state.quantity),
      }))
      .filter((entry) => !isNaN(entry.quantity) && entry.quantity > 0);

    if (entries.length === 0) {
      toast.error("No entries to save", {
        description: "Please enter quantities for at least one item.",
      });
      return;
    }

    // Check for any errors
    const hasErrors = entries.some((entry) => {
      const state = itemStates[entry.itemId];
      return state.validation?.type === "error";
    });

    if (hasErrors) {
      toast.error("Cannot save entries", {
        description: "Please fix validation errors before saving.",
      });
      return;
    }

    // Show success (mock save)
    console.log("Saving entries:", {
      projectId,
      date: dateStr,
      entries,
    });

    toast.success("Progress saved successfully", {
      description: `Saved ${entries.length} ${entries.length === 1 ? "entry" : "entries"} for ${format(selectedDate, "PPP")}`,
    });

    // Reset form
    setItemStates({});
  }, [itemStates, dateStr, selectedDate, projectId]);

  // Count checked items
  const checkedCount = Object.values(itemStates).filter((state) => state.checked).length;

  if (!project) {
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
                {project.name}
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
          <p className="text-muted-foreground mt-2">
            Record completed quantities for {project.name}
          </p>
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
            toDate={new Date()} // Can't enter future dates
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
            wbsItems={mockWBSItems}
            phasesByWBS={phasesByWBS}
            detailsByPhase={detailsByPhase}
            metricsById={metricsById}
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
