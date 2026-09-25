import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Eye, Loader2, RefreshCcw, ChevronsUpDown, Check } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TeletexMark } from "@/components/layout/TeletexMark";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import { ZabbixSourceFilter } from "@/components/oneview/ZabbixSourceFilter";
import {
  ClientIdentity,
  CLASSIFICATION_PENDING_LABEL,
  canonicalHostName,
  facetCustomerDisplayName,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { ConfigurableMetricStrip } from "@/components/oneview/ConfigurableMetricStrip";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableToolbar } from "@/components/oneview/ConfigurableTableTools";
import { IncidentDetailDrawer } from "@/components/oneview/IncidentDetailDrawer";
import { OperationalCta } from "@/components/oneview/OperationalCta";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { OperationalFilterGroup } from "@/components/oneview/OperationalFilterGroup";
import { OperationalIncidentsToolbar } from "@/components/oneview/OperationalIncidentsToolbar";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { PlatformHealthStrip } from "@/components/oneview/PlatformHealthStrip";
import { OneViewSemanticStatusBadge, OneViewSeverityBadge, SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { TruncatedText } from "@/components/oneview/TruncatedText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/context/AuthContext";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewMetricStrip } from "@/lib/oneview-metric-strip-preferences";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { dashboardWidgetsForPage } from "@/lib/oneview-dashboard-layout";
import { OV_FILTER_CHIP, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  IncidentAssigneeFacet,
  OneViewAlert,
  OneViewFacetsResponse,
  OneViewIncident,
  OneViewSeverity,
  fetchAlert,
  fetchAlertHistory,
  fetchIncidents,
  formatNullableCount,
  formatOneViewSeverityLabel,
  bucketOneViewReadNow,
} from "@/lib/oneview-api";
import {
  activeFreshAttentionIds,
  freshAttentionTone,
  reconcileFreshAttention,
  sameStringSet,
  type FreshAttentionTone,
} from "@/lib/oneview-fresh-attention";
import { getOneViewFacets, peekOneViewFacets } from "@/lib/oneview-facets-store";
import {
  LIVE_TRANSITION_DURATION_MS,
  detectLiveTransitions,
  isLiveTransitionActive,
  mergeLiveTransitionQueue,
  prunePinnedByTransitions,
  reconcileLiveTransitions,
  sameLiveTransitionMap,
  snapshotFromAlert,
  snapshotFromIncident,
  toLiveSnapshotMap,
  type LiveTransition,
} from "@/lib/oneview-live-transition";
import {
  DEFAULT_MONITOR_WINDOW,
  MONITOR_ALERT_MODE,
  MONITOR_QUEUE_LIMIT,
  MONITOR_QUEUE_ITEM_LIMIT_OPTIONS,
  MONITOR_QUEUE_SORT,
  MONITOR_QUEUE_SORT_OPTIONS,
  MONITOR_SEVERITY_CHIP_OPTIONS,
  MONITOR_UNASSIGNED_LIMIT,
  MONITOR_UNASSIGNED_OPERATIONAL_STATES,
  MONITOR_WINDOW_OPTIONS,
  buildMonitoringChamadosHref,
  effectiveMonitorSeverities,
  fetchMonitoringAlerts,
  fetchMonitoringUnassignedIncidents,
  monitorWindowActiveLabel,
  monitorWindowMs,
  monitorWindowShortLabel,
  parseMonitorAlertMode,
  parseMonitorQueueSort,
  parseMonitorSeveritySelection,
  parseMonitorWindow,
  type MonitorAlertMode,
  type MonitorAlertSeverity,
  type MonitorQueueSort,
  type MonitorWindowPreset,
} from "@/lib/oneview-monitoring";
import {
  INCIDENTS_QUEUE_MODE,
  analystFacetOptions,
  applyIncidentsQueueToSearchParams,
  parseAssignedToSysIds,
  parseIncidentsQueueMode,
  type IncidentsQueueMode,
} from "@/lib/oneview-operational-incidents";
import {
  RecentOperationalMetrics,
  fetchRecentOperationalMetrics,
  queueOverflowLabel,
} from "@/lib/oneview-recent";
import {
  customerFilterCountNoun,
  isDatasourceOnlyFilterValue,
  splitLegacyCustomerQuery,
  augmentCustomerFacetsWithDedicatedDatasources,
  mergeOperationalZabbixSourceFilterOptions,
  zabbixSourceKey,
} from "@/lib/oneview-zabbix-source";
import { createOneViewQueryGeneration } from "@/lib/oneview-query-generation";

/** OV-P0-255 — polling operacional 10s. */
const REFRESH_MS = 10_000;

/** OV-P0-43: faixa visual das cinco severidades (Not classified no chip discreto). */
const MONITOR_VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];

type SectionErrors = Partial<Record<"summary" | "queue" | "incidents", string | null>>;

/**
 * Grid da fila — Cliente | Host | Problema | Severidade | ACK | Início | Duração | Ação.
 * Trilhas fixas + Problema flexível. Header e linhas compartilham a mesma largura
 * (w-full num wrapper com min-width), para as colunas ficarem alinhadas.
 */
const MONITOR_ALERT_COLUMNS = [
  { id: "client", label: "Cliente" },
  { id: "host", label: "Host" },
  { id: "problem", label: "Problema", required: true },
  { id: "severity", label: "Severidade" },
  { id: "ack", label: "ACK" },
  { id: "started", label: "Início" },
  { id: "duration", label: "Duração" },
  { id: "action", label: "Ação" },
] as const;
type MonitorAlertColumnId = typeof MONITOR_ALERT_COLUMNS[number]["id"];

const MONITOR_INCIDENT_COLUMNS = [
  { id: "number", label: "Número", required: true },
  { id: "description", label: "Descrição" },
  { id: "client", label: "Cliente" },
  { id: "updated", label: "Atualização" },
  { id: "analyst", label: "Analista" },
  { id: "priority", label: "Prioridade" },
  { id: "state", label: "Estado" },
] as const;
type MonitorIncidentColumnId = typeof MONITOR_INCIDENT_COLUMNS[number]["id"];

const MONITOR_ALERT_COLUMN_WIDTH: Record<MonitorAlertColumnId, string> = {
  client: "11rem",
  host: "12rem",
  problem: "minmax(0,1fr)",
  severity: "8rem",
  ack: "7rem",
  started: "6.5rem",
  duration: "5.75rem",
  action: "4rem",
};
const MONITOR_INCIDENT_COLUMN_WIDTH: Record<MonitorIncidentColumnId, string> = {
  number: "7.5rem",
  description: "minmax(10rem,1.25fr)",
  client: "minmax(8rem,0.85fr)",
  updated: "6.5rem",
  analyst: "8rem",
  priority: "7rem",
  state: "7.5rem",
};

const MONITOR_ALERT_TABLE_MIN_WIDTH = "64rem";
const MONITOR_INCIDENT_TABLE_MIN_WIDTH = "52rem";

function monitorColumnAlign(column: string) {
  if (column === "started" || column === "duration" || column === "updated") return "justify-self-end text-right";
  if (column === "action") return "justify-self-center text-center";
  return "justify-self-start text-left";
}

const MONITORING_DASHBOARD_WIDGETS = dashboardWidgetsForPage("monitoring").filter((widget) => widget.id !== "health");
const MONITORING_METRIC_OPTIONS = [
  { id: "information", label: "Informação", defaultSpan: 2 },
  { id: "warning", label: "Warning", defaultSpan: 2 },
  { id: "average", label: "Average", defaultSpan: 2 },
  { id: "high", label: "High", defaultSpan: 2 },
  { id: "disaster", label: "Disaster", defaultSpan: 2 },
] as const;

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

/** OV-P0-83 — início compacto PT-BR (first_seen_at). */
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

function formatUpdatedAgo(value?: string | null) {
  if (!value) return "—";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "—";
  return formatDurationSeconds(elapsedMs / 1000);
}

