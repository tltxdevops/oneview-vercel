import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import settings from "@/lib/settings";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { Badge } from "@/components/ui/badge";
import { PlatformHealthStrip } from "@/components/oneview/PlatformHealthStrip";
import { BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OneViewDataSourceKind } from "@/lib/oneview-api";

interface AppLayoutProps {
  title?: string;
  description?: ReactNode;
  clientSelect?: ReactNode;
  topbarRightSection?: ReactNode;
  headerAside?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  topbarClassName?: string;
  headerContent?: ReactNode;
  onRefresh?: () => void | Promise<void>;
  refreshInterval?: number;
  enableAutoRefresh?: boolean;
  showRefreshMeta?: boolean;
  dataSource?: OneViewDataSourceKind | null;
  checkedAt?: string | null;
  showHealthStrip?: boolean;
  wallboard?: boolean;
}

const DEFAULT_REFRESH_INTERVAL = 60;

export function AppLayout({
  title,
  description,
  clientSelect,
  topbarRightSection,
  headerAside,
  children,
  contentClassName,
  topbarClassName,
  headerContent,
  onRefresh,
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
  enableAutoRefresh = true,
  showRefreshMeta = true,
  dataSource,
  checkedAt,
  showHealthStrip = true,
  wallboard = false,
}: AppLayoutProps) {
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(refreshInterval);

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

  useEffect(() => {
    if (!enableAutoRefresh) {
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
  }, [enableAutoRefresh, refreshIntervalValue, triggerRefresh]);

  const formattedLastUpdate = useMemo(() => {
    if (!lastUpdatedAt) return "—";
    return new Date(lastUpdatedAt).toLocaleTimeString("pt-BR", { hour12: false });
  }, [lastUpdatedAt]);

  const refreshMeta = useMemo(() => {
    if (!showRefreshMeta) return null;

    const nextUpdateLabel = enableAutoRefresh ? `${countdown}s` : null;

    return (
      <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground sm:text-sm">
        <span>
          Última atualização: <span className="font-semibold text-foreground">{formattedLastUpdate}</span>
        </span>
        {nextUpdateLabel ? <span>Próxima atualização: {nextUpdateLabel}</span> : null}
        {isRefreshing ? <span>Atualizando...</span> : null}
      </div>
    );
  }, [showRefreshMeta, enableAutoRefresh, countdown, formattedLastUpdate, isRefreshing]);

  const effectiveDataSource = dataSource ?? null;
  const checkedAtLabel = useMemo(() => {
    if (!checkedAt) return null;
    const date = new Date(checkedAt);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("pt-BR");
  }, [checkedAt]);

  const topbarLeft = clientSelect ? (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {clientSelect}
    </div>
  ) : undefined;

  const topbarRight = (showHealthStrip || topbarRightSection) ? (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
      {topbarRightSection}
      {showHealthStrip ? <PlatformHealthStrip /> : null}
    </div>
  ) : undefined;

  return (
    <div className="flex h-dvh overflow-hidden bg-background antialiased">
      {!wallboard ? <Sidebar /> : null}
      <div className={cn("flex h-dvh min-w-0 flex-1 flex-col overflow-hidden", !wallboard && "ml-14")}>
        <Topbar
          clientSection={topbarLeft}
          rightSection={topbarRight}
          className={topbarClassName}
        />
        <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className={cn("flex flex-col gap-3 p-3 lg:px-4", contentClassName)}>
            {headerContent ?? (
              (title || description || headerAside || refreshMeta) && (
                <header className="flex flex-col gap-2">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      {title && <h1 className="ov-typography-page-title">{title}</h1>}
                      {description && (
                        <p className="ov-typography-body text-muted-foreground">{description}</p>
                      )}
                    </div>
                    {(headerAside || refreshMeta) && (
                      <div className="flex flex-col items-end gap-2 text-right">
                        {headerAside}
                        {refreshMeta}
                      </div>
                    )}
                  </div>
                </header>
              )
            )}

            {effectiveDataSource ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn(
                  "border px-3 py-1 hover:bg-inherit",
                  "ov-status-badge",
                  effectiveDataSource === "database"
                    ? "ov-status-monitoring-normalized"
                    : "ov-status-classification-pending",
                )}>
                  <BadgeCheck className="mr-1.5 h-3.5 w-3.5" />
                  {effectiveDataSource === "database" ? "Banco em tempo real" : "Cópia atualizada"}
                </Badge>
                {checkedAtLabel ? (
                  <span className="text-xs text-muted-foreground">Última consulta: {checkedAtLabel}</span>
                ) : null}
              </div>
            ) : null}

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
