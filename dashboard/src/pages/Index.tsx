import { useMemo, useState, useLayoutEffect, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { AlertsList } from "@/components/alerts/AlertsList";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Activity, AlertTriangle, Database, RefreshCcw, Server, Wifi, Shield, Filter, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Link } from "react-router-dom";
import {
  DataSource,
  AlertMetrics,
  OneViewDataSourceKind,
  OneViewHealthResponse,
  OneViewSyncLog,
  dataSourcesToClients,
  fetchAlerts,
  fetchAlertMetrics,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchSyncLogs,
  oneViewAlertToLegacyAlert,
} from "@/lib/oneview-api";
import { Alert, Severity } from "@/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const SUMMARY_REFRESH_MS = 60_000;
const ALERTS_REFRESH_MS = 120_000;
const AUTOMATIC_ALERT_LIMIT = 500;
const SEVERITY_PRIORITY: Record<string, number> = {
  Critical: 1,
  High: 2,
  Average: 3,
  Info: 4,
};

function formatMetricDuration(seconds: number | undefined): string {
  const value = Math.max(Math.floor(seconds || 0), 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}

function formatDataSourceName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.length <= 3 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

export default function Index() {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [syncLogs, setSyncLogs] = useState<OneViewSyncLog[]>([]);
  const [sourcesMeta, setSourcesMeta] = useState<{ source?: OneViewDataSourceKind; checkedAt?: string }>({});
  const [alertsMeta, setAlertsMeta] = useState<{ source?: OneViewDataSourceKind; checkedAt?: string }>({});
  const [metricsMeta, setMetricsMeta] = useState<{ source?: OneViewDataSourceKind; checkedAt?: string }>({});
  const [healthMeta, setHealthMeta] = useState<{ source?: OneViewDataSourceKind; checkedAt?: string }>({});
  const [syncMeta, setSyncMeta] = useState<{ source?: OneViewDataSourceKind; checkedAt?: string }>({});
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [isLoading, setIsLoading] = useState(false);
  const pendingLoadsRef = useRef(0);
  const alertsContainerRef = useRef<HTMLDivElement | null>(null);
  const [visibleAlertCount, setVisibleAlertCount] = useState<number | null>(null);
  const healthRowRef = useRef<HTMLDivElement | null>(null);
  const sourceSummaryRef = useRef<HTMLDivElement | null>(null);

  const clients = useMemo(() => dataSourcesToClients(dataSources), [dataSources]);

  const beginLoad = useCallback(() => {
    pendingLoadsRef.current += 1;
    setIsLoading(true);
  }, []);

  const endLoad = useCallback(() => {
    pendingLoadsRef.current = Math.max(pendingLoadsRef.current - 1, 0);
    setIsLoading(pendingLoadsRef.current > 0);
  }, []);

  const loadSummaryAndSources = useCallback(async () => {
    beginLoad();
    try {
      const [healthResponse, sourcesResponse, metricsResponse, syncResponse] = await Promise.all([
        fetchOneViewHealth(),
        fetchDataSourcesWithMeta(),
        fetchAlertMetrics(),
        fetchSyncLogs(8),
      ]);
      setHealth(healthResponse);
      setHealthMeta({ source: healthResponse.data_source, checkedAt: healthResponse.checked_at });
      setDataSources(sourcesResponse.items);
      setSourcesMeta({ source: sourcesResponse.data_source, checkedAt: sourcesResponse.checked_at });
      setMetrics(metricsResponse);
      setMetricsMeta({ source: metricsResponse.data_source, checkedAt: metricsResponse.checked_at });
      setSyncLogs(syncResponse.items);
      setSyncMeta({ source: syncResponse.data_source, checkedAt: syncResponse.checked_at });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao carregar dados reais";
      toast.error(message);
    } finally {
      endLoad();
    }
  }, [beginLoad, endLoad]);

  const loadAlerts = useCallback(async () => {
    beginLoad();
    try {
      const alertsResponse = await fetchAlerts({ limit: AUTOMATIC_ALERT_LIMIT, offset: 0 });
      setAlerts(alertsResponse.items.map(oneViewAlertToLegacyAlert));
      setAlertsMeta({ source: alertsResponse.data_source, checkedAt: alertsResponse.checked_at });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao carregar alertas";
      toast.error(message);
    } finally {
      endLoad();
    }
  }, [beginLoad, endLoad]);

  const loadData = useCallback(async () => {
    await Promise.all([loadSummaryAndSources(), loadAlerts()]);
  }, [loadAlerts, loadSummaryAndSources]);

  useEffect(() => {
    const summaryTimer = window.setInterval(() => void loadSummaryAndSources(), SUMMARY_REFRESH_MS);
    const alertsTimer = window.setInterval(() => void loadAlerts(), ALERTS_REFRESH_MS);

    return () => {
      window.clearInterval(summaryTimer);
      window.clearInterval(alertsTimer);
    };
  }, [loadAlerts, loadSummaryAndSources]);

  const currentDataSource = effectiveDataSource(
    healthMeta.source,
    sourcesMeta.source,
    alertsMeta.source,
    metricsMeta.source,
    syncMeta.source,
  );
  const lastCheckedAt = latestCheckedAt(
    healthMeta.checkedAt,
    sourcesMeta.checkedAt,
    alertsMeta.checkedAt,
    metricsMeta.checkedAt,
    syncMeta.checkedAt,
  );

  const filteredAlerts = useMemo(() => {
    if (selectedClient === "all" || (Array.isArray(selectedClient) && selectedClient.includes("all"))) {
      return alerts;
    }

    const sel = Array.isArray(selectedClient) ? selectedClient : [selectedClient];
    return alerts.filter((alert) => alert.clientId && sel.includes(alert.clientId));
  }, [alerts, selectedClient]);

  const selectedClientName = useMemo(() => {
    if (selectedClient === "all") return "Todos os clientes";
    const sel = Array.isArray(selectedClient) ? selectedClient : [selectedClient];
    const names = sel
      .map((id) => clients.find((client) => client.id === id)?.name ?? id)
      .filter(Boolean);
    return names.length === 1 ? names[0] : `${names[0]} (+${names.length - 1})`;
  }, [clients, selectedClient]);

  const dashboardAlerts = useMemo(() => {
    const nonResolved = filteredAlerts.filter((alert) => alert.status !== "Resolved");
    return nonResolved.length > 0 ? nonResolved : filteredAlerts;
  }, [filteredAlerts]);

  const [visibleSeverities, setVisibleSeverities] = useState<Severity[]>(["Critical", "High", "Average"]);

  const dashboardAlertsFiltered = useMemo(() => {
    const filtered = dashboardAlerts.filter((alert) => visibleSeverities.includes(alert.severity));
    return filtered.sort((a, b) => (SEVERITY_PRIORITY[a.severity] ?? 99) - (SEVERITY_PRIORITY[b.severity] ?? 99));
  }, [dashboardAlerts, visibleSeverities]);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const container = alertsContainerRef.current;
    if (!container) return;

    setVisibleAlertCount(null);

    let attempts = 0;
    const maxAttempts = 5;
    let frameId = 0;

    const doMeasure = () => {
      attempts += 1;
      const list = container.querySelector("ul");
      const firstItem = list?.querySelector("li");
      const topbarEl = document.querySelector("section.sticky");
      const topbarH = topbarEl ? topbarEl.getBoundingClientRect().height : 0;
      const healthH = healthRowRef.current ? healthRowRef.current.getBoundingClientRect().height : 0;
      const summaryH = sourceSummaryRef.current ? sourceSummaryRef.current.getBoundingClientRect().height : 0;
      const available = Math.max(0, window.innerHeight - topbarH - healthH - summaryH - 48);
      const itemHeight = firstItem?.getBoundingClientRect().height ?? 0;

      if (list && firstItem && available > 0 && itemHeight > 0) {
        const listStyles = window.getComputedStyle(list);
        const gapValue = parseFloat(listStyles.rowGap || listStyles.gap || "0") || 0;
        const maxByHeight = Math.floor((available - 4 + gapValue) / (itemHeight + gapValue));
        const boundedCount = Math.max(1, Number.isFinite(maxByHeight) ? maxByHeight : 1);
        setVisibleAlertCount(Math.min(dashboardAlertsFiltered.length, boundedCount));
        return true;
      }

      if (attempts < maxAttempts) {
        frameId = window.requestAnimationFrame(doMeasure);
        return false;
      }

      setVisibleAlertCount((prev) => prev ?? Math.max(1, dashboardAlertsFiltered.length));
      return true;
    };

    frameId = window.requestAnimationFrame(() => {
      doMeasure();
    });

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [dashboardAlertsFiltered.length]);

  const alertsToRender = useMemo(() => {
    if (visibleAlertCount === null) return dashboardAlertsFiltered;
    return dashboardAlertsFiltered.slice(0, visibleAlertCount);
  }, [dashboardAlertsFiltered, visibleAlertCount]);

  const healthCards = useMemo(() => {
    const scope = selectedClient === "all" ? "Geral" : selectedClientName;
    const criticalCount = filteredAlerts.filter((alert) => alert.severity === "Critical").length;
    const highCount = filteredAlerts.filter((alert) => alert.severity === "High").length;
    const pendingCount = filteredAlerts.filter((alert) => alert.status === "Active").length;
    const metricSeverity = metrics?.by_severity.reduce<Record<string, number>>((acc, item) => {
      acc[item.severity] = item.count;
      return acc;
    }, {}) ?? {};
    const activeTotal = selectedClient === "all" ? metrics?.active_total ?? pendingCount : pendingCount;
    const disasterTotal = selectedClient === "all" ? metricSeverity.disaster ?? criticalCount : criticalCount;
    const highTotal = selectedClient === "all" ? metricSeverity.high ?? highCount : highCount;
    const sourceCount = dataSources.filter((source) => source.sync_enabled && source.status === "active").length;
    const failedSources = dataSources.filter((source) => source.status === "error").length;
    const totalAlerts = health?.counts.total_alerts ?? metrics?.alerts_total ?? activeTotal;

    return [
      { title: "Alertas sincronizados", status: totalAlerts.toLocaleString("pt-BR"), icon: <Wifi className="h-5 w-5 text-primary" /> },
      { title: "Alertas carregados", status: alerts.length.toLocaleString("pt-BR"), icon: <Database className="h-5 w-5 text-primary" /> },
      { title: "Alertas ativos", status: activeTotal.toLocaleString("pt-BR"), icon: <Activity className="h-5 w-5 text-primary" /> },
      { title: "Críticos / Alta", status: (disasterTotal + highTotal).toLocaleString("pt-BR"), icon: <AlertTriangle className="h-5 w-5 text-primary" /> },
      {
        title: "Fontes de dados ativas",
        status: `${sourceCount}/${dataSources.length}`,
        icon: <RefreshCcw className="h-5 w-5 text-primary" />,
      },
      {
        title: "Fontes de dados com erro",
        status: String(failedSources),
        icon: <Shield className="h-5 w-5 text-primary" />,
      },
      { title: "Dados atualizados", status: lastCheckedAt ? formatDateTime(lastCheckedAt) : "consultando...", icon: <Server className="h-5 w-5 text-primary" /> },
    ].map((card) => ({ ...card, scope }));
  }, [alerts.length, dataSources, filteredAlerts, health, lastCheckedAt, metrics, selectedClient, selectedClientName]);

  const alertCountByDataSource = useMemo(() => {
    return alerts.reduce<Record<string, number>>((acc, alert) => {
      if (!alert.clientId) return acc;
      acc[alert.clientId] = (acc[alert.clientId] ?? 0) + 1;
      return acc;
    }, {});
  }, [alerts]);

  const internalSourceSummaries = useMemo(() => {
    return dataSources
      .filter((source) => source.environment === "internal")
      .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name))
      .map((source) => ({
        ...source,
        alertCount: source.alerts_count ?? alertCountByDataSource[source.id] ?? 0,
        syncLabel: source.last_sync_status === "success"
          ? `sucesso · ${source.alerts_count ?? alertCountByDataSource[source.id] ?? 0} alertas`
          : source.last_sync_status === "failed"
            ? `falha · ${source.pending_reason ?? source.last_sync_error ?? source.last_error ?? "pendência registrada"}`
            : source.last_sync_status === "running" ? "em execução" : source.last_sync_status || "não testado",
      }));
  }, [alertCountByDataSource, dataSources]);

  return (
    <AppLayout
      clientSelect={
        <ClientSelect
          clients={clients}
          selectedClient={selectedClient}
          onClientChange={setSelectedClient}
        />
      }
      onRefresh={loadData}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      dataSource={currentDataSource}
      checkedAt={lastCheckedAt}
    >
      <div className="flex flex-col gap-6">
        <section
          ref={healthRowRef}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-7"
        >
          {healthCards.map((card) => (
            <Card key={card.title} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                  <p className="text-sm text-muted-foreground/90">{card.status}</p>
                </div>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">{card.icon}</div>
              </div>
            </Card>
          ))}
        </section>

        <Card ref={sourceSummaryRef} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">Clientes Zabbix internos</h2>
              <p className="text-sm text-muted-foreground">
                {`${metrics?.active_total ?? alerts.length} alertas ativos no OneView. Normalização média: ${formatMetricDuration(metrics?.avg_normalization_time_seconds)}.`}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={loadData} disabled={isLoading}>
              {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Recarregar visualização
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {internalSourceSummaries.map((source) => (
              <div
                key={source.id}
                className="min-w-[130px] rounded-md border border-border/70 bg-muted/30 px-3 py-2"
                title={source.last_sync_error || undefined}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground">{formatDataSourceName(source.name)}</span>
                  <span className="text-base font-semibold text-primary">{source.alertCount}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{source.syncLabel}</p>
              </div>
            ))}
          </div>
          {syncLogs.length > 0 ? (
            <div className="mt-4 border-t border-border/60 pt-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Últimas sincronizações</h3>
              <div className="grid gap-2 lg:grid-cols-2">
                {syncLogs.map((log) => (
                  <div key={log.id} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{formatDataSourceName(log.datasource)}</span>
                      <span className={log.status === "success" ? "text-emerald-700" : "text-red-700"}>{log.status === "success" ? "sucesso" : log.status === "failed" ? "falha" : log.status}</span>
                      {log.fetched !== null ? <span>obtidos={log.fetched}</span> : null}
                      {log.upserted !== null ? <span>gravados={log.upserted}</span> : null}
                    </div>
                    <p className="mt-1 text-muted-foreground">{log.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <div className="flex flex-col gap-6 lg:flex-row lg:min-h-[360px]">
          <div className="flex w-full flex-col gap-6 lg:w-2/3 lg:min-h-0">
            <div className="flex min-h-0 flex-1 flex-col rounded-[10px] p-4">
              <header className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-semibold">Alertas</h2>
                <div className="flex items-center gap-2">
                  {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/alertas" className="text-sm font-medium">Ver todos</Link>
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="flex items-center gap-2">
                        <Filter className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-56">
                      <div className="flex flex-col gap-2">
                        {(["Critical", "High", "Average", "Info"] as const).map((severity) => (
                          <label key={severity} className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={visibleSeverities.includes(severity)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setVisibleSeverities((prev) => Array.from(new Set([...prev, severity])));
                                  } else {
                                    setVisibleSeverities((prev) => prev.filter((item) => item !== severity));
                                  }
                                }}
                              />
                              <span className="text-sm">{severity}</span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </header>
              <div ref={alertsContainerRef} className="min-h-0 flex-1">
                <AlertsList
                  alerts={visibleAlertCount === null ? dashboardAlertsFiltered.slice(0, 0) : alertsToRender}
                  sampleNeeded={visibleAlertCount === null}
                />
              </div>
            </div>
          </div>

          <div className="hidden items-center lg:flex"><div className="h-full w-px rounded-full bg-border/60" aria-hidden /></div>

          <div className="flex w-full flex-col gap-6 lg:w-1/3 lg:min-h-0">
            <div className="flex min-h-0 flex-1 flex-col rounded-[10px] p-4">
              <header className="flex items-center justify-between pb-4">
                <h2 className="text-xl font-semibold">Chamados</h2>
                <Button variant="ghost" size="sm" disabled>
                  Ver todos
                </Button>
              </header>
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Integração de chamados não disponível na visão atual.</p>
                <p>Este painel consolida os alertas operacionais persistidos pelo OneView.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function effectiveDataSource(...sources: Array<OneViewDataSourceKind | undefined>): OneViewDataSourceKind | null {
  if (sources.includes("snapshot")) return "snapshot";
  if (sources.includes("database")) return "database";
  return null;
}

function latestCheckedAt(...values: Array<string | undefined>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "data indisponível"
    : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