function displayIncidentField(value?: string | null, fallback?: string | null) {
  const primary = String(value || "").trim();
  if (primary && primary !== "undefined" && primary !== "null") return primary;
  const secondary = String(fallback || "").trim();
  if (secondary && secondary !== "undefined" && secondary !== "null") return secondary;
  return "—";
}

function safeActorName(value?: string | null) {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor;
}

function historyOrigin(item: AlertHistoryItem) {
  if (item.origin === "oneview_internal") return "OneView";
  if (item.legacy) return "Legado";
  return "Origem";
}

function historyEventLabel(eventType: string) {
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

function incidentKey(item: OneViewIncident) {
  return String(item.sys_id || item.number || "").trim();
}

function Panel({
  title,
  description,
  error,
  onRetry,
  overflow,
  empty,
  aside,
  toolbar,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  error?: string | null;
  onRetry?: () => void;
  overflow?: string | null;
  empty?: boolean;
  aside?: ReactNode;
  /** OV-P0-104 — controles da fila abaixo do título do painel. */
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "ov-panel flex flex-col overflow-hidden",
        empty ? "shrink-0" : "min-h-0 flex-1",
        className,
      )}
    >
      <div className="flex shrink-0 flex-col items-stretch gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {typeof title === "string" ? <h2 className="ov-type-section-title break-words text-foreground">{title}</h2> : title}
          {description ? <p className="ov-type-secondary text-muted-foreground">{description}</p> : null}
          {overflow ? <p className="text-[11px] font-medium text-muted-foreground">{overflow}</p> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5 sm:shrink-0 sm:justify-end">
          {aside}
          {error ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={onRetry}
            >
              <RefreshCcw className="mr-1 h-3 w-3" />
              Tentar
            </Button>
          ) : null}
        </div>
      </div>
      {toolbar ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
          {toolbar}
        </div>
      ) : null}
      {error ? <p className="shrink-0 px-4 py-1.5 ov-typography-small text-[hsl(var(--ov-color-warning))]">{error}</p> : null}
      <div className={cn("overflow-hidden px-4", empty ? "py-1.5" : "min-h-0 flex-1 py-2")}>{children}</div>
    </section>
  );
}

function MonitorUnassignedRow({
  item,
  onOpen,
  columns,
  gridTemplate,
  selected = false,
  showAnalyst = false,
  liveTransition = null,
}: {
  item: OneViewIncident;
  onOpen: (item: OneViewIncident) => void;
  columns: readonly MonitorIncidentColumnId[];
  gridTemplate: string;
  selected?: boolean;
  showAnalyst?: boolean;
  liveTransition?: LiveTransition | null;
}) {
  const number = displayIncidentField(item.number);
  const analyst = displayIncidentField(item.assigned_to_display, item.assigned_to);
  const incidentDescription = displayIncidentField(item.short_description, item.description);
  const cells: Record<MonitorIncidentColumnId, ReactNode> = {
    number: <span key="number" className="block truncate text-[13px] font-semibold text-foreground" title={number}>{number}</span>,
    description: <span key="description" className="block truncate text-[11px] text-foreground/85" title={incidentDescription}>{incidentDescription}</span>,
    client: <span key="client" className="block truncate text-[11px] text-foreground/80" title={displayIncidentField(item.company_display, item.company)}>{displayIncidentField(item.company_display, item.company)}</span>,
    updated: <span key="updated" className="block truncate text-[11px] tabular-nums text-muted-foreground" title={formatUpdatedAgo(item.sys_updated_on)}>{formatUpdatedAgo(item.sys_updated_on)}</span>,
    analyst: <span key="analyst" className="block truncate text-[10px] text-muted-foreground" title={analyst}>{showAnalyst ? analyst : "—"}</span>,
    priority: <span key="priority"><Badge variant="secondary" className="h-5 max-w-full truncate px-1.5 text-[10px]">{displayIncidentField(item.priority_display, item.priority)}</Badge></span>,
    state: <span key="state"><Badge variant="outline" className="h-5 max-w-full truncate px-1.5 text-[10px]">{displayIncidentField(item.state_display, item.state)}</Badge></span>,
  };
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "ov-monitoring-table-grid grid w-full min-h-10 items-center gap-x-3 border-b border-border/50 px-1 py-1.5 text-left last:border-b-0 transition-colors hover:bg-muted/40",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
        liveTransition && "ov-live-transition",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
      aria-label={`Abrir chamado ${number}${liveTransition ? ` · ${liveTransition.label}` : ""}`}
    >
      {columns.map((column) => <span key={column} className={cn("min-w-0 overflow-hidden", monitorColumnAlign(column))}>{cells[column]}</span>)}
      {liveTransition ? <span className="ov-live-transition-badge sr-only" aria-live="polite">{liveTransition.label}</span> : null}
    </button>
  );
}

/**
 * OV-P0-72 / OV-P0-76 / OV-P0-77 / OV-P0-82 — linha da fila tabular.
 * Clique / Abrir → drawer inline (?alert=); cor só no badge de severidade.
 * Seleção (?alert=): destaque discreto, sem background de severidade na row.
 */
