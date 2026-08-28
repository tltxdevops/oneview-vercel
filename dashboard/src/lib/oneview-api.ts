import { Alert, Client, Severity } from "@/types";
import { isSsoEnvironmentReady, loginRequest, msalInstance } from "@/lib/auth/msal";
import { isReadOnlyMode } from "@/lib/demo-mode";
import { getServerAuthToken, serverAuthEnabled } from "@/lib/server-auth";
import { canonicalClientName, canonicalHostName } from "@/components/oneview/ClientIdentity";

const API_BASE_URL = "/api";

async function authHeaders(): Promise<Record<string, string>> {
  if (serverAuthEnabled()) {
    const token = getServerAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (import.meta.env.VITE_ONEVIEW_API_AUTH_DISABLED === "true") return {};
  if (!msalInstance || !isSsoEnvironmentReady) return {};

  const account = msalInstance.getActiveAccount();
  if (!account) return {};

  try {
    const result = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account,
    });
    const token = result.idToken || result.accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch (error) {
    console.warn("[oneview-api] Falha ao obter token para API", error);
    return {};
  }
}

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const authorization = await authHeaders();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authorization,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let errorCode = "request_failed";
    try {
      const errorBody = await response.json() as { error?: unknown };
      if (typeof errorBody?.error === "string" && /^[a-z0-9_]+$/i.test(errorBody.error)) errorCode = errorBody.error;
    } catch {
      // A resposta de erro nunca é exibida integralmente para evitar vazamento de detalhes internos.
    }
    const messages: Record<string, string> = {
      invalid_query: "Filtros inválidos. Revise os valores informados.",
      not_found: "Alerta não encontrado.",
      authentication_required: "Sua sessão expirou. Entre novamente.",
      // OV-P0-100 — estado operacional explícito (sem servir snapshot obsoleto em produção).
      database_timeout: "Dados temporariamente indisponíveis",
      database_unavailable: "Dados temporariamente indisponíveis",
      live_database_disabled: "Dados temporariamente indisponíveis",
      live_data_not_configured: "Dados temporariamente indisponíveis",
      snapshot_unavailable: "Dados temporariamente indisponíveis",
      unsafe_database_user: "Dados temporariamente indisponíveis",
      servicenow_not_configured: "ServiceNow indisponível",
      servicenow_unavailable: "ServiceNow indisponível",
      servicenow_timeout: "ServiceNow indisponível",
      servicenow_rate_limited: "ServiceNow indisponível",
      servicenow_authentication_failed: "ServiceNow indisponível",
      servicenow_access_forbidden: "ServiceNow indisponível",
      servicenow_incidents_disabled: "ServiceNow indisponível",
      insufficient_role: "Seu usuário não possui permissão para solicitar reconhecimento.",
      ack_request_disabled: "A solicitação de reconhecimento está desabilitada.",
      datasource_not_allowed: "Esta fonte ainda não permite solicitação de reconhecimento.",
      alert_already_recognized: "Este alerta já foi reconhecido no OneView.",
      invalid_comment: "O comentário deve possuir no máximo 500 caracteres.",
      actions_database_not_configured: "O canal seguro de solicitações ainda não está configurado.",
    };
    throw new Error(messages[errorCode] || `Não foi possível consultar o OneView (${response.status}).`);
  }

  const body = (await response.json()) as T;
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;
  const headerSource = response.headers.get("X-OneView-Data-Source");
  const bodySource = record.data_source;
  const dataSource = headerSource === "snapshot" || bodySource === "snapshot"
    ? "snapshot"
    : headerSource === "database" || bodySource === "database"
      ? "database"
      : headerSource === "servicenow" || bodySource === "servicenow"
        ? "servicenow"
        : undefined;

  return {
    ...record,
    ...(dataSource ? { data_source: dataSource } : {}),
    checked_at: typeof record.checked_at === "string" ? record.checked_at : new Date().toISOString(),
  } as T;
}

export type OneViewDataSourceKind = "database" | "snapshot" | "servicenow";

/** Labels oficiais Zabbix (sem tradução). Slugs técnicos permanecem para BFF/filtros. */
export const ONEVIEW_SEVERITY_CATALOG = {
  disaster: { label: "Disaster", rank: 7 },
  /** Interno legado; sem nome oficial Zabbix 0–5 — UI via formatOneViewSeverityLabel. */
  critical: { label: "critical", rank: 6 },
  high: { label: "High", rank: 5 },
  average: { label: "Average", rank: 4 },
  warning: { label: "Warning", rank: 3 },
  information: { label: "Information", rank: 2 },
  not_classified: { label: "Not classified", rank: 1 },
} as const;

export type OneViewSeverity = keyof typeof ONEVIEW_SEVERITY_CATALOG;

const ZABBIX_SEVERITY_DISPLAY: Record<string, string> = Object.freeze({
  "0": "Not classified",
  "1": "Information",
  "2": "Warning",
  "3": "Average",
  "4": "High",
  "5": "Disaster",
  not_classified: "Not classified",
  information: "Information",
  warning: "Warning",
  average: "Average",
  high: "High",
  /** OV-P0-102 — critical legado apresenta-se como High (persistido continua critical). */
  critical: "High",
  disaster: "Disaster",
});

const reportedUnknownSeverities = new Set<string>();

function sanitizeSeverityToken(value: string) {
  return value.replace(/[<>]/g, "").trim() || "—";
}

