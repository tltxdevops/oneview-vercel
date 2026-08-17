/**
 * OV-P0-69 / OV-P0-103 — helpers/constantes exclusivos da Home.
 * Não altera oneview-recent.ts (Monitoramento / janelas legadas).
 */
import {
  IncidentListResponse,
  OneViewAlert,
  OneViewIncident,
  fetchAlerts,
  fetchIncidents,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";
import { isoAgo } from "@/lib/oneview-recent";

export const HOME_ALERT_MODE = {
  prioritary: "prioritary",
  all: "all",
} as const;

export type HomeAlertMode = (typeof HOME_ALERT_MODE)[keyof typeof HOME_ALERT_MODE];

/** Prioritários = Average + High + Disaster (ativos na janela). */
export const HOME_PRIORITARY_SEVERITIES = ["average", "high", "disaster"] as const;

/** Todos = Information + Warning + Average + High + Disaster. */
export const HOME_ALL_SEVERITIES = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
] as const;

export type HomeAlertSeverity = (typeof HOME_ALL_SEVERITIES)[number];

/**
 * OV-P0-103 — janelas operacionais da Home (não compartilhadas com Monitoramento).
 * 30m | 2h | 8h | 24h · default 2h.
 */
export const HOME_OPERATIONAL_WINDOW_PRESETS = {
  "30m": 30 * 60_000,
  "2h": 2 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;

export type HomeOperationalWindowPreset = keyof typeof HOME_OPERATIONAL_WINDOW_PRESETS;
export const DEFAULT_HOME_OPERATIONAL_WINDOW: HomeOperationalWindowPreset = "2h";
export const HOME_OPERATIONAL_WINDOW_OPTIONS = Object.keys(
  HOME_OPERATIONAL_WINDOW_PRESETS,
) as HomeOperationalWindowPreset[];

export function parseHomeOperationalWindow(value?: string | null): HomeOperationalWindowPreset {
  if (value && Object.prototype.hasOwnProperty.call(HOME_OPERATIONAL_WINDOW_PRESETS, value)) {
    return value as HomeOperationalWindowPreset;
  }
  return DEFAULT_HOME_OPERATIONAL_WINDOW;
}

export function homeOperationalWindowMs(preset: HomeOperationalWindowPreset) {
  return HOME_OPERATIONAL_WINDOW_PRESETS[preset];
}

export function homeOperationalWindowActiveLabel(preset: HomeOperationalWindowPreset) {
  return `Ativos iniciados nas últimas ${preset}`;
}

/** Mapeia janela Home → date_preset conhecido em /alertas (8h ≈ 6h). */
export function homeWindowToAlertsDatePreset(preset: string): string {
  if (preset === "8h") return "6h";
  if (preset === "30m" || preset === "2h" || preset === "24h") return preset;
  return "2h";
}

/** OV-P0-73 — máximo visual Home (~7 linhas por painel). */
export const HOME_ALERTS_PAGE_SIZE = 7;
export const HOME_INCIDENTS_PAGE_SIZE = 7;
export const HOME_EVENTS_LIMIT = 7;

/** OV-P0-103 — chamados Home: Novo / Em andamento / Em espera (exclui Resolvido/Encerrado). */
export const HOME_UNASSIGNED_OPERATIONAL_STATES = "1,2,3";

export const HOME_SEVERITY_FILTER_OPTIONS: Array<{ value: "all" | HomeAlertSeverity; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "information", label: "Information" },
  { value: "warning", label: "Warning" },
  { value: "average", label: "Average" },
  { value: "high", label: "High" },
  { value: "disaster", label: "Disaster" },
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

const CLOSED_SN_STATES = new Set(["6", "7"]);

export function parseHomeAlertMode(value?: string | null): HomeAlertMode {
  return value === HOME_ALERT_MODE.all ? HOME_ALERT_MODE.all : HOME_ALERT_MODE.prioritary;
}

/** Resolve severidades da lista Home (toggle + filtro opcional). */
export function resolveHomeAlertSeverities(
  mode: HomeAlertMode,
  severityFilter?: string | null,
): HomeAlertSeverity[] {
  const base = mode === HOME_ALERT_MODE.all
    ? [...HOME_ALL_SEVERITIES]
    : [...HOME_PRIORITARY_SEVERITIES];
  const raw = String(severityFilter || "").trim().toLowerCase();
  if (!raw || raw === "all") return base;
  if ((HOME_ALL_SEVERITIES as readonly string[]).includes(raw)) {
    return [raw as HomeAlertSeverity];
  }
  return base;
}

/** Toggle do Resumo operacional (OV-P0-103): clique novamente remove o filtro. */
export function toggleHomeSeverityFilter(
  current: string,
  next: HomeAlertSeverity,
): "all" | HomeAlertSeverity {
  return current === next ? "all" : next;
}

/** Ordenação Home: severidade desc → início mais recente. */
export function compareHomeAlerts(left: OneViewAlert, right: OneViewAlert) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Date.parse(right.first_seen_at || right.started_at || "")
    - Date.parse(left.first_seen_at || left.started_at || "");
}

