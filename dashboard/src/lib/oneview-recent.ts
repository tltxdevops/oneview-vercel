import {
  GlobalHistoryItem,
  OneViewAlert,
  OneViewSyncLog,
  fetchAlerts,
  fetchGlobalHistory,
  fetchSyncLogs,
  normalizeAlertSeveritySummary,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";

/** Defaults usados pelo Monitoramento quando a Home não passa windowMs. */
export const RECENT_PRIORITY_WINDOW_MS = 2 * 60 * 60 * 1000;
export const RECENT_EVENTS_WINDOW_MS = 30 * 60 * 1000;
export const RECENT_CREATED_WINDOW_MS = 60 * 60 * 1000;
export const PRIORITY_SEVERITIES = ["disaster", "high"] as const;

/** OV-P0-33: janela operacional explícita da Home. */
export const HOME_WINDOW_PRESETS = {
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;

export type HomeWindowPreset = keyof typeof HOME_WINDOW_PRESETS;
export const DEFAULT_HOME_WINDOW: HomeWindowPreset = "2h";
export const HOME_WINDOW_OPTIONS = Object.keys(HOME_WINDOW_PRESETS) as HomeWindowPreset[];

export function parseHomeWindow(value?: string | null): HomeWindowPreset {
  if (value && Object.prototype.hasOwnProperty.call(HOME_WINDOW_PRESETS, value)) {
    return value as HomeWindowPreset;
  }
  return DEFAULT_HOME_WINDOW;
}

export function homeWindowMs(preset: HomeWindowPreset) {
  return HOME_WINDOW_PRESETS[preset];
}

/** Rótulo curto para cards: "2h", "15m". */
export function homeWindowShortLabel(preset: HomeWindowPreset) {
  return preset;
}

/** Rótulo compacto da faixa Home: "Ativos iniciados nas últimas 2h". */
export function homeWindowActiveLabel(preset: HomeWindowPreset) {
  return `Ativos iniciados nas últimas ${preset}`;
}

export function isoAgo(ms: number, now = Date.now()) {
  return new Date(now - ms).toISOString();
}

const severityRank: Record<string, number> = {
  disaster: 0,
  critical: 1,
  high: 2,
  average: 3,
  warning: 4,
  information: 5,
  not_classified: 6,
};

/** Disaster → High → início mais recente. */
export function compareRecentPriorityAlerts(left: OneViewAlert, right: OneViewAlert) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Date.parse(right.first_seen_at || right.started_at || "") - Date.parse(left.first_seen_at || left.started_at || "");
}

export function queueOverflowLabel(total: number, shown: number) {
  const extra = Math.max(0, Number(total) || 0) - Math.max(0, Number(shown) || 0);
  if (extra <= 0) return null;
  return `+ ${extra.toLocaleString("pt-BR")} na fila`;
}

export type RecentPriorityResult = {
  items: OneViewAlert[];
  total: number;
  data_source?: string;
  checked_at?: string;
};

export async function fetchRecentPriorityAlerts(params: {
  limit: number;
  customers?: string[];
  signal?: AbortSignal;
  now?: number;
  /** Janela server-side (Home). Default = RECENT_PRIORITY_WINDOW_MS. */
  windowMs?: number;
}): Promise<RecentPriorityResult> {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? RECENT_PRIORITY_WINDOW_MS;
  const response = await fetchAlerts({
    page: 1,
    pageSize: params.limit,
    status: "active",
    severities: [...PRIORITY_SEVERITIES],
    customers: params.customers,
    acknowledgedSource: false,
    firstSeenFrom: isoAgo(windowMs, now),
    sort: "severity",
    order: "desc",
    signal: params.signal,
  });
  // Ordenação local reforça Disaster → High → início recente; não filtra severidade no cliente.
  const items = [...(response.items ?? [])]
    .sort(compareRecentPriorityAlerts)
    .slice(0, params.limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}

export type RecentSeverityCounts = {
  information: number | null;
  warning: number | null;
  average: number | null;
  high: number | null;
  disaster: number | null;
};

export type RecentOperationalMetrics = {
  /** Legado Monitoramento (quando windowMs não é informado). */
  created_last_1h: number | null;
  disaster_unacked_recent: number | null;
  high_unacked_recent: number | null;
  acks_last_30m: number | null;
  last_sync_at: string | null;
  /**
   * OV-P0-42A Home: faixa das cinco severidades (ativos + first_seen na janela).
   * null = falha/contrato ausente (UI "—"); número inclui zero válido.
   */
  by_severity: RecentSeverityCounts | null;
  not_classified: number | null;
  checked_at?: string;
  data_source?: string;
};

function totalFromSettled(result: PromiseSettledResult<{ pagination?: { total_items?: number }; checked_at?: string; data_source?: string }>) {
  if (result.status !== "fulfilled") return { total: null as number | null, checked_at: undefined as string | undefined, data_source: undefined as string | undefined };
  return {
    total: Number(result.value.pagination?.total_items) || 0,
    checked_at: result.value.checked_at,
    data_source: result.value.data_source,
  };
}

function latestSyncAt(logs: OneViewSyncLog[]) {
  const sorted = [...logs].sort((left, right) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""));
  return sorted[0]?.created_at || null;
}

function severityCountsFromSummary(summary: unknown): {
  by_severity: RecentSeverityCounts | null;
  not_classified: number | null;
} {
  // OV-P0-42A-REGRESSION: normalização compartilhada campo a campo (nunca all-or-nothing; nunca `low`).
  return normalizeAlertSeveritySummary(summary);
}

/** Contagens verificáveis via /oneview/alerts (server-side). Falha → null (nunca inventa zero). */
export async function fetchRecentOperationalMetrics(params?: {
  customers?: string[];
  datasources?: string[];
  signal?: AbortSignal;
  now?: number;
  /** Quando informado (Home OV-P0-42A), uma única consulta alimenta by_severity. */
  windowMs?: number;
  from?: string;
  to?: string;
}): Promise<RecentOperationalMetrics> {
  const now = params?.now ?? Date.now();
  const customers = params?.customers;
  const datasources = params?.datasources;
  const signal = params?.signal;

  // Home: 1× alerts (summary) + sync. Monitoramento (sem windowMs) mantém as 4 consultas legadas.
  if (params?.windowMs != null || params?.from) {
    const results = await Promise.allSettled([
      fetchAlerts({
        page: 1,
        pageSize: 1,
        status: "active",
        customers,
        datasources,
        firstSeenFrom: params.from ?? isoAgo(params.windowMs ?? RECENT_PRIORITY_WINDOW_MS, now),
        firstSeenTo: params.to,
        signal,
      }),
      fetchSyncLogs(8),
    ]);
    const summaryResult = results[0];
    const syncResult = results[1];
    if (summaryResult.status !== "fulfilled") {
      return {
        created_last_1h: null,
        disaster_unacked_recent: null,
        high_unacked_recent: null,
        acks_last_30m: null,
        last_sync_at: syncResult.status === "fulfilled" ? latestSyncAt(syncResult.value.items ?? []) : null,
        by_severity: null,
        not_classified: null,
        data_source: undefined,
      };
    }
    const payload = summaryResult.value;
    const { by_severity, not_classified } = severityCountsFromSummary(payload.filtered_summary);
    return {
      created_last_1h: null,
      disaster_unacked_recent: null,
      high_unacked_recent: null,
      acks_last_30m: null,
      last_sync_at: syncResult.status === "fulfilled" ? latestSyncAt(syncResult.value.items ?? []) : null,
      by_severity,
      not_classified,
      checked_at: payload.checked_at,
      data_source: payload.data_source,
    };
  }

  const createdWindow = RECENT_CREATED_WINDOW_MS;
  const priorityWindow = RECENT_PRIORITY_WINDOW_MS;
  const ackWindow = RECENT_EVENTS_WINDOW_MS;
  const results = await Promise.allSettled([
    fetchAlerts({
      page: 1,
      pageSize: 1,
      status: "active",
        customers,
        datasources,
        firstSeenFrom: isoAgo(createdWindow, now),
      signal,
    }),
    fetchAlerts({
      page: 1,
      pageSize: 1,
      status: "active",
        customers,
        datasources,
        severities: ["disaster"],
      acknowledgedSource: false,
      firstSeenFrom: isoAgo(priorityWindow, now),
      signal,
    }),
    fetchAlerts({
      page: 1,
      pageSize: 1,
      status: "active",
        customers,
        datasources,
        severities: ["high"],
      acknowledgedSource: false,
      firstSeenFrom: isoAgo(priorityWindow, now),
      signal,
    }),
    fetchAlerts({
      page: 1,
      pageSize: 1,
      status: "all",
        customers,
        datasources,
        acknowledgedSource: true,
      acknowledgedFrom: isoAgo(ackWindow, now),
      signal,
    }),
    fetchSyncLogs(8),
  ]);

  const created = totalFromSettled(results[0]);
  const disaster = totalFromSettled(results[1]);
  const high = totalFromSettled(results[2]);
  const acks = totalFromSettled(results[3]);
  const syncResult = results[4];

  const checked_at = [created, disaster, high, acks]
    .map((row) => row.checked_at)
    .filter(Boolean)
    .sort((left, right) => Date.parse(String(right)) - Date.parse(String(left)))[0];

  return {
    created_last_1h: created.total,
    disaster_unacked_recent: disaster.total,
    high_unacked_recent: high.total,
    acks_last_30m: acks.total,
    last_sync_at: syncResult.status === "fulfilled" ? latestSyncAt(syncResult.value.items ?? []) : null,
    by_severity: null,
    not_classified: null,
    checked_at: checked_at || undefined,
    data_source: created.data_source || disaster.data_source || high.data_source || acks.data_source,
  };
}

export async function fetchRecentOperationalEvents(params: {
  limit: number;
  customers?: string[];
  datasources?: string[];
  signal?: AbortSignal;
  now?: number;
  windowMs?: number;
  from?: string;
  to?: string;
}): Promise<{ items: GlobalHistoryItem[]; total: number; data_source?: string; checked_at?: string }> {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? RECENT_EVENTS_WINDOW_MS;
  const response = await fetchGlobalHistory({
    page: 1,
    pageSize: params.limit,
    customers: params.customers,
    datasources: params.datasources,
    eventType: "operational",
    occurredFrom: params.from ?? isoAgo(windowMs, now),
    occurredTo: params.to,
    signal: params.signal,
  });
  const items = (response.items ?? []).slice(0, params.limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}

/**
 * OV-P0-43: alertas ativos recentes com todas as severidades (não só High/Disaster).
 * Distinto de fetchRecentPriorityAlerts (priority = High/Disaster sem ACK).
 */
export async function fetchRecentAlerts(params: {
  limit: number;
  customers?: string[];
  signal?: AbortSignal;
  now?: number;
  windowMs?: number;
}): Promise<RecentPriorityResult> {
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? RECENT_PRIORITY_WINDOW_MS;
  const response = await fetchAlerts({
    page: 1,
    pageSize: params.limit,
    status: "active",
    customers: params.customers,
    firstSeenFrom: isoAgo(windowMs, now),
    sort: "first_seen_at",
    order: "desc",
    signal: params.signal,
  });
  const items = (response.items ?? []).slice(0, params.limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}
