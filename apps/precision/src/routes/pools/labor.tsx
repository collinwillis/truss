import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { Search, Wrench } from "lucide-react";
import { Input } from "@truss/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@truss/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@truss/ui/components/card";
import { Badge } from "@truss/ui/components/badge";
import { Skeleton } from "@truss/ui/components/skeleton";
import { ScrollArea } from "@truss/ui/components/scroll-area";
import { useState, useMemo } from "react";

export const Route = createFileRoute("/pools/labor")({
  component: LaborPoolPage,
});

/**
 * Labor constants browser.
 *
 * WHY: Estimators need to browse available labor items to understand
 * craft/welder constants before creating activities. This provides a
 * searchable catalog with phase filtering.
 */
function LaborPoolPage() {
  const [datasetVersion] = useState<"v1" | "v2">("v1");
  const [selectedWBS, setSelectedWBS] = useState<string>("");
  const [selectedPhase, setSelectedPhase] = useState<string>("");
  const [search, setSearch] = useState("");

  // Pool data
  const wbsPool = useQuery(api.precision.getWBSPool, { datasetVersion });
  const phasePool = useQuery(
    api.precision.getPhasePool,
    selectedWBS ? { datasetVersion, wbsPoolId: parseInt(selectedWBS) } : "skip"
  );
  const laborPool = useQuery(
    api.precision.getLaborPool,
    selectedPhase ? { datasetVersion, phasePoolId: parseInt(selectedPhase) } : "skip"
  );

  // Filter by search
  const filteredLabor = useMemo(() => {
    if (!laborPool) return [];
    if (!search.trim()) return laborPool;
    const q = search.toLowerCase();
    return laborPool.filter((item) => item.description.toLowerCase().includes(q));
  }, [laborPool, search]);

  return (
    <div className="space-y-4 flex-1 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Wrench className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold tracking-tight">Labor Constants</h1>
        <Badge variant="secondary" className="text-[10px]">
          {datasetVersion.toUpperCase()}
        </Badge>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={selectedWBS}
          onValueChange={(val) => {
            setSelectedWBS(val);
            setSelectedPhase("");
          }}
        >
          <SelectTrigger className="h-8 text-sm w-[240px]">
            <SelectValue placeholder="Select WBS category..." />
          </SelectTrigger>
          <SelectContent>
            {wbsPool?.map((wbs) => (
              <SelectItem key={wbs.poolId} value={String(wbs.poolId)}>
                {wbs.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {phasePool && (
          <Select value={selectedPhase} onValueChange={setSelectedPhase}>
            <SelectTrigger className="h-8 text-sm w-[300px]">
              <SelectValue placeholder="Select phase type..." />
            </SelectTrigger>
            <SelectContent>
              {phasePool.map((phase) => (
                <SelectItem key={phase.poolId} value={String(phase.poolId)}>
                  {phase.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {selectedPhase && (
          <div className="relative flex-1 max-w-[240px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
            <Input
              placeholder="Search labor items..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
        )}
      </div>

      {/* Labor items table */}
      {!selectedWBS ? (
        <EmptyState message="Select a WBS category to browse labor constants." />
      ) : !selectedPhase ? (
        <EmptyState message="Select a phase type to see available labor items." />
      ) : laborPool === undefined ? (
        <TableSkeleton />
      ) : filteredLabor.length === 0 ? (
        <EmptyState
          message={search ? "No matching labor items." : "No labor items for this phase."}
        />
      ) : (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px] text-xs">ID</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-right text-xs w-[100px]">Craft Constant</TableHead>
                <TableHead className="text-xs w-[60px]">Units</TableHead>
                <TableHead className="text-right text-xs w-[100px]">Weld Constant</TableHead>
                <TableHead className="text-xs w-[60px]">Units</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLabor.map((item) => (
                <TableRow key={item.poolId}>
                  <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                    {item.poolId}
                  </TableCell>
                  <TableCell className="text-sm">{item.description}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {item.craftConstant}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.craftUnits}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {item.weldConstant}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.weldUnits}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="rounded-full bg-fill-secondary p-3 mb-4">
        <Wrench className="h-6 w-6 text-foreground-subtle" />
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