function MonitorAlertRow({
  alert,
  onOpen,
  columns,
  gridTemplate,
  selected = false,
  freshTone = null,
  liveTransition = null,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
  columns: readonly MonitorAlertColumnId[];
  gridTemplate: string;
  selected?: boolean;
  freshTone?: FreshAttentionTone | null;
  liveTransition?: LiveTransition | null;
}) {
  const acked = Boolean(alert.acknowledged_source);
  const fresh = Boolean(freshTone);
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
  const cells: Record<MonitorAlertColumnId, ReactNode> = {
    client: (
      <span key="client" className="flex min-w-0 items-center gap-2" title={clientTitle}>
        <ClientIdentity customer={{ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source }} operationalScope={alert.operational_scope} operationalScopeLabel={alert.operational_scope_label} size="xs" className="shrink-0" />
        <TruncatedText className="text-sm font-semibold text-foreground" title={clientTitle}>{clientLabel}</TruncatedText>
      </span>
    ),
    host: <TruncatedText key="host" className="text-xs text-foreground/85">{canonicalHostName(alert)}</TruncatedText>,
    problem: <TruncatedText key="problem" className="text-xs text-muted-foreground">{alert.problem_name}</TruncatedText>,
    severity: (
      <span key="severity" className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        <OneViewSeverityBadge severity={alert.severity} showDot={false} />
        {liveTransition ? <span className="ov-live-transition-badge" aria-live="polite">{liveTransition.label}</span> : null}
        {fresh ? <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-[hsl(var(--ov-color-danger))]"><span className="ov-fresh-dot" aria-hidden="true" />Novo</span> : null}
      </span>
    ),
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
        "ov-monitoring-table-grid grid w-full min-h-12 items-center gap-x-3 px-1 py-2 text-left transition-colors hover:bg-muted/50",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
        freshTone === "disaster" && "ov-fresh-attention-disaster",
        freshTone === "high" && "ov-fresh-attention-high",
        liveTransition && "ov-live-transition",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
      aria-label={`Abrir alerta ${alert.problem_name || alert.id}${fresh ? " · Novo" : ""}${liveTransition ? ` · ${liveTransition.label}` : ""}`}
    >
      {columns.map((column) => <span key={column} className={cn("min-w-0 overflow-hidden", monitorColumnAlign(column))}>{cells[column]}</span>)}
    </button>
  );
}

export default function MonitoringPage() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({
    page: "monitoring",
    actorId,
    widgets: MONITORING_DASHBOARD_WIDGETS,
  });
  const monitoringMetrics = useOneViewMetricStrip({ stripId: "monitoring-summary", actorId, definitions: MONITORING_METRIC_OPTIONS });
  const monitorAlertColumns = useOneViewTableColumns({ tableId: "monitor-alerts", actorId, definitions: MONITOR_ALERT_COLUMNS });
  const monitorIncidentColumns = useOneViewTableColumns({ tableId: "monitor-incidents", actorId, definitions: MONITOR_INCIDENT_COLUMNS });
  const monitoringQueueItemLimit = dashboard.layout.widgets.find((item) => item.id === "monitoring-queue")?.itemLimit ?? MONITOR_QUEUE_LIMIT;
  const monitoringIncidentItemLimit = dashboard.layout.widgets.find((item) => item.id === "incidents")?.itemLimit ?? MONITOR_UNASSIGNED_LIMIT;
  const [searchParams, setSearchParams] = useSearchParams();
  const tvMode = searchParams.get("tv") === "1";
  const homeWindow = parseMonitorWindow(searchParams.get("window"));
  const windowMs = monitorWindowMs(homeWindow);
  const windowLabel = monitorWindowShortLabel(homeWindow);
  const alertMode = parseMonitorAlertMode(searchParams.get("mode"));
  const incidentsMode = parseIncidentsQueueMode(searchParams.get("incidents"));
  const incidentsAssignedTo = incidentsMode === INCIDENTS_QUEUE_MODE.unassigned
    ? []
    : parseAssignedToSysIds(searchParams.get("assigned_to"));
  const showIncidentAnalysts = incidentsMode !== INCIDENTS_QUEUE_MODE.unassigned;
  const queueSort = useMemo(
    () => parseMonitorQueueSort(searchParams.get("sort")),
    [searchParams],
  );
  const severitySelection = useMemo(
    () => parseMonitorSeveritySelection(searchParams.getAll("severity")),
    [searchParams],
  );
  const activeSeverities = useMemo(
    () => effectiveMonitorSeverities(alertMode, severitySelection),
    [alertMode, severitySelection],
  );

  const [recentMetrics, setRecentMetrics] = useState<RecentOperationalMetrics | null>(null);
  const [alertSearch, setAlertSearch] = useState("");
  const [incidentSearch, setIncidentSearch] = useState("");
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(() => peekOneViewFacets());
  const [queueAlerts, setQueueAlerts] = useState<OneViewAlert[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [unassignedIncidents, setUnassignedIncidents] = useState<OneViewIncident[]>([]);
  const [unassignedTotal, setUnassignedTotal] = useState(0);
  const [incidentAssignees, setIncidentAssignees] = useState<IncidentAssigneeFacet[]>([]);
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({});
  const [isUpdating, setIsUpdating] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const requestedAlertId = searchParams.get("alert");
  const requestedIncidentId = searchParams.get("incident");
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<OneViewAlert | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<OneViewIncident | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const [navOpen, setNavOpen] = useState(() => {
    try {
      const raw = sessionStorage.getItem("oneview-monitor-sidebar-open");
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {
      // sessionStorage pode estar indisponível.
    }
    return true;
  });
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);
  const [severityFilterOpen, setSeverityFilterOpen] = useState(false);
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>(() =>
    splitLegacyCustomerQuery(searchParams.getAll("customer")).customers,
  );
  const [selectedDatasources, setSelectedDatasources] = useState<string[]>(() => {
    const migrated = splitLegacyCustomerQuery(searchParams.getAll("customer")).datasources;
    const fromQuery = searchParams.getAll("datasource").map((value) => zabbixSourceKey(value)).filter(Boolean);
    return [...new Set([...fromQuery, ...migrated])];
  });

  const inFlight = useRef<Promise<void> | null>(null);
  const refreshAllRef = useRef<() => Promise<void>>(async () => {});
  const queryGenerationRef = useRef(createOneViewQueryGeneration());
  const listsAbort = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);
  const freshKnownIdsRef = useRef<Set<string>>(new Set());
  const freshStartedAtRef = useRef<Map<string, number>>(new Map());
  const freshSeededRef = useRef(false);
  const [freshAttentionIds, setFreshAttentionIds] = useState<Set<string>>(new Set());
  const pollGenerationRef = useRef(0);
  const alertSnapshotReadyRef = useRef(false);
  const previousAlertsRef = useRef<Map<string, OneViewAlert>>(new Map());
  const alertConsumedKeysRef = useRef<Set<string>>(new Set());
  const alertTransitionsRef = useRef<Map<string, LiveTransition>>(new Map());
  const alertPinnedRef = useRef<Map<string, OneViewAlert>>(new Map());
  const [alertTransitions, setAlertTransitions] = useState<Map<string, LiveTransition>>(new Map());
  const incidentSnapshotReadyRef = useRef(false);
  const previousIncidentsRef = useRef<Map<string, OneViewIncident>>(new Map());
  const incidentConsumedKeysRef = useRef<Set<string>>(new Set());
  const incidentTransitionsRef = useRef<Map<string, LiveTransition>>(new Map());
  const incidentPinnedRef = useRef<Map<string, OneViewIncident>>(new Map());
  const [incidentTransitions, setIncidentTransitions] = useState<Map<string, LiveTransition>>(new Map());

  const setSectionError = useCallback((key: keyof SectionErrors, value: string | null) => {
    setSectionErrors((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);

  const patchSearchParams = useCallback((mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    mutate(next);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const setMonitorWindow = useCallback((preset: MonitorWindowPreset) => {
    patchSearchParams((next) => {
      next.set("window", parseMonitorWindow(preset));
    });
  }, [patchSearchParams]);

  const setAlertMode = useCallback((mode: MonitorAlertMode) => {
    patchSearchParams((next) => {
      next.set("mode", parseMonitorAlertMode(mode));
      // Troca de modo reseta chips → default do modo (Prioritários / Todos).
      next.delete("severity");
    });
  }, [patchSearchParams]);

  const setQueueSort = useCallback((sort: MonitorQueueSort) => {
    patchSearchParams((next) => {
      const parsed = parseMonitorQueueSort(sort);
      if (parsed === MONITOR_QUEUE_SORT.recent) {
        next.delete("sort");
      } else {
        next.set("sort", parsed);
      }
    });
  }, [patchSearchParams]);

  const setIncidentsMode = useCallback((mode: IncidentsQueueMode) => {
    patchSearchParams((next) => {
      applyIncidentsQueueToSearchParams(
        next,
        mode,
        mode === INCIDENTS_QUEUE_MODE.unassigned ? [] : incidentsAssignedTo,
      );
    });
  }, [incidentsAssignedTo, patchSearchParams]);

  const setIncidentsAssignedTo = useCallback((assignedTo: string[]) => {
    patchSearchParams((next) => {
      applyIncidentsQueueToSearchParams(
        next,
        incidentsMode === INCIDENTS_QUEUE_MODE.unassigned
          ? INCIDENTS_QUEUE_MODE.assigned
          : incidentsMode,
        assignedTo,
      );
    });
  }, [incidentsMode, patchSearchParams]);

  const setSeveritySelection = useCallback((values: MonitorAlertSeverity[]) => {
    patchSearchParams((next) => {
      next.delete("severity");
      const unique = parseMonitorSeveritySelection(values);
      const defaults = effectiveMonitorSeverities(parseMonitorAlertMode(next.get("mode")), null);
      const isDefault = unique.length === defaults.length
        && defaults.every((item) => unique.includes(item));
      if (!isDefault && unique.length) {
        unique.forEach((severity) => next.append("severity", severity));
      }
    });
  }, [patchSearchParams]);

  const toggleSeverityChip = useCallback((severity: MonitorAlertSeverity) => {
    const current = severitySelection.length ? [...severitySelection] : [...activeSeverities];
    const next = current.includes(severity)
      ? current.filter((item) => item !== severity)
      : [...current, severity];
    // Lista vazia → default do modo (Prioritários / Todos).
    setSeveritySelection(next);
  }, [activeSeverities, setSeveritySelection, severitySelection]);

  useEffect(() => {
    const raw = searchParams.get("window");
    const parsed = parseMonitorWindow(raw);
    if (raw === parsed) return;
    patchSearchParams((next) => {
      next.set("window", parsed);
    });
  }, [patchSearchParams, searchParams]);

  useEffect(() => {
    const rawMode = searchParams.get("mode");
    const parsed = parseMonitorAlertMode(rawMode);
    if (rawMode === parsed) return;
    if (rawMode == null && parsed === MONITOR_ALERT_MODE.prioritary) {
      // Default implícito — não força ?mode= na URL até o usuário alterar.
      return;
    }
    patchSearchParams((next) => {
      next.set("mode", parsed);
    });
  }, [patchSearchParams, searchParams]);

  useEffect(() => {
    patchSearchParams((next) => {
      next.delete("customer");
      next.delete("datasource");
      selectedCustomerKeys.forEach((value) => next.append("customer", value));
      selectedDatasources.forEach((value) => next.append("datasource", value));
    });
  }, [patchSearchParams, selectedCustomerKeys, selectedDatasources]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  const zabbixSourceFilterOptions = useMemo(
    () => mergeOperationalZabbixSourceFilterOptions(facets?.datasources),
    [facets?.datasources],
  );

  const customerCards = useMemo(() => {
    const customers = augmentCustomerFacetsWithDedicatedDatasources(
      (facets?.customers ?? [])
        .filter((customer) => !isDatasourceOnlyFilterValue(customer.key) && !isDatasourceOnlyFilterValue(customer.name))
        .map((customer) => ({
          ...customer,
          name: facetCustomerDisplayName(customer),
          alerts_count: null,
        })),
      facets?.datasources,
    );
    return [
      { key: "all", name: "Todos" },
      ...customers,
    ];
  }, [facets?.customers, facets?.datasources]);

  const selectedCustomerLabel = useMemo(() => {
    if (selectedCustomerKeys.length === 0) return "TODOS";
    if (selectedCustomerKeys.length > 1) return `${selectedCustomerKeys.length} CLIENTES`;
    const selected = customerCards.find((customer) => customer.key === selectedCustomerKeys[0]);
    return (selected?.name || "CLIENTE").toUpperCase();
  }, [customerCards, selectedCustomerKeys]);

  const hasValidSummary = Boolean(recentMetrics);
  const severityStripLoading = isUpdating && !recentMetrics;
  const severityCounts = hasValidSummary ? recentMetrics?.by_severity ?? null : null;
  const severityStripItems = MONITOR_VISUAL_SEVERITY_STRIP.map((severity) => {
    const value = severityCounts?.[severity] ?? null;
    return {
      key: severity,
      label: formatOneViewSeverityLabel(severity),
      value: formatNullableCount(value),
      tone: severity === "information" ? "info" as const : severity === "warning" || severity === "average" ? "warning" as const : "danger" as const,
      description: `${monitorWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
      // OV-P0-82: clique aplica/remove filtro server-side na própria /monitoramento.
      selected: activeSeverities.includes(severity),
      onClick: () => toggleSeverityChip(severity),
    };
  });
  const severityMetricStripItems = useMemo(() => {
    const byId = new Map(severityStripItems.map((item) => [item.key, item]));
    return monitoringMetrics.visibleMetrics.flatMap((metric) => {
      const item = byId.get(metric.id);
      return item ? [{
        ...item,
        span: monitoringMetrics.span[metric.id] ?? 2,
        rowSpan: monitoringMetrics.rowSpan[metric.id] ?? 1,
      }] : [];
    });
  }, [monitoringMetrics.rowSpan, monitoringMetrics.span, monitoringMetrics.visibleMetrics, severityStripItems]);

  const queueEmpty = hasLoaded && !queueAlerts.length && !sectionErrors.queue;
  const unassignedEmpty = hasLoaded && !unassignedIncidents.length && !sectionErrors.incidents;
  const modeLabel = alertMode === MONITOR_ALERT_MODE.prioritary ? "Prioritários" : "Todos";
  const unassignedTitleCount = Math.max(0, Math.trunc(Number(unassignedTotal) || unassignedIncidents.length || 0));
  const unassignedPanelTitle = incidentsMode === INCIDENTS_QUEUE_MODE.assigned
    ? `${unassignedTitleCount.toLocaleString("pt-BR")} em acompanhamento`
    : incidentsMode === INCIDENTS_QUEUE_MODE.all
      ? `${unassignedTitleCount.toLocaleString("pt-BR")} chamados`
      : `${unassignedTitleCount.toLocaleString("pt-BR")} sem responsável`;
  const queuePanelDescription = `${modeLabel} · últimas ${windowLabel}`;
  const lastUpdatedLabel = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
  const selectedIncidentKey = selectedIncident ? incidentKey(selectedIncident) : null;

  const toggleCustomer = (key: string) => {
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const monitoringQueryKey = useMemo(() => JSON.stringify({
    alertMode,
    severitySelection,
    customers: selectedCustomerKeys,
    datasources: selectedDatasources,
    queueSort,
    incidentsMode,
    incidentsAssignedTo,
    windowMs,
    monitoringQueueItemLimit,
    monitoringIncidentItemLimit,
  }), [
    alertMode,
    incidentsAssignedTo,
    incidentsMode,
    monitoringIncidentItemLimit,
    monitoringQueueItemLimit,
    queueSort,
    selectedCustomerKeys,
    selectedDatasources,
    severitySelection,
    windowMs,
  ]);

  useEffect(() => {
    queryGenerationRef.current.advance();
    queryGenerationRef.current.deferCurrentIfDifferent();
    listsAbort.current?.abort();
  }, [monitoringQueryKey]);

  const refreshAll = useCallback(async () => {
    if (inFlight.current) {
      queryGenerationRef.current.deferCurrentIfDifferent();
      return inFlight.current;
    }
    pollGenerationRef.current += 1;
    const pollGeneration = pollGenerationRef.current;
    const queryGeneration = queryGenerationRef.current.begin();

    const request = (async () => {
      setIsUpdating(true);
      const isInitial = !hasDataRef.current;
      listsAbort.current?.abort();
      const controller = new AbortController();
      listsAbort.current = controller;
      const customers = selectedCustomerKeys.length ? selectedCustomerKeys : undefined;
      const datasources = selectedDatasources.length ? selectedDatasources : undefined;
      const now = bucketOneViewReadNow();

      const tasks: Array<Promise<unknown>> = [
        fetchRecentOperationalMetrics({ customers, datasources, signal: controller.signal, now, windowMs }),
        getOneViewFacets(),
        fetchMonitoringAlerts({
          mode: alertMode,
          severity: severitySelection,
          customers,
          datasources,
          limit: monitoringQueueItemLimit,
          windowMs,
          sort: queueSort,
          signal: controller.signal,
          now,
        }),
        fetchMonitoringUnassignedIncidents({
          mode: incidentsMode,
          assignedTo: incidentsAssignedTo,
          windowMs,
          now,
          limit: monitoringIncidentItemLimit,
          signal: controller.signal,
        }),
      ];

      const results = await Promise.allSettled(tasks);

      if (controller.signal.aborted || !queryGenerationRef.current.isCurrent(queryGeneration)) return;

      const [metricsResult, facetsResult, queueResult, incidentsResult] = results;
      let anySuccess = false;

      if (metricsResult.status === "fulfilled") {
        setRecentMetrics(metricsResult.value as RecentOperationalMetrics);
        setSectionError("summary", null);
        anySuccess = true;
      } else {
        setSectionError(
          "summary",
          isInitial ? "Não foi possível carregar as métricas." : "Falha ao atualizar métricas. Valores anteriores mantidos.",
        );
      }

      if (facetsResult.status === "fulfilled") {
        setFacets(facetsResult.value as OneViewFacetsResponse);
        anySuccess = true;
      }

      if (queueResult.status === "fulfilled") {
        const payload = queueResult.value as Awaited<ReturnType<typeof fetchMonitoringAlerts>>;
        /* OV-P0-268 alert transitions */
        const serverAlerts = payload.items ?? [];
        const previousAlerts = previousAlertsRef.current;
        const nextAlertMap = new Map(serverAlerts.map((item) => [item.id, item]));
        const provenAlertSnapshots = toLiveSnapshotMap(serverAlerts.map((item) => snapshotFromAlert(item)));
        const missingAlertIds = [...previousAlerts.keys()].filter((id) => !nextAlertMap.has(id));
        if (alertSnapshotReadyRef.current && missingAlertIds.length) {
          const proofs = await Promise.allSettled(
            missingAlertIds.slice(0, 5).map(async (id) => {
              const detail = await fetchAlert(id, controller.signal);
              return snapshotFromAlert((detail as { item?: OneViewAlert })?.item ?? (detail as OneViewAlert));
            }),
          );
          if (controller.signal.aborted || pollGeneration !== pollGenerationRef.current) return;
          for (const proof of proofs) {
            if (proof.status !== "fulfilled" || !proof.value?.id) continue;
            provenAlertSnapshots.set(proof.value.id, proof.value);
          }
        }
        if (controller.signal.aborted || pollGeneration !== pollGenerationRef.current) return;
        const detectedAlerts = detectLiveTransitions({
          previousById: toLiveSnapshotMap([...previousAlerts.values()].map((item) => snapshotFromAlert(item))),
          nextById: provenAlertSnapshots,
          previousSnapshotReady: alertSnapshotReadyRef.current,
          consumedVersionKeys: alertConsumedKeysRef.current,
          now: Date.now(),
        });
        const reconciledAlerts = reconcileLiveTransitions({
          current: alertTransitionsRef.current,
          detected: detectedAlerts,
          consumedVersionKeys: alertConsumedKeysRef.current,
          now: Date.now(),
        });
        const nextPinnedAlerts = new Map(alertPinnedRef.current);
        for (const transition of reconciledAlerts.active.values()) {
          if (nextAlertMap.has(transition.id)) continue;
          const previous = previousAlerts.get(transition.id);
          const proven = provenAlertSnapshots.get(transition.id);
          if (!previous) continue;
          nextPinnedAlerts.set(transition.id, {
            ...previous,
            acknowledged_source: proven?.acknowledged_source ?? previous.acknowledged_source,
            acknowledged_internal: proven?.acknowledged_internal ?? previous.acknowledged_internal,
            status_source: proven?.status_source ?? previous.status_source,
            status_internal: proven?.status_internal ?? previous.status_internal,
          });
        }
        alertTransitionsRef.current = reconciledAlerts.active;
        alertConsumedKeysRef.current = reconciledAlerts.consumedVersionKeys;
        alertPinnedRef.current = prunePinnedByTransitions(nextPinnedAlerts, reconciledAlerts.active, Date.now());
        setAlertTransitions(new Map(reconciledAlerts.active));
        previousAlertsRef.current = nextAlertMap;
        alertSnapshotReadyRef.current = true;
        setQueueAlerts(serverAlerts);
        setQueueTotal(payload.total);
        setSectionError("queue", null);
        anySuccess = true;
      } else {
        setSectionError(
          "queue",
          isInitial ? "Não foi possível carregar a fila." : "Falha ao atualizar a fila. Valores anteriores mantidos.",
        );
      }

      if (incidentsResult?.status === "fulfilled") {
        const payload = incidentsResult.value as Awaited<ReturnType<typeof fetchMonitoringUnassignedIncidents>>;
        /* OV-P0-268 incident transitions */
        const serverIncidents = payload.items ?? [];
        const previousIncidents = previousIncidentsRef.current;
        const nextIncidentMap = new Map(
          serverIncidents
            .map((item) => [String(item.sys_id || item.id || ""), item] as const)
            .filter(([id]) => Boolean(id)),
        );
        const provenIncidentSnapshots = toLiveSnapshotMap(serverIncidents.map((item) => snapshotFromIncident(item)));
        const missingIncidentIds = [...previousIncidents.keys()].filter((id) => !nextIncidentMap.has(id));
        if (incidentSnapshotReadyRef.current && missingIncidentIds.length) {
          const proofs = await Promise.allSettled(
            missingIncidentIds.slice(0, 5).map(async (id) => {
              const detail = await fetchIncidents({ sysId: id, pageSize: 1, signal: controller.signal });
              const item = detail.items?.[0];
              return item ? snapshotFromIncident(item) : null;
            }),
          );
          if (controller.signal.aborted || pollGeneration !== pollGenerationRef.current) return;
          for (const proof of proofs) {
            if (proof.status !== "fulfilled" || !proof.value?.id) continue;
            provenIncidentSnapshots.set(proof.value.id, proof.value);
          }
        }
        if (controller.signal.aborted || pollGeneration !== pollGenerationRef.current) return;
        const detectedIncidents = detectLiveTransitions({
          previousById: toLiveSnapshotMap([...previousIncidents.values()].map((item) => snapshotFromIncident(item))),
          nextById: provenIncidentSnapshots,
          previousSnapshotReady: incidentSnapshotReadyRef.current,
          consumedVersionKeys: incidentConsumedKeysRef.current,
          now: Date.now(),
        });
        const reconciledIncidents = reconcileLiveTransitions({
          current: incidentTransitionsRef.current,
          detected: detectedIncidents,
          consumedVersionKeys: incidentConsumedKeysRef.current,
          now: Date.now(),
        });
        const nextPinnedIncidents = new Map(incidentPinnedRef.current);
        for (const transition of reconciledIncidents.active.values()) {
          if (nextIncidentMap.has(transition.id)) continue;
          const previous = previousIncidents.get(transition.id);
          const proven = provenIncidentSnapshots.get(transition.id);
          if (!previous) continue;
          nextPinnedIncidents.set(transition.id, {
            ...previous,
            assigned_to: proven?.assigned_to ?? previous.assigned_to,
            assigned_to_display: proven?.assigned_to_display ?? previous.assigned_to_display,
          });
        }
        incidentTransitionsRef.current = reconciledIncidents.active;
        incidentConsumedKeysRef.current = reconciledIncidents.consumedVersionKeys;
        incidentPinnedRef.current = prunePinnedByTransitions(nextPinnedIncidents, reconciledIncidents.active, Date.now());
        setIncidentTransitions(new Map(reconciledIncidents.active));
        previousIncidentsRef.current = nextIncidentMap;
        incidentSnapshotReadyRef.current = true;
        setUnassignedIncidents(serverIncidents);
        setUnassignedTotal(Number(payload.pagination?.total_items) || serverIncidents.length);
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
      } else if (isInitial && !hasDataRef.current) {
        setSectionError("incidents", "Chamados indisponíveis");
      } else {
        setSectionError("incidents", "Falha ao atualizar chamados. Valores anteriores mantidos.");
      }

      if (anySuccess) {
        hasDataRef.current = true;
        setHasLoaded(true);
        setLastUpdatedAt(Date.now());
      }
    })().finally(() => {
      const refreshCurrentQuery = queryGenerationRef.current.complete(queryGeneration);
      inFlight.current = null;
      if (!refreshCurrentQuery) {
        setIsUpdating(false);
        return;
      }
      queueMicrotask(() => {
        void refreshAllRef.current();
      });
    });

    inFlight.current = request;
    return request;
  }, [alertMode, incidentsAssignedTo, incidentsMode, monitoringIncidentItemLimit, monitoringQueueItemLimit, queueSort, selectedCustomerKeys, selectedDatasources, setSectionError, severitySelection, windowMs]);

  refreshAllRef.current = refreshAll;

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refreshAll();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      void refreshAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAll]);

  const mergedQueueAlerts = mergeLiveTransitionQueue({
    serverItems: queueAlerts,
    pinnedById: alertPinnedRef.current,
    transitions: alertTransitions,
    passesFilter: () => true,
    filter: {
      hideAcknowledged: alertMode === MONITOR_ALERT_MODE.prioritary,
      hideResolved: true,
      hideAssigned: false,
    },
  }).slice(0, monitoringQueueItemLimit);
  const mergedUnassignedIncidents = mergeLiveTransitionQueue({
    serverItems: unassignedIncidents,
    pinnedById: incidentPinnedRef.current,
    transitions: incidentTransitions,
    passesFilter: () => true,
    filter: {
      hideAcknowledged: false,
      hideResolved: false,
      hideAssigned: incidentsMode === INCIDENTS_QUEUE_MODE.unassigned,
    },
    idOf: (item) => String(item.sys_id || item.id || ""),
  }).slice(0, monitoringIncidentItemLimit);
  const normalizedAlertSearch = alertSearch.trim().toLocaleLowerCase("pt-BR");
  const displayQueueAlerts = mergedQueueAlerts.filter((alert) => !normalizedAlertSearch || [
    operationalClientLabel(alert), canonicalHostName(alert), alert.problem_name, alert.severity,
  ].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(normalizedAlertSearch)));
  const normalizedIncidentSearch = incidentSearch.trim().toLocaleLowerCase("pt-BR");
  const displayUnassignedIncidents = mergedUnassignedIncidents.filter((item) => !normalizedIncidentSearch || [
    item.number, item.short_description, item.description, item.company_display, item.company, item.assigned_to_display, item.assigned_to, item.priority_display, item.state_display,
  ].some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(normalizedIncidentSearch)));
  const monitorAlertColumnIds = monitorAlertColumns.visibleColumns.map((column) => column.id);
  const monitorAlertGrid = monitorAlertColumnIds.map((column) => MONITOR_ALERT_COLUMN_WIDTH[column]).join(" ");
  const monitorIncidentColumnIds = monitorIncidentColumns.visibleColumns.map((column) => column.id);
  const monitorIncidentGrid = monitorIncidentColumnIds.map((column) => MONITOR_INCIDENT_COLUMN_WIDTH[column]).join(" ");

  useEffect(() => {
    const next = reconcileFreshAttention({
      alerts: queueAlerts,
      knownIds: freshKnownIdsRef.current,
      attentionStartedAt: freshStartedAtRef.current,
      isFirstSnapshot: !freshSeededRef.current,
    });
    freshKnownIdsRef.current = next.knownIds;
    freshStartedAtRef.current = next.attentionStartedAt;
    freshSeededRef.current = true;
    const active = activeFreshAttentionIds(next.attentionStartedAt);
    setFreshAttentionIds((current) => (sameStringSet(current, active) ? current : active));
  }, [queueAlerts]);

  useEffect(() => {
    if (!freshAttentionIds.size) return undefined;
    const timer = window.setInterval(() => {
      const active = activeFreshAttentionIds(freshStartedAtRef.current);
      setFreshAttentionIds((current) => (sameStringSet(current, active) ? current : active));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [freshAttentionIds.size]);

  useEffect(() => {
    /* OV-P0-268 transition tick */
    if (!alertTransitions.size && !incidentTransitions.size) return undefined;
    const timer = window.setInterval(() => {
      const tick = Date.now();
      const nextAlerts = new Map(
        [...alertTransitionsRef.current].filter(([, transition]) => isLiveTransitionActive(transition, tick)),
      );
      const nextIncidents = new Map(
        [...incidentTransitionsRef.current].filter(([, transition]) => isLiveTransitionActive(transition, tick)),
      );
      alertTransitionsRef.current = nextAlerts;
      incidentTransitionsRef.current = nextIncidents;
      alertPinnedRef.current = prunePinnedByTransitions(alertPinnedRef.current, nextAlerts, tick);
      incidentPinnedRef.current = prunePinnedByTransitions(incidentPinnedRef.current, nextIncidents, tick);
      if (!sameLiveTransitionMap(alertTransitions, nextAlerts)) setAlertTransitions(nextAlerts);
      if (!sameLiveTransitionMap(incidentTransitions, nextIncidents)) setIncidentTransitions(nextIncidents);
    }, Math.min(250, LIVE_TRANSITION_DURATION_MS));
    return () => window.clearInterval(timer);
  }, [alertTransitions, incidentTransitions]);

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
      // push (não replace) para back/forward reabrir/fechar o drawer
      setSearchParams(next, { replace: false });
    }
  }, [searchParams, setSearchParams]);

  const closeIncident = useCallback(() => {
    setSelectedIncident(null);
    if (searchParams.has("incident")) {
      const next = new URLSearchParams(searchParams);
      next.delete("incident");
      setSearchParams(next, { replace: false });
    }
  }, [searchParams, setSearchParams]);

  const openAlert = useCallback((alert: OneViewAlert) => {
    setSelectedIncident(null);
    setSelectedAlertId(alert.id);
    setSelectedPreview(alert);
    void loadSelectedAlert(alert.id);
    const next = new URLSearchParams(searchParams);
    next.delete("incident");
    next.set("alert", alert.id);
    setSearchParams(next, { replace: false });
  }, [loadSelectedAlert, searchParams, setSearchParams]);

  const openIncident = useCallback((item: OneViewIncident) => {
    detailRequest.current?.abort();
    setSelectedAlertId(null);
    setSelectedPreview(null);
    setDetail(null);
    setHistory(null);
    setDetailError(null);
    setIsDetailLoading(false);
    const id = incidentKey(item);
    setSelectedIncident(item);
    const next = new URLSearchParams(searchParams);
    next.delete("alert");
    if (id) next.set("incident", id);
    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);

  const resolveIncidentFromId = useCallback(async (id: string, signal?: AbortSignal) => {
    const local = unassignedIncidents.find((item) => incidentKey(item) === id);
    if (local) return local;
    const bySys = await fetchIncidents({
      page: 1,
      pageSize: 50,
      unassigned: true,
      state: MONITOR_UNASSIGNED_OPERATIONAL_STATES,
      signal,
    });
    const fromList = (bySys.items ?? []).find((item) => incidentKey(item) === id);
    if (fromList) return fromList;
    if (/^INC/i.test(id)) {
      const byNumber = await fetchIncidents({
        page: 1,
        pageSize: 5,
        number: id,
        signal,
      });
      return (byNumber.items ?? []).find((item) => incidentKey(item) === id)
        ?? (byNumber.items ?? [])[0]
        ?? null;
    }
    return null;
  }, [unassignedIncidents]);

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
    setSelectedIncident(null);
    setSelectedAlertId(requestedAlertId);
    const preview = queueAlerts.find((item) => item.id === requestedAlertId) ?? null;
    setSelectedPreview(preview);
    void loadSelectedAlert(requestedAlertId);
  }, [loadSelectedAlert, queueAlerts, requestedAlertId, selectedAlertId]);

  useEffect(() => {
    if (!requestedIncidentId) {
      if (selectedIncident) {
        setSelectedIncident(null);
      }
      return;
    }
    if (selectedIncident && incidentKey(selectedIncident) === requestedIncidentId) return;

    const controller = new AbortController();
    void (async () => {
      const found = await resolveIncidentFromId(requestedIncidentId, controller.signal);
      if (controller.signal.aborted) return;
      if (found) {
        setSelectedAlertId(null);
        setSelectedPreview(null);
        setSelectedIncident(found);
      } else {
        setSelectedIncident(null);
      }
    })();
    return () => controller.abort();
  }, [requestedIncidentId, resolveIncidentFromId, selectedIncident]);

  useEffect(() => () => {
    detailRequest.current?.abort();
  }, []);

  const selectedAlert = detail?.item ?? selectedPreview;
  const historyItems = (history?.items ?? []).filter(
    (item) => item.event_type !== "internal_acknowledged" && item.origin !== "oneview_internal",
  );
  const alertsHref = alertMode === MONITOR_ALERT_MODE.prioritary ? "/alertas?view=priority" : "/alertas?view=open";
  const chamadosHref = buildMonitoringChamadosHref({ mode: incidentsMode, assignedTo: incidentsAssignedTo });

  return (
    <div
      className="noc-monitor flex h-[100dvh] w-[100vw] max-h-[100dvh] max-w-[100vw] overflow-hidden bg-background text-foreground antialiased"
      data-tv={tvMode ? "1" : "0"}
    >
      {!dashboard.isWallboard ? (
        <Sidebar
          monitoringCollapse
          open={navOpen}
          onOpenChange={setNavOpen}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-200",
          !dashboard.isWallboard && navOpen ? "ml-14" : "ml-0",
        )}
      >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {/* OV-P0-104 — topo: título · ações · health à direita */}
        <div className="flex min-w-0 items-center gap-3">
          {!navOpen ? <TeletexMark inverted /> : null}
          <SectionAccentTitle level={1}>Monitoramento</SectionAccentTitle>
        </div>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {isUpdating ? (
            <span className="inline-flex shrink-0 items-center gap-1 ov-type-caption text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Atualizando
            </span>
          ) : <span className="hidden shrink-0 ov-type-caption text-muted-foreground sm:inline">Atualizado: {lastUpdatedLabel}</span>}
          <PlatformHealthStrip />
        </div>
      </header>

      <div className="mx-auto flex h-0 w-full max-w-[1920px] min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2 sm:p-3 min-[1440px]:overflow-hidden">
        {/* OV-P0-75: >=1440 fila ~60% | chamados ~40%; em 1366 empilha abaixo */}
        <section aria-label="Filtros operacionais" className="hidden">
          <div className="flex flex-wrap items-center gap-2">
            <OperationalFilterGroup label="Cliente">
              <ClientFilterCombobox
                open={customerFilterOpen}
                onOpenChange={setCustomerFilterOpen}
                options={customerCards}
                selectedKeys={selectedCustomerKeys}
                selectedLabel={selectedCustomerLabel}
                onToggle={toggleCustomer}
                triggerClassName="h-9"
                countNoun={customerFilterCountNoun(alertMode === MONITOR_ALERT_MODE.prioritary ? "prioritary" : "filter")}
              />
            </OperationalFilterGroup>
            <OperationalFilterGroup label="Fonte" showDivider>
              <ZabbixSourceFilter
                value={selectedDatasources[0] || "all"}
                options={zabbixSourceFilterOptions}
                onValueChange={(value) => setSelectedDatasources(value === "all" ? [] : [value])}
                triggerClassName="h-9"
              />
            </OperationalFilterGroup>
            <OperationalFilterGroup label="Período" showDivider>
              {MONITOR_WINDOW_OPTIONS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant={homeWindow === preset ? "default" : "outline"}
                  className={cn(OV_FILTER_CHIP, "h-9")}
                  aria-pressed={homeWindow === preset}
                  onClick={() => setMonitorWindow(preset)}
                >
                  {preset}
                </Button>
              ))}
            </OperationalFilterGroup>
            <Popover open={severityFilterOpen} onOpenChange={setSeverityFilterOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className={cn(OV_FILTER_CONTROL, "h-9 gap-2 px-2.5")} aria-expanded={severityFilterOpen}>
                  Mais filtros
                  <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 space-y-3 p-3">
                <div className="space-y-1">
                  <p className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">Severidades</p>
                  {MONITOR_SEVERITY_CHIP_OPTIONS.map((option) => {
                    const pressed = activeSeverities.includes(option.value);
                    return (
                      <Button key={option.value} type="button" variant="ghost" size="sm" className={cn("h-8 w-full justify-start border px-2 text-xs", pressed && "border-foreground/20 bg-muted/40", pressed && (option.value === "disaster" || option.value === "high") && "font-semibold")} aria-pressed={pressed} onClick={() => toggleSeverityChip(option.value)}>
                        {option.label}
                        {pressed ? <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" /> : null}
                      </Button>
                    );
                  })}
                </div>
                <div className="space-y-1 border-t border-border/60 pt-3">
                  <p className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">Ordenação</p>
                  <Select value={queueSort} onValueChange={(value) => setQueueSort(parseMonitorQueueSort(value))}>
                    <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-full px-2.5 text-xs")} aria-label="Ordenação da fila"><SelectValue placeholder="Mais recentes" /></SelectTrigger>
                    <SelectContent align="start">{MONITOR_QUEUE_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
            <span className="ov-type-caption font-semibold uppercase tracking-wide text-muted-foreground">Fila</span>
            <OperationalSegmentedControl
              aria-label="Filtro rápido da fila"
              value={alertMode}
              onChange={setAlertMode}
              options={[
                { value: MONITOR_ALERT_MODE.prioritary, label: "Prioritários" },
                { value: MONITOR_ALERT_MODE.all, label: "Todos" },
              ]}
            />
          </div>
        </section>

        <ConfigurableDashboard controller={dashboard} className="min-h-0 flex-1" metricStrip={monitoringMetrics}>
          <ConfigurableDashboardWidget id="operational-summary">
            <div className="shrink-0 space-y-1">
              <ConfigurableMetricStrip
                aria-label="Severidades ativas na janela"
                controller={monitoringMetrics}
                editable={dashboard.isEditing}
                gridProfile="twelve"
                gridClassName="ov-monitoring-metric-grid"
                items={severityMetricStripItems}
              />
              {sectionErrors.summary ? <p className="ov-typography-small text-[hsl(var(--ov-color-warning))]">{sectionErrors.summary}</p> : null}
            </div>
          </ConfigurableDashboardWidget>

          <ConfigurableDashboardWidget id="monitoring-queue">
          <Panel
            title={<SectionAccentTitle>Fila operacional</SectionAccentTitle>}
            description={queuePanelDescription}
            error={sectionErrors.queue}
            onRetry={() => void refreshAll()}
            overflow={queueOverflowLabel(queueTotal, queueAlerts.length)}
            empty={queueEmpty}
            className="h-full min-h-[24rem] min-[1440px]:min-h-0 min-[1440px]:flex-1"
            aside={(
              <div className="inline-flex items-center gap-2">
                <span className="ov-type-caption font-semibold tabular-nums text-muted-foreground">{formatNullableCount(queueTotal)} na fila</span>
                <OperationalCta to={alertsHref}>Ver todos em Alertas</OperationalCta>
              </div>
            )}
          >
            <div className="flex h-full min-h-0 flex-col">
              <ConfigurableTableToolbar
                search={alertSearch}
                onSearchChange={setAlertSearch}
                searchPlaceholder="Buscar nos alertas carregados…"
                searchLabel="Buscar na fila operacional"
              columns={monitorAlertColumns}
              scopeHint="A busca considera os alertas carregados nesta fila."
              className="-mx-4 -mt-2 mb-2"
              activeFilterCount={selectedCustomerKeys.length + selectedDatasources.length + (homeWindow === DEFAULT_MONITOR_WINDOW ? 0 : 1) + (alertMode === MONITOR_ALERT_MODE.prioritary ? 0 : 1) + (queueSort === MONITOR_QUEUE_SORT.recent ? 0 : 1)}
              onClearFilters={() => { setSelectedCustomerKeys([]); setSelectedDatasources([]); setMonitorWindow(DEFAULT_MONITOR_WINDOW); setAlertMode(MONITOR_ALERT_MODE.prioritary); setQueueSort(MONITOR_QUEUE_SORT.recent); }}
              trailing={(
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  Mostrar
                  <Select
                    value={String(monitoringQueueItemLimit)}
                    onValueChange={(value) => {
                      const next = Number.parseInt(value, 10);
                      if (Number.isFinite(next)) dashboard.updateWidget("monitoring-queue", { itemLimit: next });
                    }}
                  >
                    <SelectTrigger className="h-9 w-[4.75rem] px-2 text-xs" aria-label="Quantidade de alertas na fila">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {(dashboard.widgets.find((widget) => widget.id === "monitoring-queue")?.itemLimitOptions ?? MONITOR_QUEUE_ITEM_LIMIT_OPTIONS).map((limit) => (
                        <SelectItem key={limit} value={String(limit)}>{limit}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              filters={(
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1 text-xs text-muted-foreground">Cliente<ClientFilterCombobox open={customerFilterOpen} onOpenChange={setCustomerFilterOpen} options={customerCards} selectedKeys={selectedCustomerKeys} selectedLabel={selectedCustomerLabel} onToggle={toggleCustomer} triggerClassName="h-9 w-full" countNoun={customerFilterCountNoun(alertMode === MONITOR_ALERT_MODE.prioritary ? "prioritary" : "filter")} /></div>
                  <div className="space-y-1 text-xs text-muted-foreground">Fonte<ZabbixSourceFilter value={selectedDatasources[0] || "all"} options={zabbixSourceFilterOptions} onValueChange={(value) => setSelectedDatasources(value === "all" ? [] : [value])} triggerClassName="h-9 w-full" /></div>
                  <label className="space-y-1 text-xs text-muted-foreground">Período<Select value={homeWindow} onValueChange={(value) => setMonitorWindow(parseMonitorWindow(value))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{MONITOR_WINDOW_OPTIONS.map((preset) => <SelectItem key={preset} value={preset}>{preset}</SelectItem>)}</SelectContent></Select></label>
                  <label className="space-y-1 text-xs text-muted-foreground">Fila<Select value={alertMode} onValueChange={(value) => setAlertMode(parseMonitorAlertMode(value))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={MONITOR_ALERT_MODE.prioritary}>Prioritários</SelectItem><SelectItem value={MONITOR_ALERT_MODE.all}>Todos</SelectItem></SelectContent></Select></label>
                  <label className="space-y-1 text-xs text-muted-foreground">Ordenação<Select value={queueSort} onValueChange={(value) => setQueueSort(parseMonitorQueueSort(value))}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{MONITOR_QUEUE_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>
                  <div className="space-y-1 text-xs text-muted-foreground sm:col-span-2 lg:col-span-3"><span>Severidades</span><div className="flex flex-wrap gap-1.5">{MONITOR_SEVERITY_CHIP_OPTIONS.map((option) => <Button key={option.value} type="button" variant={activeSeverities.includes(option.value) ? "default" : "outline"} size="sm" className="h-8" onClick={() => toggleSeverityChip(option.value)}>{option.label}</Button>)}</div></div>
                </div>
              )}
            />
              {!hasLoaded && !queueAlerts.length ? (
                <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : !queueAlerts.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">
                  {alertMode === MONITOR_ALERT_MODE.prioritary
                    ? "Nenhum alerta prioritário na janela."
                    : "Nenhum alerta ativo na janela."}
                </p>
              ) : (
                <>
                <div className="min-h-0 flex-1 overflow-auto overscroll-contain max-h-[calc(100dvh-20rem)]">
                  <div className="ov-monitoring-table" style={{ minWidth: MONITOR_ALERT_TABLE_MIN_WIDTH }}>
                    <div
                      className="ov-monitoring-table-grid sticky top-0 z-10 grid shrink-0 items-center gap-x-3 border-b border-border/70 bg-background px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                      style={{ gridTemplateColumns: monitorAlertGrid }}
                      aria-hidden="true"
                    >
                      {monitorAlertColumns.visibleColumns.map((column) => <span key={column.id} className={cn("min-w-0 truncate", monitorColumnAlign(column.id))}>{column.label}</span>)}
                    </div>
                    <ul className="divide-y divide-border">
                    {displayQueueAlerts.map((alert) => (
                      <li key={alert.id}>
                        <MonitorAlertRow
                          alert={alert}
                          onOpen={openAlert}
                          columns={monitorAlertColumnIds}
                          gridTemplate={monitorAlertGrid}
                          selected={selectedAlertId === alert.id}
                          freshTone={freshAttentionIds.has(alert.id) ? freshAttentionTone(alert.severity) : null}
                          liveTransition={alertTransitions.get(alert.id) ?? null}
                        />
                      </li>
                    ))}
                    </ul>
                  </div>
                </div>
                {queueTotal > displayQueueAlerts.length ? (
                  <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                    <p className="text-[11px] font-medium tabular-nums text-muted-foreground">
                      Mostrando {displayQueueAlerts.length.toLocaleString("pt-BR")} de {formatNullableCount(queueTotal)}
                    </p>
                    <OperationalCta to={alertsHref}>Ver todos em Alertas</OperationalCta>
                  </div>
                ) : null}
                </>
              )}
            </div>
          </Panel>
          </ConfigurableDashboardWidget>

          <ConfigurableDashboardWidget id="incidents">
          <Panel
            title={<SectionAccentTitle>Chamados</SectionAccentTitle>}
            description={unassignedPanelTitle}
            error={sectionErrors.incidents}
            onRetry={() => void refreshAll()}
            overflow={queueOverflowLabel(unassignedTotal, unassignedIncidents.length)}
            empty={unassignedEmpty}
            className="min-h-[16rem] min-[1440px]:min-h-0 min-[1440px]:flex-1"
            aside={(
              <OperationalCta to={chamadosHref}>Ver todos em Chamados</OperationalCta>
            )}
          >
            <ConfigurableTableToolbar
              search={incidentSearch}
              onSearchChange={setIncidentSearch}
              searchPlaceholder="Buscar nos chamados carregados…"
              searchLabel="Buscar na fila de chamados"
              columns={monitorIncidentColumns}
              activeFilterCount={(incidentsMode === INCIDENTS_QUEUE_MODE.unassigned ? 0 : 1) + incidentsAssignedTo.length}
              scopeHint="A busca considera os chamados carregados nesta fila."
              className="-mx-4 -mt-2 mb-2"
              filters={<OperationalIncidentsToolbar mode={incidentsMode} onModeChange={setIncidentsMode} assignedTo={incidentsAssignedTo} onAssignedToChange={setIncidentsAssignedTo} analysts={incidentAssignees} />}
            />
            {!hasLoaded && !unassignedIncidents.length ? (
              <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
            ) : !unassignedIncidents.length ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                {incidentsMode === INCIDENTS_QUEUE_MODE.assigned
                  ? "Nenhum chamado com analista na janela."
                  : incidentsMode === INCIDENTS_QUEUE_MODE.all
                    ? "Nenhum chamado na janela."
                    : "Nenhum chamado monitoring sem responsável."}
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="ov-monitoring-table" style={{ minWidth: MONITOR_INCIDENT_TABLE_MIN_WIDTH }}>
                  <div
                    className="ov-monitoring-table-grid sticky top-0 z-10 grid shrink-0 items-center gap-x-3 border-b border-border/70 bg-background pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                    style={{ gridTemplateColumns: monitorIncidentGrid }}
                    aria-hidden="true"
                  >
                    {monitorIncidentColumns.visibleColumns.map((column) => <span key={column.id} className={cn("min-w-0 truncate", monitorColumnAlign(column.id))}>{column.label}</span>)}
                  </div>
                  <div>
                  {displayUnassignedIncidents.map((item) => (
                    <MonitorUnassignedRow
                      key={item.sys_id || item.number || String(item.sys_updated_on)}
                      item={item}
                      onOpen={openIncident}
                      columns={monitorIncidentColumnIds}
                      gridTemplate={monitorIncidentGrid}
                      selected={selectedIncidentKey === incidentKey(item)}
                      showAnalyst={showIncidentAnalysts}
                      liveTransition={incidentTransitions.get(String(item.sys_id || item.id || "")) ?? null}
                    />
                  ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>
          </ConfigurableDashboardWidget>
        </ConfigurableDashboard>
      </div>
      </div>

      <AlertDetailDrawer
        open={selectedAlertId !== null}
        onOpenChange={(next) => { if (!next) closeAlert(); }}
        alert={selectedAlert}
        historyItems={historyItems}
        isLoading={isDetailLoading}
        error={detailError}
        description="Consulta rápida sem sair do Monitoramento."
      />

      <IncidentDetailDrawer
        incident={selectedIncident}
        onOpenChange={(open) => { if (!open) closeIncident(); }}
        description="Consulta rápida sem sair do Monitoramento."
      />
    </div>
  );
}