function reportUnknownSeverity(raw: string) {
  const key = raw.toLowerCase();
  if (reportedUnknownSeverities.has(key)) return;
  reportedUnknownSeverities.add(key);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[oneview] severidade sem label Zabbix oficial: ${sanitizeSeverityToken(raw)}`);
  }
}

/**
 * Apresentação única de severidade (nomenclatura oficial Zabbix).
 * Não inventa tradução; desconhecido → valor sanitizado ou "—".
 */
export function formatOneViewSeverityLabel(value?: string | number | null): string {
  if (value === undefined || value === null) return "—";
  const raw = String(value).trim();
  if (!raw) return "—";
  const key = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ZABBIX_SEVERITY_DISPLAY, key)) {
    return ZABBIX_SEVERITY_DISPLAY[key];
  }
  reportUnknownSeverity(raw);
  return sanitizeSeverityToken(raw);
}

/** Severidades usadas nos filtros da V1 (Zabbix). `critical` só entra quando existir no dado. */
export const ONEVIEW_V1_FILTER_SEVERITIES: OneViewSeverity[] = [
  "disaster",
  "high",
  "average",
  "warning",
  "information",
  "not_classified",
];

export function isOneViewSeverity(value: string): value is OneViewSeverity {
  return Object.prototype.hasOwnProperty.call(ONEVIEW_SEVERITY_CATALOG, value);
}

export function normalizeOneViewSeverity(value?: string | null): OneViewSeverity {
  const normalized = String(value || "").trim().toLowerCase();
  return isOneViewSeverity(normalized) ? normalized : "not_classified";
}

/**
 * OV-P0-102 — família High: filtro/query `high` inclui `critical` legado.
 * Disaster NÃO inclui critical. Sem chip Critical na UI.
 */
export function expandHighFamilySeverities(values: string[]): OneViewSeverity[] {
  const seen = new Set<OneViewSeverity>();
  for (const value of values) {
    const raw = String(value || "").trim().toLowerCase();
    if (!isOneViewSeverity(raw)) continue;
    seen.add(raw);
  }
  if (seen.has("high")) seen.add("critical");
  return [...seen];
}

/** Valores canônicos aceitos pelo BFF — nunca labels de apresentação. */
export function canonicalizeSeveritiesForApi(values: string[]): OneViewSeverity[] {
  return expandHighFamilySeverities(values);
}

/** Família High (query): high + critical legado. */
export function highFamilySeverities(): OneViewSeverity[] {
  return ["high", "critical"];
}

/** Família Disaster (query): somente disaster — critical pertence a High (OV-P0-102). */
export function disasterFamilySeverities(_counts?: Record<string, number>): OneViewSeverity[] {
  return ["disaster"];
}

export interface OneViewResponseMeta {
  data_source?: OneViewDataSourceKind;
  checked_at?: string;
  fallback_code?: string | null;
}

export interface AckRequestResponse {
  request_id: string;
  status: "recorded";
  idempotent: boolean;
  execution_enabled: false;
  actor_name: string;
  message: string;
}

export interface DataSource {
  id: string;
  name: string;
  client_name: string;
  type: "zabbix";
  environment: "internal" | "external";
  api_url: string;
  problem_group_filter: string | null;
  status: "active" | "inactive" | "error";
  sync_enabled: boolean;
  sync_interval_seconds: number;
  via_vpn: boolean;
  observation: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_success_at: string | null;
  last_error: string | null;
  failure_count: number;
  sync_locked_at: string | null;
  sync_lock_owner: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
  has_token?: boolean;
  alerts_count?: number;
  pending_reason?: string | null;
}

export interface OutboxResult {
  outbox_id: string;
  status: "pending" | string;
}

export interface AlertNoteResult {
  id: string;
  alert_id: string;
  message: string;
  operator_name: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface AlertAssignmentResult {
  id: string;
  alert_id: string;
  operator_name: string;
  status: string;
  source: string;
  assigned_at: string;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertStatusResult {
  id: string;
  status_internal: string;
  acknowledged_internal: boolean;
  updated_at: string;
}

export interface OneViewAlert {
  id: string;
  data_source_id: string;
  datasource_name?: string;
  client_name: string;
  client_name_original?: string;
  customer_name: string | null;
  /** Valor original persistido; identidade/display usam customer_key/customer_name canônicos. */
  customer_name_original?: string | null;
  customer_key: string | null;
  customer_source: string | null;
  customer_confidence: string | null;
  /** OV-P0-56 — escopo operacional derivado no BFF. */
  operational_scope?: "customer" | "platform" | "test" | "unknown" | null;
  operational_scope_label?: string | null;
  enrichment_status: "enriched" | "pending";
  enrichment_state: "complete" | "partial" | "legacy" | "unclassified";
  source_type: string;
  source_event_id: string;
  source_problem_id: string | null;
  source_trigger_id: string | null;
  source_host_id: string | null;
  host_name: string | null;
  host_visible_name: string | null;
  host_technical_name: string | null;
  host_ip: string | null;
  host_group: string | null;
  host_groups: Array<{ id: string | null; name: string }>;
  event_tags: Array<{ tag: string; value: string }>;
  trigger_tags: Array<{ tag: string; value: string }>;
  host_tags: Array<{ tag: string; value: string }>;
  /** OV-P0-109 — referência SN das tags Zabbix (sem lookup ServiceNow na listagem). */
  servicenow_reference?: {
    number: string | null;
    sys_id?: string | null;
    sys_id: string | null;
    url?: string | null;
    extra_count?: number;
  } | null;
  service_name: string | null;
  item_name: string | null;
  item_key: string | null;
  trigger_description: string | null;
  operational_data: string | null;
  problem_name: string;
  severity: string;
  status_source: string;
  status_internal: string;
  acknowledged_source: boolean;
  acknowledged_internal: boolean;
  acknowledged_source_at?: string | null;
  acknowledged_source_by?: string | null;
  acknowledged_internal_at?: string | null;
  acknowledged_internal_by?: string | null;
  acknowledged_internal_comment?: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  ack_request_status?: "pending" | "processing" | null;
  suppressed: boolean;
  suppressed_until: string | null;
  maintenance_status: string | null;
  first_seen_at: string;
  started_at?: string;
  last_seen_at: string;
  resolved_at: string | null;
  source_recovery_event_id: string | null;
  duration_seconds: number | null;
  temporal_integrity?: "source_clock_inconsistent" | null;
  created_at: string;
  updated_at: string;
  /** OV-P0-87 — read model de recorrência (detail). */
  recurrence_count_24h?: number;
  recurrence_count_7d?: number;
  previous_occurrence_at?: string | null;
  previous_recovery_at?: string | null;
  is_recurrent?: boolean;
  recurrence_key?: string | null;
  recurrence_previous?: {
    occurrence_at: string | null;
    recovery_at: string | null;
    duration_seconds: number | null;
    temporal_integrity?: "source_clock_inconsistent" | null;
    acknowledged_at: string | null;
    acknowledged_by: string | null;
    incident: OneViewAlert["servicenow_reference"];
  } | null;
  same_problem?: {
    other_hosts: number;
    customers: number;
    period_from: string | null;
    period_to: string | null;
  } | null;
}

export interface AlertPagination {
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
}

export interface AlertListResponse extends OneViewResponseMeta {
  items: OneViewAlert[];
  pagination: AlertPagination;
  filtered_summary?: {
    total: number;
    active: number;
    resolved: number;
    acknowledged_source: number;
    unacknowledged_source: number;
    /**
     * Faixa visual das cinco severidades Zabbix.
     * `high` inclui `critical` legado somente neste summary (item.severity permanece "critical").
     * Campo legado `low` (warning+information+not_classified) foi removido.
     */
    by_severity: {
      information: number;
      warning: number;
      average: number;
      high: number;
      disaster: number;
    };
    /** Fora da faixa visual das cinco severidades. */
    not_classified: number;
  };
  temporal_counts?: {
    created: Record<"15m" | "1h" | "6h" | "24h" | "7d", number>;
    updated: Record<"15m" | "1h" | "6h" | "24h" | "7d", number>;
    resolved: Record<"15m" | "1h" | "6h" | "24h" | "7d" | "30d", number>;
  };
  snapshot_coverage?: {
    partial: boolean;
    total_persisted: number;
    available_items: number;
  };
}

/** Contagem finita verificável; ausente/inválido → null (UI "—"). Zero válido permanece 0. */
export function readFiniteCount(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Formata contagem para KPI/faixa: nunca emite "NaN". */
export function formatNullableCount(value: number | null | undefined): string {
  const n = readFiniteCount(value);
  return n == null ? "—" : n.toLocaleString("pt-BR");
}

export type NormalizedSeverityStripCounts = {
  information: number | null;
  warning: number | null;
  average: number | null;
  high: number | null;
  disaster: number | null;
};

export type NormalizedAlertSeveritySummary = {
  by_severity: NormalizedSeverityStripCounts | null;
  not_classified: number | null;
};

/**
 * OV-P0-42A-REGRESSION: normaliza filtered_summary campo a campo.
 * Não recria `low`. Não inventa zero para campo ausente.
 */
export function normalizeAlertSeveritySummary(summary: unknown): NormalizedAlertSeveritySummary {
  if (!summary || typeof summary !== "object") {
    return { by_severity: null, not_classified: null };
  }
  const raw = summary as Record<string, unknown>;
  const by = raw.by_severity;
  const notClassified = readFiniteCount(raw.not_classified);
  if (!by || typeof by !== "object" || Array.isArray(by)) {
    return { by_severity: null, not_classified: notClassified };
  }
  const bag = by as Record<string, unknown>;
  return {
    by_severity: {
      information: readFiniteCount(bag.information),
      warning: readFiniteCount(bag.warning),
      average: readFiniteCount(bag.average),
      high: readFiniteCount(bag.high),
      disaster: readFiniteCount(bag.disaster),
    },
    not_classified: notClassified,
  };
}

export interface AlertDetailResponse extends OneViewResponseMeta {
  item: OneViewAlert & {
    history_count: number;
    acknowledgement_count: number;
    source_ack?: {
      acknowledged: boolean;
      actor_name: string | null;
      acknowledged_at: string | null;
      comment: string | null;
      acknowledge_id: string | null;
      history_available: boolean;
    };
  };
}

export interface AlertHistoryItem {
  id: string;
  event_type: string;
  title: string;
  description: string | null;
  previous_value: unknown;
  current_value: unknown;
  source_event_id: string | null;
  occurred_at: string;
  created_at: string;
  actor_name: string | null;
  ack_actor_name: string | null;
  ack_actor_unresolved: boolean;
  actor_type: string | null;
  source: string;
  origin: string;
  legacy: boolean;
  comment?: string | null;
  grouped_event_count?: number;
  first_occurred_at?: string;
  last_occurred_at?: string;
}

export interface AlertHistoryResponse extends OneViewResponseMeta {
  alert_id: string;
  items: AlertHistoryItem[];
  total_items: number;
  source_total_items?: number;
  history_available?: boolean;
  history_partial?: boolean;
  first_event_at?: string | null;
  last_event_at?: string | null;
  has_recovery?: boolean;
  has_ack?: boolean;
  acknowledgement_count?: number;
  first_ack_at?: string | null;
  latest_ack_at?: string | null;
  has_ack_comment?: boolean;
  ack_actor_summary?: string;
}

export interface AlertMetrics extends OneViewResponseMeta {
  alerts_total?: number;
  alerts_sample_size?: number;
  active_total: number;
  resolved_today?: number;
  source_acknowledgements_today?: number;
  oneview_acknowledgements_today?: number;
  operational_day?: {
    timezone: string;
    from: string;
    to: string;
  };
  by_severity: Array<{ severity: string; count: number }>;
  by_status: Array<{ status_internal: string; count: number }>;
  by_client: Array<{ client_name: string; count: number }>;
  by_service: Array<{ service_name: string; environment: string | null; count: number }>;
  top_hosts: Array<{ host_name: string; count: number }>;
  unacknowledged_total: number;
  longest_duration: Array<{
    id: string;
    client_name: string;
    host_name: string | null;
    problem_name: string;
    severity: string;
    duration_seconds: number | null;
    first_seen_at: string;
  }>;
  avg_ack_time_seconds: number;
  avg_normalization_time_seconds: number;
}

export interface DataSourceListResponse extends OneViewResponseMeta {
  items: Array<Partial<DataSource> & Pick<DataSource, "id" | "name" | "client_name" | "status">>;
}

export interface OneViewFacetsResponse extends OneViewResponseMeta {
  customers: Array<{
    key: string;
    name: string;
    alerts_count: number;
    disaster_count?: number;
    high_count?: number;
    unacknowledged_count?: number;
    max_severity?: string;
    high_confidence_count: number;
    low_confidence_count: number;
    enrichment_status: "enriched" | "pending";
  }>;
  datasources: Array<{
    id: string;
    name: string;
    alerts_count: number;
  }>;
  clients?: Array<{
    id: string;
    name: string;
    status?: string;
    alerts_count?: number;
    last_sync_at?: string | null;
  }>;
  /** OV-P0-42B: presente no modo janela (first_seen_from). */
  window?: {
    field: "first_seen_at";
    from: string;
    to: string | null;
  };
  total_active?: number;
  top_clients?: Array<{
    customer_key: string;
    customer_name: string;
    count: number;
  }>;
  unclassified_count?: number | null;
  partial?: boolean;
}

export interface GlobalHistoryItem {
  id: string;
  alert_id: string;
  event_type: string;
  title: string;
  description: string | null;
  occurred_at: string;
  actor_name: string | null;
  source: string;
  customer_name: string;
  customer_key: string;
  /** OV-P0-56/61 — apresentação de Eventos (BFF). */
  operational_scope: "customer" | "platform" | "test" | "unknown";
  operational_scope_label: string;
  datasource_name: string;
  host_name: string;
  problem_name: string;
  severity: string;
  previous_value?: unknown;
  current_value?: unknown;
  legacy?: boolean;
}

export interface GlobalHistoryResponse extends OneViewResponseMeta {
  items: GlobalHistoryItem[];
  pagination: {
    page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
}

export interface OneViewHealthResponse extends OneViewResponseMeta {
  status: "ok" | string;
  database_reachable: boolean;
  counts: {
    total_alerts: number;
    active_alerts: number;
  };
  capabilities?: {
    acknowledgement: boolean;
  };
  thresholds?: {
    alert_stale_minutes: number;
  };
}

export interface AttentionRequiredResponse extends OneViewResponseMeta {
  summary: {
    total: number;
    disaster: number;
    critical?: number;
    high: number;
    average: number;
    low?: number;
    by_customer: Array<{ customer_name: string; count: number }>;
    by_datasource: Array<{ datasource_name: string; count: number }>;
  };
  thresholds: {
    disaster_minutes: number;
    high_minutes: number;
    average_minutes: number;
    low_minutes?: number;
  };
  items: Array<{
    id: string;
    customer_name: string | null;
    customer_confidence: string;
    operational_scope?: "customer" | "platform" | "test" | "unknown" | null;
    operational_scope_label?: string | null;
    datasource_name: string;
    host_visible_name: string | null;
    host_technical_name?: string | null;
    host_name?: string | null;
    problem: string;
    severity: string;
    first_seen_at: string;
    last_seen_at: string;
    unacknowledged_minutes: number;
    acknowledged: false;
  }>;
}

export type OperationalStatus = "healthy" | "warning" | "error" | "stale" | "disabled";
export type RuntimeHealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "STALE" | "READY_DISABLED" | "CONFIG_MISSING" | "UNKNOWN";

export interface RuntimeHealthComponent {
  id: string;
  category: "PLATFORM" | "ZABBIX" | "SERVICENOW" | "WORKERS" | "INTEGRATIONS";
  name: string;
  enabled: boolean;
  status: RuntimeHealthStatus;
  connectivity: string;
  auth: string;
  freshness: { age_seconds: number | null; ratio: number | null } | null;
  last_success_at: string | null;
  last_observed_at: string | null;
  last_error_at: string | null;
  interval_seconds: number | null;
  duration_ms: number | null;
  hostname: string | null;
  version: string | null;
  failure_count: number;
  current_error: string | null;
  last_historical_error: string | null;
  detail: string | null;
}

export interface RuntimeHealthResponse extends OneViewResponseMeta {
  overall_status: RuntimeHealthStatus;
  generated_at: string;
  components: RuntimeHealthComponent[];
}

export interface OperationsHealthResponse extends OneViewResponseMeta {
  status: OperationalStatus;
  summary: Record<OperationalStatus, number> & { total: number };
  worker: { status: "healthy" | "stale" | "unknown"; last_activity_at: string | null };
  items: Array<{
    id: string;
    name: string;
    client_name: string;
    source_status: "active" | "inactive" | "error";
    operational_status: OperationalStatus;
    reason_code: string;
    sync_enabled: boolean;
    sync_interval_seconds: number;
    last_sync_status: string | null;
    last_sync_at: string | null;
    last_success_at: string | null;
    last_activity_at: string | null;
    failure_count: number;
  }>;
}

export interface OneViewSyncLog {
  id: string;
  datasource: string;
  data_source_id: string;
  status: string;
  fetched: number;
  upserted: number;
  detail: string;
  created_at: string | null;
}

export interface SyncLogListResponse extends OneViewResponseMeta {
  items: OneViewSyncLog[];
}

export const ONEVIEW_READ_ONLY_MESSAGE =
  "Ações operacionais desabilitadas neste modo de leitura. Nenhum ACK real foi executado.";

function readOnlyMessage(action: string): string {
  return `Modo leitura atual: ${action} está desabilitado.`;
}

export async function fetchDataSourcesWithMeta(): Promise<{ items: DataSource[] } & OneViewResponseMeta> {
  const response = await fetchApi<DataSourceListResponse>("/oneview/data-sources");

  return {
    data_source: response.data_source,
    checked_at: response.checked_at,
    fallback_code: response.fallback_code,
    items: response.items.map((source) => ({
    id: source.id,
    name: source.name,
    client_name: source.client_name,
    type: source.type ?? "zabbix",
    environment: source.environment ?? "internal",
    api_url: "",
    problem_group_filter: source.problem_group_filter ?? null,
    status: source.status,
    sync_enabled: source.sync_enabled ?? false,
    sync_interval_seconds: source.sync_interval_seconds ?? 300,
    via_vpn: source.via_vpn ?? false,
    observation: source.observation ?? null,
    last_sync_at: source.last_sync_at ?? null,
    last_sync_status: source.last_sync_status ?? null,
    last_sync_error: source.last_sync_error ?? null,
    last_success_at: source.last_success_at ?? null,
    last_error: source.last_error ?? null,
    failure_count: source.failure_count ?? 0,
    sync_locked_at: source.sync_locked_at ?? null,
    sync_lock_owner: source.sync_lock_owner ?? null,
    display_order: source.display_order ?? 100,
    created_at: source.created_at ?? new Date().toISOString(),
    updated_at: source.updated_at ?? new Date().toISOString(),
    has_token: source.has_token,
    alerts_count: source.alerts_count,
    pending_reason: source.pending_reason ?? null,
    })),
  };
}

export async function fetchDataSources(): Promise<DataSource[]> {
  return (await fetchDataSourcesWithMeta()).items;
}

export async function requestDataSourceSync(id: string, reason = "manual_ui"): Promise<OutboxResult> {
  if (isReadOnlyMode) {
    throw new Error("Modo leitura: o sync permanece exclusivamente no Worker separado.");
  }
  return fetchApi<OutboxResult>(`/data-sources/${id}/request-sync`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export interface FetchAlertsParams {
  page?: number;
  pageSize?: number;
  clients?: string[];
  customers?: string[];
  datasources?: string[];
  customerConfidences?: Array<"high" | "medium" | "low" | "unclassified">;
  severities?: string[];
  status?: "active" | "resolved" | "all";
  acknowledged?: boolean;
  acknowledgedSource?: boolean;
  acknowledgedInternal?: boolean;
  search?: string;
  searchField?: "all" | "host" | "problem" | "customer" | "eventid";
  hostSearch?: string;
  problemSearch?: string;
  dateFrom?: string;
  dateTo?: string;
  firstSeenFrom?: string;
  firstSeenTo?: string;
  lastSeenFrom?: string;
  lastSeenTo?: string;
  resolvedFrom?: string;
  resolvedTo?: string;
  acknowledgedFrom?: string;
  acknowledgedTo?: string;
  sort?: "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "client" | "datasource" | "host" | "problem" | "duration" | "status" | "acknowledged_source" | "acknowledged_at";
  order?: "asc" | "desc";
  sortSecondary?: "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "client" | "datasource" | "host" | "problem" | "duration" | "status" | "acknowledged_source" | "acknowledged_at";
  recurrenceKey?: string;
  signal?: AbortSignal;
}

export async function fetchAlerts(params?: FetchAlertsParams): Promise<AlertListResponse> {
  const search = new URLSearchParams();
  search.set("page", String(params?.page ?? 1));
  search.set("page_size", String(params?.pageSize ?? 50));
  for (const client of params?.clients ?? []) search.append("client", client);
  for (const customer of params?.customers ?? []) search.append("customer", customer);
  for (const datasource of params?.datasources ?? []) search.append("datasource", datasource);
  for (const confidence of params?.customerConfidences ?? []) search.append("customer_confidence", confidence);
  for (const severity of canonicalizeSeveritiesForApi(params?.severities ?? [])) search.append("severity", severity);
  if (params?.status) search.set("status", params.status);
  if (typeof params?.acknowledged === "boolean") search.set("acknowledged", String(params.acknowledged));
  if (typeof params?.acknowledgedSource === "boolean") search.set("acknowledged_source", String(params.acknowledgedSource));
  if (typeof params?.acknowledgedInternal === "boolean") search.set("acknowledged_internal", String(params.acknowledgedInternal));
  if (params?.search) search.set("search", params.search);
  if (params?.searchField && params.searchField !== "all") search.set("search_field", params.searchField);
  if (params?.hostSearch) search.set("host_search", params.hostSearch);
  if (params?.problemSearch) search.set("problem_search", params.problemSearch);
  if (params?.dateFrom) search.set("date_from", params.dateFrom);
  if (params?.dateTo) search.set("date_to", params.dateTo);
  if (params?.firstSeenFrom) search.set("first_seen_from", params.firstSeenFrom);
  if (params?.firstSeenTo) search.set("first_seen_to", params.firstSeenTo);
  if (params?.lastSeenFrom) search.set("last_seen_from", params.lastSeenFrom);
  if (params?.lastSeenTo) search.set("last_seen_to", params.lastSeenTo);
  if (params?.resolvedFrom) search.set("resolved_from", params.resolvedFrom);
  if (params?.resolvedTo) search.set("resolved_to", params.resolvedTo);
  if (params?.acknowledgedFrom) search.set("acknowledged_from", params.acknowledgedFrom);
  if (params?.acknowledgedTo) search.set("acknowledged_to", params.acknowledgedTo);
  if (params?.sort) search.set("sort", params.sort);
  if (params?.order) search.set("order", params.order);
  if (params?.sortSecondary) search.set("sort_secondary", params.sortSecondary);
  if (params?.recurrenceKey) search.set("recurrence_key", params.recurrenceKey);

  const query = search.toString();
  return fetchApi<AlertListResponse>(`/oneview/alerts${query ? `?${query}` : ""}`, { signal: params?.signal });
}

export async function fetchAlert(id: string, signal?: AbortSignal): Promise<AlertDetailResponse> {
  return fetchApi<AlertDetailResponse>(`/oneview/alerts/${encodeURIComponent(id)}`, { signal });
}

export async function fetchAlertHistory(id: string, signal?: AbortSignal): Promise<AlertHistoryResponse> {
  return fetchApi<AlertHistoryResponse>(`/oneview/alerts/${encodeURIComponent(id)}/history`, { signal });
}

export async function fetchGlobalHistory(params?: {
  page?: number;
  pageSize?: number;
  customers?: string[];
  datasources?: string[];
  eventType?: string;
  search?: string;
  occurredFrom?: string;
  occurredTo?: string;
  signal?: AbortSignal;
}): Promise<GlobalHistoryResponse> {
  const search = new URLSearchParams();
  search.set("page", String(Math.max(1, params?.page ?? 1)));
  search.set("page_size", String(Math.min(params?.pageSize ?? 50, 100)));
  for (const customer of params?.customers ?? []) search.append("customer", customer);
  for (const datasource of params?.datasources ?? []) search.append("datasource", datasource);
  if (params?.eventType && params.eventType !== "all") search.set("event_type", params.eventType);
  if (params?.search) search.set("search", params.search);
  if (params?.occurredFrom) search.set("occurred_from", params.occurredFrom);
  if (params?.occurredTo) search.set("occurred_to", params.occurredTo);
  const query = search.toString();
  return fetchApi<GlobalHistoryResponse>(`/oneview/history${query ? `?${query}` : ""}`, { signal: params?.signal });
}

export type OneViewIncident = {
  sys_id: string | null;
  id?: string | null;
  sysId?: string | null;
  number: string | null;
  short_description: string | null;
  description?: string | null;
  state: string | null;
  priority: string | null;
  impact?: string | null;
  impact_display?: string | null;
  urgency?: string | null;
  urgency_display?: string | null;
  caller_id: string | null;
  contact_type: string | null;
  assignment_group: string | null;
  assigned_to: string | null;
  company: string | null;
  opened_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  sys_created_on: string | null;
  sys_updated_on: string | null;
  correlation_id: string | null;
  u_hostname_zabbix: string | null;
  u_ip_zabbix: string | null;
  category?: string | null;
  category_display?: string | null;
  subcategory?: string | null;
  subcategory_display?: string | null;
  close_code?: string | null;
  close_notes?: string | null;
  contract?: string | null;
  zabbix_event_id?: string | null;
  zabbix_host?: string | null;
  zabbix_ip?: string | null;
  caller_id_display?: string | null;
  contact_type_display?: string | null;
  assignment_group_display?: string | null;
  assigned_to_display?: string | null;
  company_display?: string | null;
  state_display?: string | null;
  priority_display?: string | null;
  /** OV-P0-245 canonical aliases; snake_case remains for existing consumers. */
  assignmentGroup?: string | null;
  assignedTo?: string | null;
  assignedToId?: string | null;
  customer?: string | null;
  shortDescription?: string | null;
  openedAt?: string | null;
  updatedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  channel?: string | null;
  relatedAlert?: {
    alertId: string | null;
    severity: string | null;
    host: string | null;
    datasource: string | null;
    link: string | null;
    relationSource?: string | null;
    customer?: string | null;
    problem?: string | null;
    status?: string | null;
    sourceEventId?: string | null;
  } | null;
  servicenow_url?: string | null;
};

export type IncidentRelatedAlert = {
  id: string;
  data_source_id?: string | null;
  host: string;
  customer: string;
  problem: string;
  severity: string;
  status: string;
  source_event_id?: string | null;
  first_seen_at?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
  oneview_link?: string | null;
};

export type IncidentRelatedAlertResponse = {
  matched: boolean;
  sys_id?: string | null;
  number?: string | null;
  zabbix_event_id: string | null;
  relation_source?: "sys_id" | "number" | "event_id" | "none";
  alert: IncidentRelatedAlert | null;
  data_source?: OneViewDataSourceKind | string;
  checked_at?: string;
  error?: string;
};

export type IncidentCallerFacet = {
  value: string;
  label: string;
  count: number;
  display_value?: string;
};

/** SN-P0-28 — facet de analista (assigned_to). */
export type IncidentAssigneeFacet = {
  value: string;
  label: string;
  count: number;
  display_value?: string;
};

export type IncidentListResponse = {
  items: OneViewIncident[];
  pagination: {
    page: number;
    page_size: number;
    total_items: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
  filters: {
    caller_id: string | null;
    assigned_to: string | null;
    contact_type: string | null;
    number: string | null;
    state: string | null;
    priority: string | null;
    company: string | null;
    opened_from: string | null;
    opened_to: string | null;
    updated_from?: string | null;
    updated_to?: string | null;
    include_related_alert?: boolean;
    unassigned: boolean;
    assignment_group?: string | null;
    search: string | null;
  };
  counts?: {
    total: number;
    open: number;
    in_progress: number;
    resolved: number;
    closed: number;
    unassigned: number;
  } | null;
  /** SN-P0-25 / SN-P0-28 / SN-P0-30 — facets Aggregate no universo monitoring. */
  facets?: {
    callers?: IncidentCallerFacet[];
    assignees?: IncidentAssigneeFacet[];
    companies?: IncidentAssigneeFacet[];
    states?: IncidentAssigneeFacet[];
    priorities?: IncidentAssigneeFacet[];
  } | null;
  data_source?: OneViewDataSourceKind | string;
  checked_at?: string;
  freshness?: {
    last_success_at?: string | null;
    watermark_sys_updated_on?: string | null;
  };
};

export async function fetchIncidents(params?: {
  page?: number;
  pageSize?: number;
  callerId?: string;
  assignedTo?: string;
  number?: string;
  sysId?: string;
  state?: string;
  priority?: string;
  company?: string;
  openedFrom?: string;
  openedTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  includeRelatedAlert?: boolean;
  unassigned?: boolean;
  assignmentGroup?: string;
  search?: string;
  signal?: AbortSignal;
}): Promise<IncidentListResponse> {
  // SN-P0-15: filtros allowlisted apenas. Encoded query só no BFF; canal monitoring é fixo no backend.
  const search = new URLSearchParams();
  search.set("page", String(Math.max(1, params?.page ?? 1)));
  search.set("page_size", String(Math.min(Math.max(params?.pageSize ?? 25, 1), 100)));
  if (params?.callerId) search.set("caller_id", params.callerId);
  if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.number) search.set("number", params.number);
  if (params?.sysId) search.set("sys_id", params.sysId);
  if (params?.state) search.set("state", params.state);
  if (params?.priority) search.set("priority", params.priority);
  if (params?.company) search.set("company", params.company);
  if (params?.openedFrom) search.set("opened_from", params.openedFrom);
  if (params?.openedTo) search.set("opened_to", params.openedTo);
  if (params?.updatedFrom) search.set("updated_from", params.updatedFrom);
  if (params?.updatedTo) search.set("updated_to", params.updatedTo);
  if (params?.includeRelatedAlert) search.set("include_related_alert", "true");
  if (params?.unassigned) search.set("unassigned", "true");
  if (params?.assignmentGroup) search.set("assignment_group", params.assignmentGroup);
  if (params?.search) search.set("search", params.search);
  const query = search.toString();
  return fetchApi<IncidentListResponse>(`/oneview/incidents${query ? `?${query}` : ""}`, {
    signal: params?.signal,
  });
}

export type OperatorQueueTab = "all" | "unassigned" | "following" | "recent";

export type OperatorQueueItem = {
  alert_id: string | null;
  customer_name: string | null;
  customer_key: string | null;
  operator_tag: string | null;
  problem_name: string | null;
  host_name: string | null;
  severity: string | null;
  incident_number: string | null;
  incident_sys_id: string | null;
  incident_state: string | null;
  incident_state_display: string | null;
  assigned_to: string | null;
  assigned_to_display: string | null;
  analyst_label: string;
  unassigned: boolean;
  assignment_group: string | null;
  assignment_group_display: string | null;
  last_updated_at: string | null;
  updated_ago_label: string | null;
  sla_status: null;
  next_followup_at: null;
  relation_source: string;
  oneview_link: string | null;
  servicenow_url: string | null;
};

export type OperatorQueueFacet = { value: string; label: string };

export type OperatorQueueResponse = OneViewResponseMeta & {
  items: OperatorQueueItem[];
  pagination: AlertPagination;
  filters: {
    tab: OperatorQueueTab;
    operator_tag: string | null;
    customer: string | null;
    assigned_to: string | null;
    state: string | null;
    severity: string | null;
    page: number;
    page_size: number;
  };
  counts: {
    all: number;
    unassigned: number;
    following: number;
    recent: number;
  };
  facets: {
    operator_tags: OperatorQueueFacet[];
    customers: OperatorQueueFacet[];
    analysts: OperatorQueueFacet[];
    states: OperatorQueueFacet[];
    severities: OperatorQueueFacet[];
  };
  sla_rules_implemented: false;
  sla_awaiting_business_rules: true;
};

export async function fetchOperatorQueue(params?: {
  tab?: OperatorQueueTab;
  operatorTag?: string;
  customer?: string;
  assignedTo?: string;
  state?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}): Promise<OperatorQueueResponse> {
  const search = new URLSearchParams();
  search.set("page", String(Math.max(1, params?.page ?? 1)));
  search.set("page_size", String(Math.min(Math.max(params?.pageSize ?? 50, 1), 100)));
  if (params?.tab) search.set("tab", params.tab);
  if (params?.operatorTag) search.set("operator_tag", params.operatorTag);
  if (params?.customer) search.set("customer", params.customer);
  if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.state) search.set("state", params.state);
  if (params?.severity) search.set("severity", params.severity);
  return fetchApi<OperatorQueueResponse>(`/oneview/operator-queue?${search.toString()}`, {
    signal: params?.signal,
  });
}

/** SN-P0-08 — lookup read-only alerta ↔ incidente via zabbix_event_id. */
export async function fetchIncidentRelatedAlert(
  reference: string | { sysId?: string | null; number?: string | null; sourceEventId?: string | null },
  signal?: AbortSignal,
): Promise<IncidentRelatedAlertResponse> {
  const search = new URLSearchParams();
  if (typeof reference === "string") {
    search.set("zabbix_event_id", reference.trim());
  } else {
    if (reference.sysId) search.set("sys_id", reference.sysId.trim());
    if (reference.number) search.set("number", reference.number.trim());
    if (reference.sourceEventId) search.set("source_event_id", reference.sourceEventId.trim());
  }
  return fetchApi<IncidentRelatedAlertResponse>(
    `/oneview/incidents/related-alert?${search.toString()}`,
    { signal },
  );
}

/** SN-P0-16 / SN-P0-27 — incidentes SN relacionados ao alerta. Sem fallback por host. */
export type AlertRelatedIncident = {
  sys_id: string | null;
  number: string | null;
  state: string | null;
  state_display?: string | null;
  priority: string | null;
  priority_display?: string | null;
  assignment_group: string | null;
  assignment_group_display?: string | null;
  assigned_to: string | null;
  assigned_to_display?: string | null;
  sys_updated_on: string | null;
  zabbix_event_id?: string | null;
  servicenow_url?: string | null;
};

export type AlertRelatedIncidentsRelationSource =
  | "zabbix_servicenow_sys_id"
  | "zabbix_servicenow_number"
  | "zabbix_inc_reference"
  | "zabbix_event_id"
  | "none";

export type AlertRelatedIncidentsResponse = OneViewResponseMeta & {
  matched: boolean;
  relation_source?: AlertRelatedIncidentsRelationSource;
  source_event_id: string | null;
  incident_numbers?: string[];
  incident_sys_ids?: string[];
  incidents: AlertRelatedIncident[];
  error?: string;
};

export type FetchAlertRelatedIncidentsParams = {
  sourceEventId?: string | null;
  /** Números INC do histórico/comentário (BFF valida e consulta SN). */
  incidentNumbers?: string[] | null;
  /** OV-P0-108 — números de __zbx_servicenow_number. */
  tagIncidentNumbers?: string[] | null;
  /** OV-P0-108 — sys_ids de __zbx_servicenow_sys_id. */
  incidentSysIds?: string[] | null;
  /** Corpus textual opcional (comentários/ACK/timeline) — BFF extrai INC. */
  texts?: string[] | null;
};

export async function fetchAlertRelatedIncidents(
  sourceEventIdOrParams: string | FetchAlertRelatedIncidentsParams,
  signal?: AbortSignal,
): Promise<AlertRelatedIncidentsResponse> {
  const params: FetchAlertRelatedIncidentsParams = typeof sourceEventIdOrParams === "string"
    ? { sourceEventId: sourceEventIdOrParams }
    : (sourceEventIdOrParams || {});
  const search = new URLSearchParams();
  const eventId = String(params.sourceEventId || "").trim();
  if (eventId) search.set("source_event_id", eventId);
  for (const number of params.incidentNumbers || []) {
    const value = String(number || "").trim();
    if (value) search.append("inc", value);
  }
  for (const number of params.tagIncidentNumbers || []) {
    const value = String(number || "").trim();
    if (value) search.append("sn_number", value);
  }
  for (const sysId of params.incidentSysIds || []) {
    const value = String(sysId || "").trim();
    if (value) search.append("sys_id", value);
  }
  for (const text of params.texts || []) {
    const value = String(text || "").trim();
    if (value) search.append("text", value);
  }
  return fetchApi<AlertRelatedIncidentsResponse>(
    `/oneview/alerts/related-incidents?${search.toString()}`,
    { signal },
  );
}

export async function requestAlertAcknowledgement(
  id: string,
  comment: string,
  idempotencyKey: string,
): Promise<AckRequestResponse> {
  return fetchApi<AckRequestResponse>(`/oneview/alerts/${encodeURIComponent(id)}/ack-request`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ comment }),
  });
}

export async function fetchOperationsHealth(signal?: AbortSignal): Promise<OperationsHealthResponse> {
  return fetchApi<OperationsHealthResponse>("/oneview/operations/health", { signal });
}

export async function fetchRuntimeHealth(signal?: AbortSignal): Promise<RuntimeHealthResponse> {
  return fetchApi<RuntimeHealthResponse>("/oneview/runtime-health", { signal });
}

export async function fetchOneViewFacets(signal?: AbortSignal): Promise<OneViewFacetsResponse> {
  return fetchApi<OneViewFacetsResponse>("/oneview/clients-summary", { signal });
}

/** OV-P0-42B: top clientes ativos na janela (first_seen_at), server-side. */
export async function fetchClientsTopSummary(params: {
  status?: "active";
  firstSeenFrom: string;
  firstSeenTo?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<OneViewFacetsResponse> {
  const search = new URLSearchParams();
  search.set("status", params.status || "active");
  search.set("first_seen_from", params.firstSeenFrom);
  if (params.firstSeenTo) search.set("first_seen_to", params.firstSeenTo);
  if (params.limit != null) search.set("limit", String(params.limit));
  return fetchApi<OneViewFacetsResponse>(`/oneview/clients-summary?${search.toString()}`, {
    signal: params.signal,
  });
}

/**
 * OV-P0-42B-VALIDATION: contrato windowed obrigatório.
 * Facets legado (só customers) sem top_clients/total_active → inválido.
 */
export function isWindowedClientsSummary(payload: unknown): payload is OneViewFacetsResponse & {
  top_clients: NonNullable<OneViewFacetsResponse["top_clients"]>;
  total_active: number;
  unclassified_count: number;
} {
  if (!payload || typeof payload !== "object") return false;
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.top_clients)) return false;
  if (typeof raw.total_active !== "number" || !Number.isFinite(raw.total_active)) return false;
  if (typeof raw.unclassified_count !== "number" || !Number.isFinite(raw.unclassified_count)) return false;
  if (!raw.window || typeof raw.window !== "object") return false;
  const window = raw.window as Record<string, unknown>;
  return window.field === "first_seen_at" && typeof window.from === "string" && Boolean(window.from);
}

export async function fetchAlertMetrics(options: { refresh?: boolean } = {}): Promise<AlertMetrics> {
  return fetchApi<AlertMetrics>(`/oneview/dashboard-summary${options.refresh ? "?refresh=1" : ""}`);
}

export async function fetchAttentionRequired(
  limit = 100,
  options: { firstSeenFrom?: string; firstSeenTo?: string; signal?: AbortSignal } = {},
): Promise<AttentionRequiredResponse> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const search = new URLSearchParams();
  search.set("limit", String(safeLimit));
  if (options.firstSeenFrom) search.set("first_seen_from", options.firstSeenFrom);
  if (options.firstSeenTo) search.set("first_seen_to", options.firstSeenTo);
  return fetchApi<AttentionRequiredResponse>(`/oneview/attention-required?${search.toString()}`, {
    signal: options.signal,
  });
}

export async function fetchOneViewHealth(): Promise<OneViewHealthResponse> {
  return fetchApi<OneViewHealthResponse>("/oneview/health");
}

export async function fetchSyncLogs(limit = 8): Promise<SyncLogListResponse> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  return fetchApi<SyncLogListResponse>(`/oneview/sync-logs?limit=${safeLimit}`);
}

export async function addAlertNote(id: string, message: string, operatorName = "oneview-ui"): Promise<AlertNoteResult> {
  if (isReadOnlyMode) throw new Error(readOnlyMessage("notas reais"));
  return fetchApi<AlertNoteResult>(`/alerts/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ message, operator_name: operatorName }),
  });
}

