import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eye, Loader2 } from "lucide-react";
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
import { ConfigurableMetricStrip } from "@/components/oneview/ConfigurableMetricStrip";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableColumns, ConfigurableTableToolbar } from "@/components/oneview/ConfigurableTableTools";
import { IncidentDetailDrawer } from "@/components/oneview/IncidentDetailDrawer";
import { OperationalCta } from "@/components/oneview/OperationalCta";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { OperationalFilterGroup } from "@/components/oneview/OperationalFilterGroup";
import { OperationalIncidentsToolbar } from "@/components/oneview/OperationalIncidentsToolbar";
import {
  OPERATIONAL_INCIDENT_QUEUE_COLUMNS,
  OPERATIONAL_INCIDENT_QUEUE_COLUMN_WIDTH,
  OperationalIncidentsQueueList,
  operationalIncidentKey,
  type OperationalIncidentQueueColumnId,
} from "@/components/oneview/OperationalIncidentsQueueList";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { OneViewSemanticStatusBadge, OneViewSeverityBadge, SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { TruncatedText } from "@/components/oneview/TruncatedText";
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
import { cn } from "@/lib/utils";
import { dashboardWidgetsForPage } from "@/lib/oneview-dashboard-layout";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewMetricStrip } from "@/lib/oneview-metric-strip-preferences";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { useAuthContext } from "@/context/AuthContext";
import { OV_FILTER_CHIP, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  AlertListResponse,
  GlobalHistoryItem,
  IncidentAssigneeFacet,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewFacetsResponse,
  OneViewIncident,
  OneViewSeverity,
  fetchAlert,
  fetchAlertHistory,
  fetchOperatorQueue,
  formatNullableCount,
  formatOneViewSeverityLabel,
  ONEVIEW_FACETS_PATH,
  bucketOneViewReadNow,
  oneViewAlertsPath,
  type OperatorQueueItem,
  type OperatorQueueResponse,
} from "@/lib/oneview-api";
import {
  DEFAULT_HOME_ALERT_MODE,
  DEFAULT_HOME_OPERATIONAL_WINDOW,
  HOME_ALERT_MODE,
  HOME_ALERTS_PAGE_SIZE,
  HOME_ALERT_STATUS_OPTIONS,
  HOME_EVENTS_LIMIT,
  HOME_OPERATIONAL_WINDOW_OPTIONS,
  HOME_SEVERITY_FILTER_OPTIONS,
  buildHomeAlertsHref,
  defaultHomeAlertsFetchParams,
  fetchHomeAlerts,
  homeAlertsResultFromResponse,
  homeOperationalWindowActiveLabel,
  homeOperationalWindowMs,
  parseHomeAlertMode,
  parseHomeOperationalWindow,
  toggleHomeSeverityFilter,
  type HomeAlertMode,
  type HomeAlertStatus,
  type HomeAlertSeverity,
  type HomeOperationalWindowPreset,
} from "@/lib/oneview-home";
import { getOneViewFacets } from "@/lib/oneview-facets-store";
import { useOneViewWarmRead } from "@/hooks/useOneViewWarmRead";
import {
  INCIDENTS_QUEUE_MODE,
  analystFacetOptions,
  buildOperationalChamadosHref,
  fetchOperationalIncidents,
  parseIncidentsQueueMode,
  type IncidentsQueueMode,
} from "@/lib/oneview-operational-incidents";
import {
  RecentOperationalMetrics,
  fetchRecentOperationalEvents,
  fetchRecentOperationalMetrics,
  queueOverflowLabel,
} from "@/lib/oneview-recent";
import { toast } from "sonner";
import {
  customerFilterCountNoun,
  augmentCustomerFacetsWithDedicatedDatasources,
  isDatasourceOnlyFilterValue,
} from "@/lib/oneview-zabbix-source";

const SUMMARY_REFRESH_MS = 10_000;
const LIST_REFRESH_MS = 10_000;
const HOME_DASHBOARD_WIDGETS = dashboardWidgetsForPage("home").filter((widget) => widget.id !== "health");

const HOME_EVENT_COLUMNS = [
  { id: "client", label: "Cliente" },
  { id: "host", label: "Host" },
  { id: "problem", label: "Problema", required: true },
  { id: "severity", label: "Severidade" },
  { id: "time", label: "Horário" },
] as const;

const HOME_ALERT_COLUMNS = [
  { id: "client", label: "Cliente" },
  { id: "host", label: "Host" },
  { id: "problem", label: "Problema", required: true },
  { id: "severity", label: "Severidade" },
  { id: "ack", label: "ACK" },
  { id: "started", label: "Início" },
  { id: "duration", label: "Duração" },
  { id: "action", label: "Ação" },
] as const;
type HomeAlertColumnId = typeof HOME_ALERT_COLUMNS[number]["id"];

