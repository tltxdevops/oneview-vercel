import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eye, History, Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientIdentity, canonicalClientName, canonicalHostName } from "@/components/oneview/ClientIdentity";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  GlobalHistoryItem,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewSeverity,
  fetchAlert,
  fetchAlertHistory,
  fetchClientsTopSummary,
  formatNullableCount,
  formatOneViewSeverityLabel,
  isWindowedClientsSummary,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";
import {
  HOME_WINDOW_OPTIONS,
  PRIORITY_SEVERITIES,
  RecentOperationalMetrics,
  fetchRecentOperationalEvents,
  fetchRecentOperationalMetrics,
  fetchRecentPriorityAlerts,
  homeWindowActiveLabel,
  homeWindowMs,
  homeWindowShortLabel,
  isoAgo,
  parseHomeWindow,
  queueOverflowLabel,
  type HomeWindowPreset,
} from "@/lib/oneview-recent";
import { toast } from "sonner";

const SUMMARY_REFRESH_MS = 60_000;
const LIST_REFRESH_MS = 60_000;
const PRIORITY_PAGE_SIZE = 6;
const RECENT_EVENTS_LIMIT = 6;
const CLIENTS_LIMIT = 5;

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
type SectionKey = "summary" | "priority" | "events" | "clients";

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

function severityLabel(value: string) {
  return formatOneViewSeverityLabel(value);
}

function severityTone(value: string) {
  const severity = normalizeOneViewSeverity(value);
  if (severity === "disaster") return "border-red-600 bg-red-100 text-red-950";
  if (severity === "high") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "average") return "border-amber-200 bg-amber-50 text-amber-700";
  if (severity === "warning") return "border-yellow-200 bg-yellow-50 text-yellow-800";
  if (severity === "information") return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
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

function SectionState({
  loading,
  error,
  empty,
  emptyMessage,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyMessage: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-2 py-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-2/3" />
      </div>
    );
  }
  if (error) {
    return <OperationalErrorBanner className="my-2" message={error} onRetry={onRetry} />;
  }
  if (empty) {
    return <OperationalEmptyState compact title={emptyMessage} />;
  }
  return <>{children}</>;
}

