import { Alert, Client, Severity } from "@/types";
import { isSsoEnvironmentReady, loginRequest, msalInstance } from "@/lib/auth/msal";
import { isSnapshotMode } from "@/lib/demo-mode";
import { SNAPSHOT_TOTAL_ALERTS, demoAlertMetrics, demoAlerts, demoDataSources } from "@/lib/demo-oneview-data";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "/api");

async function authHeaders(): Promise<Record<string, string>> {
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
    headers: {
      "Content-Type": "application/json",
      ...authorization,
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorText || response.statusText}`);
  }

  return response.json();
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

export interface AlertListResponse {
  items: OneViewAlert[];
  total: number;
}

export interface AlertMetrics {
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

export async function fetchDataSources(): Promise<DataSource[]> {
  if (isSnapshotMode) return demoDataSources.map((source) => ({ ...source }));
  return fetchApi<DataSource[]>("/data-sources");
}

export async function requestDataSourceSync(id: string, reason = "manual_ui"): Promise<OutboxResult> {
  if (isSnapshotMode) {
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
    return { items: items.slice(offset, offset + limit), total };
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
  return fetchApi<AlertListResponse>(`/alerts${query ? `?${query}` : ""}`);
}

export async function fetchAlert(id: string): Promise<OneViewAlert> {
  if (isSnapshotMode) {
    const alert = demoAlerts.find((item) => item.id === id || item.source_event_id === id);
    if (!alert) throw new Error(`Alerta não encontrado no snapshot OneView: ${id}`);
    return alert;
  }
  return fetchApi<OneViewAlert>(`/alerts/${id}`);
}

export async function fetchAlertMetrics(): Promise<AlertMetrics> {
  if (isSnapshotMode) return demoAlertMetrics;
  return fetchApi<AlertMetrics>("/alerts/metrics");
}

export async function addAlertNote(id: string, message: string, operatorName = "oneview-ui"): Promise<AlertNoteResult> {
  if (isSnapshotMode) throw new Error("Modo leitura por snapshot real: notas reais estão desabilitadas.");
  return fetchApi<AlertNoteResult>(`/alerts/${id}/notes`, {
    method: "POST",
    body: JSON.stringify({ message, operator_name: operatorName }),
  });
}

export async function assignAlert(id: string, operatorName = "oneview-ui"): Promise<AlertAssignmentResult> {
  if (isSnapshotMode) throw new Error("Modo leitura por snapshot real: atribuições reais estão desabilitadas.");
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
  if (isSnapshotMode) throw new Error("Modo leitura por snapshot real: ACK real está desabilitado e não foi executado.");
  return fetchApi<AlertStatusResult>(`/alerts/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status, message, operator_name: operatorName }),
  });
}

export async function fetchAllAlerts(params?: Omit<FetchAlertsParams, "limit" | "offset">): Promise<AlertListResponse> {
  if (isSnapshotMode) return fetchAlerts(params);

  const pageSize = 500;
  const firstPage = await fetchAlerts({ ...params, limit: pageSize, offset: 0 });
  const items = [...firstPage.items];

  for (let offset = pageSize; offset < firstPage.total; offset += pageSize) {
    const page = await fetchAlerts({ ...params, limit: pageSize, offset });
    items.push(...page.items);
  }

  return { items, total: firstPage.total };
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