const HOME_OPERATOR_COLUMNS = [
  { id: "customer", label: "Cliente", required: true },
  { id: "operator", label: "Operadora" },
  { id: "host", label: "Host" },
  { id: "problem", label: "Problema" },
  { id: "incident", label: "Chamado" },
  { id: "analyst", label: "Responsável" },
  { id: "updated", label: "Atualização" },
  { id: "severity", label: "Severidade", defaultVisible: false },
  { id: "state", label: "Estado INC", defaultVisible: false },
] as const;
type HomeOperatorColumnId = typeof HOME_OPERATOR_COLUMNS[number]["id"];

const HOME_ALERT_COLUMN_WIDTH: Record<HomeAlertColumnId, string> = {
  client: "11rem",
  host: "12rem",
  problem: "minmax(0,1fr)",
  severity: "8rem",
  ack: "7rem",
  started: "6.5rem",
  duration: "5.75rem",
  action: "4rem",
};
const HOME_OPERATOR_COLUMN_WIDTH: Record<HomeOperatorColumnId, string> = {
  customer: "minmax(9rem,1fr)",
  operator: "8rem",
  host: "9rem",
  problem: "minmax(10rem,1.2fr)",
  incident: "7rem",
  analyst: "8rem",
  updated: "6.5rem",
  severity: "7.5rem",
  state: "7rem",
};

const HOME_ALERT_TABLE_MIN_WIDTH = "64rem";
const HOME_OPERATOR_TABLE_MIN_WIDTH = "48rem";

function homeColumnAlign(column: string) {
  if (column === "started" || column === "duration" || column === "updated") return "justify-self-end text-right";
  if (column === "action") return "justify-self-center text-center";
  return "justify-self-start text-left";
}

function formatCompactFirstSeen(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Ordem visual Home OV-P0-42A (sem Not classified — chip no mesmo bloco). */
const HOME_VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];
const HOME_METRIC_OPTIONS = [
  { id: "information", label: "Informação", defaultSpan: 2 },
  { id: "warning", label: "Warning", defaultSpan: 2 },
  { id: "average", label: "Average", defaultSpan: 2 },
  { id: "high", label: "High", defaultSpan: 2 },
  { id: "disaster", label: "Disaster", defaultSpan: 2 },
] as const;

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