function PriorityRow({
  alert,
  onOpen,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 py-2.5 text-left transition-colors hover:bg-muted/30"
      onClick={() => onOpen(alert)}
      aria-label={`Abrir resumo de ${alert.problem_name || "alerta"}`}
    >
      <ClientIdentity
        customer={{ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source }}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={cn("text-[10px]", severityTone(alert.severity))}>
            {severityLabel(alert.severity)}
          </Badge>
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
            Sem ACK
          </Badge>
        </div>
        <p className="mt-1 truncate text-sm font-semibold text-foreground">
          {canonicalClientName({ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source })}
        </p>
        <p className="truncate text-xs text-foreground/80">{canonicalHostName(alert)}</p>
        <p className="truncate text-xs text-muted-foreground">{alert.problem_name}</p>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
          <span>Duração {formatDurationSeconds(alert.duration_seconds)}</span>
          <span>Início {formatDateTime(alert.first_seen_at)}</span>
        </div>
      </div>
      <Eye className="h-5 w-5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export default function Index() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAlertId = searchParams.get("alert");
  const homeWindow = parseHomeWindow(searchParams.get("window"));
  const windowMs = homeWindowMs(homeWindow);
  const windowLabel = homeWindowShortLabel(homeWindow);
  const [recentMetrics, setRecentMetrics] = useState<RecentOperationalMetrics | null>(null);
  const [topClients, setTopClients] = useState<Array<{ key: string; name: string; count: number }>>([]);
  const [unclassifiedClientCount, setUnclassifiedClientCount] = useState<number | null>(null);
  const [clientsPartial, setClientsPartial] = useState(false);
  const [hasClientsData, setHasClientsData] = useState(false);
  const [priorityAlerts, setPriorityAlerts] = useState<OneViewAlert[]>([]);
  const [priorityTotal, setPriorityTotal] = useState(0);
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
  const hasClientsRef = useRef(false);
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

  const setHomeWindow = useCallback((preset: HomeWindowPreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("window", parseHomeWindow(preset));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const raw = searchParams.get("window");
    const parsed = parseHomeWindow(raw);
    if (raw === parsed) return;
    const next = new URLSearchParams(searchParams);
    next.set("window", parsed);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const buildAlertsQuery = useCallback((options: {
    status?: string;
    severities?: string[];
    sourceAck?: string;
    host?: string;
    sort?: string;
    order?: string;
    created?: string;
    view?: string;
    dateField?: string;
    datePreset?: string;
  }) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    for (const severity of options.severities ?? []) params.append("severity", severity);
    if (options.sourceAck) params.set("source_ack", options.sourceAck);
    if (options.host) params.set("host", options.host);
    if (options.sort) params.set("sort", options.sort);
    if (options.order) params.set("order", options.order);
    if (options.created) params.set("created", options.created);
    if (options.view) params.set("view", options.view);
    if (options.dateField) params.set("date_field", options.dateField);
    if (options.datePreset) params.set("date_preset", options.datePreset);
    return params;
  }, []);

  const priorityAlertsQuery = useMemo(() => buildAlertsQuery({
    status: "active",
    severities: [...PRIORITY_SEVERITIES],
    sourceAck: "unacknowledged",
    sort: "severity",
    order: "desc",
    dateField: "first_seen",
    datePreset: homeWindow,
    view: "priority",
  }), [buildAlertsQuery, homeWindow]);

  const priorityAlertsHref = `/alertas?${priorityAlertsQuery.toString()}`;

  /** High visual → high + critical legado (filtro server-side em /alertas). */
  const severityAlertsHref = useCallback((severity: OneViewSeverity | "not_classified") => {
    const severities = severity === "high"
      ? ["high", "critical"]
      : [severity];
    return `/alertas?${buildAlertsQuery({
      status: "active",
      severities,
      dateField: "first_seen",
      datePreset: homeWindow,
    }).toString()}`;
  }, [buildAlertsQuery, homeWindow]);

  const customerAlertsHref = (customerKey: string) => {
    const params = buildAlertsQuery({
      status: "active",
      dateField: "first_seen",
      datePreset: homeWindow,
    });
    if (customerKey === "unclassified") params.set("customer", "unclassified");
    else if (customerKey) params.set("customer", customerKey);
    return `/alertas?${params.toString()}`;
  };

  const loadSummary = useCallback((mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (summaryInFlight.current) return summaryInFlight.current;
    const isInitial = mode === "initial" || !hasSummaryRef.current;
    if (isInitial) setIsSummaryLoading(true);
    else if (mode === "quiet") beginQuietUpdate();

    const request = (async () => {
      const now = Date.now();
      const results = await Promise.allSettled([
        fetchRecentOperationalMetrics({ now, windowMs }),
        fetchClientsTopSummary({
          status: "active",
          firstSeenFrom: isoAgo(windowMs, now),
          limit: CLIENTS_LIMIT,
        }),
      ]);

      const [metricsResult, clientsResult] = results;
      const nextMetas: ResourceMeta[] = [];
      let summaryFailed = true;
      let clientsFailed = true;

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

      if (clientsResult.status === "fulfilled" && isWindowedClientsSummary(clientsResult.value)) {
        const payload = clientsResult.value;
        const rows = payload.top_clients;
        setTopClients(rows.map((row) => ({
          key: String(row.customer_key || "").trim() || "unclassified",
          name: canonicalClientName({
            key: row.customer_key,
            name: row.customer_name,
          }),
          count: Number.isFinite(Number(row.count)) ? Number(row.count) : 0,
        })));
        setUnclassifiedClientCount(payload.unclassified_count);
        setClientsPartial(Boolean(payload.partial));
        setHasClientsData(true);
        hasClientsRef.current = true;
        nextMetas.push({
          source: payload.data_source as OneViewDataSourceKind | undefined,
          checkedAt: payload.checked_at,
        });
        setSectionError("clients", null);
        clientsFailed = false;
      } else if (isInitial && !hasClientsRef.current) {
        // OV-P0-42B-VALIDATION: contrato ausente/legado ou rejeição → erro, não lista vazia.
        if (clientsResult.status === "fulfilled") {
          setTopClients([]);
          setUnclassifiedClientCount(null);
          setHasClientsData(false);
        }
        setSectionError("clients", "Dados indisponíveis");
      } else {
        setSectionError("clients", "Dados indisponíveis");
      }

      if (nextMetas.length) setMetas(nextMetas);
      if (!summaryFailed) hasSummaryRef.current = true;

      const hardFailures = [summaryFailed && metricsResult.status === "rejected", clientsFailed && clientsResult.status === "rejected"]
        .filter(Boolean).length;
      if (hardFailures === results.length) {
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
      const results = await Promise.allSettled([
        fetchRecentPriorityAlerts({
          limit: PRIORITY_PAGE_SIZE,
          signal: controller.signal,
          now,
          windowMs,
        }),
        fetchRecentOperationalEvents({
          limit: RECENT_EVENTS_LIMIT,
          signal: controller.signal,
          now,
          windowMs,
        }),
      ]);

      if (controller.signal.aborted || requestId !== listsRequestIdRef.current) return;

      const [priorityResult, historyResult] = results;
      let anySuccess = false;

      if (priorityResult.status === "fulfilled") {
        setPriorityAlerts(priorityResult.value.items);
        setPriorityTotal(priorityResult.value.total);
        setListsMeta({
          source: priorityResult.value.data_source as OneViewDataSourceKind | undefined,
          checkedAt: priorityResult.value.checked_at,
        });
        setSectionError("priority", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setSectionError("priority", "Não foi possível carregar os alertas prioritários.");
      } else {
        setSectionError("priority", "Falha ao atualizar prioritários. Os valores anteriores foram mantidos.");
      }

      if (historyResult.status === "fulfilled") {
        const events = (historyResult.value.items ?? []).filter(isAllowedHomeEvent).slice(0, RECENT_EVENTS_LIMIT);
        setRecentEvents(events);
        setEventsTotal(historyResult.value.total);
        setListsMeta((current) => ({
          source: current.source || (historyResult.value.data_source as OneViewDataSourceKind | undefined),
          checkedAt: latestCheckedAt(current.checkedAt, historyResult.value.checked_at) ?? undefined,
        }));
        setSectionError("events", null);
        anySuccess = true;
      } else if (isInitial && !hasListsRef.current) {
        setSectionError("events", "Não foi possível carregar os eventos recentes.");
      } else {
        setSectionError("events", "Falha ao atualizar eventos. Os valores anteriores foram mantidos.");
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
  }, [beginQuietUpdate, endQuietUpdate, setSectionError, windowMs]);

  const loadSelectedAlert = useCallback(async (alertId: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setIsDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setHistory(null);
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

  const refreshAll = useCallback(async (mode: "quiet" | "manual" = "manual") => {
    await Promise.all([loadSummary(mode), loadLists(mode)]);
  }, [loadLists, loadSummary]);

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
      description: `${homeWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
      href: severityAlertsHref(severity),
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
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Janela temporal">
      {HOME_WINDOW_OPTIONS.map((preset) => (
        <Button
          key={preset}
          type="button"
          size="sm"
          variant={homeWindow === preset ? "default" : "outline"}
          className="h-7 px-2 text-[11px]"
          aria-pressed={homeWindow === preset}
          onClick={() => setHomeWindow(preset)}
        >
          {preset}
        </Button>
      ))}
    </div>
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
      onRefresh={() => refreshAll("quiet")}
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

        <div className="grid items-stretch gap-3 xl:grid-cols-2">
          <SectionPanel
            className="flex min-h-0 flex-col overflow-hidden"
            title="Prioridade agora"
            description={queueOverflowLabel(priorityTotal, priorityAlerts.length)
              ? `${windowLabel} · sem ACK · ${queueOverflowLabel(priorityTotal, priorityAlerts.length)}`
              : `${windowLabel} · Disaster/High · sem ACK`}
            aside={(
              <Button variant="ghost" size="sm" asChild>
                <Link to={priorityAlertsHref}>Abrir todos em Alertas</Link>
              </Button>
            )}
            bodyClassName="divide-y divide-border/60 px-3"
          >
              <SectionState
                loading={isListsLoading && !priorityAlerts.length}
                error={sectionErrors.priority ?? null}
                empty={!priorityAlerts.length}
                emptyMessage="Nenhum alerta prioritário recente no momento."
                onRetry={() => void loadLists("manual")}
              >
                {priorityAlerts.map((alert) => (
                  <PriorityRow key={alert.id} alert={alert} onOpen={openAlert} />
                ))}
              </SectionState>
          </SectionPanel>

          <SectionPanel
            className="flex min-h-0 flex-col overflow-hidden"
            title="Eventos recentes"
            description={queueOverflowLabel(eventsTotal, recentEvents.length)
              ? `${windowLabel} · ${queueOverflowLabel(eventsTotal, recentEvents.length)}`
              : `${windowLabel} · até ${RECENT_EVENTS_LIMIT} eventos`}
            aside={(
              <Button variant="ghost" size="sm" asChild>
                <Link to="/historico">Abrir histórico</Link>
              </Button>
            )}
            bodyClassName="divide-y divide-border/60 px-3"
          >
              <SectionState
                loading={isListsLoading && !recentEvents.length && !sectionErrors.events}
                error={sectionErrors.events ?? null}
                empty={!recentEvents.length}
                emptyMessage="Nenhum evento operacional recente disponível."
                onRetry={() => void loadLists("manual")}
              >
                {recentEvents.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex w-full items-start justify-between gap-2.5 py-2.5 text-left transition-colors hover:bg-muted/30"
                    onClick={() => openHistoryEvent(item)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <ClientIdentity
                        customer={{ key: item.customer_key, name: item.customer_name }}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px]">{homeEventLabel(item.event_type)}</Badge>
                          {item.severity ? (
                            <Badge variant="outline" className={cn("text-[10px]", severityTone(item.severity))}>
                              {severityLabel(item.severity)}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 truncate text-sm font-semibold text-foreground">
                          {canonicalClientName({ key: item.customer_key, name: item.customer_name })}
                        </p>
                        <p className="truncate text-xs text-foreground/80">{canonicalHostName(item)}</p>
                        <p className="truncate text-xs text-muted-foreground">{item.problem_name}</p>
                        {item.description ? (
                          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.description}</p>
                        ) : null}
                        {safeActorName(item.actor_name) ? (
                          <p className="mt-1 text-[10px] text-muted-foreground">Por {safeActorName(item.actor_name)}</p>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatDateTime(item.occurred_at)}</span>
                  </button>
                ))}
              </SectionState>
          </SectionPanel>
        </div>

        <SectionPanel
          aria-label="Clientes mais impactados"
          title="Clientes mais impactados"
          description={clientsPartial
            ? `Ativos · janela ${windowLabel} · Teletex · ranking limitado`
            : `Ativos · janela ${windowLabel} · Teletex`}
          bodyClassName="space-y-2 px-3 py-2.5"
          aside={sectionErrors.clients ? (
            <Button type="button" size="sm" variant="outline" className="ov-error-action h-7 px-2 text-xs" onClick={() => void loadSummary("manual")}>
              Tentar novamente
            </Button>
          ) : null}
        >
            <SectionState
              loading={isSummaryLoading && !hasClientsData}
              error={sectionErrors.clients ?? null}
              empty={hasClientsData && !topClients.length && unclassifiedClientCount === 0}
              emptyMessage="Nenhum cliente"
              onRetry={() => void loadSummary("manual")}
            >
              {topClients.map((client) => (
                <div key={client.key} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <ClientIdentity customer={{ key: client.key, name: client.name }} showName nameClassName="font-semibold" />
                    <p className="shrink-0 text-xs text-muted-foreground">
                      {formatNullableCount(client.count)} alertas
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={customerAlertsHref(client.key)}>Abrir em Alertas</Link>
                  </Button>
                </div>
              ))}
              {hasClientsData && unclassifiedClientCount != null ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border/60 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-muted-foreground">Cliente não classificado</p>
                    <p className="text-xs text-muted-foreground">{formatNullableCount(unclassifiedClientCount)} alertas · fora do ranking</p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={customerAlertsHref("unclassified")}>Abrir em Alertas</Link>
                  </Button>
                </div>
              ) : null}
            </SectionState>
        </SectionPanel>

      </div>

      <Sheet open={selectedAlertId !== null} onOpenChange={(open) => { if (!open) closeAlert(); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-2xl">
          {selectedAlert ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <SheetTitle className="text-xl">Resumo do alerta</SheetTitle>
                    <SheetDescription>Consulta rápida sem sair da Home.</SheetDescription>
                    <ClientIdentity
                      customer={{
                        key: selectedAlert.customer_key,
                        name: selectedAlert.customer_name,
                        source: selectedAlert.customer_source,
                      }}
                      size="md"
                      showName
                    />
                  </div>
                  <Badge variant="outline" className={cn("shrink-0 text-[10px]", severityTone(selectedAlert.severity || "not_classified"))}>
                    {severityLabel(selectedAlert.severity || "not_classified")}
                  </Badge>
                </div>
              </SheetHeader>

              <Tabs key={selectedAlertId ?? "closed"} defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
                <TabsList className="mx-6 mt-4 grid w-auto grid-cols-2">
                  <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                  <TabsTrigger value="history"><History className="mr-1.5 h-4 w-4" />Histórico</TabsTrigger>
                </TabsList>

                {detailError ? <OperationalErrorBanner className="mx-6 mt-4 px-3 py-2" message={detailError} /> : null}

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  <TabsContent value="summary" className="mt-4 space-y-4">
                    {isDetailLoading && !detail ? (
                      <><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></>
                    ) : (
                      <>
                        <Card className="ov-panel p-4">
                          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
                          <p className="mt-2 text-base font-semibold leading-6">{selectedAlert.problem_name || "Alerta sem descrição"}</p>
                        </Card>
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <div><dt className="text-xs text-muted-foreground">Severidade</dt><dd className="font-semibold">{severityLabel(selectedAlert.severity || "not_classified")}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Estado</dt><dd className="font-semibold">{selectedAlert.resolved_at ? "Resolvido" : "Ativo"}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Host</dt><dd className="font-semibold">{canonicalHostName(selectedAlert)}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Início</dt><dd>{formatDateTime(selectedAlert.first_seen_at)}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Duração</dt><dd>{formatDurationSeconds(selectedAlert.duration_seconds)}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Última atualização</dt><dd>{formatDateTime(selectedAlert.last_seen_at)}</dd></div>
                          <div>
                            <dt className="text-xs text-muted-foreground">ACK da origem</dt>
                            <dd className={selectedAlert.acknowledged_source ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                              {selectedAlert.acknowledged_source ? "Reconhecido" : "Pendente"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">Responsável</dt>
                            <dd className="font-semibold">
                              {safeActorName(selectedAlert.acknowledged_source_by || selectedAlert.acknowledged_by) || "—"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">Horário do ACK</dt>
                            <dd>{selectedAlert.acknowledged_source_at || selectedAlert.acknowledged_at ? formatDateTime(selectedAlert.acknowledged_source_at || selectedAlert.acknowledged_at) : "—"}</dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-xs text-muted-foreground">Comentário oficial</dt>
                            <dd className="font-medium">
                              {historyItems.find((item) => item.comment)?.comment || "—"}
                            </dd>
                          </div>
                        </dl>
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="history" className="mt-4 space-y-3">
                    {isDetailLoading && !history ? (
                      <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                    ) : historyItems.length ? (
                      historyItems.map((item) => (
                        <Card key={item.id} className="ov-panel p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">{item.title || homeEventLabel(item.event_type)}</Badge>
                            <Badge variant="outline" className="text-[10px]">{historyOrigin(item)}</Badge>
                            <span className="text-[10px] text-muted-foreground">{formatDateTime(item.occurred_at)}</span>
                          </div>
                          {item.description ? <p className="mt-2 text-sm text-muted-foreground">{item.description}</p> : null}
                          {item.comment ? <p className="mt-1 text-xs text-muted-foreground">Comentário: {item.comment}</p> : null}
                          {safeActorName(item.ack_actor_name || item.actor_name) ? (
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              Reconhecido por {safeActorName(item.ack_actor_name || item.actor_name)}
                            </p>
                          ) : null}
                        </Card>
                      ))
                    ) : (
                      <p className="py-10 text-center text-sm text-muted-foreground">Nenhum evento de histórico disponível para este alerta.</p>
                    )}
                  </TabsContent>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-border/70 px-6 py-4">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/alertas?alert=${encodeURIComponent(selectedAlert.id)}&from=home`}>Abrir em Alertas</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/historico?alert=${encodeURIComponent(selectedAlert.id)}&from=home`}>Ver histórico</Link>
                  </Button>
                </div>
              </Tabs>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
