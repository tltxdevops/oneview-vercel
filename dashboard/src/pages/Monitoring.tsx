import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Expand, Eye, Loader2, Minimize2, RefreshCcw, ChevronsUpDown, Check } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import {
  ClientIdentity,
  CLASSIFICATION_PENDING_LABEL,
  canonicalHostName,
  facetCustomerDisplayName,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import { OperationalCta } from "@/components/oneview/OperationalCta";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { OperationalFilterGroup } from "@/components/oneview/OperationalFilterGroup";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { PlatformHealthStrip } from "@/components/oneview/PlatformHealthStrip";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { TruncatedText } from "@/components/oneview/TruncatedText";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { OV_FILTER_CHIP, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  IncidentRelatedAlert,
  OneViewAlert,
  OneViewFacetsResponse,
  OneViewIncident,
  OneViewSeverity,
  fetchAlert,
  fetchAlertHistory,
  fetchIncidentRelatedAlert,
  fetchIncidents,
  fetchOneViewFacets,
  formatNullableCount,
  formatOneViewSeverityLabel,
} from "@/lib/oneview-api";
import {
  activeFreshAttentionIds,
  freshAttentionTone,
  reconcileFreshAttention,
  sameStringSet,
  type FreshAttentionTone,
} from "@/lib/oneview-fresh-attention";
import {
  MONITOR_ALERT_MODE,
  MONITOR_QUEUE_LIMIT,
  MONITOR_QUEUE_SORT,
  MONITOR_QUEUE_SORT_OPTIONS,
  MONITOR_SEVERITY_CHIP_OPTIONS,
  MONITOR_UNASSIGNED_LIMIT,
  MONITOR_UNASSIGNED_OPERATIONAL_STATES,
  MONITOR_WINDOW_OPTIONS,
  buildMonitoringUnassignedChamadosHref,
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
  RecentOperationalMetrics,
  fetchRecentOperationalMetrics,
  queueOverflowLabel,
} from "@/lib/oneview-recent";

const REFRESH_MS = 30_000;

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
 * Validado mentalmente em 1366×768 e 1920×1080 (problema absorve o restante).
 */
const QUEUE_GRID =
  "grid grid-cols-[minmax(9.5rem,13rem)_minmax(8rem,12rem)_minmax(0,1fr)_6.25rem_4.75rem_5.75rem_5.5rem_3.75rem] items-center gap-x-3";

/** OV-P0-75 — coluna direita ~28% a partir de 1440px; abaixo empilha (1366). */
const COMMAND_CENTER_GRID =
  "grid min-h-0 flex-1 gap-2 min-[1440px]:grid-cols-[minmax(0,72fr)_minmax(0,28fr)]";

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

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
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

function alertSeverityLabel(value: string | null | undefined) {
  return displayIncidentField(value);
}

function alertStatusLabel(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "active") return "Ativo";
  if (key === "resolved") return "Resolvido";
  return displayIncidentField(value);
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{value}</p>
    </div>
  );
}

function incidentKey(item: OneViewIncident) {
  return String(item.sys_id || item.number || "").trim();
}

/** OV-P0-79 — rótulo compacto do filtro de severidade (sem chips permanentes). */
function monitorSeverityTriggerLabel(severities: MonitorAlertSeverity[]) {
  if (!severities.length) return "Severidade";
  if (severities.length <= 3) {
    return severities.map((severity) => formatOneViewSeverityLabel(severity)).join(", ");
  }
  return `Severidade · ${severities.length}`;
}

function Panel({
  title,
  error,
  onRetry,
  overflow,
  empty,
  aside,
  toolbar,
  children,
  className,
}: {
  title: string;
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
        "flex flex-col overflow-hidden rounded-lg border border-border bg-card/90",
        empty ? "shrink-0" : "min-h-0 flex-1",
        className,
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-foreground sm:text-base">{title}</h2>
          {overflow ? <p className="text-[11px] font-medium text-muted-foreground">{overflow}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
          {toolbar}
        </div>
      ) : null}
      {error ? <p className="shrink-0 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-200/90">{error}</p> : null}
      <div className={cn("overflow-hidden px-3", empty ? "py-1.5" : "min-h-0 flex-1 py-1.5")}>{children}</div>
    </section>
  );
}

