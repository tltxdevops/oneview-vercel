import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import settings from "@/lib/settings";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCcw, Pause, Play, BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSnapshotMode } from "@/lib/demo-mode";

interface AppLayoutProps {
  title?: string;
  description?: ReactNode;
  clientSelect?: ReactNode;
  headerAside?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  headerContent?: ReactNode;
  onRefresh?: () => void | Promise<void>;
  refreshInterval?: number;
  enableAutoRefresh?: boolean;
  initiallyPaused?: boolean;
  showRefreshMeta?: boolean;
}

const DEFAULT_REFRESH_INTERVAL = 60;

export function AppLayout({
  title,
  description,
  clientSelect,
  headerAside,
  children,
  contentClassName,
  headerContent,
  onRefresh,
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
  enableAutoRefresh = true,
  initiallyPaused = false,
  showRefreshMeta = true,
}: AppLayoutProps) {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(initiallyPaused);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(refreshInterval);

  // If caller didn't provide a refreshInterval, read from persisted settings
  const effectiveRefreshInterval = typeof refreshInterval === "number" ? refreshInterval : settings.getStoredRefreshInterval();
  const refreshIntervalValue = Math.max(5, effectiveRefreshInterval);

  const triggerRefresh = useCallback(async () => {
    try {
      setIsRefreshing(true);
      await onRefresh?.();
      setLastUpdatedAt(Date.now());
      setCountdown(refreshIntervalValue);
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, refreshIntervalValue]);

  // Load inicial apenas uma vez
  useEffect(() => {
    let mounted = true;
    const loadInitial = async () => {
      if (mounted) {
        await triggerRefresh();
      }
    };
    loadInitial();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh timer
  useEffect(() => {
    if (!enableAutoRefresh || isPaused) {
      setCountdown(refreshIntervalValue);
      return;
    }

    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          void triggerRefresh();
          return refreshIntervalValue;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [enableAutoRefresh, isPaused, refreshIntervalValue, triggerRefresh]);

  const formattedLastUpdate = useMemo(() => {
    if (!lastUpdatedAt) return "—";
    return new Date(lastUpdatedAt).toLocaleTimeString("pt-BR", { hour12: false });
  }, [lastUpdatedAt]);

  const topbarControls = useMemo(() => {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void triggerRefresh()}
          disabled={isRefreshing}
        >
          <RefreshCcw className="h-4 w-4" />
          {isRefreshing ? "Atualizando..." : "Atualizar agora"}
        </Button>
        <Button
          variant={isPaused ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => setIsPaused((prev) => !prev)}
          disabled={!enableAutoRefresh}
        >
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {isPaused ? "Retomar" : "Pausar"}
        </Button>
      </div>
    );
  }, [enableAutoRefresh, isPaused, triggerRefresh, isRefreshing]);

  const refreshMeta = useMemo(() => {
    if (!showRefreshMeta) return null;

    const nextUpdateLabel = enableAutoRefresh
      ? isPaused
        ? "Pausada"
        : `${countdown}s`
      : "Manual";

    return (
      <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground sm:text-sm">
        <span>
          Última atualização: <span className="font-semibold text-foreground">{formattedLastUpdate}</span>
        </span>
        <span>Próxima atualização: {nextUpdateLabel}</span>
      </div>
    );
  }, [showRefreshMeta, enableAutoRefresh, isPaused, countdown, formattedLastUpdate]);

  return (
    <div className="flex min-h-screen bg-background antialiased">
      <Sidebar />
      <div className="ml-20 flex min-h-screen flex-1 flex-col">
        <Topbar clientSection={clientSelect} rightSection={topbarControls} />
        <main className="flex-1 overflow-x-hidden">
          <div className={cn("flex flex-col gap-5 p-5", contentClassName)}>
            {headerContent ?? (
              (title || description || headerAside || refreshMeta) && (
                <header className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1.5">
                      {title && <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
                      {description && (
                        <p className="text-sm text-muted-foreground">{description}</p>
                      )}
                    </div>
                    {(headerAside || refreshMeta) && (
                      <div className="flex flex-col items-end gap-3 text-right">
                        {headerAside}
                        {refreshMeta}
                      </div>
                    )}
                  </div>
                </header>
              )
            )}

            {isSnapshotMode ? (
              <div>
                <Badge className="border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700 hover:bg-emerald-50">
                  <BadgeCheck className="mr-1.5 h-3.5 w-3.5" />
                  Snapshot real do banco OneView
                </Badge>
              </div>
            ) : null}

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
