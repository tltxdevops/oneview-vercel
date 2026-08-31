import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink, Eye, Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  ClientIdentity,
  CLASSIFICATION_PENDING_LABEL,
  canonicalHostName,
  facetCustomerDisplayName,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { ClientFilterCombobox, type ClientFilterOption } from "@/components/oneview/ClientFilterCombobox";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import { OperationalCta } from "@/components/oneview/OperationalCta";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { OperationalFilterGroup } from "@/components/oneview/OperationalFilterGroup";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { TruncatedText } from "@/components/oneview/TruncatedText";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import { OV_FILTER_CHIP, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  GlobalHistoryItem,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewIncident,
  OneViewSeverity,
  fetchAlert,
  fetchAlertHistory,
  fetchIncidentRelatedAlert,
  fetchOneViewFacets,
  fetchOperatorQueue,
  formatNullableCount,
  formatOneViewSeverityLabel,
  type OperatorQueueItem,
  type OperatorQueueResponse,
} from "@/lib/oneview-api";
import {
  DEFAULT_HOME_ALERT_MODE,
  HOME_ALERT_MODE,
  HOME_ALERTS_PAGE_SIZE,
  HOME_ALERT_STATUS_OPTIONS,
  HOME_EVENTS_LIMIT,
  HOME_INCIDENTS_PAGE_SIZE,
  HOME_OPERATIONAL_WINDOW_OPTIONS,
  HOME_SEVERITY_FILTER_OPTIONS,
  buildHomeAlertsHref,
  fetchHomeAlerts,
  fetchHomeIncidentStreams,
  homeOperationalWindowActiveLabel,
  homeOperationalWindowMs,
  parseHomeAlertMode,
  parseHomeOperationalWindow,
  toggleHomeSeverityFilter,
  type HomeAlertMode,
  type HomeAlertStatus,
  type HomeAlertSeverity,
  type HomeIncidentStreams,
  type HomeOperationalWindowPreset,
} from "@/lib/oneview-home";
import {
  RecentOperationalMetrics,
  fetchRecentOperationalEvents,
  fetchRecentOperationalMetrics,
  queueOverflowLabel,
} from "@/lib/oneview-recent";
import { toast } from "sonner";

const SUMMARY_REFRESH_MS = 10_000;
const LIST_REFRESH_MS = 10_000;

/** Ordem visual Home OV-P0-42A (sem Not classified — chip no mesmo bloco). */
const HOME_VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];

function formatMetricCount(value: number | null | undefined) {
  return formatNullableCount(value);
}

const HOME_EVENT_ALLOWLIST = new Set([
  "problem_created",
  "created_from_zabbix",
  "acknowledged",
  "ack_message",
  "severity_changed",
  "recovered",
  "maintenance",
  "suppressed",
  "unsuppressed",
]);

const HOME_EVENT_BLOCKLIST = /upsert|backfill|reconcil|retry|outbox|cache|payload|worker|sync_log|internal_acknowledged/i;

type ResourceMeta = { source?: OneViewDataSourceKind; checkedAt?: string };
type SectionKey = "summary" | "alerts" | "incidents" | "operators" | "events";
type HomeIncidentTab = "queue" | "in_progress" | "recent";

function safeActorName(value?: string | null) {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor;
}

function formatDateTime(value?: string | null) {
  if (!value) return "Aguardando consulta";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Aguardando consulta" : date.toLocaleString("pt-BR");
}