export type HomeAlertsResult = {
  items: OneViewAlert[];
  total: number;
  data_source?: string;
  checked_at?: string;
};

/**
 * Alertas ativos na janela da Home (OV-P0-69).
 * Distinto de fetchRecentPriorityAlerts (Monitoramento = disaster/high sem ACK).
 */
export async function fetchHomeAlerts(params: {
  mode: HomeAlertMode;
  severity?: string | null;
  customers?: string[];
  limit?: number;
  windowMs: number;
  signal?: AbortSignal;
  now?: number;
}): Promise<HomeAlertsResult> {
  const now = params.now ?? Date.now();
  const limit = Math.min(Math.max(params.limit ?? HOME_ALERTS_PAGE_SIZE, 1), 50);
  const severities = resolveHomeAlertSeverities(params.mode, params.severity);
  const response = await fetchAlerts({
    page: 1,
    pageSize: limit,
    status: "active",
    severities: [...severities],
    customers: params.customers?.length ? params.customers : undefined,
    firstSeenFrom: isoAgo(params.windowMs, now),
    sort: "severity",
    order: "desc",
    signal: params.signal,
  });
  const items = [...(response.items ?? [])]
    .sort(compareHomeAlerts)
    .slice(0, limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}

/**
 * OV-P0-103 — Chamados sem responsável na Home.
 * assigned_to vazio + estados operacionais (1,2,3). Prioriza Novo / Em andamento.
 */
export async function fetchHomeIncidents(params?: {
  pageSize?: number;
  signal?: AbortSignal;
}): Promise<IncidentListResponse> {
  const pageSize = Math.min(
    Math.max(params?.pageSize ?? HOME_INCIDENTS_PAGE_SIZE, 1),
    25,
  );
  const response = await fetchIncidents({
    page: 1,
    pageSize: Math.max(pageSize, 25),
    unassigned: true,
    state: HOME_UNASSIGNED_OPERATIONAL_STATES,
    signal: params?.signal,
  });
  const items = prioritizeHomeUnassignedIncidents(response.items ?? []).slice(0, pageSize);
  return {
    ...response,
    items,
  };
}

/** Novo (1) → Em andamento (2) → demais operacionais; exclui Resolvido/Encerrado. */
export function prioritizeHomeUnassignedIncidents(items: OneViewIncident[]): OneViewIncident[] {
  const rank = (state: string) => {
    if (state === "1") return 0;
    if (state === "2") return 1;
    if (state === "3") return 2;
    return 9;
  };
  return items
    .filter((item) => !CLOSED_SN_STATES.has(String(item.state || "").trim()))
    .sort((left, right) => {
      const diff = rank(String(left.state || "").trim()) - rank(String(right.state || "").trim());
      if (diff !== 0) return diff;
      return Date.parse(String(right.opened_at || "")) - Date.parse(String(left.opened_at || ""));
    });
}

/** Deep-link /chamados alinhado ao painel Home (OV-P0-103). */
export function buildHomeUnassignedChamadosHref() {
  return "/chamados?unassigned=true";
}

/** Deep-link /alertas a partir dos filtros atuais da Home. */
export function buildHomeAlertsHref(options: {
  mode: HomeAlertMode;
  severity?: string | null;
  customers?: string[];
  windowPreset: string;
}) {
  const params = new URLSearchParams();
  params.set("status", "active");
  params.set("date_field", "first_seen");
  params.set("date_preset", homeWindowToAlertsDatePreset(options.windowPreset));
  const severities = resolveHomeAlertSeverities(options.mode, options.severity);
  for (const severity of severities) {
    params.append("severity", severity);
    if (severity === "high") params.append("severity", "critical");
  }
  for (const customer of options.customers ?? []) {
    if (customer) params.append("customer", customer);
  }
  if (options.mode === HOME_ALERT_MODE.prioritary && (!options.severity || options.severity === "all")) {
    params.set("view", "priority");
  }
  return `/alertas?${params.toString()}`;
}
