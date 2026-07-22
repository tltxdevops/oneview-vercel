import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  Eye,
  History,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  Siren,
  UserCheck,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  AlertMetrics,
  AttentionRequiredResponse,
  ONEVIEW_SEVERITY_CATALOG,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewFacetsResponse,
  OneViewSeverity,
  OneViewSyncLog,
  OperationalStatus,
  OperationsHealthResponse,
  fetchAlert,
  fetchAlertHistory,
  fetchAlertMetrics,
  fetchAlerts,
  fetchAttentionRequired,
  fetchOneViewFacets,
  fetchOperationsHealth,
  fetchSyncLogs,
  disasterFamilySeverities,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";
import { Client } from "@/types";
import { toast } from "sonner";

const SUMMARY_REFRESH_MS = 60_000;
const LIST_REFRESH_MS = 60_000;
const PRIORITY_PAGE_SIZE = 15;
const RECENT_PAGE_SIZE = 10;
const ATTENTION_FETCH_LIMIT = 200;
const PRIORITY_SEVERITIES = ["disaster", "high"] as const;

type AttentionBucket = "disaster" | "high" | "average";
type RecentSeverityGroup = "critical" | "high" | "average" | "low";

const RECENT_SEVERITY_GROUPS: Record<RecentSeverityGroup, { label: string; severities: OneViewSeverity[] }> = {
  critical: { label: "Críticos", severities: ["disaster", "critical"] },
  high: { label: "Altos", severities: ["high"] },
  average: { label: "Médios", severities: ["average"] },
  low: { label: "Baixos", severities: ["warning", "information", "not_classified"] },
};

const ATTENTION_BUCKETS: Record<AttentionBucket, {
  label: string;
  severities: string[];
  chipClass: string;
  thresholdKey: "disaster_minutes" | "high_minutes" | "average_minutes";
  count: (summary: AttentionRequiredResponse["summary"] | undefined) => number;
}> = {
  disaster: {
    label: "Desastres sem ACK",
    severities: ["disaster", "critical"],
    chipClass: "border-red-200 bg-red-50 text-red-800 hover:border-red-300 hover:bg-red-100",
    thresholdKey: "disaster_minutes",
    count: (summary) => (summary?.disaster ?? 0) + (summary?.critical ?? 0),
  },
  high: {
    label: "Altos sem ACK",
    severities: ["high"],
    chipClass: "border-red-100 bg-red-50/70 text-red-700 hover:border-red-200 hover:bg-red-100",
    thresholdKey: "high_minutes",
    count: (summary) => summary?.high ?? 0,
  },
  average: {
    label: "Médios sem ACK",
    severities: ["average"],
    chipClass: "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:bg-amber-100",
    thresholdKey: "average_minutes",
    count: (summary) => summary?.average ?? 0,
  },
};

type ResourceMeta = { source?: OneViewDataSourceKind; checkedAt?: string };
type SyncTone = "green" | "yellow" | "red";

type SyncSourceRow = {
  key: string;
  name: string;
  tone: SyncTone;
  statusLabel: string;
  detail: string;
  lastResult: string | null;
  fetched: number | null;
  upserted: number | null;
  durationSeconds: number | null;
  failureCount: number | null;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  syncedAt: string | null;
  operationalStatus?: OperationalStatus;
};

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

const severityRank: Record<string, number> = {
  disaster: 0,
  critical: 1,
  high: 2,
  average: 3,
  warning: 4,
  information: 5,
  not_classified: 6,
};

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function logoForCustomer(key: string, name: string) {
  const value = normalized(`${key} ${name}`);
  return customerLogos.find((item) => item.aliases.some((alias) => value.includes(alias)))?.src ?? "";
}

function safeCustomerName(value?: string | null) {
  const name = String(value || "").trim();
  return name && normalized(name) !== "cliente nao classificado" && normalized(name) !== "sem classificacao"
    ? name
    : "Cliente não identificado";
}

function safeActorName(value?: string | null) {
  const actor = String(value || "").trim();
  return actor && !/^\d+$/.test(actor) ? actor : null;
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

function relativeTime(value?: string | null) {
  if (!value) return "horário indisponível";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "horário indisponível"
    : formatDistanceToNow(date, { addSuffix: true, locale: ptBR });
}

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
}