function MonitorUnassignedRow({
  item,
  onOpen,
  selected = false,
}: {
  item: OneViewIncident;
  onOpen: (item: OneViewIncident) => void;
  selected?: boolean;
}) {
  const number = displayIncidentField(item.number);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border/50 py-1.5 text-left last:border-b-0 transition-colors hover:bg-muted/40",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
      )}
      aria-label={`Abrir chamado ${number}`}
    >
      <p className="truncate text-[13px] font-semibold text-foreground" title={number}>{number}</p>
      <p className="truncate text-right text-[11px] text-muted-foreground" title={formatUpdatedAgo(item.sys_updated_on)}>
        {formatUpdatedAgo(item.sys_updated_on)}
      </p>
      <p className="truncate text-[11px] text-foreground/80" title={displayIncidentField(item.company_display, item.company)}>
        {displayIncidentField(item.company_display, item.company)}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Badge variant="secondary" className="h-5 max-w-[7rem] truncate px-1.5 text-[10px]">
          {displayIncidentField(item.priority_display, item.priority)}
        </Badge>
        <Badge variant="outline" className="h-5 max-w-[7rem] truncate px-1.5 text-[10px]">
          {displayIncidentField(item.state_display, item.state)}
        </Badge>
      </div>
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
  selected = false,
  freshTone = null,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
  selected?: boolean;
  freshTone?: FreshAttentionTone | null;
}) {
  const acked = Boolean(alert.acknowledged_source);
  const fresh = Boolean(freshTone);

  return (
    <button
      type="button"
      onClick={() => onOpen(alert)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        QUEUE_GRID,
        "w-full rounded-md px-1 py-2 text-left transition-colors hover:bg-muted/50",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
        freshTone === "disaster" && "ov-fresh-attention-disaster",
        freshTone === "high" && "ov-fresh-attention-high",
      )}
      aria-label={`Abrir alerta ${alert.problem_name || alert.id}${fresh ? " · Novo" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ClientIdentity
          customer={{
            key: alert.customer_key,
            name: alert.customer_name,
            source: alert.customer_source,
          }}
          operationalScope={alert.operational_scope}
          operationalScopeLabel={alert.operational_scope_label}
          size="sm"
          className="shrink-0"
        />
        <span className="min-w-0">
          <TruncatedText className="text-sm font-semibold text-foreground">
            {operationalClientLabel({
              key: alert.customer_key,
              name: alert.customer_name,
              source: alert.customer_source,
              operational_scope: alert.operational_scope,
              operational_scope_label: alert.operational_scope_label,
            })}
          </TruncatedText>
          {normalizeOperationalScope(alert.operational_scope) === "unknown" ? (
            <TruncatedText className="text-[10px] text-muted-foreground">{CLASSIFICATION_PENDING_LABEL}</TruncatedText>
          ) : null}
        </span>
      </span>

      <TruncatedText className="min-w-0 text-left text-xs text-foreground/85">{canonicalHostName(alert)}</TruncatedText>

      <TruncatedText className="min-w-0 text-left text-xs text-muted-foreground">{alert.problem_name}</TruncatedText>

      <span className="flex min-w-0 flex-wrap items-center gap-1 justify-self-start">
        <SeverityBadge severity={alert.severity} className="h-fit w-fit px-1.5 py-0.5 text-[11px] leading-none" />
        {fresh ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider",
              freshTone === "disaster"
                ? "text-red-800 dark:text-red-200"
                : "text-red-600 dark:text-red-300",
            )}
          >
            <span className="ov-fresh-dot" aria-hidden="true" />
            Novo
          </span>
        ) : null}
      </span>

      <span className="justify-self-start">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            acked
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200",
          )}
        >
          {acked ? "Com ACK" : "Sem ACK"}
        </Badge>
      </span>

      <span className="justify-self-end text-right text-xs tabular-nums text-muted-foreground">
        {formatCompactFirstSeen(alert.first_seen_at || alert.started_at)}
      </span>

      <span className="justify-self-end text-right text-xs tabular-nums text-muted-foreground">
        {formatDurationSeconds(alert.duration_seconds)}
      </span>

      <span className="justify-self-end text-right">
        <span className="inline-flex h-7 items-center gap-0.5 text-xs font-medium text-primary">
          Abrir
          <Eye className="h-3 w-3" aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

export default function MonitoringPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tvMode = searchParams.get("tv") === "1";
  const homeWindow = parseMonitorWindow(searchParams.get("window"));
  const windowMs = monitorWindowMs(homeWindow);
  const windowLabel = monitorWindowShortLabel(homeWindow);
  const alertMode = parseMonitorAlertMode(searchParams.get("mode"));
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
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [queueAlerts, setQueueAlerts] = useState<OneViewAlert[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [unassignedIncidents, setUnassignedIncidents] = useState<OneViewIncident[]>([]);
  const [unassignedTotal, setUnassignedTotal] = useState(0);
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({});
  const [isUpdating, setIsUpdating] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const requestedAlertId = searchParams.get("alert");
  const requestedIncidentId = searchParams.get("incident");
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<OneViewAlert | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<OneViewIncident | null>(null);
  const [relatedAlert, setRelatedAlert] = useState<IncidentRelatedAlert | null>(null);
  const [relatedAlertLoading, setRelatedAlertLoading] = useState(false);
  const [relatedAlertChecked, setRelatedAlertChecked] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  const relatedAlertRequest = useRef<AbortController | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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
    searchParams.getAll("customer").filter(Boolean),
  );

  const inFlight = useRef<Promise<void> | null>(null);
  const openBeforeFullscreen = useRef(true);
  const wasFullscreen = useRef(false);
  const listsAbort = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);
  const freshKnownIdsRef = useRef<Set<string>>(new Set());
  const freshStartedAtRef = useRef<Map<string, number>>(new Map());
  const freshSeededRef = useRef(false);
  const [freshAttentionIds, setFreshAttentionIds] = useState<Set<string>>(new Set());

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
      selectedCustomerKeys.forEach((value) => next.append("customer", value));
    });
  }, [patchSearchParams, selectedCustomerKeys]);

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

  const customerCards = useMemo(() => {
    const by = recentMetrics?.by_severity;
    const known = by
      ? [by.information, by.warning, by.average, by.high, by.disaster, recentMetrics?.not_classified]
      : [];
    const total = known.length && known.every((value) => value != null)
      ? known.reduce<number>((sum, value) => sum + Number(value), 0)
      : 0;
    return [
      { key: "all", name: "Todos", alerts_count: total },
      ...(facets?.customers ?? []).map((customer) => ({
        ...customer,
        name: facetCustomerDisplayName(customer),
      })),
    ];
  }, [facets?.customers, recentMetrics]);

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
      description: `${monitorWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
      // OV-P0-82: clique aplica/remove filtro server-side na própria /monitoramento.
      selected: activeSeverities.includes(severity),
      onClick: () => toggleSeverityChip(severity),
    };
  });

  const queueEmpty = hasLoaded && !queueAlerts.length && !sectionErrors.queue;
  const unassignedEmpty = hasLoaded && !unassignedIncidents.length && !sectionErrors.incidents;
  const modeLabel = alertMode === MONITOR_ALERT_MODE.prioritary ? "Prioritários" : "Todos";
  const unassignedTitleCount = Math.max(0, Math.trunc(Number(unassignedTotal) || unassignedIncidents.length || 0));
  const unassignedPanelTitle = `${unassignedTitleCount.toLocaleString("pt-BR")} sem responsável`;
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

  const refreshAll = useCallback(async () => {
    if (inFlight.current) return inFlight.current;

    const request = (async () => {
      setIsUpdating(true);
      const isInitial = !hasDataRef.current;
      listsAbort.current?.abort();
      const controller = new AbortController();
      listsAbort.current = controller;
      const customers = selectedCustomerKeys.length ? selectedCustomerKeys : undefined;
      const now = Date.now();

      const tasks: Array<Promise<unknown>> = [
        fetchRecentOperationalMetrics({ customers, signal: controller.signal, now, windowMs }),
        fetchOneViewFacets(controller.signal),
        fetchMonitoringAlerts({
          mode: alertMode,
          severity: severitySelection,
          customers,
          limit: MONITOR_QUEUE_LIMIT,
          windowMs,
          sort: queueSort,
          signal: controller.signal,
          now,
        }),
        fetchMonitoringUnassignedIncidents({
          limit: MONITOR_UNASSIGNED_LIMIT,
          signal: controller.signal,
        }),
      ];

      const results = await Promise.allSettled(tasks);

      if (controller.signal.aborted) return;

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
        setQueueAlerts(payload.items);
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
        setUnassignedIncidents(payload.items ?? []);
        setUnassignedTotal(Number(payload.pagination?.total_items) || (payload.items?.length ?? 0));
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
      }
    })().finally(() => {
      setIsUpdating(false);
      inFlight.current = null;
    });

    inFlight.current = request;
    return request;
  }, [alertMode, queueSort, selectedCustomerKeys, setSectionError, severitySelection, windowMs]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshAll();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

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
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (isFullscreen === wasFullscreen.current) return;
    if (isFullscreen) {
      openBeforeFullscreen.current = navOpen;
      setNavOpen(false);
    } else {
      setNavOpen(openBeforeFullscreen.current);
    }
    wasFullscreen.current = isFullscreen;
  }, [isFullscreen, navOpen]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen pode ser bloqueado pelo navegador; a tela permanece utilizável.
    }
  }, []);

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
    relatedAlertRequest.current?.abort();
    setSelectedIncident(null);
    setRelatedAlert(null);
    setRelatedAlertLoading(false);
    setRelatedAlertChecked(false);
    if (searchParams.has("incident")) {
      const next = new URLSearchParams(searchParams);
      next.delete("incident");
      setSearchParams(next, { replace: false });
    }
  }, [searchParams, setSearchParams]);

  const openAlert = useCallback((alert: OneViewAlert) => {
    relatedAlertRequest.current?.abort();
    setSelectedIncident(null);
    setRelatedAlert(null);
    setRelatedAlertChecked(false);
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
        relatedAlertRequest.current?.abort();
        setSelectedIncident(null);
        setRelatedAlert(null);
        setRelatedAlertLoading(false);
        setRelatedAlertChecked(false);
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

  useEffect(() => {
    if (!selectedIncident) {
      relatedAlertRequest.current?.abort();
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(false);
      return;
    }
    const eventId = String(selectedIncident.zabbix_event_id || "").trim();
    if (!eventId) {
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(true);
      return;
    }
    const controller = new AbortController();
    relatedAlertRequest.current = controller;
    setRelatedAlert(null);
    setRelatedAlertLoading(true);
    setRelatedAlertChecked(false);
    fetchIncidentRelatedAlert(eventId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setRelatedAlert(response.matched && response.alert ? response.alert : null);
        setRelatedAlertChecked(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRelatedAlert(null);
        setRelatedAlertChecked(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedAlertLoading(false);
      });
    return () => controller.abort();
  }, [selectedIncident]);

  useEffect(() => () => {
    detailRequest.current?.abort();
    relatedAlertRequest.current?.abort();
  }, []);

  const selectedAlert = detail?.item ?? selectedPreview;
  const historyItems = (history?.items ?? []).filter(
    (item) => item.event_type !== "internal_acknowledged" && item.origin !== "oneview_internal",
  );
  const descriptionText = selectedIncident
    ? displayIncidentField(selectedIncident.description, selectedIncident.short_description)
    : "—";
  const hasZabbixHost = Boolean(String(selectedIncident?.u_hostname_zabbix || "").trim());
  const hasZabbixIp = Boolean(String(selectedIncident?.u_ip_zabbix || "").trim());
  const alertsHref = alertMode === MONITOR_ALERT_MODE.prioritary ? "/alertas?view=priority" : "/alertas?view=open";
  const chamadosHref = buildMonitoringUnassignedChamadosHref();

  return (
    <div
      className="noc-monitor flex h-[100dvh] w-[100vw] max-h-[100dvh] max-w-[100vw] overflow-hidden bg-background text-foreground antialiased"
      data-tv={tvMode ? "1" : "0"}
    >
      <Sidebar
        monitoringCollapse
        open={navOpen}
        onOpenChange={setNavOpen}
      />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-200",
          navOpen ? "ml-14" : "ml-0",
        )}
      >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
        {/* OV-P0-104 — topo: título · health · sync · fullscreen */}
        <h1 className="shrink-0 text-xl font-semibold tracking-tight text-foreground">Monitoramento</h1>
        <div className="min-w-0 flex-1">
          <PlatformHealthStrip />
        </div>
        {isUpdating ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Atualizando
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="ml-auto h-8 w-8 shrink-0"
          onClick={() => void toggleFullscreen()}
          aria-label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
        >
          {isFullscreen
            ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
            : <Expand className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </header>

      <div className="mx-auto flex h-0 w-full max-w-[1920px] min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 sm:p-3">
        {/* OV-P0-75: >=1440 fila ~72% | chamados ~28%; em 1366 empilha abaixo */}
        <div className={COMMAND_CENTER_GRID}>
          <Panel
            title={`Fila · ${modeLabel} · ${windowLabel}`}
            error={sectionErrors.queue}
            onRetry={() => void refreshAll()}
            overflow={queueOverflowLabel(queueTotal, queueAlerts.length)}
            empty={queueEmpty}
            className="min-h-0 min-[1440px]:flex-1"
            aside={(
              <OperationalCta to={alertsHref}>Ver todos em Alertas</OperationalCta>
            )}
            toolbar={(
              <>
                <ClientFilterCombobox
                  open={customerFilterOpen}
                  onOpenChange={setCustomerFilterOpen}
                  options={customerCards}
                  selectedKeys={selectedCustomerKeys}
                  selectedLabel={selectedCustomerLabel}
                  onToggle={toggleCustomer}
                />
                <OperationalSegmentedControl
                  aria-label="Modo da fila"
                  value={alertMode}
                  onChange={setAlertMode}
                  options={[
                    { value: MONITOR_ALERT_MODE.prioritary, label: "Prioritários" },
                    { value: MONITOR_ALERT_MODE.all, label: "Todos" },
                  ]}
                />
                <Popover open={severityFilterOpen} onOpenChange={setSeverityFilterOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn(OV_FILTER_CONTROL, "min-w-[9.5rem] max-w-[16rem] justify-between gap-2 px-2.5")}
                      aria-label="Severidades"
                      aria-expanded={severityFilterOpen}
                      title={activeSeverities.map((s) => formatOneViewSeverityLabel(s)).join(", ")}
                    >
                      <span className="truncate text-left font-medium">
                        {monitorSeverityTriggerLabel(activeSeverities)}
                      </span>
                      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 space-y-1 p-2">
                    <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Severidade
                    </p>
                    {MONITOR_SEVERITY_CHIP_OPTIONS.map((option) => {
                      const pressed = activeSeverities.includes(option.value);
                      return (
                        <Button
                          key={option.value}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-8 w-full justify-start border px-2 text-xs",
                            pressed && "border-foreground/20 bg-muted/40",
                            pressed && (option.value === "disaster" || option.value === "high") && "font-semibold",
                          )}
                          aria-pressed={pressed}
                          onClick={() => toggleSeverityChip(option.value)}
                        >
                          {option.label}
                          {pressed ? <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" /> : null}
                        </Button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
                <div className="flex items-center gap-1.5">
                  <span className="hidden text-[10px] font-semibold uppercase tracking-wide text-muted-foreground lg:inline">
                    Ordenação
                  </span>
                  <Select
                    value={queueSort}
                    onValueChange={(value) => setQueueSort(parseMonitorQueueSort(value))}
                  >
                    <SelectTrigger
                      className={cn(OV_FILTER_CONTROL, "h-8 min-w-[10.5rem] max-w-[14rem] px-2.5 text-xs")}
                      aria-label="Ordenação da fila"
                    >
                      <SelectValue placeholder="Mais recentes" />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {MONITOR_QUEUE_SORT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <OperationalFilterGroup label="Janela temporal">
                  {MONITOR_WINDOW_OPTIONS.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      size="sm"
                      variant={homeWindow === preset ? "default" : "outline"}
                      className={OV_FILTER_CHIP}
                      aria-pressed={homeWindow === preset}
                      onClick={() => setMonitorWindow(preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </OperationalFilterGroup>
              </>
            )}
          >
            <div className="flex h-full min-h-0 flex-col gap-1.5">
              <div className="shrink-0 space-y-1">
                <CompactMetricStrip
                  aria-label="Severidades ativas na janela"
                  items={severityStripItems}
                />
                {sectionErrors.summary ? (
                  <p className="text-xs text-amber-700 dark:text-amber-200/90">{sectionErrors.summary}</p>
                ) : null}
              </div>
              {!hasLoaded && !queueAlerts.length ? (
                <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : !queueAlerts.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">
                  {alertMode === MONITOR_ALERT_MODE.prioritary
                    ? "Nenhum alerta prioritário na janela."
                    : "Nenhum alerta ativo na janela."}
                </p>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div
                    className={cn(
                      QUEUE_GRID,
                      "shrink-0 border-b border-border/70 px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
                    )}
                    aria-hidden="true"
                  >
                    <span className="text-left">Cliente</span>
                    <span className="text-left">Host</span>
                    <span className="text-left">Problema</span>
                    <span className="text-left">Severidade</span>
                    <span className="text-left">ACK</span>
                    <span className="text-right">Início</span>
                    <span className="text-right">Duração</span>
                    <span className="text-right">Ação</span>
                  </div>
                  <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                    {queueAlerts.map((alert) => (
                      <li key={alert.id}>
                        <MonitorAlertRow
                          alert={alert}
                          onOpen={openAlert}
                          selected={selectedAlertId === alert.id}
                          freshTone={freshAttentionIds.has(alert.id) ? freshAttentionTone(alert.severity) : null}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Panel>

          <Panel
            title={snIncidentsEnabled ? unassignedPanelTitle : "Chamados sem responsável"}
            error={snIncidentsEnabled ? sectionErrors.incidents : null}
            onRetry={() => void refreshAll()}
            overflow={snIncidentsEnabled
              ? queueOverflowLabel(unassignedTotal, unassignedIncidents.length)
              : null}
            empty={snIncidentsEnabled ? unassignedEmpty : true}
            className="min-h-0 min-[1440px]:flex-1"
            aside={snIncidentsEnabled ? (
              <OperationalCta to={chamadosHref}>Ver todos em Chamados</OperationalCta>
            ) : null}
          >
            {!snIncidentsEnabled ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                Chamados não estão habilitados neste ambiente.
              </p>
            ) : !hasLoaded && !unassignedIncidents.length ? (
              <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
            ) : !unassignedIncidents.length ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                Nenhum chamado monitoring sem responsável.
              </p>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div
                  className="grid shrink-0 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-2 border-b border-border/70 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                  aria-hidden="true"
                >
                  <span>Número · Cliente</span>
                  <span className="text-right">Atualização · Prioridade · Estado</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {unassignedIncidents.map((item) => (
                    <MonitorUnassignedRow
                      key={item.sys_id || item.number || String(item.sys_updated_on)}
                      item={item}
                      onOpen={openIncident}
                      selected={selectedIncidentKey === incidentKey(item)}
                    />
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>
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

      <Sheet open={selectedIncident !== null} onOpenChange={(open) => { if (!open) closeIncident(); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-xl">
          {selectedIncident ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <SheetTitle className="font-mono text-lg">{displayIncidentField(selectedIncident.number)}</SheetTitle>
                <SheetDescription>{displayIncidentField(selectedIncident.company_display, selectedIncident.company)}</SheetDescription>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant="outline">{displayIncidentField(selectedIncident.state_display, selectedIncident.state)}</Badge>
                  <Badge variant="secondary">{displayIncidentField(selectedIncident.priority_display, selectedIncident.priority)}</Badge>
                </div>
              </SheetHeader>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
                <DetailField label="Descrição" value={descriptionText} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label="Grupo" value={displayIncidentField(selectedIncident.assignment_group_display, selectedIncident.assignment_group)} />
                  <DetailField label="Responsável" value={displayIncidentField(selectedIncident.assigned_to_display, selectedIncident.assigned_to)} />
                  <DetailField label="Abertura" value={formatDateTime(selectedIncident.opened_at)} />
                  <DetailField label="Atualização" value={formatDateTime(selectedIncident.sys_updated_on)} />
                  <DetailField label="Encerramento" value={formatDateTime(selectedIncident.closed_at || selectedIncident.resolved_at)} />
                  <DetailField label="Caller" value={displayIncidentField(selectedIncident.caller_id_display, selectedIncident.caller_id)} />
                  <DetailField label="Canal" value={displayIncidentField(selectedIncident.contact_type_display, selectedIncident.contact_type)} />
                </div>

                {hasZabbixHost || hasZabbixIp ? (
                  <section aria-label="Dados Zabbix" className="space-y-3 rounded-md border border-border/70 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Zabbix</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {hasZabbixHost ? <DetailField label="Hostname Zabbix" value={displayIncidentField(selectedIncident.u_hostname_zabbix)} /> : null}
                      {hasZabbixIp ? <DetailField label="IP Zabbix" value={displayIncidentField(selectedIncident.u_ip_zabbix)} /> : null}
                    </div>
                  </section>
                ) : null}

                <section aria-label="Alerta relacionado" className="space-y-3 rounded-md border border-border/70 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Alerta relacionado</p>
                  {relatedAlertLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-4 w-1/3" />
                    </div>
                  ) : relatedAlertChecked && relatedAlert ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <DetailField label="Cliente" value={displayIncidentField(relatedAlert.customer)} />
                        <DetailField label="Host" value={displayIncidentField(relatedAlert.host)} />
                        <DetailField label="Severidade" value={alertSeverityLabel(relatedAlert.severity)} />
                        <DetailField label="Estado" value={alertStatusLabel(relatedAlert.status)} />
                      </div>
                      <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" asChild>
                        <Link to={`/alertas?alert=${encodeURIComponent(relatedAlert.id)}`}>
                          Abrir alerta
                        </Link>
                      </Button>
                    </div>
                  ) : relatedAlertChecked ? (
                    <p className="text-sm text-muted-foreground">Alerta relacionado não localizado</p>
                  ) : null}
                </section>
              </div>

              <div className="border-t border-border/70 px-6 py-4">
                {selectedIncident.servicenow_url ? (
                  <ServiceNowDevLink href={selectedIncident.servicenow_url} fullWidth />
                ) : (
                  <p className="text-center text-xs text-muted-foreground">
                    Link do ServiceNow indisponível para este incidente.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
