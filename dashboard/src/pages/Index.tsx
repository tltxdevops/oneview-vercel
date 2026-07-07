import { useMemo, useState, useLayoutEffect, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { AlertsList } from "@/components/alerts/AlertsList";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Activity, AlertTriangle, Cloud, Database, RefreshCcw, Server, Wifi, Shield, Filter, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Link } from "react-router-dom";
import {
  DataSource,
  AlertMetrics,
  dataSourcesToClients,
  fetchAllAlerts,
  fetchAlertMetrics,
  fetchDataSources,
  oneViewAlertToLegacyAlert,
} from "@/lib/oneview-api";
import { Alert, Severity } from "@/types";
import { toast } from "sonner";
import { isSnapshotMode as isDemoMode } from "@/lib/demo-mode";
import {
  SNAPSHOT_EXPORTED_ALERTS,
  SNAPSHOT_LAST_UPDATED_AT,
  SNAPSHOT_SUMMARY,
  SNAPSHOT_TOTAL_ALERTS,
  demoSyncLogs,
} from "@/lib/demo-oneview-data";
import { cn } from "@/lib/utils";

const LOCAL_REFRESH_MS = 30_000;
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
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [isLoading, setIsLoading] = useState(false);
  const alertsContainerRef = useRef<HTMLDivElement | null>(null);
  const [visibleAlertCount, setVisibleAlertCount] = useState<number | null>(null);
  const healthRowRef = useRef<HTMLDivElement | null>(null);
  const sourceSummaryRef = useRef<HTMLDivElement | null>(null);

  const clients = useMemo(() => dataSourcesToClients(dataSources), [dataSources]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [sources, alertsResponse, metricsResponse] = await Promise.all([
        fetchDataSources(),
        fetchAllAlerts(),
        fetchAlertMetrics(),
      ]);
      setDataSources(sources);
      setAlerts(alertsResponse.items.map(oneViewAlertToLegacyAlert));
      setMetrics(metricsResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao carregar dados reais";
      toast.error(message);
      setAlerts([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadData();
    }, LOCAL_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [loadData]);

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
    const unacknowledged = selectedClient === "all"
      ? metrics?.unacknowledged_total ?? filteredAlerts.filter((alert) => alert.status === "Active").length
      : filteredAlerts.filter((alert) => alert.status === "Active").length;
    const sourceCount = dataSources.filter((source) => source.sync_enabled && source.status === "active").length;
    const failedSources = dataSources.filter((source) => source.last_sync_status === "failed" || source.last_sync_status === "test_failed").length;
    const integrationStatus = `${sourceCount} fonte${sourceCount === 1 ? "" : "s"} ativa${sourceCount === 1 ? "" : "s"}${
      failedSources > 0 ? `, ${failedSources} pendência${failedSources === 1 ? "" : "s"}` : ""
    }`;

    if (isDemoMode) {
      return [
        { title: "Alertas sincronizados", status: SNAPSHOT_TOTAL_ALERTS.toLocaleString("pt-BR"), icon: <Wifi className="h-5 w-5 text-primary" /> },
        { title: "Alertas exportados", status: SNAPSHOT_EXPORTED_ALERTS.toLocaleString("pt-BR"), icon: <Database className="h-5 w-5 text-primary" /> },
        { title: "Alertas ativos", status: String(activeTotal), icon: <Activity className="h-5 w-5 text-primary" /> },
        { title: "Críticos / High", status: String(disasterTotal + highTotal), icon: <AlertTriangle className="h-5 w-5 text-primary" /> },
        {
          title: "Datasources ativas",
          status: `${SNAPSHOT_SUMMARY.datasources_active}/${SNAPSHOT_SUMMARY.datasources_total}`,
          icon: <RefreshCcw className="h-5 w-5 text-primary" />,
        },
        {
          title: "Datasources com erro",
          status: String(SNAPSHOT_SUMMARY.datasources_error),
          icon: <Shield className="h-5 w-5 text-primary" />,
        },
        { title: "Snapshot atualizado", status: formatSnapshotDate(SNAPSHOT_LAST_UPDATED_AT), icon: <Server className="h-5 w-5 text-primary" /> },
      ].map((card) => ({ ...card, scope }));
    }

    return [
      { title: "Rede", status: `${activeTotal} alertas ativos`, icon: <Wifi className="h-5 w-5 text-primary" /> },
      { title: "Nuvem", status: `${disasterTotal} desastres`, icon: <Cloud className="h-5 w-5 text-primary" /> },
      { title: "Servidores", status: `${highTotal} alta severidade`, icon: <Server className="h-5 w-5 text-primary" /> },
      { title: "Banco de dados", status: integrationStatus, icon: <Database className="h-5 w-5 text-primary" /> },
      {
        title: "Reconhecimento",
        status: isDemoMode
          ? `${unacknowledged} pendentes, ACK desabilitado`
          : `${unacknowledged} pendentes, TMR ${formatMetricDuration(metrics?.avg_ack_time_seconds)}`,
        icon: <Shield className="h-5 w-5 text-primary" />,
      },
    ].map((card) => ({ ...card, scope }));
  }, [dataSources, filteredAlerts, metrics, selectedClient, selectedClientName]);

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
          ? `success · ${source.alerts_count ?? alertCountByDataSource[source.id] ?? 0} alertas`
          : source.last_sync_status === "failed"
            ? `failed · ${source.pending_reason ?? source.last_sync_error ?? source.last_error ?? "pendência registrada"}`
            : source.last_sync_status || "não testado",
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
      showRefreshMeta={false}
    >
      <div className="flex flex-col gap-6">
        <section
          ref={healthRowRef}
          className={cn("grid grid-cols-1 gap-3", isDemoMode ? "sm:grid-cols-2 xl:grid-cols-7" : "sm:grid-cols-5")}
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
                {isDemoMode
                  ? `${SNAPSHOT_TOTAL_ALERTS.toLocaleString("pt-BR")} alertas sincronizados; ${SNAPSHOT_EXPORTED_ALERTS.toLocaleString("pt-BR")} alertas ativos recentes no snapshot atualizado.`
                  : `${metrics?.active_total ?? alerts.length} alertas ativos no OneView. Normalização média: ${formatMetricDuration(metrics?.avg_normalization_time_seconds)}.`}
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
          {isDemoMode ? (
            <div className="mt-4 border-t border-border/60 pt-4">
              <h3 className="mb-2 text-sm font-semibold text-foreground">Últimas sincronizações</h3>
              <div className="grid gap-2 lg:grid-cols-2">
                {demoSyncLogs.map((log) => (
                  <div key={log.id} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{formatDataSourceName(log.datasource)}</span>
                      <span className={log.status === "success" ? "text-emerald-700" : "text-red-700"}>{log.status}</span>
                      {log.fetched !== null ? <span>fetched={log.fetched}</span> : null}
                      {log.upserted !== null ? <span>upserted={log.upserted}</span> : null}
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
                <p className="font-medium text-foreground">Integração de chamados não disponível no snapshot atual.</p>
                <p>Este painel consolida os alertas operacionais persistidos pelo OneView.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function formatSnapshotDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "data indisponível"
    : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
