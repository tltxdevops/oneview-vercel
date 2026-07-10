import { Alert, Client, Severity } from "@/types";
import { isSsoEnvironmentReady, loginRequest, msalInstance } from "@/lib/auth/msal";
import { isReadOnlyMode, isSnapshotMode } from "@/lib/demo-mode";
import { SNAPSHOT_TOTAL_ALERTS, demoAlertMetrics, demoAlerts, demoDataSources } from "@/lib/demo-oneview-data";
import { getServerAuthToken, serverAuthEnabled } from "@/lib/server-auth";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "/api");

async function authHeaders(): Promise<Record<string, string>> {
  if (serverAuthEnabled()) {
    const token = getServerAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (import.meta.env.VITE_ONEVIEW_API_AUTH_DISABLED === "true") return {};
  if (!msalInstance || !isSsoEnvironmentReady) return {};

  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
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
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorText || response.statusText}`);
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
  source_type: string;
  source_event_id: string;
  source_problem_id: string | null;
  source_trigger_id: string | null;
  source_host_id: string | null;
  host_name: string | null;
  host_ip: string | null;
  host_group: string | null;
  service_name: string | null;
  problem_name: string;
  severity: string;
  status_source: string;
  status_internal: string;
  acknowledged_source: boolean;
  acknowledged_internal: boolean;
  first_seen_at: string;
  started_at?: string;
  last_seen_at: string;
  resolved_at: string | null;
  duration_seconds: number;
  fingerprint: string;
  payload_normalized: {
    eventid?: string;
    triggerid?: string;
    severity?: string;
    opdata?: string;
    suppressed?: boolean;
    tags?: Array<{ tag?: string; value?: string }>;
    acknowledges?: unknown[];
    suppression_data?: unknown[];
  };
  created_at: string;
  updated_at: string;
}

export interface AlertListResponse extends OneViewResponseMeta {
  items: OneViewAlert[];
  total: number;
}

export interface AlertMetrics extends OneViewResponseMeta {
  active_total: number;
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

function snapshotMeta(): Required<OneViewResponseMeta> {
  return { data_source: "snapshot", checked_at: new Date().toISOString() };
}

function readOnlyMessage(action: string): string {
  return `Modo leitura atual: ${action} está desabilitado.`;
}

export async function fetchDataSourcesWithMeta(): Promise<{ items: DataSource[] } & OneViewResponseMeta> {
  const response: DataSourceListResponse = isSnapshotMode
    ? { items: demoDataSources.map((source) => ({ ...source })), ...snapshotMeta() }
    : await fetchApi<DataSourceListResponse>("/oneview/data-sources");

  return {
    data_source: response.data_source,
    checked_at: response.checked_at,
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
  if (isSnapshotMode || isReadOnlyMode) {
    throw new Error("Modo leitura por snapshot real: o sync permanece exclusivamente no Worker separado.");
  }
  return fetchApi<OutboxResult>(`/data-sources/${id}/request-sync`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export interface FetchAlertsParams {
  clientName?: string;
  severity?: string;
  statusInternal?: string;
  acknowledged?: boolean;
  host?: string;
  service?: string;
  limit?: number;
  offset?: number;
}

export async function fetchAlerts(params?: FetchAlertsParams): Promise<AlertListResponse> {
  if (isSnapshotMode) {
    let items = [...demoAlerts];
    if (params?.clientName) items = items.filter((item) => item.client_name === params.clientName);
    if (params?.severity) items = items.filter((item) => item.severity === params.severity);
    if (params?.statusInternal) items = items.filter((item) => item.status_internal === params.statusInternal);
    if (typeof params?.acknowledged === "boolean") {
      items = items.filter((item) =>
        (item.acknowledged_internal || item.acknowledged_source) === params.acknowledged,
      );
    }
    if (params?.host) {
      const host = params.host.toLocaleLowerCase("pt-BR");
      items = items.filter((item) => item.host_name?.toLocaleLowerCase("pt-BR").includes(host));
    }
    if (params?.service) items = items.filter((item) => item.service_name === params.service);

    const hasFilter = Boolean(
      params?.clientName ||
      params?.severity ||
      params?.statusInternal ||
      typeof params?.acknowledged === "boolean" ||
      params?.host ||
      params?.service,
    );
    const total = hasFilter ? items.length : SNAPSHOT_TOTAL_ALERTS;
    const offset = Math.max(params?.offset ?? 0, 0);
    const limit = Math.max(params?.limit ?? total, 0);
    return { items: items.slice(offset, offset + limit), total, ...snapshotMeta() };
  }

  const search = new URLSearchParams();
  if (params?.clientName) search.set("client_name", params.clientName);
  if (params?.severity) search.set("severity", params.severity);
  if (params?.statusInternal) search.set("status_internal", params.statusInternal);
  if (typeof params?.acknowledged === "boolean") search.set("acknowledged", String(params.acknowledged));
  if (params?.host) search.set("host", params.host);
  if (params?.service) search.set("service", params.service);
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.offset) search.set("offset", String(params.offset));

  const query = search.toString();
  return fetchApi<AlertListResponse>(`/oneview/alerts${query ? `?${query}` : ""}`);
}

export async function fetchAlert(id: string): Promise<OneViewAlert> {
  if (isSnapshotMode) {
    const alert = demoAlerts.find((item) => item.id === id || item.source_event_id === id);
    if (!alert) throw new Error(`Alerta não encontrado no snapshot OneView: ${id}`);
    return alert;
  }

  const response = await fetchAlerts({ limit: 5000 });
  const alert = response.items.find((item) => item.id === id || item.source_event_id === id);
  if (!alert) throw new Error(`Alerta não encontrado na visualização atual do OneView: ${id}`);
  return alert;
}

export async function fetchAlertMetrics(): Promise<AlertMetrics> {
  if (isSnapshotMode) return { ...demoAlertMetrics, ...snapshotMeta() };
  return fetchApi<AlertMetrics>("/oneview/dashboard-summary");
}

export async function addAlertNote(id: string, message: string, operatorName = "oneview-ui"): Promise<AlertNoteResult> {
  if (isSnapshotMode || isReadOnlyMode) throw new Error(readOnlyMessage("notas reais"));
  return fetchApi<AlertNoteResult>(`/alerts/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ message, operator_name: operatorName }),
  });
}

export async function assignAlert(id: string, operatorName = "oneview-ui"): Promise<AlertAssignmentResult> {
  if (isSnapshotMode || isReadOnlyMode) throw new Error(readOnlyMessage("atribuições reais"));
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
  if (isSnapshotMode || isReadOnlyMode) throw new Error(readOnlyMessage("ACK real"));
  return fetchApi<AlertStatusResult>(`/alerts/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status, message, operator_name: operatorName }),
  });
}

export async function fetchAllAlerts(params?: Omit<FetchAlertsParams, "limit" | "offset">): Promise<AlertListResponse> {
  if (isSnapshotMode) return fetchAlerts(params);
  return fetchAlerts({ ...params, limit: 5000, offset: 0 });
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
    case "warning":
      return "Average";
    default:
      return "Info";
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
    case "Info":
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
    host: alert.host_name || "-",
    problem: alert.problem_name,
    operationalData: alert.payload_normalized?.opdata || "",
    duration: formatDurationSeconds(alert.duration_seconds),
    status,
    tags: (alert.payload_normalized?.tags || [])
      .map((tag) => `${tag.tag ?? ""}: ${tag.value ?? ""}`.trim())
      .filter(Boolean),
    clientId: alert.data_source_id,
    clientName: alert.client_name,
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
