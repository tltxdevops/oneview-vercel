import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  HeartPulse,
  Loader2,
  RefreshCcw,
  Server,
  ShieldAlert,
  Siren,
  UserCheck,
  WifiOff,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AlertMetrics,
  AttentionRequiredResponse,
  DataSource,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewFacetsResponse,
  OneViewHealthResponse,
  OneViewSyncLog,
  OperationsHealthResponse,
  fetchAlertMetrics,
  fetchAlerts,
  fetchAttentionRequired,
  fetchDataSourcesWithMeta,
  fetchOneViewFacets,
  fetchOneViewHealth,
  fetchOperationsHealth,
  fetchSyncLogs,
  formatDurationSeconds,
} from "@/lib/oneview-api";
import { Client } from "@/types";
import { toast } from "sonner";

const SUMMARY_REFRESH_MS = 60_000;
const RECENT_REFRESH_MS = 120_000;
const RECENT_LIMIT = 8;

type ResourceMeta = { source?: OneViewDataSourceKind; checkedAt?: string };

const customerLogos: Array<{ aliases: string[]; src: string }> = [
  { aliases: ["castrolanda"], src: "/tltx/clientes/logos/castrolanda-logo.png" },
  { aliases: ["fps"], src: "/tltx/clientes/logos/fps-logo.png" },
  { aliases: ["fraport"], src: "/tltx/clientes/logos/fraport-logo.png" },
  { aliases: ["havan"], src: "/tltx/clientes/logos/havan-logo.png" },
  { aliases: ["osasco"], src: "/tltx/clientes/logos/osasco-logo.png" },
  { aliases: ["teletex"], src: "/tltx/clientes/logos/teletex-logo.png" },
  { aliases: ["tuper"], src: "/tltx/clientes/logos/tuper-logo.png" },
  { aliases: ["zurich"], src: "/tltx/clientes/logos/zurich-logo.png" },
];

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function logoForCustomer(key: string, name: string) {
  const value = normalized(`${key} ${name}`);
  return customerLogos.find((item) => item.aliases.some((alias) => value.includes(alias)))?.src ?? "";
}

function safeCustomerName(value?: string | null) {
  const name = String(value || "").trim();
  return name && normalized(name) !== "cliente nao classificado" ? name : "Cliente não identificado";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Aguardando consulta";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Aguardando consulta" : date.toLocaleString("pt-BR");
}

function relativeTime(value?: string | null) {
  if (!value) return "horário indisponível";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "horário indisponível"
    : formatDistanceToNow(date, { addSuffix: true, locale: ptBR });
}

function severityLabel(value: string) {
  if (value === "disaster") return "Crítico";
  if (value === "high") return "Alto";
  if (value === "average") return "Médio";
  return "Baixo";
}