function formatClock(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

function latestCheckedAt(...values: Array<string | undefined | null>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function historyOrigin(item: AlertHistoryItem) {
  if (item.origin === "oneview_internal") return "OneView";
  if (item.legacy) return "Legado";
  return "Origem";
}

function isAllowedHomeEvent(item: GlobalHistoryItem) {
  const eventType = String(item.event_type || "").toLowerCase();
  if (!HOME_EVENT_ALLOWLIST.has(eventType)) return false;
  if (HOME_EVENT_BLOCKLIST.test(eventType)) return false;
  if (HOME_EVENT_BLOCKLIST.test(String(item.title || ""))) return false;
  if (HOME_EVENT_BLOCKLIST.test(String(item.description || ""))) return false;
  if (eventType === "resolved_by_reconciliation") return false;
  return true;
}

function homeEventLabel(eventType: string) {
  const value = eventType.toLowerCase();
  if (value === "problem_created" || value === "created_from_zabbix") return "Alerta identificado";
  if (value === "acknowledged") return "ACK";
  if (value === "ack_message") return "Comentário";
  if (value === "severity_changed") return "Mudança de severidade";
  if (value === "recovered") return "Recovery";
  if (value === "maintenance") return "Manutenção";
  if (value === "suppressed") return "Supressão";
  if (value === "unsuppressed") return "Fim da supressão";
  return "Evento operacional";
}

function displayIncidentField(value?: string | null, fallback?: string | null) {
  const primary = String(value || "").trim();
  if (primary && primary !== "undefined" && primary !== "null") return primary;
  const secondary = String(fallback || "").trim();
  if (secondary && secondary !== "undefined" && secondary !== "null") return secondary;
  return "—";
}

function incidentLoadErrorMessage(error: unknown) {
  if (error instanceof Error && error.message === "Sua sessão expirou. Entre novamente.") {
    return error.message;
  }
  return "Chamados indisponíveis";
}

/** OV-P0-73 / OV-P0-78 — classes compartilhadas dos painéis Home. */
const HOME_PANEL_HEADER_ASIDE = "inline-flex h-7 items-center gap-2";
const HOME_PANEL_COUNT = "text-xs font-medium tabular-nums text-muted-foreground";
const HOME_FILTER_ROW = "flex flex-wrap items-center gap-2 border-b border-border/60 py-1.5";
const HOME_LIST_DIVIDE = "divide-y divide-border/60";
const HOME_INCIDENT_TABS: Array<{ value: HomeIncidentTab; label: string }> = [
  { value: "queue", label: "Fila" },
  { value: "in_progress", label: "Em atendimento" },
  { value: "recent", label: "Recentes" },
];

function SectionState({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
  emptyClassName,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyMessage: string;
  onRetry?: () => void;
  emptyClassName?: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-1.5 py-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  if (error) {
    return <OperationalErrorBanner className="my-2" message={error} onRetry={onRetry} />;
  }
  if (empty) {
    return (
      <OperationalEmptyState
        compact
        title={emptyMessage}
        className={cn("px-3 py-6 text-xs", emptyClassName)}
      />
    );
  }
  return <>{children}</>;
}

function HomePanelCount({ value }: { value: number }) {
  return <span className={HOME_PANEL_COUNT}>{formatMetricCount(value)}</span>;
}

/** OV-P0-73 / OV-P0-111: cliente > host > problema > severidade + horário + duração. */
function HomeAlertRow({
  alert,
  onOpen,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
}) {
  const startedAt = alert.first_seen_at || alert.started_at;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 py-1.5 text-left transition-colors hover:bg-muted/30"
      onClick={() => onOpen(alert)}
      aria-label={`Abrir resumo de ${alert.problem_name || "alerta"}`}
    >
      <ClientIdentity
        customer={{ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source }}
        operationalScope={alert.operational_scope}
        operationalScopeLabel={alert.operational_scope_label}
        size="sm"
        className="shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <TruncatedText className="text-[13px] font-semibold leading-tight text-foreground">
          {operationalClientLabel({
            key: alert.customer_key,
            name: alert.customer_name,
            source: alert.customer_source,
            operational_scope: alert.operational_scope,
            operational_scope_label: alert.operational_scope_label,
          })}
        </TruncatedText>
        <TruncatedText className="text-[11px] leading-tight text-foreground/80">{canonicalHostName(alert)}</TruncatedText>
        {normalizeOperationalScope(alert.operational_scope) === "unknown" ? (
          <TruncatedText className="text-[10px] leading-tight text-muted-foreground">{CLASSIFICATION_PENDING_LABEL}</TruncatedText>
        ) : null}
        <TruncatedText className="text-[11px] leading-tight text-muted-foreground">{alert.problem_name}</TruncatedText>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <SeverityBadge severity={alert.severity} className="h-5 px-1.5" />
          <span
            className="text-[10px] font-medium tabular-nums text-foreground/80"
            title={startedAt ? `Início: ${formatDateTime(startedAt)}` : "Horário de início indisponível"}
          >
            {formatClock(startedAt)}
          </span>
          <span
            className="text-[10px] text-muted-foreground"
            title="Duração: há quanto tempo o alerta está ativo"
          >
            · {formatDurationSeconds(alert.duration_seconds)}
          </span>
        </div>
      </div>
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center self-center text-muted-foreground" aria-hidden="true">
        <Eye className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function HomeIncidentCard({
  item,
  onOpenRelatedAlert,
}: {
  item: OneViewIncident;
  onOpenRelatedAlert: (item: OneViewIncident) => void;
}) {
  const href = buildProductionServiceNowIncidentLink(item.sys_id);
  return (
    <article className="space-y-1.5 border-b border-border/50 py-2 last:border-b-0">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-foreground" title={displayIncidentField(item.number)}>
            {displayIncidentField(item.number)}
          </p>
          <p className="truncate text-[11px] text-foreground/80" title={displayIncidentField(item.company_display, item.company)}>
            {displayIncidentField(item.company_display, item.company)}
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground" title={formatDateTime(item.sys_updated_on)}>
          {formatClock(item.sys_updated_on)}
        </span>
      </div>
      <TruncatedText className="text-[11px] leading-tight text-muted-foreground">
        {displayIncidentField(item.short_description)}
      </TruncatedText>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{displayIncidentField(item.priority_display, item.priority)}</Badge>
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{displayIncidentField(item.state_display, item.state)}</Badge>
        <span className="text-[10px] text-muted-foreground">
          {item.assigned_to ? displayIncidentField(item.assigned_to_display, item.assigned_to) : "Sem responsável"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-medium">
        <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onOpenRelatedAlert(item)}>
          Abrir alerta no OneView
        </button>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
            Abrir chamado no ServiceNow <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function HomeOperatorRow({ item }: { item: OperatorQueueItem }) {
  const content = (
    <div className="min-w-0 space-y-0.5 py-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <TruncatedText className="text-[11px] font-semibold text-foreground">{displayIncidentField(item.customer_name)}</TruncatedText>
        <span className="shrink-0 text-[10px] text-muted-foreground">{item.updated_ago_label || "Atualização indisponível"}</span>
      </div>
      <TruncatedText className="text-[10px] text-muted-foreground">{displayIncidentField(item.operator_tag)}</TruncatedText>
      <p className="truncate text-[10px] text-muted-foreground">
        {item.incident_number || "Sem INC"} · {item.analyst_label || "Sem responsável"}
      </p>
    </div>
  );
  return item.oneview_link ? (
    <Link to={item.oneview_link} className="block rounded-sm px-1 transition-colors hover:bg-muted/40">{content}</Link>
  ) : <div className="px-1">{content}</div>;
}

export default function Index() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAlertId = searchParams.get("alert");
  const homeWindow = parseHomeOperationalWindow(searchParams.get("window"));
  const windowMs = homeOperationalWindowMs(homeWindow);

  const [alertMode, setAlertMode] = useState<HomeAlertMode>(DEFAULT_HOME_ALERT_MODE);
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [alertStatus, setAlertStatus] = useState<HomeAlertStatus>("active");
  const [selectedDatasources, setSelectedDatasources] = useState<string[]>([]);
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>([]);
  const [clientFilterOpen, setClientFilterOpen] = useState(false);
  const [customerOptions, setCustomerOptions] = useState<ClientFilterOption[]>([
    { key: "all", name: "Todos" },
  ]);
  const [datasourceOptions, setDatasourceOptions] = useState<Array<{ value: string; label: string }>>([
    { value: "all", label: "Todos" },
  ]);

  const [recentMetrics, setRecentMetrics] = useState<RecentOperationalMetrics | null>(null);
  const [homeAlerts, setHomeAlerts] = useState<OneViewAlert[]>([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [incidentStreams, setIncidentStreams] = useState<HomeIncidentStreams | null>(null);
  const [incidentTab, setIncidentTab] = useState<HomeIncidentTab>("queue");
  const [operatorQueue, setOperatorQueue] = useState<OperatorQueueResponse | null>(null);
  const [recentEvents, setRecentEvents] = useState<GlobalHistoryItem[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);

  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [isListsLoading, setIsListsLoading] = useState(true);
  const [isBackgroundUpdating, setIsBackgroundUpdating] = useState(false);
  const [metas, setMetas] = useState<ResourceMeta[]>([]);
  const [listsMeta, setListsMeta] = useState<ResourceMeta>({});
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<SectionKey, string>>>({});

  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<OneViewAlert | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const summaryInFlight = useRef<Promise<void> | null>(null);
  const listsRequest = useRef<AbortController | null>(null);
  const listsRequestIdRef = useRef(0);
  const hasSummaryRef = useRef(false);
  const hasListsRef = useRef(false);
  const quietUpdatesRef = useRef(0);
  const detailRequest = useRef<AbortController | null>(null);

  const beginQuietUpdate = useCallback(() => {
    quietUpdatesRef.current += 1;
    setIsBackgroundUpdating(true);
  }, []);

  const endQuietUpdate = useCallback(() => {
    quietUpdatesRef.current = Math.max(0, quietUpdatesRef.current - 1);
    if (quietUpdatesRef.current === 0) setIsBackgroundUpdating(false);
  }, []);

  const setSectionError = useCallback((key: SectionKey, message: string | null) => {
    setSectionErrors((current) => {
      const next = { ...current };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }, []);

  const setHomeWindow = useCallback((preset: HomeOperationalWindowPreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("window", parseHomeOperationalWindow(preset));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const raw = searchParams.get("window");
    const parsed = parseHomeOperationalWindow(raw);
    if (raw === parsed) return;
    const next = new URLSearchParams(searchParams);
    next.set("window", parsed);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const homeAlertsHref = useMemo(() => buildHomeAlertsHref({
    mode: alertMode,
    severity: severityFilter,
    customers: selectedCustomerKeys,
    datasources: selectedDatasources,
    status: alertStatus,
    windowPreset: homeWindow,
  }), [alertMode, alertStatus, homeWindow, selectedCustomerKeys, selectedDatasources, severityFilter]);

  /** OV-P0-103 — Resumo operacional filtra a lista da Home (toggle local; sem navegar). */
  const toggleSeverityStrip = useCallback((severity: HomeAlertSeverity) => {
    setSeverityFilter((current) => toggleHomeSeverityFilter(current, severity));
  }, []);

  const selectedCustomerLabel = useMemo(() => {
    if (selectedCustomerKeys.length === 0) return "TODOS";
    if (selectedCustomerKeys.length > 1) return `${selectedCustomerKeys.length} CLIENTES`;
    const selected = customerOptions.find((customer) => customer.key === selectedCustomerKeys[0]);
    return String(selected?.name || "CLIENTE").toUpperCase();
  }, [customerOptions, selectedCustomerKeys]);

  const toggleCustomer = useCallback((key: string) => {
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ));
  }, []);

  const loadSummary = useCallback((mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (summaryInFlight.current) return summaryInFlight.current;
    const isInitial = mode === "initial" || !hasSummaryRef.current;
    if (isInitial) setIsSummaryLoading(true);
    else if (mode === "quiet") beginQuietUpdate();

    const request = (async () => {
      const now = Date.now();
      const results = await Promise.allSettled([
        fetchRecentOperationalMetrics({ now, windowMs }),
        fetchOneViewFacets(),
      ]);

      const [metricsResult, facetsResult] = results;
      const nextMetas: ResourceMeta[] = [];
      let summaryFailed = true;

      if (metricsResult.status === "fulfilled") {
        setRecentMetrics(metricsResult.value);
        nextMetas.push({
          source: metricsResult.value.data_source as OneViewDataSourceKind | undefined,
          checkedAt: metricsResult.value.checked_at,
        });
        setSectionError("summary", null);
        summaryFailed = false;
      } else if (isInitial && !hasSummaryRef.current) {
        setSectionError("summary", "Não foi possível carregar o resumo operacional.");
      } else {
        setSectionError("summary", "Falha ao atualizar o resumo. Os valores anteriores foram mantidos.");
      }

      if (facetsResult.status === "fulfilled") {
        const customers = facetsResult.value.customers ?? [];
        setCustomerOptions([
          { key: "all", name: "Todos" },
          ...customers.map((customer) => ({
            key: customer.key,
            name: facetCustomerDisplayName(customer),
            alerts_count: customer.alerts_count,
          })),
        ]);
        setDatasourceOptions([
          { value: "all", label: "Todos" },
          ...(facetsResult.value.datasources ?? []).map((datasource) => ({
            value: datasource.name,
            label: datasource.name,
          })),
        ]);
        nextMetas.push({
          source: facetsResult.value.data_source as OneViewDataSourceKind | undefined,
          checkedAt: facetsResult.value.checked_at,
        });
      }

      if (nextMetas.length) setMetas(nextMetas);
      if (!summaryFailed) hasSummaryRef.current = true;

      if (summaryFailed && metricsResult.status === "rejected" && facetsResult.status === "rejected") {
        toast.error("Não foi possível atualizar a visão operacional.");
      }
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar a visão operacional.");
    }).finally(() => {
      setIsSummaryLoading(false);
      if (!isInitial && mode === "quiet") endQuietUpdate();
      summaryInFlight.current = null;
    });

    summaryInFlight.current = request;
    return request;
  }, [beginQuietUpdate, endQuietUpdate, setSectionError, windowMs]);

  const loadLists = useCallback(async (mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (mode === "quiet" && listsRequest.current && !listsRequest.current.signal.aborted) return;
    listsRequest.current?.abort();
    const controller = new AbortController();
    const requestId = ++listsRequestIdRef.current;
    listsRequest.current = controller;
    const isInitial = mode === "initial" || !hasListsRef.current;
    const beganQuiet = !isInitial && mode === "quiet";
    if (isInitial) setIsListsLoading(true);
    else if (beganQuiet) beginQuietUpdate();

    try {
      const now = Date.now();
      const tasks: Array<Promise<unknown>> = [
        fetchHomeAlerts({
          mode: alertMode,
          severity: severityFilter,
          customers: selectedCustomerKeys,
          datasources: selectedDatasources,
          status: alertStatus,
          limit: HOME_ALERTS_PAGE_SIZE,
          windowMs,
          signal: controller.signal,
          now,
        }),
        fetchRecentOperationalEvents({
          limit: HOME_EVENTS_LIMIT,
          customers: selectedCustomerKeys,
          signal: controller.signal,
          now,
          windowMs,
        }),
        fetchHomeIncidentStreams({
          pageSize: HOME_INCIDENTS_PAGE_SIZE,
          signal: controller.signal,
        }),
        fetchOperatorQueue({
          tab: "all",
          alertStatus: "active",
          pageSize: 3,
          signal: controller.signal,
        }),
      ];

      const results = await Promise.allSettled(tasks);
      if (controller.signal.aborted || requestId !== listsRequestIdRef.current) return;

      const [alertsResult, historyResult, incidentsResult, operatorsResult] = results;
      let anySuccess = false;

      if (alertsResult.status === "fulfilled") {
        const payload = alertsResult.value as Awaited<ReturnType<typeof fetchHomeAlerts>>;
        setHomeAlerts(payload.items);
        setAlertsTotal(payload.total);
        setListsMeta({
          source: payload.data_source as OneViewDataSourceKind | undefined,
          checkedAt: payload.checked_at,
        });
        setSectionError("alerts", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setSectionError("alerts", "Não foi possível carregar os alertas.");
      } else {
        setSectionError("alerts", "Falha ao atualizar alertas. Os valores anteriores foram mantidos.");
      }

      if (historyResult.status === "fulfilled") {
        const payload = historyResult.value as Awaited<ReturnType<typeof fetchRecentOperationalEvents>>;
        const events = (payload.items ?? []).filter(isAllowedHomeEvent).slice(0, HOME_EVENTS_LIMIT);
        setRecentEvents(events);
        setEventsTotal(payload.total);
        setListsMeta((current) => ({
          source: current.source || (payload.data_source as OneViewDataSourceKind | undefined),
          checkedAt: latestCheckedAt(current.checkedAt, payload.checked_at) ?? undefined,
        }));
        setSectionError("events", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setSectionError("events", "Não foi possível carregar os eventos recentes.");
      } else {
        setSectionError("events", "Falha ao atualizar eventos. Os valores anteriores foram mantidos.");
      }

      if (incidentsResult?.status === "fulfilled") {
        const payload = incidentsResult.value as Awaited<ReturnType<typeof fetchHomeIncidentStreams>>;
        setIncidentStreams(payload);
        setSectionError("incidents", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setIncidentStreams(null);
        setSectionError("incidents", incidentLoadErrorMessage(incidentsResult?.reason));
      } else {
        setSectionError("incidents", incidentLoadErrorMessage(incidentsResult?.reason));
      }

      if (operatorsResult?.status === "fulfilled") {
        const payload = operatorsResult.value as OperatorQueueResponse;
        setOperatorQueue(payload);
        setSectionError("operators", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setOperatorQueue(null);
        setSectionError("operators", "Fila de operadoras indisponível.");
      } else {
        setSectionError("operators", "Falha ao atualizar operadoras. Os dados anteriores foram mantidos.");
      }

      if (anySuccess) hasListsRef.current = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "Não foi possível carregar as listas operacionais.");
      }
    } finally {
      if (requestId === listsRequestIdRef.current) setIsListsLoading(false);
      if (beganQuiet) endQuietUpdate();
    }
  }, [
    alertMode,
    alertStatus,
    beginQuietUpdate,
    endQuietUpdate,
    selectedCustomerKeys,
    selectedDatasources,
    setSectionError,
    severityFilter,
    windowMs,
  ]);

  const loadSelectedAlert = useCallback(async (alertId: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setIsDetailLoading(true);
    setDetailError(null);
    // OV-P0-108 — mantém preview/detail existente enquanto carrega (sem flicker).
    try {
      const results = await Promise.allSettled([
        fetchAlert(alertId, controller.signal),
        fetchAlertHistory(alertId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const errors: string[] = [];
      if (results[0].status === "fulfilled") setDetail(results[0].value);
      else errors.push(results[0].reason instanceof Error ? results[0].reason.message : "Detalhe indisponível.");
      if (results[1].status === "fulfilled") setHistory(results[1].value);
      else errors.push(results[1].reason instanceof Error ? results[1].reason.message : "Histórico indisponível.");
      if (errors.length) setDetailError(errors[0]);
    } finally {
      if (!controller.signal.aborted) setIsDetailLoading(false);
    }
  }, []);

  const openAlert = useCallback((alert: Pick<OneViewAlert, "id"> & Partial<OneViewAlert>, preview?: OneViewAlert | null) => {
    setSelectedAlertId(alert.id);
    setSelectedPreview(preview ?? (alert as OneViewAlert));
    void loadSelectedAlert(alert.id);
    const next = new URLSearchParams(searchParams);
    next.set("alert", alert.id);
    setSearchParams(next, { replace: false });
  }, [loadSelectedAlert, searchParams, setSearchParams]);

  const openHistoryEvent = useCallback((item: GlobalHistoryItem) => {
    openAlert({
      id: item.alert_id,
      severity: item.severity,
      problem_name: item.problem_name,
      host_name: item.host_name,
      host_visible_name: item.host_name,
      customer_name: item.customer_name,
      customer_key: item.customer_key,
      datasource_name: item.datasource_name,
    });
  }, [openAlert]);

  const openIncidentRelatedAlert = useCallback(async (incident: OneViewIncident) => {
    try {
      const result = await fetchIncidentRelatedAlert({
        sysId: incident.sys_id,
        number: incident.number,
      });
      if (!result.matched || !result.alert?.id) {
        toast.message("Nenhum alerta relacionado localizado.");
        return;
      }
      openAlert({
        id: result.alert.id,
        severity: result.alert.severity,
        problem_name: result.alert.problem,
        host_name: result.alert.host,
        host_visible_name: result.alert.host,
        customer_name: result.alert.customer,
        customer_key: result.alert.customer,
      });
    } catch {
      toast.error("Não foi possível localizar o alerta relacionado.");
    }
  }, [openAlert]);

  const closeAlert = useCallback(() => {
    detailRequest.current?.abort();
    setSelectedAlertId(null);
    setSelectedPreview(null);
    setDetail(null);
    setHistory(null);
    setDetailError(null);
    setIsDetailLoading(false);
    if (searchParams.has("alert")) {
      const next = new URLSearchParams(searchParams);
      next.delete("alert");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!requestedAlertId) {
      if (selectedAlertId) {
        detailRequest.current?.abort();
        setSelectedAlertId(null);
        setSelectedPreview(null);
        setDetail(null);
        setHistory(null);
        setDetailError(null);
        setIsDetailLoading(false);
      }
      return;
    }
    if (requestedAlertId === selectedAlertId) return;
    setSelectedAlertId(requestedAlertId);
    setSelectedPreview(null);
    void loadSelectedAlert(requestedAlertId);
  }, [loadSelectedAlert, requestedAlertId, selectedAlertId]);

  useEffect(() => { void loadSummary(hasSummaryRef.current ? "quiet" : "initial"); }, [loadSummary]);
  useEffect(() => {
    void loadLists(hasListsRef.current ? "quiet" : "initial");
    return () => listsRequest.current?.abort();
  }, [loadLists]);
  useEffect(() => {
    const summaryTimer = window.setInterval(() => {
      if (!document.hidden) void loadSummary("quiet");
    }, SUMMARY_REFRESH_MS);
    const listTimer = window.setInterval(() => {
      if (!document.hidden) void loadLists("quiet");
    }, LIST_REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      void Promise.all([loadSummary("quiet"), loadLists("quiet")]);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(summaryTimer);
      window.clearInterval(listTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadLists, loadSummary]);
  useEffect(() => () => detailRequest.current?.abort(), []);

  const lastCheckedAt = latestCheckedAt(...metas.map((meta) => meta.checkedAt), listsMeta.checkedAt);
  const selectedAlert = detail?.item ?? selectedPreview;
  const historyItems = (history?.items ?? []).filter((item) => item.event_type !== "internal_acknowledged" && item.origin !== "oneview_internal");
  const showInitialLoading = (isSummaryLoading && !hasSummaryRef.current) || (isListsLoading && !hasListsRef.current);
  const visibleIncidents = incidentStreams?.[incidentTab] ?? [];
  const operatorItems = (operatorQueue?.items ?? []).slice(0, 3);
  const operatorCounts = operatorQueue?.counts;

  // OV-P0-42A: faixa das cinco severidades (ativos + first_seen na janela). Zero válido ≠ erro ("—").
  const hasValidSummary = Boolean(recentMetrics);
  const severityStripLoading = isSummaryLoading && !recentMetrics;
  const severityCounts = hasValidSummary ? recentMetrics?.by_severity ?? null : null;
  const severityStripItems = HOME_VISUAL_SEVERITY_STRIP.map((severity) => {
    const value = severityCounts?.[severity] ?? null;
    return {
      key: severity,
      label: formatOneViewSeverityLabel(severity),
      value: formatMetricCount(value),
      description: `${homeOperationalWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
      selected: severityFilter === severity,
      onClick: () => toggleSeverityStrip(severity),
    };
  });

  const headerControls = (
    <div className="flex items-center gap-2">
      {isBackgroundUpdating ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Atualizando...
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          Tela atualizada: <span className="font-semibold text-foreground">{formatClock(lastCheckedAt)}</span>
        </span>
      )}
    </div>
  );

  const windowSelector = (
    <OperationalFilterGroup label="Janela temporal">
      {HOME_OPERATIONAL_WINDOW_OPTIONS.map((preset) => (
        <Button
          key={preset}
          type="button"
          size="sm"
          variant={homeWindow === preset ? "default" : "outline"}
          className={OV_FILTER_CHIP}
          aria-pressed={homeWindow === preset}
          onClick={() => setHomeWindow(preset)}
        >
          {preset}
        </Button>
      ))}
    </OperationalFilterGroup>
  );

  return (
    <AppLayout
      clientSelect={(
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight text-foreground">Início</h1>
          {windowSelector}
          {showInitialLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
      )}
      topbarRightSection={headerControls}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="gap-3 p-3 lg:px-4"
    >
      <div className="space-y-3">
        <SectionPanel
          aria-label="Resumo operacional"
          title="Resumo operacional"
          description="Resumo geral da operação Teletex."
          className="px-0"
          bodyClassName="px-2.5 py-2"
          aside={sectionErrors.summary ? (
            <Button type="button" size="sm" variant="outline" className="ov-error-action h-7 px-2 text-xs" onClick={() => void loadSummary("manual")}>
              Tentar novamente
            </Button>
          ) : null}
        >
          <CompactMetricStrip
            aria-label="Severidades ativas na janela"
            items={severityStripItems}
          />
          {sectionErrors.summary ? (
            <OperationalErrorBanner className="mt-1.5 rounded-none border-x-0 border-b-0" message={sectionErrors.summary} />
          ) : null}
        </SectionPanel>

        {/* OV-P0-248: alertas dominam; chamados e operadoras são apoio operacional. */}
        <div className="grid items-start gap-3 lg:grid-cols-5">
          <SectionPanel
            className="flex min-h-0 flex-col overflow-hidden lg:col-span-3"
            title="Alertas Recentes"
            aside={(
              <div className={HOME_PANEL_HEADER_ASIDE}>
                <HomePanelCount value={alertsTotal} />
                <OperationalCta to={homeAlertsHref}>Ver todos</OperationalCta>
              </div>
            )}
            bodyClassName="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-0"
          >
            <div className={HOME_FILTER_ROW}>
              <OperationalFilterGroup label="Modo de alertas">
                <OperationalSegmentedControl
                  aria-label="Modo de alertas"
                  value={alertMode}
                  onChange={(mode) => setAlertMode(parseHomeAlertMode(mode))}
                  options={[
                    { value: HOME_ALERT_MODE.all, label: "Todos" },
                    { value: HOME_ALERT_MODE.prioritary, label: "Prioritários" },
                  ]}
                />
              </OperationalFilterGroup>
              <OperationalFilterGroup label="Cliente" showDivider>
                <ClientFilterCombobox
                  open={clientFilterOpen}
                  onOpenChange={setClientFilterOpen}
                  options={customerOptions}
                  selectedKeys={selectedCustomerKeys}
                  selectedLabel={selectedCustomerLabel}
                  onToggle={toggleCustomer}
                />
              </OperationalFilterGroup>
              <OperationalFilterGroup label="Severidade" showDivider>
                <Select value={severityFilter} onValueChange={setSeverityFilter}>
                  <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-[9rem]")} aria-label="Filtrar por severidade">
                    <SelectValue placeholder="Severidade" />
                  </SelectTrigger>
                  <SelectContent>
                    {HOME_SEVERITY_FILTER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OperationalFilterGroup>
              <OperationalFilterGroup label="Status" showDivider>
                <Select value={alertStatus} onValueChange={(value) => setAlertStatus(value as HomeAlertStatus)}>
                  <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-[8.5rem]")} aria-label="Filtrar por status">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    {HOME_ALERT_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OperationalFilterGroup>
              <OperationalFilterGroup label="Datasource" showDivider>
                <Select
                  value={selectedDatasources[0] || "all"}
                  onValueChange={(value) => setSelectedDatasources(value === "all" ? [] : [value])}
                >
                  <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-[10rem]")} aria-label="Filtrar por datasource">
                    <SelectValue placeholder="Datasource" />
                  </SelectTrigger>
                  <SelectContent>
                    {datasourceOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OperationalFilterGroup>
            </div>
            <div className={cn(HOME_LIST_DIVIDE, "min-h-0")}>
              <SectionState
                loading={isListsLoading && !homeAlerts.length}
                error={sectionErrors.alerts ?? null}
                empty={!homeAlerts.length}
                emptyMessage="Nenhum alerta recente na fila operacional com os filtros atuais."
                onRetry={() => void loadLists("manual")}
              >
                {homeAlerts.map((alert) => (
                  <HomeAlertRow key={alert.id} alert={alert} onOpen={openAlert} />
                ))}
              </SectionState>
            </div>
            {queueOverflowLabel(alertsTotal, homeAlerts.length) ? (
              <p className="border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
                {queueOverflowLabel(alertsTotal, homeAlerts.length)}
              </p>
            ) : null}
          </SectionPanel>

          <div className="space-y-3 lg:col-span-2">
            <SectionPanel
              className="flex min-h-0 flex-col overflow-hidden"
              title="Chamados"
              aside={(
                <div className={HOME_PANEL_HEADER_ASIDE}>
                  <HomePanelCount value={incidentStreams?.total ?? 0} />
                  <OperationalCta to="/chamados">Ver todos</OperationalCta>
                </div>
              )}
              bodyClassName="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-0"
            >
              <Tabs value={incidentTab} onValueChange={(value) => setIncidentTab(value as HomeIncidentTab)}>
                <TabsList className="mt-1 h-8 w-full justify-start">
                  {HOME_INCIDENT_TABS.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value} className="h-7 px-2 text-[11px]">
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {HOME_INCIDENT_TABS.map((tab) => (
                  <TabsContent key={tab.value} value={tab.value} className="mt-1">
                    <SectionState
                      loading={isListsLoading && !visibleIncidents.length && !sectionErrors.incidents}
                      error={sectionErrors.incidents ?? null}
                      empty={!visibleIncidents.length}
                      emptyMessage={tab.value === "queue" ? "Nenhum chamado operacional sem responsável." : tab.value === "in_progress" ? "Nenhum chamado com analista responsável." : "Nenhum chamado recente disponível."}
                      emptyClassName="flex min-h-[7rem] items-center justify-center"
                      onRetry={() => void loadLists("manual")}
                    >
                      {visibleIncidents.map((item) => (
                        <HomeIncidentCard
                          key={item.sys_id || item.number || String(item.opened_at)}
                          item={item}
                          onOpenRelatedAlert={openIncidentRelatedAlert}
                        />
                      ))}
                    </SectionState>
                  </TabsContent>
                ))}
              </Tabs>
            </SectionPanel>

            <SectionPanel
              className="overflow-hidden"
              title="Operadoras"
              aside={<OperationalCta to="/operadoras">Ver fila de Operadoras</OperationalCta>}
              bodyClassName="px-3 pb-2 pt-0"
            >
              <div className="grid grid-cols-3 gap-2 border-b border-border/60 py-2 text-center">
                <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.all)}</p><p className="text-[10px] text-muted-foreground">Ativos</p></div>
                <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.unassigned)}</p><p className="text-[10px] text-muted-foreground">Sem responsável</p></div>
                <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.following)}</p><p className="text-[10px] text-muted-foreground">Em acompanhamento</p></div>
              </div>
              <SectionState
                loading={isListsLoading && !operatorQueue && !sectionErrors.operators}
                error={sectionErrors.operators ?? null}
                empty={!operatorItems.length}
                emptyMessage="Nenhum alerta ativo de operadora."
                emptyClassName="py-3"
                onRetry={() => void loadLists("manual")}
              >
                <div className={HOME_LIST_DIVIDE}>{operatorItems.map((item) => <HomeOperatorRow key={item.alert_id || `${item.incident_number}-${item.operator_tag}`} item={item} />)}</div>
              </SectionState>
            </SectionPanel>
          </div>
        </div>

        <SectionPanel
          className="flex min-h-0 flex-col overflow-hidden"
          title="Eventos recentes"
          aside={(
            <div className={HOME_PANEL_HEADER_ASIDE}>
              <HomePanelCount value={eventsTotal} />
              <OperationalCta to="/historico">Abrir histórico</OperationalCta>
            </div>
          )}
          bodyClassName="px-0 pb-0"
        >
          <SectionState
            loading={isListsLoading && !recentEvents.length && !sectionErrors.events}
            error={sectionErrors.events ?? null}
            empty={!recentEvents.length}
            emptyMessage="Nenhum evento operacional recente disponível."
            onRetry={() => void loadLists("manual")}
          >
            <div className="max-h-[18rem] overflow-auto xl:max-h-[20rem]">
              <table className="w-full min-w-[36rem] table-fixed text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-card">
                  <tr className="border-b border-border/70 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="w-[18%] px-3 py-1.5 font-semibold">Cliente</th>
                    <th className="w-[18%] px-3 py-1.5 font-semibold">Host</th>
                    <th className="w-[32%] px-3 py-1.5 font-semibold">Problema</th>
                    <th className="w-[16%] px-3 py-1.5 font-semibold">Severidade</th>
                    <th className="w-[16%] px-3 py-1.5 font-semibold">Horário</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer border-b border-border/50 last:border-b-0 hover:bg-muted/30"
                      onClick={() => openHistoryEvent(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openHistoryEvent(item);
                        }
                      }}
                      tabIndex={0}
                      aria-label={`Abrir alerta de ${item.problem_name || "evento"}`}
                    >
                      <td className="truncate px-3 py-1.5 text-[11px] font-semibold text-foreground">
                        <span className="inline-flex max-w-full items-center gap-1.5">
                          <ClientIdentity
                            customer={{
                              key: item.customer_key,
                              name: item.customer_name,
                            }}
                            operationalScope={item.operational_scope}
                            operationalScopeLabel={item.operational_scope_label}
                            size="sm"
                            className="shrink-0"
                          />
                          <TruncatedText className="text-[11px] font-semibold text-foreground">
                            {operationalClientLabel({
                              key: item.customer_key,
                              name: item.customer_name,
                              operational_scope: item.operational_scope,
                              operational_scope_label: item.operational_scope_label,
                            })}
                          </TruncatedText>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-foreground/80">
                        <TruncatedText>{canonicalHostName(item)}</TruncatedText>
                      </td>
                      <td className="px-3 py-1.5 text-[11px] text-muted-foreground">
                        <TruncatedText>{item.problem_name || "—"}</TruncatedText>
                      </td>
                      <td className="px-3 py-1.5">
                        {item.severity ? (
                          <SeverityBadge severity={item.severity} className="h-5 px-1.5" />
                        ) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-[11px] text-muted-foreground">
                        {formatClock(item.occurred_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionState>
        </SectionPanel>
      </div>

      <AlertDetailDrawer
        open={selectedAlertId !== null}
        onOpenChange={(next) => { if (!next) closeAlert(); }}
        alert={selectedAlert}
        historyItems={historyItems}
        isLoading={isDetailLoading}
        error={detailError}
        description="Consulta rápida sem sair da Home."
      />
    </AppLayout>
  );
}