function startOfLocalDayIso() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function severityLabel(value: string) {
  return ONEVIEW_SEVERITY_CATALOG[normalizeOneViewSeverity(value)].label;
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

function latestCheckedAt(...values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function historyOrigin(item: AlertHistoryItem) {
  if (item.legacy) return "Histórico legado";
  return String(item.source || "").toLowerCase() === "zabbix" ? "Zabbix" : "OneView";
}

function sanitizeSyncDetail(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "Sem detalhe adicional da fonte.";
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/(api[_-]?key|token|password|senha|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[hash]")
    .slice(0, 280);
}

function syncToneFrom(status?: OperationalStatus, syncStatus?: string): SyncTone {
  if (status === "error") return "red";
  if (status === "stale") return "yellow";
  if (syncStatus && syncStatus !== "success") return "red";
  if (status === "warning" || status === "disabled") return "yellow";
  if (status === "healthy" || syncStatus === "success") return "green";
  if (!status && !syncStatus) return "yellow";
  return "yellow";
}

function syncStatusLabel(status?: OperationalStatus, syncStatus?: string, hasAttempt?: boolean): string {
  if (status === "disabled") return "Desabilitado";
  if (status === "error" || (syncStatus && syncStatus !== "success")) return "Erro";
  if (status === "healthy" && (!syncStatus || syncStatus === "success")) return "Saudável";
  if (status === "warning" || status === "stale") return "Degradado";
  if (!status && !syncStatus && !hasAttempt) return "Sem dados";
  if (syncStatus === "success") return "Saudável";
  return "Degradado";
}

function syncLogDurationSeconds(log?: OneViewSyncLog | null): number | null {
  if (!log) return null;
  const raw = (log as OneViewSyncLog & { duration_seconds?: number; durationSeconds?: number }).duration_seconds
    ?? (log as OneViewSyncLog & { durationSeconds?: number }).durationSeconds;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function comparePriorityAlerts(left: OneViewAlert, right: OneViewAlert) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Date.parse(right.first_seen_at || "") - Date.parse(left.first_seen_at || "");
}

function buildBancoSyncRow(operations: OperationsHealthResponse | null): SyncSourceRow | null {
  if (!operations) return null;
  const source = operations.data_source;
  const checkedAt = operations.checked_at || null;
  if (source === "database") {
    return {
      key: "banco",
      name: "Banco",
      tone: "green",
      statusLabel: "Saudável",
      detail: "Consultas servidas pelo banco em tempo real.",
      lastResult: "database",
      fetched: null,
      upserted: null,
      durationSeconds: null,
      failureCount: null,
      lastSuccessAt: checkedAt,
      lastSyncAt: checkedAt,
      lastAttemptAt: checkedAt,
      syncedAt: checkedAt,
      operationalStatus: "healthy",
    };
  }
  if (source === "snapshot") {
    return {
      key: "banco",
      name: "Banco",
      tone: "yellow",
      statusLabel: "Degradado",
      detail: "Contingência: cópia atualizada (snapshot), sem leitura live do banco.",
      lastResult: "snapshot",
      fetched: null,
      upserted: null,
      durationSeconds: null,
      failureCount: null,
      lastSuccessAt: null,
      lastSyncAt: checkedAt,
      lastAttemptAt: checkedAt,
      syncedAt: checkedAt,
      operationalStatus: "warning",
    };
  }
  return {
    key: "banco",
    name: "Banco",
    tone: "yellow",
    statusLabel: "Sem dados",
    detail: "Situação do banco indisponível nesta resposta.",
    lastResult: null,
    fetched: null,
    upserted: null,
    durationSeconds: null,
    failureCount: null,
    lastSuccessAt: null,
    lastSyncAt: checkedAt,
    lastAttemptAt: checkedAt,
    syncedAt: checkedAt,
  };
}

function buildWorkerSyncRow(operations: OperationsHealthResponse | null): SyncSourceRow | null {
  const worker = operations?.worker;
  if (!worker) return null;
  const workerTone: SyncTone = worker.status === "healthy" ? "green" : "yellow";
  const statusLabel = worker.status === "healthy"
    ? "Saudável"
    : worker.status === "stale"
      ? "Degradado"
      : "Sem dados";
  return {
    key: "worker",
    name: "Worker",
    tone: workerTone,
    statusLabel,
    detail: sanitizeSyncDetail(
      worker.last_activity_at
        ? `Última atividade ${relativeTime(worker.last_activity_at)}`
        : "Sem atividade registrada do worker.",
    ),
    lastResult: worker.status,
    fetched: null,
    upserted: null,
    durationSeconds: null,
    failureCount: null,
    lastSuccessAt: worker.status === "healthy" ? worker.last_activity_at : null,
    lastSyncAt: worker.last_activity_at,
    lastAttemptAt: worker.last_activity_at,
    syncedAt: worker.last_activity_at,
  };
}

function buildSyncRows(operations: OperationsHealthResponse | null, syncLogs: OneViewSyncLog[]): SyncSourceRow[] {
  const newestBySource = new Map<string, OneViewSyncLog>();
  [...syncLogs]
    .sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""))
    .forEach((log) => {
      const key = log.datasource.toLowerCase();
      if (!newestBySource.has(key)) newestBySource.set(key, log);
    });

  const prefix: SyncSourceRow[] = [];
  const banco = buildBancoSyncRow(operations);
  if (banco) prefix.push(banco);
  const worker = buildWorkerSyncRow(operations);
  if (worker) prefix.push(worker);

  const fromOperations = (operations?.items ?? []).map((item) => {
    const log = newestBySource.get(item.name.toLowerCase());
    const tone = syncToneFrom(item.operational_status, log?.status || item.last_sync_status || undefined);
    const lastAttemptAt = log?.created_at || item.last_sync_at || item.last_activity_at || null;
    const lastResult = log?.status || item.last_sync_status || null;
    return {
      key: item.id || item.name,
      name: item.name,
      tone,
      statusLabel: syncStatusLabel(item.operational_status, lastResult || undefined, Boolean(lastAttemptAt)),
      detail: sanitizeSyncDetail(
        log?.detail
        || (item.reason_code ? `Código: ${item.reason_code}` : null)
        || (item.last_sync_status && item.last_sync_status !== "success" ? `Último sync: ${item.last_sync_status}` : null)
        || "Sem detalhe adicional da fonte.",
      ),
      lastResult,
      fetched: log ? Number(log.fetched) || 0 : null,
      upserted: log ? Number(log.upserted) || 0 : null,
      durationSeconds: syncLogDurationSeconds(log),
      failureCount: item.failure_count ?? null,
      lastSuccessAt: item.last_success_at || null,
      lastSyncAt: item.last_sync_at || null,
      lastAttemptAt,
      syncedAt: lastAttemptAt,
      operationalStatus: item.operational_status,
    } satisfies SyncSourceRow;
  });

  if (fromOperations.length || prefix.length) {
    return [...prefix, ...fromOperations];
  }

  return [...newestBySource.values()].map((log) => {
    const tone = syncToneFrom(undefined, log.status);
    return {
      key: log.id,
      name: log.datasource,
      tone,
      statusLabel: syncStatusLabel(undefined, log.status, Boolean(log.created_at)),
      detail: sanitizeSyncDetail(log.detail || (log.status === "success" ? "Sincronização concluída." : "Falha na última sincronização.")),
      lastResult: log.status,
      fetched: Number(log.fetched) || 0,
      upserted: Number(log.upserted) || 0,
      durationSeconds: syncLogDurationSeconds(log),
      failureCount: null,
      lastSuccessAt: log.status === "success" ? log.created_at : null,
      lastSyncAt: log.created_at,
      lastAttemptAt: log.created_at,
      syncedAt: log.created_at,
    } satisfies SyncSourceRow;
  });
}

const toneDotClass: Record<SyncTone, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

function AlertListRow({
  alert,
  onOpen,
  ariaLabel,
}: {
  alert: OneViewAlert;
  onOpen: (alert: OneViewAlert) => void;
  ariaLabel: string;
}) {
  return (
    <div className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("text-[10px]", severityTone(alert.severity))}>{severityLabel(alert.severity)}</Badge>
          <span className="text-xs font-semibold">{safeCustomerName(alert.customer_name)}</span>
          <span className="text-[11px] text-muted-foreground">{alert.datasource_name || "Fonte não identificada"}</span>
        </div>
        <p className="mt-1 truncate text-sm font-semibold">{alert.host_visible_name || alert.host_technical_name || "Host não identificado"}</p>
        <p className="truncate text-xs text-muted-foreground">{alert.problem_name}</p>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
          <span>Criado {relativeTime(alert.first_seen_at)}</span>
          <span>Atualizado {relativeTime(alert.last_seen_at)}</span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title="Ver detalhes do alerta"
        aria-label={ariaLabel}
        onClick={() => onOpen(alert)}
      >
        <Eye className="h-4 w-4" />
      </Button>
    </div>
  );
}

