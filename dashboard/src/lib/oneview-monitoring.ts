/**
 * OV-P0-70 / OV-P0-72 / OV-P0-75 — helpers/constantes exclusivos do Monitoramento.
 * Não altera oneview-home.ts nem o contrato legado de oneview-recent.ts.
 */
import {
  OneViewAlert,
  fetchAlerts,
  normalizeOneViewSeverity,
  type IncidentListResponse,
} from "@/lib/oneview-api";
import {
  OPERATIONAL_INCIDENT_STATES,
  OPERATIONAL_INCIDENTS_PAGE_SIZE,
  buildOperationalChamadosHref,
  fetchOperationalIncidents,
  type IncidentsQueueMode,
} from "@/lib/oneview-operational-incidents";
import { isoAgo } from "@/lib/oneview-recent";

export const MONITOR_ALERT_MODE = {
  prioritary: "prioritary",
  all: "all",
} as const;

export type MonitorAlertMode = (typeof MONITOR_ALERT_MODE)[keyof typeof MONITOR_ALERT_MODE];

/** Prioritários = Average + High + Disaster (ativos, sem ACK, na janela). */
export const MONITOR_PRIORITARY_SEVERITIES = ["average", "high", "disaster"] as const;

/** Todos = Information + Warning + Average + High + Disaster (ativos, na janela). */
export const MONITOR_ALL_SEVERITIES = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
] as const;

export type MonitorAlertSeverity = (typeof MONITOR_ALL_SEVERITIES)[number];

export const MONITOR_QUEUE_LIMIT = 14;
export const MONITOR_HOSTS_LIMIT = 6;
/** Painel de chamados: teto do BFF, lista rolável. */
export const MONITOR_UNASSIGNED_LIMIT = OPERATIONAL_INCIDENTS_PAGE_SIZE;
/** Estados operacionais SN (exclui Resolvido=6 e Encerrado=7). */
export const MONITOR_UNASSIGNED_OPERATIONAL_STATES = OPERATIONAL_INCIDENT_STATES;

/**
 * OV-P0-104 — janelas do Monitoramento (isoladas da Home / oneview-recent).
 * 30m | 2h | 8h | 24h · default 2h.
 */
export const MONITOR_WINDOW_PRESETS = {
  "30m": 30 * 60_000,
  "2h": 2 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;

export type MonitorWindowPreset = keyof typeof MONITOR_WINDOW_PRESETS;
export const DEFAULT_MONITOR_WINDOW: MonitorWindowPreset = "2h";
export const MONITOR_WINDOW_OPTIONS = Object.keys(MONITOR_WINDOW_PRESETS) as MonitorWindowPreset[];

export function parseMonitorWindow(value?: string | null): MonitorWindowPreset {
  if (value && Object.prototype.hasOwnProperty.call(MONITOR_WINDOW_PRESETS, value)) {
    return value as MonitorWindowPreset;
  }
  return DEFAULT_MONITOR_WINDOW;
}

export function monitorWindowMs(preset: MonitorWindowPreset) {
  return MONITOR_WINDOW_PRESETS[preset];
}

export function monitorWindowShortLabel(preset: MonitorWindowPreset) {
  return preset;
}

export function monitorWindowActiveLabel(preset: MonitorWindowPreset) {
  return `Ativos iniciados nas últimas ${preset}`;
}

export const MONITOR_SEVERITY_CHIP_OPTIONS: Array<{ value: MonitorAlertSeverity; label: string }> = [
  { value: "information", label: "Information" },
  { value: "warning", label: "Warning" },
  { value: "average", label: "Average" },
  { value: "high", label: "High" },
  { value: "disaster", label: "Disaster" },
];

/** OV-P0-83 — ordenação da fila (URL `sort=`). Default: Mais recentes. */
export const MONITOR_QUEUE_SORT = {
  recent: "recent",
  oldest: "oldest",
  severity: "severity",
} as const;

export type MonitorQueueSort = (typeof MONITOR_QUEUE_SORT)[keyof typeof MONITOR_QUEUE_SORT];

export const MONITOR_QUEUE_SORT_OPTIONS: Array<{ value: MonitorQueueSort; label: string }> = [
  { value: MONITOR_QUEUE_SORT.recent, label: "Mais recentes" },
  { value: MONITOR_QUEUE_SORT.oldest, label: "Mais antigos" },
  { value: MONITOR_QUEUE_SORT.severity, label: "Maior severidade" },
];

export function parseMonitorQueueSort(raw?: string | null): MonitorQueueSort {
  const value = String(raw || "").trim().toLowerCase();
  if (value === MONITOR_QUEUE_SORT.oldest) return MONITOR_QUEUE_SORT.oldest;
  if (value === MONITOR_QUEUE_SORT.severity) return MONITOR_QUEUE_SORT.severity;
  return MONITOR_QUEUE_SORT.recent;
}

/** Mapeia opção de UI → sort/order já suportados pelo BFF de alerts. */
export function resolveMonitorQueueSortParams(sort: MonitorQueueSort): {
  sort: "first_seen_at" | "severity";
  order: "asc" | "desc";
} {
  if (sort === MONITOR_QUEUE_SORT.oldest) {
    return { sort: "first_seen_at", order: "asc" };
  }
  if (sort === MONITOR_QUEUE_SORT.severity) {
    return { sort: "severity", order: "desc" };
  }
  return { sort: "first_seen_at", order: "desc" };
}

/** @deprecated OV-P0-72: prefer MONITOR_SEVERITY_CHIP_OPTIONS (multi-select). */
export const MONITOR_SEVERITY_FILTER_OPTIONS: Array<{ value: "all" | MonitorAlertSeverity; label: string }> = [
  { value: "all", label: "Todas" },
  ...MONITOR_SEVERITY_CHIP_OPTIONS,
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

export function parseMonitorAlertMode(value?: string | null): MonitorAlertMode {
  return value === MONITOR_ALERT_MODE.all ? MONITOR_ALERT_MODE.all : MONITOR_ALERT_MODE.prioritary;
}

/** Normaliza lista de severidades vindas da URL / chips. */
export function parseMonitorSeveritySelection(
  values?: string | string[] | null,
): MonitorAlertSeverity[] {
  const raw = Array.isArray(values)
    ? values
    : String(values || "")
      .split(",")
      .map((item) => item.trim());
  const seen = new Set<MonitorAlertSeverity>();
  for (const item of raw) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!(MONITOR_ALL_SEVERITIES as readonly string[]).includes(normalized)) continue;
    seen.add(normalized as MonitorAlertSeverity);
  }
  return [...seen];
}