export async function assignAlert(id: string, operatorName = "oneview-ui"): Promise<AlertAssignmentResult> {
  if (isReadOnlyMode) throw new Error(readOnlyMessage("atribuições reais"));
  return fetchApi<AlertAssignmentResult>(`/alerts/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ operator_name: operatorName }),
  });
}

export async function updateAlertStatus(
  id: string,
  status: string,
  message?: string,
  operatorName = "oneview-ui",
): Promise<AlertStatusResult> {
  if (isReadOnlyMode) throw new Error(readOnlyMessage("ACK real"));
  return fetchApi<AlertStatusResult>(`/alerts/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status, message, operator_name: operatorName }),
  });
}

export async function fetchAllAlerts(params?: FetchAlertsParams): Promise<AlertListResponse> {
  return fetchAlerts({ ...params, page: 1, pageSize: Math.min(params?.pageSize ?? 100, 100) });
}

export function dataSourcesToClients(dataSources: DataSource[]): Client[] {
  return [
    { id: "all", name: "TODOS", logo: "" },
    ...dataSources.map((source) => ({
      id: source.id,
      name: source.name,
      logo: "",
    })),
  ];
}

export function severityToUi(value: string): Severity {
  switch (value) {
    case "disaster":
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "average":
      return "Average";
    case "warning":
    case "information":
    case "not_classified":
      return "Low";
    default:
      return "Low";
  }
}