function configuredWidgetItemLimit(
  widgets: Array<{ id: string; itemLimit?: number }>,
  id: string,
  fallback: number,
) {
  const value = widgets.find((widget) => widget.id === id)?.itemLimit;
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

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

function HomeAlertRow({
  alert,
  onOpen,
  columns,
  gridTemplate,
  selected = false,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
  columns: readonly HomeAlertColumnId[];
  gridTemplate: string;
  selected?: boolean;
}) {
  const acked = Boolean(alert.acknowledged_source);
  const clientLabel = operationalClientLabel({
    key: alert.customer_key,
    name: alert.customer_name,
    source: alert.customer_source,
    operational_scope: alert.operational_scope,
    operational_scope_label: alert.operational_scope_label,
  });
  const clientTitle = normalizeOperationalScope(alert.operational_scope) === "unknown"
    ? `${clientLabel} · ${CLASSIFICATION_PENDING_LABEL}`
    : clientLabel;
  const cells: Record<HomeAlertColumnId, ReactNode> = {
    client: (
      <span key="client" className="flex min-w-0 items-center gap-2" title={clientTitle}>
        <ClientIdentity customer={{ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source }} operationalScope={alert.operational_scope} operationalScopeLabel={alert.operational_scope_label} size="xs" className="shrink-0" />
        <TruncatedText className="text-sm font-semibold text-foreground" title={clientTitle}>{clientLabel}</TruncatedText>
      </span>
    ),
    host: <TruncatedText key="host" className="text-xs text-foreground/85">{canonicalHostName(alert)}</TruncatedText>,
    problem: <TruncatedText key="problem" className="text-xs text-muted-foreground">{alert.problem_name}</TruncatedText>,
    severity: <span key="severity"><OneViewSeverityBadge severity={alert.severity} showDot={false} /></span>,
    ack: <span key="ack"><OneViewSemanticStatusBadge status={acked ? "monitoring-normalized" : "classification-pending"} label={acked ? "Com ACK" : "Sem ACK"} showDot={false} /></span>,
    started: <span key="started" className="block truncate text-xs tabular-nums text-muted-foreground">{formatCompactFirstSeen(alert.first_seen_at || alert.started_at)}</span>,
    duration: <span key="duration" className="block truncate text-xs tabular-nums text-muted-foreground">{formatDurationSeconds(alert.duration_seconds)}</span>,
    action: <span key="action" className="inline-flex h-7 items-center justify-center gap-1 text-xs font-medium text-primary">Abrir<Eye className="h-3 w-3" aria-hidden="true" /></span>,
  };
  return (
    <button
      type="button"
      onClick={() => onOpen(alert)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "ov-monitoring-table-grid grid w-full min-h-12 items-center gap-x-3 border-b border-border/50 px-1 py-2 text-left transition-colors hover:bg-muted/50 last:border-b-0",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
      aria-label={`Abrir alerta ${alert.problem_name || alert.id}`}
    >
      {columns.map((column) => <span key={column} className={cn("min-w-0 overflow-hidden", homeColumnAlign(column))}>{cells[column]}</span>)}
    </button>
  );
}

function HomeOperatorRow({
  item,
  columns,
  gridTemplate,
}: {
  item: OperatorQueueItem;
  columns: readonly HomeOperatorColumnId[];
  gridTemplate: string;
}) {
  const severity = String(item.severity || "").trim() as OneViewSeverity;
  const cells: Record<HomeOperatorColumnId, ReactNode> = {
    customer: <TruncatedText key="customer" className="text-xs font-semibold text-foreground">{displayIncidentField(item.customer_name)}</TruncatedText>,
    operator: <TruncatedText key="operator" className="text-[11px] text-muted-foreground">{displayIncidentField(item.operator_tag)}</TruncatedText>,
    host: <TruncatedText key="host" className="text-[11px] text-foreground/85">{displayIncidentField(item.host_name)}</TruncatedText>,
    problem: <TruncatedText key="problem" className="text-[11px] text-muted-foreground">{displayIncidentField(item.problem_name)}</TruncatedText>,
    incident: <span key="incident" className="text-[11px] font-medium text-foreground">{displayIncidentField(item.incident_number, "Sem INC")}</span>,
    analyst: <TruncatedText key="analyst" className="text-[10px] text-muted-foreground">{item.analyst_label || "Sem responsável"}</TruncatedText>,
    updated: <span key="updated" className="block truncate text-[10px] tabular-nums text-muted-foreground">{item.updated_ago_label || "—"}</span>,
    severity: severity ? <span key="severity"><OneViewSeverityBadge severity={severity} showDot={false} /></span> : <span key="severity" className="text-[10px] text-muted-foreground">—</span>,
    state: <span key="state"><Badge variant="outline" className="h-5 max-w-full truncate px-1.5 text-[10px]">{displayIncidentField(item.incident_state_display, item.incident_state)}</Badge></span>,
  };
  const rowClass = cn(
    "ov-monitoring-table-grid grid w-full min-h-10 items-center gap-x-3 border-b border-border/50 px-1 py-1.5 last:border-b-0 transition-colors hover:bg-muted/40",
  );
  const inner = columns.map((column) => <span key={column} className={cn("min-w-0 overflow-hidden", homeColumnAlign(column))}>{cells[column]}</span>);
  return item.oneview_link ? (
    <Link to={item.oneview_link} className={rowClass} style={{ gridTemplateColumns: gridTemplate }} aria-label={`Abrir alerta de operadora ${displayIncidentField(item.customer_name)}`}>
      {inner}
    </Link>
  ) : (
    <div className={rowClass} style={{ gridTemplateColumns: gridTemplate }}>{inner}</div>
  );
}

export default function Index() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({
    page: "home",
    actorId,
    widgets: HOME_DASHBOARD_WIDGETS,
  });
  const homeMetrics = useOneViewMetricStrip({ stripId: "home-summary", actorId, definitions: HOME_METRIC_OPTIONS });
  const homeEventColumns = useOneViewTableColumns({ tableId: "home-events", actorId, definitions: HOME_EVENT_COLUMNS });
  const homeAlertColumns = useOneViewTableColumns({ tableId: "home-alerts", actorId, definitions: HOME_ALERT_COLUMNS });
  const homeIncidentColumns = useOneViewTableColumns({ tableId: "home-incidents", actorId, definitions: OPERATIONAL_INCIDENT_QUEUE_COLUMNS });
  const homeOperatorColumns = useOneViewTableColumns({ tableId: "home-operators", actorId, definitions: HOME_OPERATOR_COLUMNS });
  const alertItemLimit = configuredWidgetItemLimit(dashboard.layout.widgets, "recent-alerts", HOME_ALERTS_PAGE_SIZE);
  const incidentItemLimit = configuredWidgetItemLimit(dashboard.layout.widgets, "incidents", 7);
  const operatorItemLimit = configuredWidgetItemLimit(dashboard.layout.widgets, "failed-links", 3);
  const eventItemLimit = configuredWidgetItemLimit(dashboard.layout.widgets, "recent-events", HOME_EVENTS_LIMIT);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAlertId = searchParams.get("alert");
  const homeWindow = parseHomeOperationalWindow(searchParams.get("window"));
  const windowMs = homeOperationalWindowMs(homeWindow);
  const warmedHomeAlerts = useOneViewWarmRead<AlertListResponse>({
    cachePath: (!searchParams.get("window") || searchParams.get("window") === DEFAULT_HOME_OPERATIONAL_WINDOW)
      ? oneViewAlertsPath(defaultHomeAlertsFetchParams())
      : "",
  });
  const warmedFacets = useOneViewWarmRead<OneViewFacetsResponse>({ cachePath: ONEVIEW_FACETS_PATH });
  const warmedHome = warmedHomeAlerts.data
    ? homeAlertsResultFromResponse(warmedHomeAlerts.data, alertItemLimit)
    : null;

  const [alertMode, setAlertMode] = useState<HomeAlertMode>(DEFAULT_HOME_ALERT_MODE);
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [alertStatus, setAlertStatus] = useState<HomeAlertStatus>("active");
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>([]);
  const [clientFilterOpen, setClientFilterOpen] = useState(false);
  const [eventSearch, setEventSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState<ClientFilterOption[]>([
    { key: "all", name: "Todos" },
  ]);

  const [recentMetrics, setRecentMetrics] = useState<RecentOperationalMetrics | null>(null);
  const [homeAlerts, setHomeAlerts] = useState<OneViewAlert[]>(() => warmedHome?.items ?? []);
  const [alertsTotal, setAlertsTotal] = useState(warmedHome?.total ?? 0);
  const [incidentsMode, setIncidentsMode] = useState<IncidentsQueueMode>(INCIDENTS_QUEUE_MODE.unassigned);
  const [incidentsAssignedTo, setIncidentsAssignedTo] = useState<string[]>([]);
  const [homeIncidents, setHomeIncidents] = useState<OneViewIncident[]>([]);
  const [incidentsTotal, setIncidentsTotal] = useState(0);
  const [incidentAssignees, setIncidentAssignees] = useState<IncidentAssigneeFacet[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<OneViewIncident | null>(null);
  const [operatorQueue, setOperatorQueue] = useState<OperatorQueueResponse | null>(null);
  const [recentEvents, setRecentEvents] = useState<GlobalHistoryItem[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);

  const [isSummaryLoading, setIsSummaryLoading] = useState(!warmedFacets.peekHit);
  const [isListsLoading, setIsListsLoading] = useState(!warmedHomeAlerts.peekHit);
  const [criticalHomeReady, setCriticalHomeReady] = useState(() => warmedHomeAlerts.peekHit);
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
  const criticalAlertsRequest = useRef<AbortController | null>(null);
  const reuseCriticalAlertsForInitialListsRef = useRef(false);
  const listsRequestIdRef = useRef(0);
  const hasSummaryRef = useRef(Boolean(warmedFacets.peekHit));
  const hasListsRef = useRef(Boolean(warmedHomeAlerts.peekHit));
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

  const changeIncidentsMode = useCallback((mode: IncidentsQueueMode) => {
    setIncidentsMode(parseIncidentsQueueMode(mode));
    if (mode === INCIDENTS_QUEUE_MODE.unassigned) setIncidentsAssignedTo([]);
  }, []);

  const changeIncidentsAssignedTo = useCallback((assignedTo: string[]) => {
    setIncidentsAssignedTo(assignedTo);
    setIncidentsMode((current) => (
      current === INCIDENTS_QUEUE_MODE.unassigned ? INCIDENTS_QUEUE_MODE.assigned : current
    ));
  }, []);

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
    status: alertStatus,
    windowPreset: homeWindow,
  }), [alertMode, alertStatus, homeWindow, selectedCustomerKeys, severityFilter]);

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
      const now = bucketOneViewReadNow();
      const results = await Promise.allSettled([
        fetchRecentOperationalMetrics({ now, windowMs }),
        getOneViewFacets(),
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
        const customers = augmentCustomerFacetsWithDedicatedDatasources(
          (facetsResult.value.customers ?? [])
            .filter((customer) => !isDatasourceOnlyFilterValue(customer.key) && !isDatasourceOnlyFilterValue(customer.name))
            .map((customer) => ({
              key: customer.key,
              name: facetCustomerDisplayName(customer),
              alerts_count: customer.alerts_count ?? null,
            })),
          facetsResult.value.datasources,
        );
        setCustomerOptions([
          { key: "all", name: "Todos" },
          ...customers.map((customer) => ({
            key: customer.key,
            name: customer.name,
            alerts_count: null,
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

  const loadCriticalHomeAlerts = useCallback(async () => {
    if (hasListsRef.current) {
      setCriticalHomeReady(true);
      return;
    }
    criticalAlertsRequest.current?.abort();
    const controller = new AbortController();
    criticalAlertsRequest.current = controller;
    setIsListsLoading(true);
    try {
      const payload = await fetchHomeAlerts({
        mode: alertMode,
        severity: severityFilter,
        customers: selectedCustomerKeys,
        status: alertStatus,
        limit: alertItemLimit,
        windowMs,
        signal: controller.signal,
        now: bucketOneViewReadNow(),
      });
      if (controller.signal.aborted || criticalAlertsRequest.current !== controller) return;
      setHomeAlerts(payload.items);
      setAlertsTotal(payload.total);
      setListsMeta({
        source: payload.data_source as OneViewDataSourceKind | undefined,
        checkedAt: payload.checked_at,
      });
      setSectionError("alerts", null);
      hasListsRef.current = true;
      reuseCriticalAlertsForInitialListsRef.current = true;
    } catch {
      if (!controller.signal.aborted && criticalAlertsRequest.current === controller) {
        setSectionError("alerts", "Falha ao carregar alertas.");
      }
    } finally {
      if (criticalAlertsRequest.current === controller) {
        criticalAlertsRequest.current = null;
        setIsListsLoading(false);
        setCriticalHomeReady(true);
      }
    }
  }, [alertItemLimit, alertMode, alertStatus, selectedCustomerKeys, setSectionError, severityFilter, windowMs]);

  const loadLists = useCallback(async (mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (mode === "quiet" && listsRequest.current && !listsRequest.current.signal.aborted) return;
    listsRequest.current?.abort();
    const controller = new AbortController();
    const requestId = ++listsRequestIdRef.current;
    listsRequest.current = controller;
    const isInitial = mode === "initial" || !hasListsRef.current;
    const reuseCriticalAlerts = reuseCriticalAlertsForInitialListsRef.current;
    reuseCriticalAlertsForInitialListsRef.current = false;
    const beganQuiet = !isInitial && mode === "quiet";
    if (isInitial) setIsListsLoading(true);
    else if (beganQuiet) beginQuietUpdate();

    try {
      const now = bucketOneViewReadNow();
      const tasks: Array<Promise<unknown>> = [
        reuseCriticalAlerts
          ? Promise.resolve(null)
          : fetchHomeAlerts({
            mode: alertMode,
            severity: severityFilter,
            customers: selectedCustomerKeys,
            status: alertStatus,
            limit: alertItemLimit,
            windowMs,
            signal: controller.signal,
            now,
          }),
        fetchRecentOperationalEvents({
          limit: eventItemLimit,
          customers: selectedCustomerKeys,
          signal: controller.signal,
          now,
          windowMs,
        }),
        fetchOperationalIncidents({
          mode: incidentsMode,
          assignedTo: incidentsAssignedTo,
          limit: incidentItemLimit,
          windowMs,
          signal: controller.signal,
          now,
        }),
        fetchOperatorQueue({
          tab: "all",
          alertStatus: "active",
          pageSize: operatorItemLimit,
          signal: controller.signal,
        }),
      ];

      const results = await Promise.allSettled(tasks);
      if (controller.signal.aborted || requestId !== listsRequestIdRef.current) return;

      const [alertsResult, historyResult, incidentsResult, operatorsResult] = results;
      let anySuccess = false;

      if (reuseCriticalAlerts) {
        setSectionError("alerts", null);
        anySuccess = true;
      } else if (alertsResult.status === "fulfilled") {
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
        const events = (payload.items ?? []).filter(isAllowedHomeEvent).slice(0, eventItemLimit);
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
        const payload = incidentsResult.value as Awaited<ReturnType<typeof fetchOperationalIncidents>>;
        setHomeIncidents(payload.items ?? []);
        setIncidentsTotal(Number(payload.pagination?.total_items) || (payload.items?.length ?? 0));
        setIncidentAssignees((current) => {
          const next = analystFacetOptions(payload.facets?.assignees);
          if (!incidentsAssignedTo.length) return next.length ? next : current;
          const map = new Map(current.map((item) => [item.value, item]));
          for (const item of next) map.set(item.value, item);
          for (const id of incidentsAssignedTo) {
            if (!map.has(id)) {
              map.set(id, { value: id, label: id, count: 0 });
            }
          }
          return [...map.values()];
        });
        setSectionError("incidents", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setHomeIncidents([]);
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
    alertItemLimit,
    alertStatus,
    beginQuietUpdate,
    endQuietUpdate,
    incidentsAssignedTo,
    incidentItemLimit,
    incidentsMode,
    eventItemLimit,
    operatorItemLimit,
    selectedCustomerKeys,
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

  const openIncident = useCallback((item: OneViewIncident) => {
    setSelectedIncident(item);
  }, []);

  const closeIncident = useCallback(() => {
    setSelectedIncident(null);
  }, []);

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

  useEffect(() => {
    void loadCriticalHomeAlerts();
    return () => criticalAlertsRequest.current?.abort();
  }, [loadCriticalHomeAlerts]);
  useEffect(() => {
    if (!criticalHomeReady) return;
    void loadSummary(hasSummaryRef.current ? "quiet" : "initial");
  }, [criticalHomeReady, loadSummary]);
  useEffect(() => {
    if (!criticalHomeReady) return;
    void loadLists(hasListsRef.current ? "quiet" : "initial");
    return () => listsRequest.current?.abort();
  }, [criticalHomeReady, loadLists]);
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
  const showIncidentAnalysts = incidentsMode !== INCIDENTS_QUEUE_MODE.unassigned;
  const selectedIncidentKey = selectedIncident ? operationalIncidentKey(selectedIncident) : null;
  const incidentsTitleCount = Math.max(0, Math.trunc(Number(incidentsTotal) || homeIncidents.length || 0));
  const incidentsPanelTitle = incidentsMode === INCIDENTS_QUEUE_MODE.assigned
    ? `${incidentsTitleCount.toLocaleString("pt-BR")} em acompanhamento`
    : incidentsMode === INCIDENTS_QUEUE_MODE.all
      ? `${incidentsTitleCount.toLocaleString("pt-BR")} chamados`
      : `${incidentsTitleCount.toLocaleString("pt-BR")} sem responsável`;
  const chamadosHref = buildOperationalChamadosHref({ mode: incidentsMode, assignedTo: incidentsAssignedTo });
  const visibleHomeAlerts = homeAlerts.slice(0, alertItemLimit);
  const visibleHomeIncidents = homeIncidents.slice(0, incidentItemLimit);
  const operatorItems = (operatorQueue?.items ?? []).slice(0, operatorItemLimit);
  const homeAlertColumnIds = useMemo(
    () => homeAlertColumns.visibleColumns.map((column) => column.id as HomeAlertColumnId),
    [homeAlertColumns.visibleColumns],
  );
  const homeAlertGrid = useMemo(
    () => homeAlertColumnIds.map((column) => HOME_ALERT_COLUMN_WIDTH[column]).join(" "),
    [homeAlertColumnIds],
  );
  const homeIncidentColumnIds = useMemo(
    () => homeIncidentColumns.visibleColumns.map((column) => column.id as OperationalIncidentQueueColumnId),
    [homeIncidentColumns.visibleColumns],
  );
  const homeIncidentGrid = useMemo(
    () => homeIncidentColumnIds.map((column) => OPERATIONAL_INCIDENT_QUEUE_COLUMN_WIDTH[column]).join(" "),
    [homeIncidentColumnIds],
  );
  const homeOperatorColumnIds = useMemo(
    () => homeOperatorColumns.visibleColumns.map((column) => column.id as HomeOperatorColumnId),
    [homeOperatorColumns.visibleColumns],
  );
  const homeOperatorGrid = useMemo(
    () => homeOperatorColumnIds.map((column) => HOME_OPERATOR_COLUMN_WIDTH[column]).join(" "),
    [homeOperatorColumnIds],
  );
  const normalizedEventSearch = eventSearch.trim().toLocaleLowerCase("pt-BR");
  const visibleRecentEvents = recentEvents
    .filter((item) => !normalizedEventSearch || [item.customer_name, canonicalHostName(item), item.problem_name, item.severity]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(normalizedEventSearch)))
    .slice(0, eventItemLimit);
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
      tone: severity === "information" ? "info" as const : severity === "warning" || severity === "average" ? "warning" as const : "danger" as const,
      description: `${homeOperationalWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
      selected: severityFilter === severity,
      onClick: () => toggleSeverityStrip(severity),
    };
  });
  const homeMetricStripItems = useMemo(() => {
    const byId = new Map(severityStripItems.map((item) => [item.key, item]));
    return homeMetrics.visibleMetrics.flatMap((metric) => {
      const item = byId.get(metric.id);
      return item ? [{
        ...item,
        span: homeMetrics.span[metric.id] ?? 2,
        rowSpan: homeMetrics.rowSpan[metric.id] ?? 1,
      }] : [];
    });
  }, [homeMetrics.rowSpan, homeMetrics.span, homeMetrics.visibleMetrics, severityStripItems]);

  const headerControls = dashboard.isWallboard ? null : (
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

  const contextBar = dashboard.isWallboard ? null : (
    <section aria-label="Contexto operacional" className="ov-panel flex flex-wrap items-center justify-between gap-2 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">Período</span>
        {windowSelector}
      </div>
      <span className="ov-type-caption text-muted-foreground">
        Atualizado: <span className="font-semibold text-foreground">{formatClock(lastCheckedAt)}</span>
      </span>
    </section>
  );

  return (
    <AppLayout
      clientSelect={(
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <SectionAccentTitle level={1}>Início</SectionAccentTitle>
          {showInitialLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
      )}
      topbarRightSection={headerControls}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      wallboard={dashboard.isWallboard}
      contentClassName="gap-2 p-3 lg:px-4"
    >
      {contextBar}
      <ConfigurableDashboard controller={dashboard} metricStrip={homeMetrics}>
        <ConfigurableDashboardWidget id="operational-summary">
        <SectionPanel
          aria-label="Resumo operacional"
          title={<SectionAccentTitle>Resumo operacional</SectionAccentTitle>}
          className="px-0"
          headerClassName="px-4 py-3"
          bodyClassName="p-4"
          aside={sectionErrors.summary ? (
            <Button type="button" size="sm" variant="outline" className="ov-error-action h-7 px-2 text-xs" onClick={() => void loadSummary("manual")}>
              Tentar novamente
            </Button>
          ) : null}
        >
          <ConfigurableMetricStrip
            aria-label="Severidades ativas na janela"
            controller={homeMetrics}
            editable={dashboard.isEditing}
            gridProfile="twelve"
            gridClassName="ov-home-metric-grid"
            items={homeMetricStripItems}
            surface={false}
          />
          {sectionErrors.summary ? (
            <OperationalErrorBanner className="mt-1.5 rounded-none border-x-0 border-b-0" message={sectionErrors.summary} />
          ) : null}
        </SectionPanel>
        </ConfigurableDashboardWidget>

        {/* Alertas | Chamados lado a lado, como no Monitoramento. */}
        <ConfigurableDashboardWidget id="recent-alerts">
          <SectionPanel
            className="flex min-h-0 flex-col overflow-hidden"
            aria-label="Alertas recentes"
            title={<SectionAccentTitle>Alertas recentes</SectionAccentTitle>}
            headerClassName="px-4 py-3"
            aside={dashboard.isWallboard ? null : (
              <div className={HOME_PANEL_HEADER_ASIDE}>
                <HomePanelCount value={alertsTotal} />
                <OperationalCta to={homeAlertsHref}>Ver todos</OperationalCta>
              </div>
            )}
            bodyClassName="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-0"
          >
            {!dashboard.isWallboard ? <div className={HOME_FILTER_ROW}>
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
                  countNoun={customerFilterCountNoun(alertMode === HOME_ALERT_MODE.prioritary ? "prioritary" : "filter")}
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
            </div> : null}
            {!dashboard.isWallboard ? (
              <div className="flex justify-end border-b border-border/60 py-1">
                <ConfigurableTableColumns controller={homeAlertColumns} />
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
              <SectionState
                loading={isListsLoading && !homeAlerts.length}
                error={sectionErrors.alerts ?? null}
                empty={!homeAlerts.length}
                emptyMessage="Nenhum alerta recente na fila operacional com os filtros atuais."
                onRetry={() => void loadLists("manual")}
              >
                <div style={{ minWidth: HOME_ALERT_TABLE_MIN_WIDTH }}>
                  <div
                    className="ov-monitoring-table-grid sticky top-0 z-[1] grid gap-x-3 border-b border-border/70 bg-card px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    style={{ gridTemplateColumns: homeAlertGrid }}
                    aria-hidden="true"
                  >
                    {homeAlertColumns.visibleColumns.map((column) => (
                      <span key={column.id} className={cn("min-w-0 truncate", homeColumnAlign(column.id))}>{column.label}</span>
                    ))}
                  </div>
                  {visibleHomeAlerts.map((alert) => (
                    <HomeAlertRow
                      key={alert.id}
                      alert={alert}
                      onOpen={openAlert}
                      columns={homeAlertColumnIds}
                      gridTemplate={homeAlertGrid}
                      selected={selectedAlertId === alert.id}
                    />
                  ))}
                </div>
              </SectionState>
            </div>
            {queueOverflowLabel(alertsTotal, visibleHomeAlerts.length) ? (
              <p className="border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
                {queueOverflowLabel(alertsTotal, visibleHomeAlerts.length)}
              </p>
            ) : null}
          </SectionPanel>
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="incidents">
          <SectionPanel
            className="flex min-h-0 flex-col overflow-hidden"
            aria-label="Chamados"
            title={<SectionAccentTitle>Chamados</SectionAccentTitle>}
            description={incidentsPanelTitle}
            headerClassName="px-4 py-3"
            aside={dashboard.isWallboard ? null : (
              <div className={HOME_PANEL_HEADER_ASIDE}>
                <OperationalCta to={chamadosHref}>Ver todos em Chamados</OperationalCta>
              </div>
            )}
            toolbar={dashboard.isWallboard ? null : (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <OperationalIncidentsToolbar
                  mode={incidentsMode}
                  onModeChange={changeIncidentsMode}
                  assignedTo={incidentsAssignedTo}
                  onAssignedToChange={changeIncidentsAssignedTo}
                  analysts={incidentAssignees}
                />
                <ConfigurableTableColumns controller={homeIncidentColumns} />
              </div>
            )}
            toolbarClassName="px-4 py-2"
            bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3 pt-2"
          >
            {sectionErrors.incidents ? (
              <OperationalErrorBanner
                className="my-2"
                message={sectionErrors.incidents}
                onRetry={() => void loadLists("manual")}
              />
            ) : (
              <OperationalIncidentsQueueList
                items={visibleHomeIncidents}
                onOpen={openIncident}
                columnIds={homeIncidentColumnIds}
                gridTemplate={homeIncidentGrid}
                columnLabels={homeIncidentColumns.visibleColumns}
                selectedKey={selectedIncidentKey}
                showAnalyst={showIncidentAnalysts}
                loading={isListsLoading && !homeIncidents.length}
                empty={!homeIncidents.length}
                emptyMessage={
                  incidentsMode === INCIDENTS_QUEUE_MODE.assigned
                    ? "Nenhum chamado com analista na janela."
                    : incidentsMode === INCIDENTS_QUEUE_MODE.all
                      ? "Nenhum chamado na janela."
                      : "Nenhum chamado monitoring sem responsável."
                }
                onActionComplete={() => void loadLists("manual")}
              />
            )}
          </SectionPanel>
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="failed-links">
        <SectionPanel
          className="overflow-hidden"
          title="Links de operadoras"
          aside={dashboard.isWallboard ? null : <OperationalCta to="/operadoras">Ver conectividade</OperationalCta>}
          bodyClassName="px-3 pb-2 pt-0"
        >
          <div className="grid grid-cols-3 gap-2 border-b border-border/60 py-2 text-center">
            <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.all)}</p><p className="text-[10px] text-muted-foreground">Ativos</p></div>
            <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.unassigned)}</p><p className="text-[10px] text-muted-foreground">Sem responsável</p></div>
            <div><p className="text-base font-semibold tabular-nums">{formatMetricCount(operatorCounts?.following)}</p><p className="text-[10px] text-muted-foreground">Em acompanhamento</p></div>
          </div>
          {!dashboard.isWallboard ? (
            <div className="flex justify-end border-b border-border/60 py-1">
              <ConfigurableTableColumns controller={homeOperatorColumns} />
            </div>
          ) : null}
          <SectionState
            loading={isListsLoading && !operatorQueue && !sectionErrors.operators}
            error={sectionErrors.operators ?? null}
            empty={!operatorItems.length}
            emptyMessage="Nenhum alerta ativo de operadora."
            emptyClassName="py-3"
            onRetry={() => void loadLists("manual")}
          >
            <div className="overflow-x-auto">
              <div style={{ minWidth: HOME_OPERATOR_TABLE_MIN_WIDTH }}>
                <div
                  className="ov-monitoring-table-grid grid gap-x-3 border-b border-border/70 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  style={{ gridTemplateColumns: homeOperatorGrid }}
                  aria-hidden="true"
                >
                  {homeOperatorColumns.visibleColumns.map((column) => (
                    <span key={column.id} className={cn("min-w-0 truncate", homeColumnAlign(column.id))}>{column.label}</span>
                  ))}
                </div>
                {operatorItems.map((item) => (
                  <HomeOperatorRow
                    key={item.alert_id || `${item.incident_number}-${item.operator_tag}`}
                    item={item}
                    columns={homeOperatorColumnIds}
                    gridTemplate={homeOperatorGrid}
                  />
                ))}
              </div>
            </div>
          </SectionState>
        </SectionPanel>
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="recent-events">
        <SectionPanel
          className="flex min-h-0 flex-col overflow-hidden"
          title="Eventos recentes"
          aside={dashboard.isWallboard ? null : (
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
            <ConfigurableTableToolbar
              search={eventSearch}
              onSearchChange={setEventSearch}
              searchPlaceholder="Buscar nos eventos carregados…"
              searchLabel="Buscar na tabela de eventos recentes"
              columns={homeEventColumns}
              scopeHint="A busca considera os eventos carregados neste painel."
            />
            <div className="max-h-[18rem] overflow-auto xl:max-h-[20rem]">
              <table className="w-full min-w-[36rem] table-fixed text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-card">
                  <tr className="border-b border-border/70 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {homeEventColumns.visibleColumns.map((column) => <th key={column.id} className="px-3 py-1.5 font-semibold">{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {!visibleRecentEvents.length ? (
                    <tr><td colSpan={homeEventColumns.visibleColumns.length} className="px-3 py-5 text-center text-xs text-muted-foreground">Nenhum evento corresponde à busca.</td></tr>
                  ) : null}
                  {visibleRecentEvents.map((item) => (
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
                      {homeEventColumns.visibleColumns.map((column) => {
                        if (column.id === "client") return <td key={column.id} className="truncate px-3 py-1.5 text-[11px] font-semibold text-foreground"><span className="inline-flex max-w-full items-center gap-1.5"><ClientIdentity customer={{ key: item.customer_key, name: item.customer_name }} operationalScope={item.operational_scope} operationalScopeLabel={item.operational_scope_label} size="sm" className="shrink-0" /><TruncatedText className="text-[11px] font-semibold text-foreground">{operationalClientLabel({ key: item.customer_key, name: item.customer_name, operational_scope: item.operational_scope, operational_scope_label: item.operational_scope_label })}</TruncatedText></span></td>;
                        if (column.id === "host") return <td key={column.id} className="px-3 py-1.5 text-[11px] text-foreground/80"><TruncatedText>{canonicalHostName(item)}</TruncatedText></td>;
                        if (column.id === "problem") return <td key={column.id} className="px-3 py-1.5 text-[11px] text-muted-foreground"><TruncatedText>{item.problem_name || "—"}</TruncatedText></td>;
                        if (column.id === "severity") return <td key={column.id} className="px-3 py-1.5">{item.severity ? <OneViewSeverityBadge severity={item.severity} showDot={false} className="h-5 px-1.5" /> : "—"}</td>;
                        return <td key={column.id} className="whitespace-nowrap px-3 py-1.5 text-[11px] text-muted-foreground">{formatClock(item.occurred_at)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionState>
        </SectionPanel>
        </ConfigurableDashboardWidget>
      </ConfigurableDashboard>

      <IncidentDetailDrawer
        incident={selectedIncident}
        onOpenChange={(open) => { if (!open) closeIncident(); }}
        description="Consulta rápida sem sair da Home."
      />

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