/**
 * Resolve severidades da fila Monitoring (modo + chips multi-select).
 * Sem seleção explícita → base do modo (Prioritários / Todos).
 * Com chips → severidades escolhidas (sempre server-side).
 */
export function resolveMonitorAlertSeverities(
  mode: MonitorAlertMode,
  severityFilter?: string | string[] | null,
): MonitorAlertSeverity[] {
  const base = mode === MONITOR_ALERT_MODE.all
    ? [...MONITOR_ALL_SEVERITIES]
    : [...MONITOR_PRIORITARY_SEVERITIES];
  const selected = parseMonitorSeveritySelection(severityFilter);
  if (!selected.length) return base;
  return selected;
}

/** Severidades efetivas exibidas como chips ativos. */
export function effectiveMonitorSeverities(
  mode: MonitorAlertMode,
  severityFilter?: string | string[] | null,
): MonitorAlertSeverity[] {
  return resolveMonitorAlertSeverities(mode, severityFilter);
}

/** Ordenação Monitoring legada (severidade desc → início mais recente). Preferir sort server-side. */
export function compareMonitorAlerts(left: OneViewAlert, right: OneViewAlert) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Date.parse(right.first_seen_at || right.started_at || "")
    - Date.parse(left.first_seen_at || left.started_at || "");
}

export type MonitorAlertsResult = {
  items: OneViewAlert[];
  total: number;
  data_source?: string;
  checked_at?: string;
};

/**
 * Fila principal do Monitoramento (OV-P0-70 / OV-P0-72 / OV-P0-83).
 * Prioritários: Avg+High+Disaster (default), ativos, sem ACK.
 * Todos: 5 severidades (default), ativos (ACK livre).
 * Ordenação server-side (first_seen_at / severity).
 */
export async function fetchMonitoringAlerts(params: {
  mode: MonitorAlertMode;
  /** Single, CSV ou array — chips multi-select. */
  severity?: string | string[] | null;
  customers?: string[];
  limit?: number;
  windowMs: number;
  /** OV-P0-83 — recent | oldest | severity. Default recent. */
  sort?: MonitorQueueSort | string | null;
  signal?: AbortSignal;
  now?: number;
}): Promise<MonitorAlertsResult> {
  const now = params.now ?? Date.now();
  const limit = Math.min(Math.max(params.limit ?? MONITOR_QUEUE_LIMIT, 1), 50);
  const severities = resolveMonitorAlertSeverities(params.mode, params.severity);
  const sortParams = resolveMonitorQueueSortParams(parseMonitorQueueSort(params.sort));
  const response = await fetchAlerts({
    page: 1,
    pageSize: limit,
    status: "active",
    severities: [...severities],
    customers: params.customers?.length ? params.customers : undefined,
    acknowledgedSource: params.mode === MONITOR_ALERT_MODE.prioritary ? false : undefined,
    firstSeenFrom: isoAgo(params.windowMs, now),
    sort: sortParams.sort,
    order: sortParams.order,
    signal: params.signal,
  });
  const items = (response.items ?? []).slice(0, limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}

/**
 * OV-P0-75 — chamados monitoring (estados operacionais).
 * Padrão: unassigned + state 1,2,3. Janela opened_from da página em todos os modos.
 */
export async function fetchMonitoringUnassignedIncidents(params?: {
  mode?: IncidentsQueueMode | string | null;
  assignedTo?: string | string[] | null;
  windowMs?: number;
  now?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<IncidentListResponse> {
  return fetchOperationalIncidents(params);
}

/** Deep-link /chamados com filtro equivalente ao painel. */
export function buildMonitoringUnassignedChamadosHref() {
  return buildOperationalChamadosHref({ mode: "unassigned" });
}

export function buildMonitoringChamadosHref(params?: {
  mode?: IncidentsQueueMode | string | null;
  assignedTo?: string | string[] | null;
}) {
  return buildOperationalChamadosHref(params);
}

/** Deep-link /alertas a partir do modo atual do Monitoramento. */
export function buildMonitoringAlertHref(alertId: string, mode: MonitorAlertMode) {
  const view = mode === MONITOR_ALERT_MODE.prioritary ? "priority" : "open";
  return `/alertas?alert=${encodeURIComponent(alertId)}&view=${view}`;
}