export function uiSeverityToApi(value: string): string | undefined {
  switch (value) {
    case "5":
    case "Critical":
      return "disaster";
    case "4":
    case "High":
      return "high";
    case "3":
    case "Average":
      return "average";
    case "2":
      return "warning";
    case "1":
    case "Low":
      return "information";
    case "0":
      return "not_classified";
    default:
      return undefined;
  }
}

export function oneViewAlertToLegacyAlert(alert: OneViewAlert): Alert {
  const firstSeen = new Date(alert.first_seen_at);
  const status =
    alert.status_source === "resolved" || alert.status_internal === "normalized"
      ? "Resolved"
      : alert.acknowledged_internal || alert.acknowledged_source || alert.status_internal === "acknowledged"
        ? "Acknowledged"
        : "Active";

  return {
    id: alert.source_event_id || alert.id,
    time: Number.isNaN(firstSeen.getTime()) ? alert.first_seen_at : firstSeen.toISOString(),
    severity: severityToUi(alert.severity),
    host: canonicalHostName(alert),
    problem: alert.problem_name,
    operationalData: "",
    duration: formatDurationSeconds(alert.duration_seconds),
    status,
    tags: [],
    clientId: alert.data_source_id,
    clientName: canonicalClientName({
      key: alert.customer_key,
      name: alert.customer_name,
      source: alert.customer_source,
    }),
  };
}

export function formatDurationSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "Duração indisponível";
  const seconds = Math.floor(value);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
