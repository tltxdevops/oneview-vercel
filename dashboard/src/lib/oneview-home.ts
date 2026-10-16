/**
 * OV-P0-69 / OV-P0-103 — helpers/constantes exclusivos da Home.
 * Não altera oneview-recent.ts (Monitoramento / janelas legadas).
 */
import {
  AlertListResponse,
  IncidentListResponse,
  OneViewAlert,
  OneViewIncident,
  bucketOneViewReadNow,
  fetchAlerts,
  fetchIncidents,
  type FetchAlertsParams,
} from "@/lib/oneview-api";
import { isoAgo } from "@/lib/oneview-recent";

export const HOME_ALERT_MODE = {
  prioritary: "prioritary",
  all: "all",
} as const;

export type HomeAlertMode = (typeof HOME_ALERT_MODE)[keyof typeof HOME_ALERT_MODE];

/** OV-P0-246 — Home abre em Todos; Prioritários permanece opt-in. */
export const DEFAULT_HOME_ALERT_MODE: HomeAlertMode = HOME_ALERT_MODE.all;

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
export type HomeAlertStatus = "active" | "resolved" | "all";
export type HomeAlertAckFilter = "pending" | "acknowledged" | "all";

export const HOME_ALERT_STATUS_OPTIONS: Array<{ value: HomeAlertStatus; label: string }> = [
  { value: "active", label: "Ativos" },
  { value: "resolved", label: "Resolvidos" },
  { value: "all", label: "Todos" },
];

export const HOME_ALERT_ACK_FILTER_OPTIONS: Array<{ value: HomeAlertAckFilter; label: string }> = [
  { value: "pending", label: "Sem ACK" },
  { value: "acknowledged", label: "Com ACK" },
  { value: "all", label: "Todos" },
];

/**
 * OV-P0-103 — janelas operacionais da Home (não compartilhadas com Monitoramento).
 * 30m | 2h | 8h | 24h · default 2h.
 */
export const HOME_OPERATIONAL_WINDOW_PRESETS = {
  "30m": 30 * 60_000,
  "2h": 2 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
} as const;

export type HomeOperationalWindowPreset = keyof typeof HOME_OPERATIONAL_WINDOW_PRESETS;
export type HomeOperationalWindow = HomeOperationalWindowPreset | "custom";
export type HomeOperationalRange = {
  window: HomeOperationalWindow;
  from: string;
  to: string;
  fromDate?: string;
  toDate?: string;
};
export const DEFAULT_HOME_OPERATIONAL_WINDOW: HomeOperationalWindowPreset = "2h";
export const HOME_OPERATIONAL_WINDOW_OPTIONS = Object.keys(
  HOME_OPERATIONAL_WINDOW_PRESETS,
) as HomeOperationalWindowPreset[];

const HOME_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function saoPauloDate(value: Date | number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function parseHomeOperationalRange(params: {
  window?: string | null;
  from?: string | null;
  to?: string | null;
  now?: number;
}): HomeOperationalRange {
  const now = params.now ?? Date.now();
  if (params.window === "custom") {
    const fromDate = String(params.from || "");
    const toDate = String(params.to || "");
    const today = saoPauloDate(now);
    if (HOME_DATE_ONLY.test(fromDate) && HOME_DATE_ONLY.test(toDate)
      && fromDate <= toDate && toDate <= today) {
      return {
        window: "custom",
        fromDate,
        toDate,
        from: new Date(`${fromDate}T00:00:00.000-03:00`).toISOString(),
        to: new Date(`${toDate}T23:59:59.999-03:00`).toISOString(),
      };
    }
  }
  const window = parseHomeOperationalWindow(params.window);
  return {
    window,
    from: new Date(now - homeOperationalWindowMs(window)).toISOString(),
    to: new Date(now).toISOString(),
  };
}

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
  if (["30m", "2h", "24h", "7d", "30d"].includes(preset)) return preset;
  return "2h";
}

/** OV-P0-73 — máximo visual Home (~7 linhas por painel). */
export const HOME_ALERTS_PAGE_SIZE = 7;
export const HOME_INCIDENTS_PAGE_SIZE = 7;
export const HOME_INCIDENTS_FETCH_SIZE = 100;
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

const CLOSED_SN_STATES = new Set(["6", "7"]);

export function parseHomeAlertMode(value?: string | null): HomeAlertMode {
  return value === HOME_ALERT_MODE.prioritary ? HOME_ALERT_MODE.prioritary : DEFAULT_HOME_ALERT_MODE;
}

