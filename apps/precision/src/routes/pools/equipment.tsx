import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import { Search, Truck } from "lucide-react";
import { Input } from "@truss/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@truss/ui/components/table";
import { Badge } from "@truss/ui/components/badge";
import { Skeleton } from "@truss/ui/components/skeleton";
import { useState, useMemo } from "react";

export const Route = createFileRoute("/pools/equipment")({
  component: EquipmentPoolPage,
});

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Equipment catalog browser.
 *
 * WHY: Estimators need to browse available equipment with rate comparison
 * (hourly, daily, weekly, monthly) before adding equipment activities.
 */
function EquipmentPoolPage() {
  const [datasetVersion] = useState<"v1" | "v2">("v1");
  const [search, setSearch] = useState("");

  const equipmentPool = useQuery(api.precision.getEquipmentPool, { datasetVersion });

  const filtered = useMemo(() => {
    if (!equipmentPool) return [];
    if (!search.trim()) return equipmentPool;
    const q = search.toLowerCase();
    return equipmentPool.filter((item) => item.description.toLowerCase().includes(q));
  }, [equipmentPool, search]);

  return (
    <div className="space-y-4 flex-1 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Truck className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold tracking-tight">Equipment Catalog</h1>
        <Badge variant="secondary" className="text-[10px]">
          {datasetVersion.toUpperCase()}
        </Badge>
        {equipmentPool && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {equipmentPool.length} items
          </span>
        )}
      </div>

      {/* Search */}
      <div className="relative max-w-[320px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-subtle" />
        <Input
          placeholder="Search equipment..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 pl-8 text-sm"
        />
      </div>

      {/* Equipment table */}
      {equipmentPool === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-full bg-fill-secondary p-3 mb-4">
            <Truck className="h-6 w-6 text-foreground-subtle" />
          </div>
          <p className="text-sm text-muted-foreground">
            {search ? "No matching equipment." : "No equipment in catalog."}
          </p>
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px] text-xs">ID</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-right text-xs w-[90px]">Hour Rate</TableHead>
                <TableHead className="text-right text-xs w-[90px]">Day Rate</TableHead>
                <TableHead className="text-right text-xs w-[90px]">Week Rate</TableHead>
                <TableHead className="text-right text-xs w-[100px]">Month Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <TableRow key={item.poolId}>
                  <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                    {item.poolId}
                  </TableCell>
                  <TableCell className="text-sm">{item.description}</TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {currencyFmt.format(item.hourRate)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {currencyFmt.format(item.dayRate)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {currencyFmt.format(item.weekRate)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm tabular-nums">
                    {currencyFmt.format(item.monthRate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
