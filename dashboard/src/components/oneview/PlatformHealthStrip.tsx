import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { RuntimeHealthResponse, fetchRuntimeHealth } from "@/lib/oneview-api";
import {
  readRuntimeHealthSnapshot,
  writeRuntimeHealthSnapshot,
} from "@/lib/oneview-health-snapshot";
import { operationalToneDotClass, operationalToneLabel, runtimeSummary } from "@/lib/runtime-health";
import { formatRelativePtBr } from "@/lib/platform-health";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { runAfterOneViewFirstUseful } from "@/lib/oneview-performance";

const REFRESH_MS = 30_000;

export function PlatformHealthStrip({ className }: { className?: string }) {
  const [health, setHealth] = useState<RuntimeHealthResponse | null>(() => readRuntimeHealthSnapshot());
  const [usingSnapshot, setUsingSnapshot] = useState(() => Boolean(health));
  const inFlight = useRef<Promise<void> | null>(null);
  const tipId = useId();
  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const request = fetchRuntimeHealth()
      .then((payload) => {
        setHealth(payload);
        writeRuntimeHealthSnapshot(payload);
        setUsingSnapshot(false);
      })
      .finally(() => { inFlight.current = null; });
    inFlight.current = request;
    return request;
  }, []);
  useEffect(() => runAfterOneViewFirstUseful(() => void refresh()), [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const items = useMemo(() => runtimeSummary(health), [health]);
  const snapshotAge = usingSnapshot ? formatRelativePtBr(health?.checked_at) : null;
  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={cn("inline-flex shrink-0 flex-nowrap items-center gap-2 rounded-md border border-border/60 bg-background/80 px-2 py-1", className)}
        aria-label={snapshotAge ? `Saúde operacional · snapshot ${snapshotAge}` : "Saúde operacional"}
      >
        {items.map((item, index) => {
          const label = operationalToneLabel(item.tone);
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
                  <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", operationalToneDotClass(item.tone))} />
                  <span className="hidden whitespace-nowrap text-xs font-medium text-foreground sm:inline">{item.name}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                id={describedBy}
                side="bottom"
                align={index === items.length - 1 ? "end" : "start"}
                className="max-w-xs space-y-1 text-left text-xs"
              >
                {item.tooltipLines.map((line, lineIndex) => (
                  <p key={`${item.key}-${lineIndex}`}>{line}</p>
                ))}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