function severityTone(value: string) {
  if (value === "disaster") return "border-red-500 bg-red-100 text-red-950";
  if (value === "high") return "border-red-200 bg-red-50 text-red-700";
  if (value === "average") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function effectiveDataSource(...sources: Array<OneViewDataSourceKind | undefined>): OneViewDataSourceKind | null {
  if (sources.includes("snapshot")) return "snapshot";
  if (sources.includes("database")) return "database";
  return null;
}

function latestCheckedAt(...values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export default function Index() {
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [operations, setOperations] = useState<OperationsHealthResponse | null>(null);
  const [attention, setAttention] = useState<AttentionRequiredResponse | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [syncLogs, setSyncLogs] = useState<OneViewSyncLog[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<OneViewAlert[]>([]);
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [isRecentLoading, setIsRecentLoading] = useState(true);
  const [metas, setMetas] = useState<ResourceMeta[]>([]);
  const [recentMeta, setRecentMeta] = useState<ResourceMeta>({});
  const summaryInFlight = useRef<Promise<void> | null>(null);
  const recentRequest = useRef<AbortController | null>(null);

  const selectedCustomerKeys = useMemo(() => {
    const values = Array.isArray(selectedClient) ? selectedClient : [selectedClient];
    return values.filter((value) => value !== "all");
  }, [selectedClient]);

  const clients = useMemo<Client[]>(() => [
    { id: "all", name: "TODOS", logo: "" },
    ...(facets?.customers ?? []).map((customer) => {
      const name = customer.key === "unclassified" ? "Não identificado" : safeCustomerName(customer.name);
      return { id: customer.key, name, logo: logoForCustomer(customer.key, name) };
    }),
  ], [facets?.customers]);

  const selectedClientLabel = useMemo(() => {
    if (!selectedCustomerKeys.length) return "Todos os clientes";
    const names = selectedCustomerKeys.map((key) => clients.find((client) => client.id === key)?.name ?? key);
    return names.length === 1 ? names[0] : `${names.length} clientes`;
  }, [clients, selectedCustomerKeys]);

  const loadSummary = useCallback(() => {
    if (summaryInFlight.current) return summaryInFlight.current;
    setIsSummaryLoading(true);
    const request = (async () => {
      const [healthResponse, operationsResponse, sourcesResponse, metricsResponse, syncResponse, facetsResponse, attentionResponse] = await Promise.all([
        fetchOneViewHealth(),
        fetchOperationsHealth(),
        fetchDataSourcesWithMeta(),
        fetchAlertMetrics(),
        fetchSyncLogs(20),
        fetchOneViewFacets(),
        fetchAttentionRequired(100),
      ]);
      setHealth(healthResponse);
      setOperations(operationsResponse);
      setDataSources(sourcesResponse.items);
      setMetrics(metricsResponse);
      setSyncLogs(syncResponse.items);
      setFacets(facetsResponse);
      setAttention(attentionResponse);
      setMetas([
        { source: healthResponse.data_source, checkedAt: healthResponse.checked_at },
        { source: operationsResponse.data_source, checkedAt: operationsResponse.checked_at },
        { source: sourcesResponse.data_source, checkedAt: sourcesResponse.checked_at },
        { source: metricsResponse.data_source, checkedAt: metricsResponse.checked_at },
        { source: syncResponse.data_source, checkedAt: syncResponse.checked_at },
        { source: facetsResponse.data_source, checkedAt: facetsResponse.checked_at },
        { source: attentionResponse.data_source, checkedAt: attentionResponse.checked_at },
      ]);
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar a visão operacional.");
    }).finally(() => {
      setIsSummaryLoading(false);
      summaryInFlight.current = null;
    });
    summaryInFlight.current = request;
    return request;
  }, []);

  const loadRecent = useCallback(async () => {
    recentRequest.current?.abort();
    const controller = new AbortController();
    recentRequest.current = controller;
    setIsRecentLoading(true);
    try {
      const response = await fetchAlerts({
        page: 1,
        pageSize: RECENT_LIMIT,
        status: "active",
        customers: selectedCustomerKeys,
        severities: ["disaster", "high"],
        sort: "first_seen_at",
        order: "desc",
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setRecentAlerts(response.items);
        setRecentMeta({ source: response.data_source, checkedAt: response.checked_at });
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "Não foi possível carregar alertas recentes.");
    } finally {
      if (!controller.signal.aborted) setIsRecentLoading(false);
    }
  }, [selectedCustomerKeys]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadRecent()]);
  }, [loadRecent, loadSummary]);

  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => {
    void loadRecent();
    return () => recentRequest.current?.abort();
  }, [loadRecent]);
  useEffect(() => {
    const summaryTimer = window.setInterval(() => { if (!document.hidden) void loadSummary(); }, SUMMARY_REFRESH_MS);
    const recentTimer = window.setInterval(() => { if (!document.hidden) void loadRecent(); }, RECENT_REFRESH_MS);
    return () => {
      window.clearInterval(summaryTimer);
      window.clearInterval(recentTimer);
    };
  }, [loadRecent, loadSummary]);

  const severityCounts = Object.fromEntries((metrics?.by_severity ?? []).map((item) => [item.severity, item.count]));
  const criticalHigh = (severityCounts.disaster ?? 0) + (severityCounts.high ?? 0);
  const operationalSources = operations?.summary.healthy ?? 0;
  const errorSources = (operations?.summary.error ?? 0) + (operations?.summary.stale ?? 0);
  const lastCheckedAt = latestCheckedAt(...metas.map((meta) => meta.checkedAt), recentMeta.checkedAt);
  const currentDataSource = effectiveDataSource(...metas.map((meta) => meta.source), recentMeta.source);
  const staleMinutes = health?.thresholds?.alert_stale_minutes ?? 15;
  const operationsBySource = new Map((operations?.items ?? []).map((item) => [item.name.toLowerCase(), item]));

  const operationalCards = [
    { label: "Alertas ativos", value: metrics?.active_total ?? health?.counts.active_alerts ?? 0, icon: Activity, tone: "bg-amber-100 text-amber-700" },
    { label: "Críticos / Altos", value: criticalHigh, icon: ShieldAlert, tone: "bg-red-100 text-red-800" },
    { label: "Não reconhecidos na origem", value: metrics?.unacknowledged_total ?? 0, icon: AlertTriangle, tone: "bg-yellow-100 text-yellow-700" },
    { label: "Resolvidos hoje", value: metrics?.resolved_today ?? 0, icon: CheckCircle2, tone: "bg-emerald-100 text-emerald-700" },
    { label: "Atenção necessária", value: attention?.summary.total ?? 0, icon: Siren, tone: "bg-red-50 text-red-700" },
  ];

  const healthCards = [
    { label: "Banco em tempo real", value: currentDataSource === "database" && health?.database_reachable ? "Operacional" : "Cópia de contingência", icon: Database },
    { label: "Worker", value: operations?.worker.status === "healthy" ? "Operacional" : operations?.worker.status === "stale" ? "Sem atividade recente" : "Em validação", icon: Server },
    { label: "Fontes operacionais", value: `${operationalSources}/${operations?.summary.total ?? dataSources.length}`, icon: HeartPulse },
    { label: "Fontes com erro", value: String(errorSources), icon: WifiOff },
    { label: "Última atualização", value: formatDateTime(lastCheckedAt), icon: RefreshCcw },
  ];

  const topCustomers = (facets?.customers ?? []).slice(0, 4);
  const newestSyncBySource = [...syncLogs]
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))
    .filter((log, index, list) => list.findIndex((item) => item.datasource === log.datasource) === index);

  const freshnessFor = (alert: OneViewAlert) => {
    if (alert.resolved_at || alert.status_source === "resolved") return { label: "Resolvido", tone: "text-emerald-700" };
    const source = operationsBySource.get((alert.datasource_name || "").toLowerCase());
    if (source?.operational_status === "error" || source?.operational_status === "stale") {
      return { label: "Dados possivelmente desatualizados", tone: "text-red-700" };
    }
    const lastSeen = Date.parse(alert.last_seen_at || "");
    const minutes = Number.isNaN(lastSeen) ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((Date.now() - lastSeen) / 60_000));
    return minutes <= staleMinutes
      ? { label: "Ativo e confirmado recentemente", tone: "text-emerald-700" }
      : { label: "Ativo, mas sem confirmação recente", tone: "text-amber-700" };
  };

  return (
    <AppLayout
      clientSelect={<ClientSelect clients={clients} selectedClient={selectedClient} onClientChange={setSelectedClient} />}
      onRefresh={refreshAll}
      enableAutoRefresh={false}
      showRefreshMeta={false}
    >
      <div className="space-y-4">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Visão operacional</h1>
            <p className="text-sm text-muted-foreground">Estado atual do ambiente OneView</p>
          </div>
          {(isSummaryLoading || isRecentLoading) ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </header>

        <section aria-label="Linha operacional" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {operationalCards.map(({ label, value, icon: Icon, tone }) => (
            <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{Number(value).toLocaleString("pt-BR")}</p></div>
                <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", tone)}><Icon className="h-4 w-4" /></span>
              </div>
            </Card>
          ))}
        </section>

        <section aria-label="Saúde operacional" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {healthCards.map(({ label, value, icon: Icon }) => (
            <Card key={label} className="rounded-[10px] border border-border/70 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span><div className="min-w-0"><p className="text-[11px] text-muted-foreground">{label}</p><p className="truncate text-sm font-semibold">{value}</p></div></div>
            </Card>
          ))}
        </section>

        <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
          <div className="text-center">
            <h2 className="text-base font-semibold">Últimas sincronizações</h2>
            <p className="text-xs text-muted-foreground">Situação mais recente por fonte</p>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {newestSyncBySource.map((log) => (
              <div key={log.id} className="w-full min-w-44 max-w-64 rounded-[10px] border border-border/70 bg-muted/15 px-3 py-2 sm:w-auto sm:flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{log.datasource}</p>
                  <Badge variant="outline" className={cn("text-[10px]", log.status === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}>
                    {log.status === "success" ? "Sucesso" : "Falha"}
                  </Badge>
                </div>
                <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><Clock3 className="h-3 w-3" />{relativeTime(log.created_at)}</p>
              </div>
            ))}
            {!newestSyncBySource.length ? <p className="py-3 text-sm text-muted-foreground">Aguardando sincronizações.</p> : null}
          </div>
        </Card>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)]">
          <Card className="rounded-[10px] border border-border/70 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Alertas recentes</h2>
                <p className="text-xs text-muted-foreground">Novos críticos e altos por primeira ocorrência · {selectedClientLabel}</p>
              </div>
              <Button variant="ghost" size="sm" asChild><Link to="/alertas">Ver todos</Link></Button>
            </div>
            <div className="mt-3 divide-y divide-border/60">
              {recentAlerts.map((alert) => {
                const freshness = freshnessFor(alert);
                const ackAvailable = health?.capabilities?.acknowledgement === true
                  && normalized(alert.datasource_name || "") === "teletex-http"
                  && !alert.acknowledged_internal;
                const alertHref = `/alertas?alert=${encodeURIComponent(alert.id)}`;
                return (
                  <div key={alert.id} className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={cn("text-[10px]", severityTone(alert.severity))}>{severityLabel(alert.severity)}</Badge>
                        <span className="text-xs font-semibold">{safeCustomerName(alert.customer_name)}</span>
                        <span className="text-[11px] text-muted-foreground">{alert.datasource_name || "Fonte não identificada"}</span>
                        <span className="text-[11px] text-muted-foreground">{relativeTime(alert.first_seen_at)}</span>
                      </div>
                      <p className="mt-1 truncate text-sm font-semibold">{alert.host_visible_name || alert.host_technical_name || "Host não identificado"}</p>
                      <p className="truncate text-xs text-muted-foreground">{alert.problem_name}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                        <span>Duração: {formatDurationSeconds(alert.duration_seconds)}</span>
                        <span>Atualizado: {relativeTime(alert.last_seen_at)}</span>
                        <span className={cn("font-medium", freshness.tone)}>{freshness.label}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Ver detalhes do alerta">
                        <Link to={alertHref} aria-label="Ver detalhes do alerta"><Eye className="h-4 w-4" /></Link>
                      </Button>
                      {ackAvailable ? (
                        <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" asChild title="Reconhecer no OneView">
                          <Link to={alertHref}>ACK</Link>
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled title="Aguardando liberação operacional.">ACK</Button>
                      )}
                      <Button variant="outline" size="icon" className="h-8 w-8" disabled title="Atribuição operacional em preparação." aria-label="Atribuir alerta">
                        <UserCheck className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!recentAlerts.length && !isRecentLoading ? <p className="py-8 text-center text-sm text-muted-foreground">Nenhum alerta crítico ou alto novo para o escopo selecionado.</p> : null}
            </div>
          </Card>

          <div className="space-y-4">
            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700"><Siren className="h-5 w-5" /></span>
                <div><h2 className="text-base font-semibold">Atenção necessária</h2><p className="text-xs text-muted-foreground">Ativos sem ACK na origem acima do limite.</p></div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  ["Crítico", attention?.summary.disaster ?? 0, attention?.thresholds.disaster_minutes ?? 5, "border-red-300 bg-red-50 text-red-800"],
                  ["Alto", attention?.summary.high ?? 0, attention?.thresholds.high_minutes ?? 15, "border-red-200 bg-red-50 text-red-700"],
                  ["Médio", attention?.summary.average ?? 0, attention?.thresholds.average_minutes ?? 30, "border-amber-200 bg-amber-50 text-amber-700"],
                ].map(([label, count, minutes, tone]) => (
                  <div key={String(label)} className={cn("rounded-[10px] border px-2.5 py-2", tone)}>
                    <p className="text-[9px] font-semibold uppercase">{label}</p>
                    <p className="text-lg font-semibold">{Number(count).toLocaleString("pt-BR")}</p>
                    <p className="text-[9px]">+ {minutes} min</p>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid gap-2">
                <div className="rounded-[10px] border border-border/70 bg-muted/20 p-2.5"><p className="text-xs font-semibold">Fontes com erro</p><p className="text-xs text-muted-foreground">{operations?.summary.error ? `${operations.summary.error} fonte(s) exigem verificação.` : "Nenhuma fonte em erro."}</p></div>
                <div className="rounded-[10px] border border-border/70 bg-muted/20 p-2.5"><p className="text-xs font-semibold">Dados potencialmente desatualizados</p><p className="text-xs text-muted-foreground">{operations?.summary.stale ? `${operations.summary.stale} fonte(s) sem atividade recente.` : "Nenhuma fonte sem atividade recente."}</p></div>
              </div>
            </Card>

            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold">Clientes com mais alertas</h2>
              <div className="mt-3 space-y-3">
                {topCustomers.map((customer, index) => {
                  const name = customer.key === "unclassified" ? "Cliente não identificado" : safeCustomerName(customer.name);
                  const maximum = Math.max(topCustomers[0]?.alerts_count ?? 1, 1);
                  return <div key={customer.key} className="space-y-1"><div className="flex items-center justify-between gap-3 text-sm"><span className="flex min-w-0 items-center gap-2"><span className="text-xs text-muted-foreground">{index + 1}</span>{logoForCustomer(customer.key, name) ? <img src={logoForCustomer(customer.key, name)} alt="" className="h-6 w-6 rounded border border-border/50 bg-white object-contain p-0.5" /> : null}<span className="truncate font-medium">{name}</span></span><span className="font-semibold">{customer.alerts_count.toLocaleString("pt-BR")}</span></div><div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (customer.alerts_count / maximum) * 100)}%` }} /></div></div>;
                })}
                {!topCustomers.length ? <p className="text-sm text-muted-foreground">Aguardando dados dos clientes.</p> : null}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
