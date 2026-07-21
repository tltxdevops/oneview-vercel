import { Alert, Client, Severity } from "@/types";
import { isSsoEnvironmentReady, loginRequest, msalInstance } from "@/lib/auth/msal";
import { isReadOnlyMode } from "@/lib/demo-mode";
import { getServerAuthToken, serverAuthEnabled } from "@/lib/server-auth";

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
      database_timeout: "A consulta demorou além do esperado. Tente novamente.",
      database_unavailable: "O banco OneView está temporariamente indisponível.",
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
      : undefined;

  return {
    ...record,
    ...(dataSource ? { data_source: dataSource } : {}),
    checked_at: typeof record.checked_at === "string" ? record.checked_at : new Date().toISOString(),
  } as T;
}

export type OneViewDataSourceKind = "database" | "snapshot";

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
  customer_name: string | null;
  customer_key: string | null;
  customer_source: string | null;
  customer_confidence: string | null;
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
  duration_seconds: number;
  created_at: string;
  updated_at: string;
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
  snapshot_coverage?: {
    partial: boolean;
    total_persisted: number;
    available_items: number;
  };
}

export interface AlertDetailResponse extends OneViewResponseMeta {
  item: OneViewAlert & {
    history_count: number;
    acknowledgement_count: number;
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
    duration_seconds: number;
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
    high_confidence_count: number;
    low_confidence_count: number;
    enrichment_status: "enriched" | "pending";
  }>;
  datasources: Array<{
    id: string;
    name: string;
    alerts_count: number;
  }>;
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
    high: number;
    average: number;
    by_customer: Array<{ customer_name: string; count: number }>;
    by_datasource: Array<{ datasource_name: string; count: number }>;
  };
  thresholds: {
    disaster_minutes: number;
    high_minutes: number;
    average_minutes: number;
  };
  items: Array<{
    id: string;
    customer_name: string | null;
    customer_confidence: string;
    datasource_name: string;
    host_visible_name: string;
    problem: string;
    severity: string;
    first_seen_at: string;
    last_seen_at: string;
    unacknowledged_minutes: number;
    acknowledged: false;
  }>;
}

export type OperationalStatus = "healthy" | "warning" | "error" | "stale" | "disabled";

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
  hostSearch?: string;
  problemSearch?: string;
  dateFrom?: string;
  dateTo?: string;
  firstSeenFrom?: string;
  lastSeenFrom?: string;
  sort?: "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "client" | "datasource" | "host" | "problem" | "duration" | "status" | "acknowledged_source";
  order?: "asc" | "desc";
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
  for (const severity of params?.severities ?? []) search.append("severity", severity);
  if (params?.status) search.set("status", params.status);
  if (typeof params?.acknowledged === "boolean") search.set("acknowledged", String(params.acknowledged));
  if (typeof params?.acknowledgedSource === "boolean") search.set("acknowledged_source", String(params.acknowledgedSource));
  if (typeof params?.acknowledgedInternal === "boolean") search.set("acknowledged_internal", String(params.acknowledgedInternal));
  if (params?.search) search.set("search", params.search);
  if (params?.hostSearch) search.set("host_search", params.hostSearch);
  if (params?.problemSearch) search.set("problem_search", params.problemSearch);
  if (params?.dateFrom) search.set("date_from", params.dateFrom);
  if (params?.dateTo) search.set("date_to", params.dateTo);
  if (params?.firstSeenFrom) search.set("first_seen_from", params.firstSeenFrom);
  if (params?.lastSeenFrom) search.set("last_seen_from", params.lastSeenFrom);
  if (params?.sort) search.set("sort", params.sort);
  if (params?.order) search.set("order", params.order);

  const query = search.toString();
  return fetchApi<AlertListResponse>(`/oneview/alerts${query ? `?${query}` : ""}`, { signal: params?.signal });
}

export async function fetchAlert(id: string, signal?: AbortSignal): Promise<AlertDetailResponse> {
  return fetchApi<AlertDetailResponse>(`/oneview/alerts/${encodeURIComponent(id)}`, { signal });
}

export async function fetchAlertHistory(id: string, signal?: AbortSignal): Promise<AlertHistoryResponse> {
  return fetchApi<AlertHistoryResponse>(`/oneview/alerts/${encodeURIComponent(id)}/history`, { signal });
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

export async function fetchOneViewFacets(signal?: AbortSignal): Promise<OneViewFacetsResponse> {
  return fetchApi<OneViewFacetsResponse>("/oneview/clients-summary", { signal });
}

export async function fetchAlertMetrics(): Promise<AlertMetrics> {
  return fetchApi<AlertMetrics>("/oneview/dashboard-summary");
}

export async function fetchAttentionRequired(limit = 100): Promise<AttentionRequiredResponse> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  return fetchApi<AttentionRequiredResponse>(`/oneview/attention-required?limit=${safeLimit}`);
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
    host: alert.host_visible_name || alert.host_technical_name || alert.host_name || "-",
    problem: alert.problem_name,
    operationalData: "",
    duration: formatDurationSeconds(alert.duration_seconds),
    status,
    tags: [],
    clientId: alert.data_source_id,
    clientName: alert.customer_name
      || (alert.datasource_name?.toLowerCase() === "teletex-http"
        ? "Classificação histórica pendente"
        : "Dados históricos aguardando classificação"),
  };
}

export function formatDurationSeconds(value: number): string {
  const seconds = Math.max(Math.floor(value || 0), 0);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