export default function Index() {
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [operations, setOperations] = useState<OperationsHealthResponse | null>(null);
  const [attention, setAttention] = useState<AttentionRequiredResponse | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [syncLogs, setSyncLogs] = useState<OneViewSyncLog[]>([]);
  const [priorityAlerts, setPriorityAlerts] = useState<OneViewAlert[]>([]);
  const [recentAlerts, setRecentAlerts] = useState<OneViewAlert[]>([]);
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [todayOnly, setTodayOnly] = useState(false);
  const [recentSeverityGroups, setRecentSeverityGroups] = useState<RecentSeverityGroup[]>([]);
  const [attentionBucket, setAttentionBucket] = useState<AttentionBucket | null>(null);
  const [clientsOpen, setClientsOpen] = useState(false);
  const [isSummaryLoading, setIsSummaryLoading] = useState(true);
  const [isListsLoading, setIsListsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBackgroundUpdating, setIsBackgroundUpdating] = useState(false);
  const [metas, setMetas] = useState<ResourceMeta[]>([]);
  const [listsMeta, setListsMeta] = useState<ResourceMeta>({});
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

  const operationalDayFrom = metrics?.operational_day?.from ?? startOfLocalDayIso();
  const operationalDayTo = metrics?.operational_day?.to ?? undefined;
  const todayDayFrom = todayOnly ? operationalDayFrom : undefined;
  const todayDayTo = todayOnly ? (operationalDayTo ?? nowIso()) : undefined;
  /** KPI "Reconhecidos": dia operacional completo (00:00 → fim do dia); é o atalho por dia. */
  const ackTodayFrom = operationalDayFrom;
  const ackTodayTo = operationalDayTo;

  const recentSeverities = useMemo(() => {
    if (!recentSeverityGroups.length) return undefined;
    const seen = new Set<string>();
    const severities: string[] = [];
    for (const group of recentSeverityGroups) {
      for (const severity of RECENT_SEVERITY_GROUPS[group].severities) {
        if (seen.has(severity)) continue;
        seen.add(severity);
        severities.push(severity);
      }
    }
    return severities;
  }, [recentSeverityGroups]);

  const severityCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const row of metrics?.by_severity ?? []) {
      map[normalizeOneViewSeverity(row.severity)] = Number(row.count) || 0;
    }
    return map;
  }, [metrics]);

  const disasterSeverities = useMemo(
    () => disasterFamilySeverities(severityCountMap),
    [severityCountMap],
  );

  const buildAlertsQuery = useCallback((options: {
    status?: string;
    severities?: string[];
    sourceAck?: string;
    createdFrom?: string;
    createdTo?: string;
    updatedFrom?: string;
    updatedTo?: string;
    resolvedFrom?: string;
    ackFrom?: string;
    ackTo?: string;
    sort?: string;
    order?: string;
  }) => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    for (const severity of options.severities ?? []) params.append("severity", severity);
    if (options.sourceAck) params.set("source_ack", options.sourceAck);
    if (options.sort) params.set("sort", options.sort);
    if (options.order) params.set("order", options.order);
    selectedCustomerKeys.forEach((customer) => params.append("customer", customer));
    const appendTemporal = (prefix: string, from?: string, to?: string) => {
      if (!from && !to) return;
      params.set(prefix, "custom");
      if (from) params.set(`${prefix}_from`, from.includes("T") ? from : from.slice(0, 10));
      if (to) params.set(`${prefix}_to`, to.includes("T") ? to : to.slice(0, 10));
    };
    appendTemporal("created", options.createdFrom, options.createdTo);
    appendTemporal("updated", options.updatedFrom, options.updatedTo);
    if (options.resolvedFrom) {
      params.set("resolved", "custom");
      params.set("resolved_from", options.resolvedFrom.slice(0, 10));
    }
    appendTemporal("ack", options.ackFrom, options.ackTo);
    return params;
  }, [selectedCustomerKeys]);

  const todayUpdatedFilter = todayOnly
    ? { updatedFrom: todayDayFrom, updatedTo: todayDayTo }
    : {};

  const priorityAlertsQuery = useMemo(() => buildAlertsQuery({
    status: "active",
    severities: [...PRIORITY_SEVERITIES],
    sort: "first_seen_at",
    order: "desc",
    ...todayUpdatedFilter,
  }), [buildAlertsQuery, todayDayFrom, todayDayTo, todayOnly]);

  const priorityAlertsHref = `/alertas?${buildAlertsQuery({
    status: "active",
    severities: [...PRIORITY_SEVERITIES],
    ...todayUpdatedFilter,
  }).toString()}`;
  const highAlertsHref = `/alertas?${buildAlertsQuery({
    status: "active",
    severities: ["high"],
    ...todayUpdatedFilter,
  }).toString()}`;
  const unacknowledgedHref = `/alertas?${buildAlertsQuery({
    status: "active",
    sourceAck: "unacknowledged",
    ...todayUpdatedFilter,
  }).toString()}`;
  const acksTodayHref = `/alertas?${buildAlertsQuery({
    status: "all",
    sourceAck: "acknowledged",
    ackFrom: ackTodayFrom,
    ackTo: ackTodayTo,
    sort: "last_seen_at",
    order: "desc",
  }).toString()}`;
  const disasterAlertsHref = `/alertas?${buildAlertsQuery({
    status: "active",
    severities: disasterSeverities,
    ...todayUpdatedFilter,
  }).toString()}`;
  const alertHref = (alertId: string, query?: URLSearchParams) => {
    const params = new URLSearchParams(query);
    params.set("alert", alertId);
    return `/alertas?${params.toString()}`;
  };

  const attentionAlertsHref = useCallback((bucket: AttentionBucket) => {
    const config = ATTENTION_BUCKETS[bucket];
    const minutes = attention?.thresholds?.[config.thresholdKey];
    const createdTo = minutes != null
      ? new Date(Date.now() - minutes * 60_000).toISOString()
      : undefined;
    return `/alertas?${buildAlertsQuery({
      status: "active",
      severities: config.severities,
      sourceAck: "unacknowledged",
      createdTo,
    }).toString()}`;
  }, [attention?.thresholds, buildAlertsQuery]);

  const syncRows = useMemo(() => buildSyncRows(operations, syncLogs), [operations, syncLogs]);

  const attentionSummary = attention?.summary;
  const attentionThresholds = attention?.thresholds;
  const attentionPanelItems = useMemo(() => {
    if (!attentionBucket) return [];
    const allowed = new Set(ATTENTION_BUCKETS[attentionBucket].severities);
    return (attention?.items ?? []).filter((item) => allowed.has(String(item.severity || "").toLowerCase()));
  }, [attention?.items, attentionBucket]);

  const toggleRecentSeverityGroup = useCallback((group: RecentSeverityGroup) => {
    setRecentSeverityGroups((current) => (
      current.includes(group)
        ? current.filter((value) => value !== group)
        : [...current, group]
    ));
  }, []);

  const loadSummary = useCallback((mode: "initial" | "quiet" | "manual" = "quiet") => {
    if (summaryInFlight.current) return summaryInFlight.current;
    const isInitial = mode === "initial" || !hasSummaryRef.current;
    if (isInitial) setIsSummaryLoading(true);
    else if (mode === "quiet") beginQuietUpdate();
    const request = (async () => {
      const [operationsResponse, metricsResponse, syncResponse, facetsResponse, attentionResponse] = await Promise.all([
        fetchOperationsHealth(),
        fetchAlertMetrics(),
        fetchSyncLogs(20),
        fetchOneViewFacets(),
        fetchAttentionRequired(ATTENTION_FETCH_LIMIT),
      ]);
      setOperations(operationsResponse);
      setMetrics(metricsResponse);
      setSyncLogs(syncResponse.items);
      setFacets(facetsResponse);
      setAttention(attentionResponse);
      setMetas([
        { source: operationsResponse.data_source, checkedAt: operationsResponse.checked_at },
        { source: metricsResponse.data_source, checkedAt: metricsResponse.checked_at },
        { source: syncResponse.data_source, checkedAt: syncResponse.checked_at },
        { source: facetsResponse.data_source, checkedAt: facetsResponse.checked_at },
        { source: attentionResponse.data_source, checkedAt: attentionResponse.checked_at },
      ]);
      hasSummaryRef.current = true;
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar a visão operacional.");
    }).finally(() => {
      setIsSummaryLoading(false);
      if (!isInitial && mode === "quiet") endQuietUpdate();
      summaryInFlight.current = null;
    });
    summaryInFlight.current = request;
    return request;
  }, [beginQuietUpdate, endQuietUpdate]);

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
      const [priorityResponse, recentResponse] = await Promise.all([
        fetchAlerts({
          page: 1,
          pageSize: PRIORITY_PAGE_SIZE,
          status: "active",
          customers: selectedCustomerKeys,
          severities: [...PRIORITY_SEVERITIES],
          sort: "severity",
          order: "desc",
          lastSeenFrom: todayDayFrom,
          lastSeenTo: todayDayTo,
          signal: controller.signal,
        }),
        fetchAlerts({
          page: 1,
          pageSize: RECENT_PAGE_SIZE,
          status: "active",
          customers: selectedCustomerKeys,
          severities: recentSeverities,
          sort: "first_seen_at",
          order: "desc",
          lastSeenFrom: todayDayFrom,
          lastSeenTo: todayDayTo,
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted || requestId !== listsRequestIdRef.current) return;
      // BFF severity sort already secondary-orders by first_seen_at; client re-sort keeps the contract explicit.
      setPriorityAlerts([...priorityResponse.items].sort(comparePriorityAlerts).slice(0, PRIORITY_PAGE_SIZE));
      setRecentAlerts(recentResponse.items.slice(0, RECENT_PAGE_SIZE));
      setListsMeta({
        source: priorityResponse.data_source || recentResponse.data_source,
        checkedAt: latestCheckedAt(priorityResponse.checked_at, recentResponse.checked_at) ?? undefined,
      });
      hasListsRef.current = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "Não foi possível carregar os alertas prioritários.");
      }
    } finally {
      if (requestId === listsRequestIdRef.current) setIsListsLoading(false);
      if (beganQuiet) endQuietUpdate();
    }
  }, [beginQuietUpdate, endQuietUpdate, recentSeverities, selectedCustomerKeys, todayDayFrom, todayDayTo, todayOnly]);

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
  }, [loadSelectedAlert]);

  const closeAlert = useCallback(() => {
    detailRequest.current?.abort();
    setSelectedAlertId(null);
    setSelectedPreview(null);
    setDetail(null);
    setHistory(null);
    setDetailError(null);
    setIsDetailLoading(false);
  }, []);

  const refreshAll = useCallback(async (mode: "quiet" | "manual" = "manual") => {
    await Promise.all([loadSummary(mode), loadLists(mode)]);
  }, [loadLists, loadSummary]);

  const triggerRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshAll("manual");
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshAll]);

  useEffect(() => { void loadSummary("initial"); }, [loadSummary]);
  useEffect(() => {
    hasListsRef.current = false;
    void loadLists("initial");
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
  const topCustomers = (facets?.customers ?? []).slice(0, 6);
  const selectedAlert = detail?.item ?? selectedPreview;
  const historyItems = (history?.items ?? []).filter((item) => item.event_type !== "internal_acknowledged" && item.origin !== "oneview_internal");
  const showInitialLoading = (isSummaryLoading && !hasSummaryRef.current) || (isListsLoading && !priorityAlerts.length && !recentAlerts.length);

  const kpiCards = [
    {
      title: "Desastres ativos",
      value: (severityCountMap.disaster ?? 0) + (severityCountMap.critical ?? 0),
      description: todayOnly ? "Desastres atualizados no dia" : "Prioridade máxima na origem",
      icon: Siren,
      tone: "bg-red-100 text-red-950",
      href: disasterAlertsHref,
    },
    {
      title: "Altos ativos",
      value: severityCountMap.high ?? 0,
      description: todayOnly ? "Altos atualizados no dia" : "Severidade alta na origem",
      icon: ShieldAlert,
      tone: "bg-red-50 text-red-700",
      href: highAlertsHref,
    },
    {
      title: "Não reconhecidos",
      value: metrics?.unacknowledged_total ?? 0,
      description: todayOnly ? "Sem ACK · atualizados no dia" : "Sem ACK no Zabbix",
      icon: History,
      tone: "bg-amber-50 text-amber-800",
      href: unacknowledgedHref,
    },
    {
      title: "Reconhecidos",
      value: metrics?.source_acknowledgements_today ?? 0,
      description: "Reconhecidos na origem hoje (desde 00:00)",
      icon: UserCheck,
      tone: "bg-emerald-50 text-emerald-700",
      href: acksTodayHref,
    },
  ];

  const topbarControls = (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      <div className="flex min-w-0 max-w-[min(100%,42rem)] items-center gap-1.5 overflow-x-auto py-0.5">
        <span className="shrink-0 text-[11px] text-muted-foreground">Syncs</span>
        <TooltipProvider delayDuration={200}>
          {syncRows.map((row) => (
            <Popover key={row.key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex max-w-[9.5rem] items-center gap-1.5 rounded-md border border-border/60 bg-white px-2 py-1 text-left text-[11px] font-medium text-foreground transition-colors hover:border-foreground/30"
                      aria-label={`Situação de ${row.name}: ${row.statusLabel}`}
                    >
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", toneDotClass[row.tone])} />
                      <span className="min-w-0 truncate">
                        <span className="block truncate leading-tight">{row.name}</span>
                        <span className="block truncate text-[10px] font-normal text-muted-foreground">{row.statusLabel}</span>
                      </span>
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  <p className="font-semibold">{row.name} · {row.statusLabel}</p>
                  <p className="mt-1 text-muted-foreground">{relativeTime(row.syncedAt)}</p>
                  <p className="mt-1 line-clamp-3">{row.detail}</p>
                </TooltipContent>
              </Tooltip>
              <PopoverContent align="end" side="bottom" className="w-80 p-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 rounded-full", toneDotClass[row.tone])} />
                    <p className="text-sm font-semibold">{row.name}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.statusLabel}</p>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                    <div>
                      <dt className="text-muted-foreground">Último resultado</dt>
                      <dd className="font-medium">{row.lastResult || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Falhas</dt>
                      <dd className="font-medium tabular-nums">{row.failureCount == null ? "—" : row.failureCount}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Obtidos</dt>
                      <dd className="font-medium tabular-nums">{row.fetched == null ? "—" : row.fetched}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Gravados</dt>
                      <dd className="font-medium tabular-nums">{row.upserted == null ? "—" : row.upserted}</dd>
                    </div>
                    {formatDurationSeconds(row.durationSeconds) ? (
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">Duração</dt>
                        <dd className="font-medium">{formatDurationSeconds(row.durationSeconds)}</dd>
                      </div>
                    ) : null}
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Último sucesso</dt>
                      <dd>{row.lastSuccessAt ? `${formatDateTime(row.lastSuccessAt)} · ${relativeTime(row.lastSuccessAt)}` : "—"}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Última tentativa</dt>
                      <dd>{row.lastAttemptAt ? `${formatDateTime(row.lastAttemptAt)} · ${relativeTime(row.lastAttemptAt)}` : "—"}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Tempo desde o último sync</dt>
                      <dd>{relativeTime(row.lastSyncAt || row.lastAttemptAt)}</dd>
                    </div>
                  </dl>
                  <p className="text-sm leading-5 text-foreground">{row.detail}</p>
                </div>
              </PopoverContent>
            </Popover>
          ))}
        </TooltipProvider>
        {!syncRows.length && !isSummaryLoading ? (
          <span className="text-[11px] text-muted-foreground">Aguardando fontes</span>
        ) : null}
      </div>
      {isBackgroundUpdating ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Atualizando...
        </span>
      ) : (
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          Última atualização: <span className="font-semibold text-foreground">{formatClock(lastCheckedAt)}</span>
        </span>
      )}
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground"
              aria-label="Atualizar agora"
              onClick={() => void triggerRefresh()}
              disabled={isRefreshing}
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Atualizar agora</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );

  return (
    <AppLayout
      clientSelect={<ClientSelect clients={clients} selectedClient={selectedClient} onClientChange={setSelectedClient} />}
      topbarRightSection={topbarControls}
      onRefresh={() => refreshAll("quiet")}
      enableAutoRefresh={false}
      showRefreshMeta={false}
    >
      <div className="space-y-2">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Visão operacional</h1>
            <p className="text-sm text-muted-foreground">
              {todayOnly
                ? "Filtro do dia ativo · alertas atualizados desde 00:00 · "
                : "Desastres e altos ativos · ACK real do Zabbix · "}
              {selectedClientLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={todayOnly ? "default" : "outline"}
              aria-pressed={todayOnly}
              title={todayOnly ? "Remover filtro do dia e mostrar tudo" : "Filtrar KPIs e listas pelo dia de hoje"}
              onClick={() => setTodayOnly((current) => !current)}
            >
              Hoje
            </Button>
            {showInitialLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            {isBackgroundUpdating ? (
              <span className="text-[11px] text-muted-foreground sm:hidden">Atualizando...</span>
            ) : null}
          </div>
        </header>

        <section aria-label="Indicadores" className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {kpiCards.map((card) => {
            const Icon = card.icon;
            return (
              <Link
                key={card.title}
                to={card.href}
                aria-label={`Abrir alertas: ${card.title}`}
                className="rounded-[10px] border border-border/70 bg-card p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{card.title}</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{Number(card.value).toLocaleString("pt-BR")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{card.description}</p>
                  </div>
                  <span className={cn("flex h-8 w-8 items-center justify-center rounded-full", card.tone)}>
                    <Icon className="h-4 w-4" />
                  </span>
                </div>
              </Link>
            );
          })}
        </section>

        <div className="grid items-stretch gap-2 xl:grid-cols-2">
          <Card className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border/70 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
              <div>
                <h2 className="text-sm font-semibold">Alertas prioritários</h2>
                <p className="text-xs text-muted-foreground">
                  {todayOnly
                    ? `Desastre e alto · atualizados no dia · até ${PRIORITY_PAGE_SIZE}`
                    : `Desastre e alto ativos · severidade, depois first_seen_at · até ${PRIORITY_PAGE_SIZE}`}
                </p>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link to={priorityAlertsHref}>Ver todos</Link>
              </Button>
            </div>
            <div className="max-h-[30rem] flex-1 divide-y divide-border/60 overflow-y-auto px-3">
              {priorityAlerts.map((alert) => (
                <AlertListRow
                  key={alert.id}
                  alert={alert}
                  onOpen={openAlert}
                  ariaLabel="Ver detalhes do alerta prioritário"
                />
              ))}
              {!priorityAlerts.length && !isListsLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {todayOnly
                    ? "Nenhum alerta prioritário atualizado no dia."
                    : "Nenhum alerta prioritário ativo no escopo selecionado."}
                </p>
              ) : null}
              {isListsLoading && !priorityAlerts.length ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Carregando alertas prioritários
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border/70 bg-white shadow-sm">
            <div className="space-y-2 border-b border-border/60 px-3 py-2.5">
              <div>
                <h2 className="text-sm font-semibold">Alertas recentes</h2>
                <p className="text-xs text-muted-foreground">
                  {todayOnly
                    ? `Atualizados no dia · até ${RECENT_PAGE_SIZE}`
                    : recentSeverityGroups.length
                      ? `Filtro ativo · first_seen_at · até ${RECENT_PAGE_SIZE}`
                      : `Todas as severidades · first_seen_at · até ${RECENT_PAGE_SIZE}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar alertas recentes por severidade">
                <button
                  type="button"
                  aria-pressed={recentSeverityGroups.length === 0}
                  onClick={() => setRecentSeverityGroups([])}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                    recentSeverityGroups.length === 0
                      ? "border-foreground/30 bg-foreground text-background"
                      : "border-border/70 bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  Todos
                </button>
                {(Object.keys(RECENT_SEVERITY_GROUPS) as RecentSeverityGroup[]).map((group) => {
                  const active = recentSeverityGroups.includes(group);
                  return (
                    <button
                      key={group}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleRecentSeverityGroup(group)}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                        active
                          ? "border-foreground/30 bg-foreground text-background"
                          : "border-border/70 bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                      )}
                    >
                      {RECENT_SEVERITY_GROUPS[group].label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="max-h-[30rem] flex-1 divide-y divide-border/60 overflow-y-auto px-3">
              {recentAlerts.map((alert) => (
                <AlertListRow
                  key={alert.id}
                  alert={alert}
                  onOpen={openAlert}
                  ariaLabel="Ver detalhes do alerta recente"
                />
              ))}
              {!recentAlerts.length && !isListsLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {todayOnly
                    ? "Nenhum alerta atualizado no dia no filtro selecionado."
                    : "Nenhum alerta recente no escopo selecionado."}
                </p>
              ) : null}
              {isListsLoading && !recentAlerts.length ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Carregando alertas recentes
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        <section
          aria-label="Atenção operacional"
          className="rounded-[10px] border border-border/70 bg-card px-3 py-2.5 shadow-sm"
        >
          <h2 className="text-sm font-semibold">Atenção operacional</h2>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
            {(Object.keys(ATTENTION_BUCKETS) as AttentionBucket[]).map((bucket) => {
              const config = ATTENTION_BUCKETS[bucket];
              const threshold = attentionThresholds?.[config.thresholdKey];
              return (
                <button
                  key={bucket}
                  type="button"
                  onClick={() => setAttentionBucket(bucket)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-left transition-colors",
                    config.chipClass,
                  )}
                >
                  {config.label} {config.count(attentionSummary)}
                  {threshold != null ? ` · +${threshold} min` : ""}
                </button>
              );
            })}
          </div>
        </section>

        <Card className="rounded-[10px] border border-border/70 bg-white px-3 py-2.5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">ServiceNow</h2>
              <p className="text-xs text-muted-foreground">Integração ServiceNow em preparação.</p>
            </div>
            <Badge variant="outline" className="text-[10px]">Em breve</Badge>
          </div>
        </Card>

        <Collapsible open={clientsOpen} onOpenChange={setClientsOpen}>
          <Card className="rounded-[10px] border border-border/70 bg-white shadow-sm">
            <CollapsibleTrigger asChild>
              <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
                <div>
                  <h2 className="text-sm font-semibold">Clientes com mais alertas</h2>
                  <p className="text-xs text-muted-foreground">Visão auxiliar · recolhida por padrão</p>
                </div>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", clientsOpen && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 border-t border-border/60 px-3 py-2.5">
                {topCustomers.map((customer, index) => {
                  const name = customer.key === "unclassified" ? "Cliente não identificado" : safeCustomerName(customer.name);
                  const maximum = Math.max(topCustomers[0]?.alerts_count ?? 1, 1);
                  return (
                    <div key={customer.key} className="space-y-1">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="text-xs text-muted-foreground">{index + 1}</span>
                          {logoForCustomer(customer.key, name) ? (
                            <img src={logoForCustomer(customer.key, name)} alt="" className="h-6 w-6 rounded border border-border/50 bg-white object-contain p-0.5" />
                          ) : null}
                          <span className="truncate font-medium">{name}</span>
                        </span>
                        <span className="font-semibold tabular-nums">{customer.alerts_count.toLocaleString("pt-BR")}</span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (customer.alerts_count / maximum) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
                {!topCustomers.length ? <p className="text-sm text-muted-foreground">Aguardando dados dos clientes.</p> : null}
              </div>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>

      <Sheet open={attentionBucket !== null} onOpenChange={(open) => { if (!open) setAttentionBucket(null); }}>
        <SheetContent side="left" className="w-full border-r border-border bg-background p-0 sm:max-w-md">
          {attentionBucket ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <SheetTitle className="text-lg">{ATTENTION_BUCKETS[attentionBucket].label}</SheetTitle>
                <SheetDescription>
                  {ATTENTION_BUCKETS[attentionBucket].count(attentionSummary).toLocaleString("pt-BR")} alertas
                  {attentionThresholds?.[ATTENTION_BUCKETS[attentionBucket].thresholdKey] != null
                    ? ` · limiar +${attentionThresholds[ATTENTION_BUCKETS[attentionBucket].thresholdKey]} min`
                    : ""}
                </SheetDescription>
              </SheetHeader>
              <div className="border-b border-border/60 px-6 py-3">
                <Button asChild className="w-full" size="sm">
                  <Link to={attentionAlertsHref(attentionBucket)}>Abrir em Alertas</Link>
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
                <div className="divide-y divide-border/60">
                  {attentionPanelItems.map((item) => (
                    <Link
                      key={item.id}
                      to={alertHref(item.id, new URLSearchParams(attentionAlertsHref(attentionBucket).split("?")[1] || ""))}
                      className="block py-3 transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{item.host_visible_name || "Host não identificado"}</p>
                          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.problem}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {safeCustomerName(item.customer_name)} · {item.datasource_name}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <Badge variant="outline" className={cn("text-[10px]", severityTone(item.severity))}>
                            {severityLabel(item.severity)}
                          </Badge>
                          <p className="mt-1 text-[11px] font-medium tabular-nums text-amber-700">
                            {item.unacknowledged_minutes} min
                          </p>
                        </div>
                      </div>
                    </Link>
                  ))}
                  {!attentionPanelItems.length ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      Nenhum item nesta faixa nos últimos {ATTENTION_FETCH_LIMIT} carregados.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={selectedAlertId !== null} onOpenChange={(open) => { if (!open) closeAlert(); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-2xl">
          {selectedAlert ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <SheetTitle className="text-xl">Detalhes do alerta</SheetTitle>
                    <SheetDescription>Resumo e histórico sem sair da visão operacional.</SheetDescription>
                  </div>
                  <Badge variant="outline" className={cn("shrink-0 text-[10px]", severityTone(selectedAlert.severity || "not_classified"))}>
                    {severityLabel(selectedAlert.severity || "not_classified")}
                  </Badge>
                </div>
              </SheetHeader>

              <Tabs key={selectedAlertId ?? "closed"} defaultValue="history" className="flex min-h-0 flex-1 flex-col">
                <TabsList className="mx-6 mt-4 grid w-auto grid-cols-2">
                  <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                  <TabsTrigger value="history"><History className="mr-1.5 h-4 w-4" />Histórico</TabsTrigger>
                </TabsList>

                {detailError ? <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</div> : null}

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  <TabsContent value="summary" className="mt-4 space-y-4">
                    {isDetailLoading && !detail ? (
                      <><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></>
                    ) : (
                      <>
                        <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
                          <p className="mt-2 text-base font-semibold leading-6">{selectedAlert.problem_name || "Alerta sem descrição"}</p>
                        </Card>
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <div><dt className="text-xs text-muted-foreground">Cliente</dt><dd className="font-semibold">{safeCustomerName(selectedAlert.customer_name)}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Fonte</dt><dd className="font-semibold">{selectedAlert.datasource_name || "Fonte não identificada"}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Host</dt><dd className="font-semibold">{selectedAlert.host_visible_name || selectedAlert.host_technical_name || "Host não identificado"}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Primeira ocorrência</dt><dd>{formatDateTime(selectedAlert.first_seen_at)}</dd></div>
                          <div><dt className="text-xs text-muted-foreground">Última ocorrência</dt><dd>{formatDateTime(selectedAlert.last_seen_at)}</dd></div>
                          <div>
                            <dt className="text-xs text-muted-foreground">ACK origem</dt>
                            <dd className={selectedAlert.acknowledged_source ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                              {selectedAlert.acknowledged_source
                                ? `Reconhecido por ${safeActorName(selectedAlert.acknowledged_source_by || selectedAlert.acknowledged_by) || "responsável não identificado"}`
                                : "Pendente"}
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
                        <Card key={item.id} className="rounded-[10px] border border-border/70 bg-white p-3 shadow-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">{item.title || item.event_type}</Badge>
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

                <div className="border-t border-border/70 px-6 py-4">
                  <Button variant="outline" size="sm" asChild>
                    <Link to={alertHref(selectedAlert.id, priorityAlertsQuery)}>Abrir em Alertas</Link>
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