/** Chegada/início canônico: first_seen_at (ingest), com started_at só como alias do BFF. */
export function homeAlertArrivalAt(alert: Pick<OneViewAlert, "first_seen_at" | "started_at">) {
  const timestamp = Date.parse(String(alert.first_seen_at || alert.started_at || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Normaliza lista de severidades vindas do filtro / strip (multi-select). */
export function parseHomeSeveritySelection(
  values?: string | string[] | null,
): HomeAlertSeverity[] {
  const raw = Array.isArray(values)
    ? values
    : String(values || "")
      .split(",")
      .map((item) => item.trim());
  const seen = new Set<HomeAlertSeverity>();
  for (const item of raw) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!(HOME_ALL_SEVERITIES as readonly string[]).includes(normalized)) continue;
    seen.add(normalized as HomeAlertSeverity);
  }
  return [...seen];
}

/** Seleção visível ao entrar no modo: Prioritários = Average/High/Disaster; Todos = vazio. */
export function homeModeDefaultSeverities(mode: HomeAlertMode): HomeAlertSeverity[] {
  return mode === HOME_ALERT_MODE.prioritary ? [...HOME_PRIORITARY_SEVERITIES] : [];
}

export function isHomePrioritarySeveritySelection(
  selection?: string | string[] | null,
): boolean {
  const selected = parseHomeSeveritySelection(selection);
  if (selected.length !== HOME_PRIORITARY_SEVERITIES.length) return false;
  return HOME_PRIORITARY_SEVERITIES.every((severity) => selected.includes(severity));
}

function homeSeverityOptionLabel(severity: HomeAlertSeverity) {
  return HOME_SEVERITY_FILTER_OPTIONS.find((option) => option.value === severity)?.label ?? severity;
}

/**
 * Resolve severidades da lista Home (modo + seleção multi).
 * Sem seleção explícita → base do modo (Todos / Prioritários).
 */
export function resolveHomeAlertSeverities(
  mode: HomeAlertMode,
  severityFilter?: string | string[] | null,
): HomeAlertSeverity[] {
  const base = mode === HOME_ALERT_MODE.all
    ? [...HOME_ALL_SEVERITIES]
    : [...HOME_PRIORITARY_SEVERITIES];
  const selected = parseHomeSeveritySelection(severityFilter);
  if (!selected.length) return base;
  return selected;
}

/** Toggle multi-select: adiciona/remove; lista vazia em Prioritários volta ao default do modo. */
export function toggleHomeSeveritySelection(
  current: readonly string[],
  severity: HomeAlertSeverity,
  mode?: HomeAlertMode,
): HomeAlertSeverity[] {
  const selected = parseHomeSeveritySelection([...current]);
  const next = selected.includes(severity)
    ? selected.filter((item) => item !== severity)
    : [...selected, severity];
  if (!next.length && mode === HOME_ALERT_MODE.prioritary) return homeModeDefaultSeverities(mode);
  return next;
}

/** Label do trigger: Todas | nomes Zabbix (até 3) | N severidades. */
export function homeSeverityFilterTriggerLabel(
  selection?: string | string[] | null,
): string {
  const selected = parseHomeSeveritySelection(selection);
  if (!selected.length) return "Todas";
  const ordered = HOME_ALL_SEVERITIES.filter((severity) => selected.includes(severity));
  if (ordered.length <= 3) {
    return ordered.map(homeSeverityOptionLabel).join(", ");
  }
  return `${ordered.length} severidades`;
}

/** OV-P0-246 — fila operacional: chegada DESC. Sem severity-first e sem duração. */
export function compareHomeAlerts(left: OneViewAlert, right: OneViewAlert) {
  const diff = homeAlertArrivalAt(right) - homeAlertArrivalAt(left);
  if (diff !== 0) return diff;
  return String(right.id || "").localeCompare(String(left.id || ""));
}

export type HomeAlertsResult = {
  items: OneViewAlert[];
  total: number;
  filtered_summary?: AlertListResponse["filtered_summary"];
  data_source?: string;
  checked_at?: string;
};

export function homeAlertsFetchParams(params: {
  mode: HomeAlertMode;
  severity?: string | string[] | null;
  customers?: string[];
  datasources?: string[];
  status?: HomeAlertStatus;
  acknowledgedSource?: boolean;
  limit?: number;
  windowMs?: number;
  from?: string;
  to?: string;
  now?: number;
  sort?: FetchAlertsParams["sort"];
  order?: "asc" | "desc";
  include?: FetchAlertsParams["include"];
}): FetchAlertsParams {
  const now = params.now ?? bucketOneViewReadNow();
  const limit = Math.min(Math.max(params.limit ?? HOME_ALERTS_PAGE_SIZE, 1), 50);
  const selected = parseHomeSeveritySelection(params.severity);
  const severities = resolveHomeAlertSeverities(params.mode, selected);
  const allUnrestricted = params.mode === HOME_ALERT_MODE.all && selected.length === 0;
  return {
    page: 1,
    pageSize: limit,
    severities: allUnrestricted ? undefined : [...severities],
    customers: params.customers?.length ? params.customers : undefined,
    datasources: params.datasources?.length ? params.datasources : undefined,
    status: params.status ?? "active",
    ...(typeof params.acknowledgedSource === "boolean" ? { acknowledgedSource: params.acknowledgedSource } : {}),
    firstSeenFrom: params.from ?? isoAgo(
      params.windowMs ?? homeOperationalWindowMs(DEFAULT_HOME_OPERATIONAL_WINDOW),
      now,
    ),
    firstSeenTo: params.to,
    sort: "first_seen_at",
    order: "desc",
    excludeOperator: true,
    include: params.include ?? "items",
    ...(params.sort ? { sort: params.sort } : {}),
    ...(params.order ? { order: params.order } : {}),
  };
}

export function defaultHomeAlertsFetchParams(now = bucketOneViewReadNow()): FetchAlertsParams {
  return homeAlertsFetchParams({
    mode: DEFAULT_HOME_ALERT_MODE,
    status: "active",
    acknowledgedSource: false,
    limit: HOME_ALERTS_PAGE_SIZE,
    windowMs: homeOperationalWindowMs(DEFAULT_HOME_OPERATIONAL_WINDOW),
    now,
  });
}

/**
 * Alertas ativos na janela da Home (OV-P0-69).
 * Distinto de fetchRecentPriorityAlerts (Monitoramento = disaster/high sem ACK).
 */
export function homeAlertsResultFromResponse(response: {
  items?: OneViewAlert[] | null;
  pagination?: { total_items?: number } | null;
  filtered_summary?: AlertListResponse["filtered_summary"];
  data_source?: string;
  checked_at?: string;
}, limit = HOME_ALERTS_PAGE_SIZE): HomeAlertsResult {
  const items = [...(response.items ?? [])].sort(compareHomeAlerts).slice(0, limit);
  return {
    items,
    total: Number(response.pagination?.total_items) || items.length,
    filtered_summary: response.filtered_summary,
    data_source: response.data_source,
    checked_at: response.checked_at,
  };
}

export async function fetchHomeAlerts(params: {
  mode: HomeAlertMode;
  severity?: string | string[] | null;
  customers?: string[];
  datasources?: string[];
  status?: HomeAlertStatus;
  acknowledgedSource?: boolean;
  limit?: number;
  windowMs?: number;
  from?: string;
  to?: string;
  signal?: AbortSignal;
  now?: number;
  sort?: FetchAlertsParams["sort"];
  order?: "asc" | "desc";
  include?: FetchAlertsParams["include"];
}): Promise<HomeAlertsResult> {
  const request = homeAlertsFetchParams(params);
  const response = await fetchAlerts({
    ...request,
    signal: params.signal,
  });
  if (params.sort) {
    const items = (response.items ?? []).slice(0, request.pageSize ?? HOME_ALERTS_PAGE_SIZE);
    return {
      items,
      total: Number(response.pagination?.total_items) || items.length,
      filtered_summary: response.filtered_summary,
      data_source: response.data_source,
      checked_at: response.checked_at,
    };
  }
  return homeAlertsResultFromResponse(response, request.pageSize ?? HOME_ALERTS_PAGE_SIZE);
}

/**
 * OV-P0-103 — Chamados sem responsável na Home.
 * assigned_to vazio + estados operacionais (1,2,3). Prioriza Novo / Em andamento.
 */
export type HomeIncidentStreams = {
  queue: OneViewIncident[];
  inProgress: OneViewIncident[];
  recent: OneViewIncident[];
  total: number;
};

function hasAssignedAnalyst(item: OneViewIncident) {
  return Boolean(String(item.assigned_to || "").trim());
}

function operationalIncident(item: OneViewIncident) {
  return OPERATIONAL_STATES.has(String(item.state || "").trim());
}

function incidentUpdatedAt(item: OneViewIncident) {
  const timestamp = Date.parse(String(item.sys_updated_on || item.opened_at || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareRecentIncidents(left: OneViewIncident, right: OneViewIncident) {
  const diff = incidentUpdatedAt(right) - incidentUpdatedAt(left);
  if (diff !== 0) return diff;
  return String(right.sys_id || right.number || "").localeCompare(String(left.sys_id || left.number || ""));
}

const OPERATIONAL_STATES = new Set(HOME_UNASSIGNED_OPERATIONAL_STATES.split(","));

/** Home V3: uma leitura do read-model, três visões derivadas sem inferir analista. */
export async function fetchHomeIncidentStreams(params?: {
  pageSize?: number;
  signal?: AbortSignal;
}): Promise<HomeIncidentStreams> {
  const pageSize = Math.min(
    Math.max(params?.pageSize ?? HOME_INCIDENTS_PAGE_SIZE, 1),
    HOME_INCIDENTS_FETCH_SIZE,
  );
  const response = await fetchIncidents({
    page: 1,
    pageSize: Math.max(pageSize, HOME_INCIDENTS_FETCH_SIZE),
    signal: params?.signal,
  });
  const items = [...(response.items ?? [])].sort(compareRecentIncidents);
  return {
    queue: items.filter((item) => operationalIncident(item) && !hasAssignedAnalyst(item)).slice(0, pageSize),
    inProgress: items.filter(hasAssignedAnalyst).slice(0, pageSize),
    recent: items.slice(0, pageSize),
    total: Number(response.pagination?.total_items) || items.length,
  };
}

/** Compatibilidade p/ consumidores legados: fila = chamados operacionais sem responsável. */
export async function fetchHomeIncidents(params?: {
  pageSize?: number;
  signal?: AbortSignal;
}): Promise<IncidentListResponse> {
  const streams = await fetchHomeIncidentStreams(params);
  const pageSize = Math.min(Math.max(params?.pageSize ?? HOME_INCIDENTS_PAGE_SIZE, 1), HOME_INCIDENTS_FETCH_SIZE);
  return {
    items: streams.queue,
    pagination: {
      page: 1,
      page_size: pageSize,
      total_items: streams.queue.length,
      total_pages: streams.queue.length ? 1 : 0,
      has_next: false,
      has_previous: false,
    },
    filters: {
      caller_id: null,
      assigned_to: null,
      contact_type: "monitoring",
      number: null,
      state: HOME_UNASSIGNED_OPERATIONAL_STATES,
      priority: null,
      company: null,
      opened_from: null,
      opened_to: null,
      unassigned: true,
      search: null,
    },
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

/** Deep-link /central-alertas a partir dos filtros atuais da Home. */
export function buildHomeAlertsHref(options: {
  mode: HomeAlertMode;
  severity?: string | string[] | null;
  customers?: string[];
  datasources?: string[];
  status?: HomeAlertStatus;
  acknowledgedSource?: boolean;
  windowPreset: string;
  fromDate?: string;
  toDate?: string;
}) {
  const params = new URLSearchParams();
  params.set("status", options.status ?? "active");
  if (typeof options.acknowledgedSource === "boolean") params.set("acknowledged_source", String(options.acknowledgedSource));
  params.set("date_field", "first_seen");
  if (options.windowPreset === "custom" && options.fromDate && options.toDate) {
    params.set("date_from", options.fromDate);
    params.set("date_to", options.toDate);
  } else {
    params.set("date_preset", homeWindowToAlertsDatePreset(options.windowPreset));
  }
  const selected = parseHomeSeveritySelection(options.severity);
  if (options.mode !== HOME_ALERT_MODE.all || selected.length) {
    const severities = resolveHomeAlertSeverities(options.mode, selected);
    for (const severity of severities) {
      params.append("severity", severity);
      if (severity === "high") params.append("severity", "critical");
    }
  }
  for (const customer of options.customers ?? []) {
    if (customer) params.append("customer", customer);
  }
  for (const datasource of options.datasources ?? []) {
    if (datasource) params.append("datasource", datasource);
  }
  if (options.mode === HOME_ALERT_MODE.prioritary && (!selected.length || isHomePrioritarySeveritySelection(selected))) {
    params.set("view", "priority");
  }
  return `/central-alertas?${params.toString()}`;
}
