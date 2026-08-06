import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  DataSource,
  OneViewHealthResponse,
  OneViewSyncLog,
  OperationsHealthResponse,
  fetchDataSources,
  fetchOneViewHealth,
  fetchOperationsHealth,
  fetchSyncLogs,
} from "@/lib/oneview-api";
import {
  PlatformHealthItem,
  buildPlatformHealthSnapshot,
  dotClass,
  formatPtBrDateTime,
  formatRelativePtBr,
  statusLabel,
} from "@/lib/platform-health";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const REFRESH_MS = 30_000;

type PlatformHealthStripProps = {
  className?: string;
  /** When provided, skip internal fetch and render these items. */
  items?: PlatformHealthItem[];
  /** Optional last sync override when using controlled items. */
  lastSyncAt?: string | null;
};

export function PlatformHealthStrip({
  className,
  items: controlledItems,
  lastSyncAt: controlledLastSyncAt,
}: PlatformHealthStripProps) {
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [operations, setOperations] = useState<OperationsHealthResponse | null>(null);
  const [dataSources, setDataSources] = useState<DataSource[] | null>(null);
  const [syncLogs, setSyncLogs] = useState<OneViewSyncLog[]>([]);
  const inFlight = useRef<Promise<void> | null>(null);
  const tipId = useId();

  const refresh = useCallback(async () => {
    if (controlledItems) return;
    if (inFlight.current) return inFlight.current;

    const request = (async () => {
      const results = await Promise.allSettled([
        fetchOneViewHealth(),
        fetchOperationsHealth(),
        fetchDataSources(),
        fetchSyncLogs(20),
      ]);
      const [healthResult, operationsResult, sourcesResult, syncResult] = results;
      if (healthResult.status === "fulfilled") setHealth(healthResult.value);
      if (operationsResult.status === "fulfilled") setOperations(operationsResult.value);
      if (sourcesResult.status === "fulfilled") setDataSources(sourcesResult.value);
      if (syncResult.status === "fulfilled") setSyncLogs(syncResult.value.items);
    })().finally(() => {
      inFlight.current = null;
    });

    inFlight.current = request;
    return request;
  }, [controlledItems]);

  useEffect(() => {
    if (controlledItems) return;
    void refresh();
  }, [controlledItems, refresh]);

  useEffect(() => {
    if (controlledItems) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [controlledItems, refresh]);

  const snapshot = useMemo(
    () => (controlledItems
      ? { items: controlledItems, lastSyncAt: controlledLastSyncAt ?? null }
      : buildPlatformHealthSnapshot({
        health,
        operations,
        dataSources,
        syncLogs,
      })),
    [controlledItems, controlledLastSyncAt, health, operations, dataSources, syncLogs],
  );

  const items = snapshot.items;
  const lastSyncRelative = formatRelativePtBr(snapshot.lastSyncAt);
  const lastSyncAbsolute = formatPtBrDateTime(snapshot.lastSyncAt);

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={cn(
          "inline-flex shrink-0 flex-nowrap items-center gap-2 rounded-md border border-border/60 bg-background/80 px-2 py-1",
          className,
        )}
        aria-label="Saúde operacional"
      >
        {items.map((item, index) => {
          const label = statusLabel(item.level);
          const describedBy = `${tipId}-${item.key}`;
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-sm px-0.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${item.name}: ${label}`}
                  aria-describedby={describedBy}
                >
                  <span
                    aria-hidden="true"
                    className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(item.level))}
                  />
                  <span className="whitespace-nowrap text-xs font-medium text-foreground">{item.name}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                id={describedBy}
                side="bottom"
                align={index === items.length - 1 ? "end" : "start"}
                className="max-w-xs space-y-1 text-left text-xs"
              >
                {item.tooltipLines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex max-w-[9.5rem] shrink-0 items-center border-l border-border/60 pl-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={lastSyncRelative ? `Último sync: ${lastSyncRelative}` : "Último sync: sem informação"}
            >
              <span className="min-w-0">
                <span className="block text-[10px] font-semibold text-muted-foreground">Último sync:</span>
                <span className="block truncate text-xs font-medium text-foreground">
                  {lastSyncRelative ?? "—"}
                </span>
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-xs space-y-1 text-left text-xs">
            <p>Última sincronização</p>
            <p>{lastSyncAbsolute ?? "Sem informação"}</p>
            {lastSyncRelative ? <p>Tempo relativo: {lastSyncRelative}</p> : null}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export type { PlatformHealthItem, HealthLevel } from "@/lib/platform-health";
