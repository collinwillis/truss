import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { useShortcut } from "@truss/features/desktop-shell/providers";
import { toast } from "sonner";
import { useCallback, useEffect, useRef } from "react";
import { exportEstimateWorkbook, type EstimateExportData } from "../../lib/export-excel";

/**
 * Estimate layout route.
 *
 * Renders child routes:
 * - Index route (`$estimateId.index.tsx`) — Overview with info + rates + WBS
 * - Sibling routes (`.wbs.$wbsId`, `.phase.$phaseId`)
 *
 * WHY: TanStack Router's file-based routing requires layout routes to render an Outlet.
 *
 * WHY it owns the export: this is the only component mounted for every screen
 * inside an estimate, so the command palette's Export entry and ⌘⇧E reach a live
 * handler from the overview, a WBS or a phase alike. Registering the shortcut
 * here (rather than in the shell config) is also the only way it takes effect —
 * KeyboardProvider snapshots config shortcuts when the shell first mounts.
 */
export const Route = createFileRoute("/estimate/$estimateId")({
  component: EstimateLayout,
});

function EstimateLayout() {
  const { estimateId } = Route.useParams();
  const convex = useConvex();

  // Guards against a second run from a double-click or a held shortcut. A ref
  // rather than state: the handler must see the current value synchronously and
  // nothing renders from it.
  const exportingRef = useRef(false);

  const runExport = useCallback(async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;

    // One-shot read instead of a reactive subscription: the export payload
    // carries every activity in the estimate and is only needed on demand.
    const progress = toast.loading("Preparing export…");
    try {
      const data = await convex.query(api.precision.getExportData, {
        proposalId: estimateId as never,
      });
      const filename = `Estimate_${data.proposal.proposalNumber}.xlsx`;
      const blob = await exportEstimateWorkbook(data as EstimateExportData);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success("Export downloaded", { id: progress, description: filename });
    } catch (error) {
      toast.error("Export failed", {
        id: progress,
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      exportingRef.current = false;
    }
  }, [convex, estimateId]);

  useShortcut("cmd+shift+e", () => {
    void runExport();
  });

  useEffect(() => {
    const handleExport = () => {
      void runExport();
    };
    document.addEventListener("export-estimate", handleExport);
    return () => document.removeEventListener("export-estimate", handleExport);
  }, [runExport]);

  return <Outlet />;
}
