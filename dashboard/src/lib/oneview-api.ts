import { Alert, Client, Severity } from "@/types";
import { isSsoEnvironmentReady, loginRequest, msalInstance } from "@/lib/auth/msal";
import { isReadOnlyMode } from "@/lib/demo-mode";
import { serverAuthEnabled } from "@/lib/server-auth";
import { canonicalClientName, canonicalHostName } from "@/components/oneview/ClientIdentity";

const API_BASE_URL = "/api";
/** OV-P0-279: same BFF read shares an in-flight promise and a brief route cache. */
export const ONEVIEW_READ_CACHE_TTL_MS = 8_000;
const READ_CACHE_TTL_MS = ONEVIEW_READ_CACHE_TTL_MS;
const READ_CACHE_STALE_TTL_MS = 5 * 60_000;
const INCIDENT_DETAIL_TTL_MS = 60_000;
const SERVICENOW_ACTION_RESOURCE_TTL_MS = 60_000;
const INCIDENT_RELATED_ALERT_TTL_MS = 15_000;
type CachedRead<T = unknown> = { value: T; freshUntil: number; expiresAt: number };
const readCache = new Map<string, CachedRead>();
const inFlightReads = new Map<string, Promise<unknown>>();
const incidentDetailCache = new Map<string, { value: unknown; expiresAt: number }>();
const incidentDetailInFlight = new Map<string, Promise<unknown>>();
const operatorReminderCache = new Map<string, { items: unknown[]; expiresAt: number }>();
const operatorReminderInFlight = new Map<string, Promise<unknown>>();
const operatorReminderGeneration = new Map<string, number>();
const serviceNowActionResourceCache = new Map<string, { value: unknown; expiresAt: number }>();
const serviceNowActionResourceInFlight = new Map<string, Promise<unknown>>();
const incidentRelatedAlertCache = new Map<string, { value: unknown; expiresAt: number }>();
const incidentRelatedAlertInFlight = new Map<string, Promise<unknown>>();
export function oneViewReadCacheKey(path: string, init?: RequestInit) {
  return `${path}|${String(init?.method || "GET").toUpperCase()}`;
}
export function clearOneViewReadCache() { readCache.clear(); inFlightReads.clear(); }
export function invalidateOneViewReadCache(pathPrefix?: string) {
  if (!pathPrefix) {
    clearOneViewReadCache();
    return;
  }
  const prefix = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  for (const key of [...readCache.keys()]) {
    if (key.startsWith(`${prefix}|`) || key.startsWith(`${prefix}?`)) readCache.delete(key);
  }
}
export function canShareOneViewRead(init?: RequestInit) {
  return (!init?.method || init.method.toUpperCase() === "GET") && !init?.signal;
}

export function bucketOneViewReadNow(now = Date.now()) {
  return Math.floor(now / READ_CACHE_TTL_MS) * READ_CACHE_TTL_MS;
}

export function peekOneViewReadCache<T>(path: string, init?: RequestInit): T | null {
  if (!path) return null;
  const cached = readCache.get(oneViewReadCacheKey(path, init));
  if (!cached || cached.freshUntil <= Date.now()) return null;
  return cached.value as T;
}

function cacheReadValue<T>(key: string, value: T) {
  const now = Date.now();
  readCache.set(key, { value, freshUntil: now + READ_CACHE_TTL_MS, expiresAt: now + READ_CACHE_STALE_TTL_MS });
}

function shouldInvalidateReadCache(path: string, method?: string) {
  const verb = String(method || "GET").toUpperCase();
  return verb !== "GET" && path.startsWith("/oneview/");
}

async function authHeaders(): Promise<Record<string, string>> {
  if (serverAuthEnabled()) {
    // HttpOnly OneView session cookie is sent by fetch(credentials: include).
    return {};
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

export class OneViewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Readonly<Record<string, string | boolean>>,
  ) {
    super(message);
    this.name = "OneViewApiError";
  }
}

export type ClientShareMessage = {
  client_key: string;
  client_name: string;
  severity: string;
  host: string;
  equipment?: string | null;
  equipment_ip?: string | null;
  problem: string;
  started_at: string;
  status: string;
  action?: string | null;
  next_steps?: string | null;
  follow_up?: string | null;
  incident_number?: string | null;
  incident_state?: string | null;
  servicenow_url?: string | null;
  oneview_url?: string | null;
  message_type: "alert" | "resolved";
  route_key?: string | null;
  snapshot?: Record<string, unknown> | null;
};

export type ClientShareChannel = "teams" | "webex";

export type ClientShareDestination = {
  client_key: string;
  route_key: string;
  route_label: string;
  destination_id: string;
  destination_name: string;
  channel_type: ClientShareChannel;
  enabled: boolean;
  is_default: boolean;
};

export type ClientShareResolution = {
  selection: "auto" | "preselected" | "explicit" | "required" | "none";
  selected_destination_id: string | null;
  requires_selection: boolean;
  reason: "single_destination" | "route_key" | "destination_id" | "unknown_route" | "ambiguous_route" | "multiple_destinations" | "no_destination";
};

export type ClientShareDestinationList = {
  destinations: ClientShareDestination[];
  resolution: ClientShareResolution;
  external_enabled: boolean;
  live_send?: boolean;
};

export type ClientSharePreview = {
  message: ClientShareMessage;
  destinations: ClientShareDestination[];
  resolution: ClientShareResolution;
  destination: ClientShareDestination | null;
  preview: { text: string; destination_id: string | null; destinations: { teams: boolean; webex: boolean } };
  external_enabled: boolean;
  live_send?: boolean;
};

export type ClientShareDelivery = {
  transport?: string;
  strategy?: string | null;
  status?: string;
  destination_id?: string | null;
  external_called?: boolean;
  http_status?: number | null;
  ambiguous?: boolean;
};

export async function fetchClientShareDestinations(clientKey: string, routeKey?: string | null, signal?: AbortSignal): Promise<ClientShareDestinationList> {
  const search = new URLSearchParams({ client_key: clientKey });
  if (routeKey) search.set("route_key", routeKey);
  return fetchApi(`/oneview/client-sharing/destinations?${search.toString()}`, { signal });
}

export async function fetchClientSharePreview(message: ClientShareMessage, signal?: AbortSignal): Promise<ClientSharePreview> {
  return fetchApi("/oneview/client-sharing/preview", { method: "POST", body: JSON.stringify({ message }), signal });
}

export async function sendClientShare(message: ClientShareMessage, idempotencyKey: string, destinationId: string): Promise<{
  dry_run: boolean;
  live_send?: boolean;
  duplicate?: boolean;
  deliveries?: ClientShareDelivery[];
}> {
  return fetchApi("/oneview/client-sharing/send", {
    method: "POST",
    body: JSON.stringify({ message, idempotency_key: idempotencyKey, destination_id: destinationId }),
  });
}

type OneViewFetchInit = RequestInit & { oneViewFresh?: boolean };

async function fetchApi<T>(path: string, init?: OneViewFetchInit): Promise<T> {
  const { oneViewFresh = false, ...requestInit } = init || {};
  const method = String(init?.method || "GET").toUpperCase();
  const isRead = method === "GET";
  // Only signal-free reads enter `inFlightReads`; a screen can safely reuse
  // that prefetch without inheriting its own AbortSignal.
  const canShare = !oneViewFresh && canShareOneViewRead(init);
  const key = oneViewReadCacheKey(path, init);
  const cached = isRead && !oneViewFresh ? readCache.get(key) : undefined;
  const now = Date.now();
  if (cached && cached.freshUntil > now) return cached.value as T;
  const shared = canShare ? inFlightReads.get(key) : undefined;
  if (shared) {
    return shared as Promise<T>;
  }
  const request = (async () => {
  const authorization = await authHeaders();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...requestInit,
    cache: "no-store",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authorization,
        ...(requestInit.headers ?? {}),
    },
  });

  if (!response.ok) {
    let errorCode = "request_failed";
    let errorDetails: Record<string, string | boolean> | undefined;
    try {
      const errorBody = await response.json() as {
        error?: unknown;
        current_assignee_name?: unknown;
        requires_confirmation?: unknown;
      };
      if (typeof errorBody?.error === "string" && /^[a-z0-9_]+$/i.test(errorBody.error)) errorCode = errorBody.error;
      const currentAssignee = typeof errorBody?.current_assignee_name === "string"
        ? errorBody.current_assignee_name.trim().slice(0, 120)
        : "";
      if (currentAssignee || typeof errorBody?.requires_confirmation === "boolean") {
        errorDetails = {
          ...(currentAssignee ? { current_assignee_name: currentAssignee } : {}),
          ...(typeof errorBody?.requires_confirmation === "boolean" ? { requires_confirmation: errorBody.requires_confirmation } : {}),
        };
      }
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
      operator_event_access_denied: "Seu usuário Zabbix não possui acesso a este alerta.",
      operator_not_found_in_zabbix: "Seu usuário ainda não está habilitado para reconhecimento nesta origem.",
      source_event_not_found: "O evento não está mais disponível na origem.",
      source_event_resolved: "O alerta já foi resolvido na origem.",
      source_already_acknowledged: "O alerta já foi reconhecido na origem.",
      source_ack_access_unavailable: "Não foi possível validar o acesso no Zabbix.",
      alert_already_recognized: "Este alerta já foi reconhecido no OneView.",
      source_acknowledge_not_implemented: "Reconhecimento no Zabbix ainda não está disponível.",
      invalid_source_event_id: "Event ID inválido para reconhecimento no Zabbix.",
      source_acknowledge_unconfirmed: "Não foi possível confirmar o reconhecimento no Zabbix.",
      invalid_comment: "O comentário deve possuir no máximo 500 caracteres.",
      actions_database_not_configured: "O canal seguro de solicitações ainda não está configurado.",
      authenticated_actions_disabled: "Seu usuário não possui permissão para solicitar esta ação.",
      servicenow_actions_disabled: "As solicitações ServiceNow ainda não estão habilitadas.",
      incident_not_found: "Chamado não encontrado.",
      incident_identity_conflict: "Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.",
      incident_number_mismatch: "O número do chamado não corresponde ao incidente selecionado.",
      invalid_target_group: "Selecione um grupo permitido.",
      invalid_work_note: "A nota deve ser texto simples, não vazio, com no máximo 2000 caracteres.",
      invalid_hold_reason: "Selecione um motivo de espera homologado.",
      action_not_found: "Solicitação operacional não encontrada.",
      SERVICENOW_CLAIM_DISABLED: "Ação de assumir chamado indisponível neste ambiente.",
      SERVICENOW_NOC_MEMBERSHIP_REQUIRED: "Seu usuário não pertence ao grupo N1 - Serviços - NOC no ServiceNow.",
      SERVICENOW_USER_NOT_FOUND: "Seu usuário não foi localizado no ServiceNow.",
      SERVICENOW_USER_AMBIGUOUS: "Seu usuário possui mais de um registro no ServiceNow.",
      SERVICENOW_USER_INACTIVE: "Seu usuário está inativo no ServiceNow.",
      SERVICENOW_UNAVAILABLE: "ServiceNow indisponível temporariamente.",
      INCIDENT_ASSIGNED_TO_OTHER: "Este chamado já possui outro responsável.",
      INVALID_CLAIM_REQUEST: "Solicitação para assumir chamado inválida.",
      INCIDENT_NOT_FOUND: "Chamado não encontrado no ServiceNow.",
      INCIDENT_IDENTITY_CONFLICT: "Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.",
      INVALID_WORK_NOTE: "A anotação deve ser um texto não vazio, com no máximo 2000 caracteres.",
      WORK_NOTE_RESULT_UNCERTAIN: "Não foi possível confirmar se a anotação foi registrada. Atualize o chamado antes de tentar novamente.",
      INVALID_PUT_ON_HOLD_REQUEST: "Selecione um fornecedor homologado para colocar o chamado em espera.",
      PUT_ON_HOLD_STATE_NOT_ALLOWED: "Somente chamados novos ou em andamento podem ser colocados em espera.",
      PUT_ON_HOLD_RESULT_UNCERTAIN: "Não foi possível confirmar se o chamado entrou em espera. Atualize o chamado antes de tentar novamente.",
    };
    throw new OneViewApiError(
      messages[errorCode] || `Não foi possível consultar o OneView (${response.status}).`,
      response.status,
      errorCode,
      errorDetails,
    );
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
  })();
  if (canShare) inFlightReads.set(key, request);
  try {
    const value = await request;
    if (isRead && !oneViewFresh) cacheReadValue(key, value);
    else if (shouldInvalidateReadCache(path, method)) {
      const root = path.split("?")[0];
      const base = root.replace(/\/[0-9a-f-]{8,}.*$/i, "").replace(/\/[^/]+$/, "") || "/oneview";
      invalidateOneViewReadCache(base);
      if (path.includes("/incidents")) {
        incidentDetailCache.clear();
        incidentDetailInFlight.clear();
      }
      if (path.includes("/reminders")) {
        operatorReminderCache.clear();
        operatorReminderInFlight.clear();
        operatorReminderGeneration.clear();
      }
    }
    return value;
  } catch (cause) {
    throw cause;
  } finally { if (canShare) inFlightReads.delete(key); }
}

export function isOneViewAbortError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const name = "name" in cause ? String((cause as { name?: unknown }).name || "") : "";
  if (name === "AbortError") return true;
  const message = "message" in cause ? String((cause as { message?: unknown }).message || "") : "";
  return /aborted|AbortError/i.test(message);
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

export interface AcknowledgeAlertInput {
  alertId: string;
  sourceEventId: string;
  comment?: string;
  /** One key per confirmation; without it the BFF dedupes by alert+actor+comment and a retry replays the failed attempt. */
  idempotencyKey?: string;
}

export interface AcknowledgeAlertResponse {
  status: "pending" | "confirmed";
  alert_id: string;
  source_event_id?: string;
  acknowledged_source: boolean;
  request_id?: string;
  outbox_id?: string | null;
  idempotent?: boolean;
  message?: string;
  acknowledged_source_by?: string | null;
  acknowledged_source_at?: string | null;
  comment?: string | null;
}

export interface SourceAckAccessResponse {
  source_ack_supported: boolean;
  source_ack_available: boolean;
  actor_ack_access: true | false | "unknown";
  reason: string | null;
  pending: boolean;
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
  operator_link?: {
    id: string;
    circuit_key: string | null;
    resolution_status: "resolved" | "unresolved" | "ambiguous";
    data_source_id: string;
    source_host_id: string;
    source_trigger_id: string;
    service_name: string | null;
    carrier_name: string | null;
    link_type: string | null;
    member_key: string | null;
    uplink_key: string | null;
    site_name: string | null;
    operational_subject: OperationalSubject;
  } | null;
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
    sys_id: string | null;
    url: string | null;
    extra_count: number;
  } | null;
  /** Reconhecimento da origem (detail; listagem pode omitir). */
  source_ack?: {
    acknowledged: boolean;
    actor_name: string | null;
    acknowledged_at: string | null;
    comment: string | null;
    acknowledge_id: string | null;
    history_available: boolean;
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
  /** Estado do alerta, independente do ciclo da ação ACK OneView. */
  alert_status?: "active" | "resolved" | "cancelled" | "unknown";
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
  source_ack_status?: "pending" | "processing" | "failed" | "cancelled" | null;
  /** BFF allowlist. Absent or false means the ACK POST must not be offered. */
  source_ack_available?: boolean;
  source_ack_unavailable_reason?: string | null;
  source_ack_supported?: boolean;
  actor_ack_access?: true | false | "unknown";
  actor_ack_access_reason?: string | null;
  oneview_ack?: {
    status: "none" | "pending" | "processing" | "success" | "cancelled" | "failed";
    requested_at: string | null;
    processed_at: string | null;
    actor_name: string | null;
    reason: string | null;
    message: string | null;
  };
  suppressed: boolean;
  suppressed_until: string | null;
  maintenance_status: string | null;
  suppression?: {
    state: "active" | "expired" | "none" | "unavailable";
    confirmation?: "confirmed" | "unconfirmed";
    explicit_unconfirmed?: boolean;
    origin: "maintenance" | "manual" | "unspecified" | null;
    maintenance_id: string | null;
    user_id: string | null;
    started_at?: string | null;
    suppress_until: string | null;
    suppress_until_kind?: "finite" | "indefinite" | "unknown" | "unsupported" | null;
    remaining_seconds?: number | null;
    evidence: "problem_get" | "column" | "conflict" | "unavailable";
  };
  operational_queue?: "pending" | "acknowledged" | "suppressed" | "history" | "unconfirmed";
  recovery_evidence?: "proven" | "legacy" | null;
  first_seen_at: string;
  started_at?: string;
  last_seen_at: string;
  resolved_at: string | null;
  source_recovery_event_id: string | null;
  datasource_last_success_at?: string | null;
  datasource_sync_state?: "fresh" | "stale" | "failed" | "unknown";
  duration_seconds: number | null;
  last_reopened_at?: string | null;
  ack_history_first_at?: string | null;
  /** Proven recovery minus the current episode start. Null while the problem is open. */
  recovery_duration_seconds?: number | null;
  /** First confirmed source ACK minus the current episode start. Null without a history clock. */
  time_to_ack_seconds?: number | null;
  temporal_integrity?: "source_clock_inconsistent" | null;
  created_at: string;
  updated_at: string;
  /** OV-P0-87 — read model de recorrência (detail). */
  recurrence_count_24h?: number;
  recurrence_count_7d?: number;
  previous_occurrence_at?: string | null;
  previous_recovery_at?: string | null;
  is_recurrent?: boolean;
  total_recent_episodes?: number;
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
    /** Active + origin-unacked. Resolved never counts. */
    operational_pending: number;
    /** oneview_ack.status in pending/processing only. */
    oneview_ack_pending: number;
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
  operational_queues?: {
    pending: number;
    acknowledged: number;
    suppressed: number;
    history: number;
    unconfirmed: number;
  };
  origin_sync?: Array<{
    datasource_name: string;
    state: "fresh" | "stale" | "failed" | "unknown";
    stale: boolean;
    last_success_at: string | null;
  }>;
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
    source_acknowledgement?: boolean;
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
export type RuntimeHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "DOWN"
  | "STALE"
  | "READY_DISABLED"
  | "CONFIG_MISSING"
  | "UNKNOWN";

export interface RuntimeHealthDimension {
  status: RuntimeHealthStatus;
  checked_at?: string | null;
  evidence_at?: string | null;
  detail?: string | null;
  cause?: string | null;
}

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
  badge?: string | null;
  badge_label?: string | null;
  cause?: string | null;
  recommended_action?: string | null;
  dimensions?: Record<string, RuntimeHealthDimension> | null;
  last_source_event_at?: string | null;
  last_db_event_at?: string | null;
  last_successful_sync_at?: string | null;
  source_db_lag_seconds?: number | null;
  active_truth?: Record<string, number | null> | null;
  metrics?: Record<string, unknown> | null;
  warning?: string | null;
  checked_at?: string | null;
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
  operationalView?: "pending" | "acknowledged" | "suppressed" | "history" | "unconfirmed";
  incidentState?: string;
  incidentStates?: string[];
  incidentNumber?: string;
  acknowledged?: boolean;
  acknowledgedSource?: boolean;
  acknowledgedInternal?: boolean;
  oneviewAckStatus?: "pending" | "success" | "cancelled" | "failed";
  oneviewAckStatuses?: Array<"pending" | "processing" | "success" | "cancelled" | "failed">;
  /** Nominal source-ACK actor/operator. */
  ackActor?: string;
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
  /** Home-only queue isolation; `/alertas` never sets it. */
  excludeOperator?: boolean;
  /** Comma list: items, summary, temporal. Omitted = all three. */
  include?: string;
  signal?: AbortSignal;
}

export function oneViewAlertsPath(params?: FetchAlertsParams): string {
  const search = new URLSearchParams();
  search.set("page", String(params?.page ?? 1));
  search.set("page_size", String(params?.pageSize ?? 50));
  for (const client of params?.clients ?? []) search.append("client", client);
  for (const customer of params?.customers ?? []) search.append("customer", customer);
  for (const datasource of params?.datasources ?? []) search.append("datasource", datasource);
  for (const confidence of params?.customerConfidences ?? []) search.append("customer_confidence", confidence);
  for (const severity of canonicalizeSeveritiesForApi(params?.severities ?? [])) search.append("severity", severity);
  if (params?.status) search.set("status", params.status);
  if (params?.operationalView) search.set("operational_view", params.operationalView);
  if (params?.incidentStates?.length) for (const value of params.incidentStates) search.append("incident_state", value);
  else if (params?.incidentState) search.set("incident_state", params.incidentState);
  if (params?.incidentNumber?.trim()) search.set("incident_number", params.incidentNumber.trim().toUpperCase());
  if (typeof params?.acknowledged === "boolean") search.set("acknowledged", String(params.acknowledged));
  if (typeof params?.acknowledgedSource === "boolean") search.set("acknowledged_source", String(params.acknowledgedSource));
  if (typeof params?.acknowledgedInternal === "boolean") search.set("acknowledged_internal", String(params.acknowledgedInternal));
  if (params?.oneviewAckStatuses?.length) for (const value of params.oneviewAckStatuses) search.append("oneview_ack_status", value);
  else if (params?.oneviewAckStatus) search.set("oneview_ack_status", params.oneviewAckStatus);
  if (params?.ackActor?.trim()) search.set("ack_actor", params.ackActor.trim());
  if (params?.hostSearch?.trim()) search.set("host_search", params.hostSearch.trim());
  if (params?.problemSearch?.trim()) search.set("problem_search", params.problemSearch.trim());
  if (params?.search) search.set("search", params.search);
  if (params?.searchField && params.searchField !== "all") search.set("search_field", params.searchField);
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
  if (params?.excludeOperator) search.set("exclude_operator", "true");
  if (params?.include) search.set("include", params.include);
  const query = search.toString();
  return `/oneview/alerts${query ? `?${query}` : ""}`;
}

export async function fetchAlerts(params?: FetchAlertsParams): Promise<AlertListResponse> {
  return fetchApi<AlertListResponse>(oneViewAlertsPath(params), { signal: params?.signal });
}

export type AlertReadOptions = { fresh?: boolean };

/** `fresh` skips the 8s read cache and stores the server answer, so other readers stop seeing the pre-ACK copy. */
export async function fetchAlert(id: string, signal?: AbortSignal, options?: AlertReadOptions): Promise<AlertDetailResponse> {
  const path = `/oneview/alerts/${encodeURIComponent(id)}`;
  if (options?.fresh) invalidateOneViewReadCache(path);
  return fetchApi<AlertDetailResponse>(path, { signal });
}

export async function fetchAlertHistory(id: string, signal?: AbortSignal, options?: AlertReadOptions): Promise<AlertHistoryResponse> {
  const path = `/oneview/alerts/${encodeURIComponent(id)}/history`;
  if (options?.fresh) invalidateOneViewReadCache(path);
  return fetchApi<AlertHistoryResponse>(path, { signal });
}

/** List, detail and history of one alert. The generic post-mutation invalidation only reaches one of them. */
export function invalidateAlertReadCache(alertId: string) {
  const path = `/oneview/alerts/${encodeURIComponent(alertId)}`;
  invalidateOneViewReadCache("/oneview/alerts");
  invalidateOneViewReadCache(path);
  invalidateOneViewReadCache(`${path}/history`);
}

export async function fetchGlobalHistory(params?: {
  page?: number;
  pageSize?: number;
  customers?: string[];
  datasources?: string[];
  eventType?: string;
  actor?: string;
  actors?: string[];
  search?: string;
  hostSearch?: string;
  problemSearch?: string;
  commentSearch?: string;
  severities?: string[];
  occurredFrom?: string;
  occurredTo?: string;
  sort?: "occurred" | "client" | "host" | "problem" | "actor" | "description" | "severity";
  order?: "asc" | "desc";
  signal?: AbortSignal;
}): Promise<GlobalHistoryResponse> {
  const search = new URLSearchParams();
  search.set("page", String(Math.max(1, params?.page ?? 1)));
  search.set("page_size", String(Math.min(params?.pageSize ?? 50, 100)));
  for (const customer of params?.customers ?? []) search.append("customer", customer);
  for (const datasource of params?.datasources ?? []) search.append("datasource", datasource);
  if (params?.eventType && params.eventType !== "all") search.set("event_type", params.eventType);
  if (params?.actors?.length) for (const actor of params.actors) search.append("actor", actor);
  else if (params?.actor) search.set("actor", params.actor);
  if (params?.search) search.set("search", params.search);
  if (params?.hostSearch) search.set("host_search", params.hostSearch);
  if (params?.problemSearch) search.set("problem_search", params.problemSearch);
  if (params?.commentSearch) search.set("comment_search", params.commentSearch);
  for (const severity of params?.severities ?? []) search.append("severity", severity);
  if (params?.occurredFrom) search.set("occurred_from", params.occurredFrom);
  if (params?.occurredTo) search.set("occurred_to", params.occurredTo);
  if (params?.sort) search.set("sort", params.sort);
  if (params?.order) search.set("order", params.order);
  const query = search.toString();
  return fetchApi<GlobalHistoryResponse>(`/oneview/history${query ? `?${query}` : ""}`, { signal: params?.signal });
}

export type OneViewIncident = {
  sys_id: string | null;
  /** Read-model has more than one sys_id for this incident number. Never actionable. */
  identity_conflict?: boolean;
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
  open_duration_seconds?: number | null;
  sla_summary?: OneViewIncidentSlaSummary | null;
  slas?: OneViewIncidentSla[];
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

export type OneViewIncidentSlaSummary = {
  availability: "available" | "stale" | "disabled" | "missing";
  state: "on_track" | "paused" | "breached" | "completed" | "cancelled" | null;
  name: string | null;
  deadline_at: string | null;
  has_breached: boolean;
  stage: string | null;
  synced_at: string | null;
};

export type OneViewIncidentSla = OneViewIncidentSlaSummary & {
  sys_id: string | null;
  start_time: string | null;
  end_time: string | null;
  original_breach_time: string | null;
  time_left: string | null;
  business_time_left: string | null;
  percentage: number | null;
  business_percentage: number | null;
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
    companies?: string[];
    opened_from: string | null;
    opened_to: string | null;
    updated_from?: string | null;
    updated_to?: string | null;
    include_related_alert?: boolean;
    manual?: boolean;
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
  global_counts?: {
    total: number;
    open: number;
    in_progress: number;
    resolved: number;
    closed: number;
    unassigned: number;
    manual: number;
  } | null;
  /** Facets do universo acessível do read-model; filtros só restringem quando explícitos. */
  facets?: {
    callers?: IncidentCallerFacet[];
    assignees?: IncidentAssigneeFacet[];
    companies?: IncidentAssigneeFacet[];
    contact_types?: IncidentAssigneeFacet[];
    states?: IncidentAssigneeFacet[];
    priorities?: IncidentAssigneeFacet[];
    assignment_groups?: IncidentAssigneeFacet[];
  } | null;
  data_source?: OneViewDataSourceKind | string;
  checked_at?: string;
  freshness?: {
    last_success_at?: string | null;
    watermark_sys_updated_on?: string | null;
  };
};

export type FetchIncidentsParams = {
  page?: number;
  pageSize?: number;
  callerId?: string;
  contactType?: string;
  assignedTo?: string;
  assignedToIds?: string[];
  number?: string;
  numberSearch?: string;
  descriptionSearch?: string;
  sysId?: string;
  state?: string;
  states?: string[];
  priority?: string;
  priorities?: string[];
  company?: string;
  companies?: string[];
  openedFrom?: string;
  openedTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  includeRelatedAlert?: boolean;
  includeItems?: boolean;
  includeCounts?: boolean;
  includeGlobalCounts?: boolean;
  includeFacets?: boolean;
  manual?: boolean;
  origin?: "manual" | "automatic";
  unassigned?: boolean;
  assignmentGroup?: string;
  assignmentGroups?: string[];
  search?: string;
  hasAssignee?: boolean;
  includeUnassigned?: boolean;
  sort?: "updated" | "opened" | "number" | "client" | "description" | "state" | "priority" | "group" | "assignee";
  order?: "asc" | "desc";
  signal?: AbortSignal;
};

export function oneViewIncidentsPath(params?: FetchIncidentsParams): string {
  const search = new URLSearchParams();
  search.set("page", String(Math.max(1, params?.page ?? 1)));
  search.set("page_size", String(Math.min(Math.max(params?.pageSize ?? 25, 1), 100)));
  if (params?.callerId) search.set("caller_id", params.callerId);
  if (params?.contactType) search.set("contact_type", params.contactType);
  const assignedToIds = (params?.assignedToIds ?? []).map((value) => value.trim()).filter(Boolean);
  if (assignedToIds.length) for (const value of assignedToIds) search.append("assigned_to", value);
  else if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.number) search.set("number", params.number);
  if (params?.numberSearch) search.set("number_search", params.numberSearch);
  if (params?.descriptionSearch) search.set("description_search", params.descriptionSearch);
  if (params?.sysId) search.set("sys_id", params.sysId);
  const states = (params?.states ?? []).map((value) => value.trim()).filter(Boolean);
  if (states.length) for (const value of states) search.append("state", value);
  else if (params?.state) search.set("state", params.state);
  const priorities = (params?.priorities ?? []).map((value) => value.trim()).filter(Boolean);
  if (priorities.length) for (const value of priorities) search.append("priority", value);
  else if (params?.priority) search.set("priority", params.priority);
  const companies = (params?.companies ?? []).map((company) => company.trim()).filter(Boolean);
  if (companies.length) {
    for (const company of companies) search.append("company", company);
  } else if (params?.company) {
    search.set("company", params.company);
  }
  if (params?.openedFrom) search.set("opened_from", params.openedFrom);
  if (params?.openedTo) search.set("opened_to", params.openedTo);
  if (params?.updatedFrom) search.set("updated_from", params.updatedFrom);
  if (params?.updatedTo) search.set("updated_to", params.updatedTo);
  if (params?.includeRelatedAlert) search.set("include_related_alert", "true");
  if (params?.includeItems === false) search.set("include_items", "false");
  if (params?.includeCounts === false) search.set("include_counts", "false");
  if (params?.includeGlobalCounts === false) search.set("include_global_counts", "false");
  if (params?.includeFacets === false) search.set("include_facets", "false");
  if (params?.manual) search.set("manual", "true");
  if (params?.origin) search.set("origin", params.origin);
  if (params?.unassigned) search.set("unassigned", "true");
  if (params?.hasAssignee) search.set("has_assignee", "true");
  if (params?.includeUnassigned) search.set("include_unassigned", "true");
  const assignmentGroups = (params?.assignmentGroups ?? []).map((value) => value.trim()).filter(Boolean);
  if (assignmentGroups.length) for (const value of assignmentGroups) search.append("assignment_group", value);
  else if (params?.assignmentGroup) search.set("assignment_group", params.assignmentGroup);
  if (params?.search) search.set("search", params.search);
  if (params?.sort) search.set("sort", params.sort);
  if (params?.order) search.set("order", params.order);
  const query = search.toString();
  return `/oneview/incidents${query ? `?${query}` : ""}`;
}

export const DEFAULT_INCIDENTS_FETCH_PARAMS: FetchIncidentsParams = {
  page: 1,
  pageSize: 25,
  includeCounts: false,
  includeGlobalCounts: false,
  includeFacets: false,
};

export async function fetchIncidents(params?: FetchIncidentsParams): Promise<IncidentListResponse> {
  return fetchApi<IncidentListResponse>(oneViewIncidentsPath(params), { signal: params?.signal });
}

export type OneViewSearchSuggestionKind =
  | "number"
  | "company"
  | "description"
  | "host"
  | "problem"
  | "customer"
  | "actor"
  | "link"
  | "event";

export type OneViewSearchSuggestion = {
  kind: OneViewSearchSuggestionKind | string;
  value: string;
  label: string;
  /** Chave canÃ´nica somente para aplicar o filtro estruturado de Cliente. */
  customer_key?: string | null;
  number?: string | null;
  company?: string | null;
  hint?: string | null;
};

/** @deprecated use OneViewSearchSuggestion */
export type IncidentSearchSuggestionKind = "number" | "company" | "description";
/** @deprecated use OneViewSearchSuggestion */
export type IncidentSearchSuggestion = OneViewSearchSuggestion;

export type FetchIncidentSearchSuggestionsParams = Omit<
  FetchIncidentsParams,
  "page" | "pageSize" | "search" | "number" | "sysId" | "includeRelatedAlert"
> & {
  q: string;
  limit?: number;
};

export type IncidentSearchSuggestionsResponse = {
  suggestions: IncidentSearchSuggestion[];
  q?: string;
  data_source?: string;
  checked_at?: string;
};

function appendIncidentScopeQueryParams(search: URLSearchParams, params?: FetchIncidentsParams) {
  if (params?.callerId) search.set("caller_id", params.callerId);
  if (params?.contactType) search.set("contact_type", params.contactType);
  const assignedToIds = (params?.assignedToIds ?? []).map((value) => value.trim()).filter(Boolean);
  if (assignedToIds.length) for (const value of assignedToIds) search.append("assigned_to", value);
  else if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.sysId) search.set("sys_id", params.sysId);
  const states = (params?.states ?? []).map((value) => value.trim()).filter(Boolean);
  if (states.length) for (const value of states) search.append("state", value);
  else if (params?.state) search.set("state", params.state);
  const priorities = (params?.priorities ?? []).map((value) => value.trim()).filter(Boolean);
  if (priorities.length) for (const value of priorities) search.append("priority", value);
  else if (params?.priority) search.set("priority", params.priority);
  const companies = (params?.companies ?? []).map((company) => company.trim()).filter(Boolean);
  if (companies.length) {
    for (const company of companies) search.append("company", company);
  } else if (params?.company) {
    search.set("company", params.company);
  }
  if (params?.openedFrom) search.set("opened_from", params.openedFrom);
  if (params?.openedTo) search.set("opened_to", params.openedTo);
  if (params?.updatedFrom) search.set("updated_from", params.updatedFrom);
  if (params?.updatedTo) search.set("updated_to", params.updatedTo);
  if (params?.unassigned) search.set("unassigned", "true");
  if (params?.hasAssignee) search.set("has_assignee", "true");
  if (params?.includeUnassigned) search.set("include_unassigned", "true");
  const assignmentGroups = (params?.assignmentGroups ?? []).map((value) => value.trim()).filter(Boolean);
  if (assignmentGroups.length) for (const value of assignmentGroups) search.append("assignment_group", value);
  else if (params?.assignmentGroup) search.set("assignment_group", params.assignmentGroup);
  if (params?.manual) search.set("manual", "true");
  if (params?.origin) search.set("origin", params.origin);
}

export function oneViewIncidentSearchSuggestPath(params: FetchIncidentSearchSuggestionsParams): string {
  const search = new URLSearchParams();
  search.set("q", params.q.trim());
  if (params.limit != null) search.set("limit", String(Math.min(Math.max(params.limit, 1), 15)));
  appendIncidentScopeQueryParams(search, params);
  return `/oneview/incidents/search-suggest?${search.toString()}`;
}

export async function fetchIncidentSearchSuggestions(
  params: FetchIncidentSearchSuggestionsParams,
): Promise<IncidentSearchSuggestionsResponse> {
  return fetchApi<IncidentSearchSuggestionsResponse>(oneViewIncidentSearchSuggestPath(params), {
    signal: params.signal,
  });
}

function appendAlertScopeQueryParams(search: URLSearchParams, params?: FetchAlertsParams) {
  for (const client of params?.clients ?? []) search.append("client", client);
  for (const customer of params?.customers ?? []) search.append("customer", customer);
  for (const datasource of params?.datasources ?? []) search.append("datasource", datasource);
  for (const confidence of params?.customerConfidences ?? []) search.append("customer_confidence", confidence);
  for (const severity of canonicalizeSeveritiesForApi(params?.severities ?? [])) search.append("severity", severity);
  if (params?.status) search.set("status", params.status);
  if (params?.operationalView) search.set("operational_view", params.operationalView);
  if (params?.incidentStates?.length) for (const value of params.incidentStates) search.append("incident_state", value);
  else if (params?.incidentState) search.set("incident_state", params.incidentState);
  if (params?.incidentNumber?.trim()) search.set("incident_number", params.incidentNumber.trim().toUpperCase());
  if (typeof params?.acknowledged === "boolean") search.set("acknowledged", String(params.acknowledged));
  if (typeof params?.acknowledgedSource === "boolean") search.set("acknowledged_source", String(params.acknowledgedSource));
  if (typeof params?.acknowledgedInternal === "boolean") search.set("acknowledged_internal", String(params.acknowledgedInternal));
  if (params?.oneviewAckStatuses?.length) for (const value of params.oneviewAckStatuses) search.append("oneview_ack_status", value);
  else if (params?.oneviewAckStatus) search.set("oneview_ack_status", params.oneviewAckStatus);
  if (params?.ackActor?.trim()) search.set("ack_actor", params.ackActor.trim());
  if (params?.hostSearch?.trim()) search.set("host_search", params.hostSearch.trim());
  if (params?.problemSearch?.trim()) search.set("problem_search", params.problemSearch.trim());
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
  if (params?.recurrenceKey) search.set("recurrence_key", params.recurrenceKey);
  if (params?.excludeOperator) search.set("exclude_operator", "true");
}

export type FetchAlertSearchSuggestionsParams = Omit<
  FetchAlertsParams,
  "page" | "pageSize" | "search" | "searchField" | "hostSearch" | "problemSearch"
> & {
  q: string;
  limit?: number;
  kind?: "number" | "company" | "description" | "host";
  kind?: "customer" | "host" | "problem" | "actor" | "number";
};

export function oneViewAlertSearchSuggestPath(params: FetchAlertSearchSuggestionsParams): string {
  const search = new URLSearchParams();
  search.set("q", params.q.trim());
  if (params.limit != null) search.set("limit", String(Math.min(Math.max(params.limit, 1), 15)));
  if (params.kind) search.set("kind", params.kind);
  if (params.kind) search.set("kind", params.kind);
  appendAlertScopeQueryParams(search, params);
  return `/oneview/alerts/search-suggest?${search.toString()}`;
}

export async function fetchAlertSearchSuggestions(
  params: FetchAlertSearchSuggestionsParams,
): Promise<IncidentSearchSuggestionsResponse> {
  return fetchApi<IncidentSearchSuggestionsResponse>(oneViewAlertSearchSuggestPath(params), {
    signal: params.signal,
  });
}

export type FetchHistorySearchSuggestionsParams = {
  q: string;
  limit?: number;
  customers?: string[];
  datasources?: string[];
  eventType?: string;
  actors?: string[];
  hostSearch?: string;
  problemSearch?: string;
  commentSearch?: string;
  severities?: string[];
  occurredFrom?: string;
  occurredTo?: string;
  kind?: "host" | "problem" | "actor" | "description";
  signal?: AbortSignal;
};

export function oneViewHistorySearchSuggestPath(params: FetchHistorySearchSuggestionsParams): string {
  const search = new URLSearchParams();
  search.set("q", params.q.trim());
  if (params.limit != null) search.set("limit", String(Math.min(Math.max(params.limit, 1), 15)));
  for (const customer of params.customers ?? []) search.append("customer", customer);
  for (const datasource of params.datasources ?? []) search.append("datasource", datasource);
  if (params.eventType && params.eventType !== "all") search.set("event_type", params.eventType);
  for (const actor of params.actors ?? []) search.append("actor", actor);
  if (params.hostSearch) search.set("host_search", params.hostSearch);
  if (params.problemSearch) search.set("problem_search", params.problemSearch);
  if (params.commentSearch) search.set("comment_search", params.commentSearch);
  for (const severity of params.severities ?? []) search.append("severity", severity);
  if (params.occurredFrom) search.set("occurred_from", params.occurredFrom);
  if (params.occurredTo) search.set("occurred_to", params.occurredTo);
  if (params.kind) search.set("kind", params.kind);
  return `/oneview/history/search-suggest?${search.toString()}`;
}

export async function fetchHistorySearchSuggestions(
  params: FetchHistorySearchSuggestionsParams,
): Promise<IncidentSearchSuggestionsResponse> {
  return fetchApi<IncidentSearchSuggestionsResponse>(oneViewHistorySearchSuggestPath(params), {
    signal: params.signal,
  });
}

export type FetchLinkSearchSuggestionsParams = CanonicalLinksQuery & {
  q: string;
  limit?: number;
  kind?: "customer" | "host" | "link" | "number";
};

export function oneViewLinkSearchSuggestPath(params: FetchLinkSearchSuggestionsParams): string {
  const search = new URLSearchParams();
  search.set("q", params.q.trim());
  if (params.limit != null) search.set("limit", String(Math.min(Math.max(params.limit, 1), 15)));
  for (const [key, value] of Object.entries(params)) {
    if (key === "q" || key === "limit" || key === "signal") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== "" && item !== "all") search.append(key, item);
    } else if (value !== undefined && value !== "" && value !== "all") search.set(key, String(value));
  }
  return `/oneview/links/search-suggest?${search.toString()}`;
}

export async function fetchLinkSearchSuggestions(
  params: FetchLinkSearchSuggestionsParams,
): Promise<IncidentSearchSuggestionsResponse> {
  return fetchApi<IncidentSearchSuggestionsResponse>(oneViewLinkSearchSuggestPath(params), {
    signal: params.signal,
  });
}

/** OV-P0-262A — possible duplicate groups (Snow Notifier-compatible, read-only). */
export type DuplicateIncidentCard = {
  sysId: string | null;
  identityConflict?: boolean;
  number: string | null;
  shortDescription: string | null;
  customer: string | null;
  state: string | null;
  stateCode: string | null;
  priority: string | null;
  priorityCode: string | null;
  assignedTo: string | null;
  assignedToId: string | null;
  assignmentGroup: string | null; // BFF card field (assignment_group display)
  createdAt: string | null;
  updatedAt: string | null;
  relatedAlert: {
    alertId: string | null;
    severity: string | null;
    host: string | null;
    link: string | null;
    problem: string | null;
    status: string | null;
  } | null;
  servicenowUrl: string | null;
};

export type DuplicateIncidentGroup = {
  duplicateKey: string;
  duplicateCount: number;
  classification: "POSSIBLE_DUPLICATE";
  shortDescription: string | null;
  primaryIncident: DuplicateIncidentCard;
  relatedIncidents: DuplicateIncidentCard[];
};

export type IncidentDuplicatesResponse = {
  classification: "POSSIBLE_DUPLICATE";
  open_universe: {
    contact_type: string;
    state_not_in: string[];
  };
  groups: DuplicateIncidentGroup[];
  stats: {
    evaluated_incidents: number;
    duplicate_groups: number;
    incidents_in_duplicate_groups: number;
    largest_group: number;
    bff_ms: number;
  };
  data_source: string;
  checked_at: string;
  write_actions: {
    auto_close: false;
    parent_incident_mutation: false;
    servicenow_write: false;
  };
};

export async function fetchIncidentDuplicates(params?: {
  customer?: string;
  customers?: string[];
  assignedTo?: string;
  assignmentGroup?: string;
  priority?: string;
  state?: string;
  signal?: AbortSignal;
}): Promise<IncidentDuplicatesResponse> {
  const search = new URLSearchParams();
  const customers = (params?.customers ?? []).map((customer) => customer.trim()).filter(Boolean);
  if (customers.length) {
    for (const customer of customers) search.append("customer", customer);
  } else if (params?.customer) {
    search.set("customer", params.customer);
  }
  if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.assignmentGroup) search.set("assignment_group", params.assignmentGroup);
  if (params?.priority) search.set("priority", params.priority);
  if (params?.state) search.set("state", params.state);
  const query = search.toString();
  return fetchApi<IncidentDuplicatesResponse>(
    `/oneview/incidents/duplicates${query ? `?${query}` : ""}`,
    { signal: params?.signal },
  );
}

export type OperatorQueueTab = "all" | "unassigned" | "following" | "recent";

export type OperatorQueueItem = {
  alert_id: string | null;
  customer_name: string | null;
  customer_key: string | null;
  datasource_name: string | null;
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
    alert_status: "all" | "active" | "resolved";
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
    datasources: OperatorQueueFacet[];
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
  datasource?: string;
  assignedTo?: string;
  state?: string;
  severity?: string;
  alertStatus?: "all" | "active" | "resolved";
  firstSeenFrom?: string;
  firstSeenTo?: string;
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
  if (params?.datasource) search.set("datasource", params.datasource);
  if (params?.assignedTo) search.set("assigned_to", params.assignedTo);
  if (params?.state) search.set("state", params.state);
  if (params?.severity) search.set("severity", params.severity);
  if (params?.alertStatus && params.alertStatus !== "all") search.set("alert_status", params.alertStatus);
  if (params?.firstSeenFrom) search.set("first_seen_from", params.firstSeenFrom);
  if (params?.firstSeenTo) search.set("first_seen_to", params.firstSeenTo);
  return fetchApi<OperatorQueueResponse>(`/oneview/operator-queue?${search.toString()}`, {
    signal: params?.signal,
  });
}

export type ServiceNowIncidentAction =
  | "servicenow.assume_self"
  | "servicenow.assign_group"
  | "servicenow.work_note"
  | "servicenow.hold";

export type ServiceNowIncidentActionOptions = {
  enabled: boolean;
  actions: ServiceNowIncidentAction[];
  assignable_groups: string[];
  hold_reasons: string[];
};

export type ServiceNowIncidentActionStatus = {
  action_id: string;
  action: ServiceNowIncidentAction;
  status: "pending" | "processing" | "succeeded" | "failed";
  requested_at: string | null;
  processed_at: string | null;
  error_code: string | null;
  idempotent: boolean;
};

export type ServiceNowOperatorIdentity = {
  available: boolean;
  service_now_user?: { name: string; email: string };
  noc_member: boolean;
  error?: string;
};

export type ServiceNowIncidentClaimResponse = {
  success: true;
  already_assigned: boolean;
  incident: {
    incident_number: string | null;
    state: string | null;
    assigned_to_name: string | null;
    assignment_group_name: string | null;
    updated_on: string | null;
  };
};

export type ServiceNowWorkNoteResponse = {
  success: true;
  incident_number: string;
  result: "added";
};

export type ServiceNowAlertAttachmentResponse = {
  success: true;
  incident_number: string;
  file_name: string;
  result: "attached";
};

export type ServiceNowPutOnHoldOptions = {
  external_vendors: string[];
  vendor_source: string;
  hold_reason_label: string;
};

export type ServiceNowPutOnHoldResponse = {
  success: true;
  already_on_hold: boolean;
  incident: {
    incident_number: string | null;
    state: string | null;
    hold_reason: string | null;
    external_vendor: string | null;
    assigned_to_name: string | null;
    assignment_group_name: string | null;
    updated_on: string | null;
  };
};

async function fetchSharedServiceNowActionResource<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cached = serviceNowActionResourceCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  const pending = serviceNowActionResourceInFlight.get(path);
  if (pending) return pending as Promise<T>;

  // A requisição compartilhada não herda o AbortSignal de uma linha desmontada.
  const request = fetchApi<T>(path).then((value) => {
    serviceNowActionResourceCache.set(path, {
      value,
      expiresAt: Date.now() + SERVICENOW_ACTION_RESOURCE_TTL_MS,
    });
    return value;
  });
  serviceNowActionResourceInFlight.set(path, request);
  try {
    return await request;
  } finally {
    if (serviceNowActionResourceInFlight.get(path) === request) {
      serviceNowActionResourceInFlight.delete(path);
    }
  }
}

export async function fetchServiceNowPutOnHoldOptions(signal?: AbortSignal): Promise<ServiceNowPutOnHoldOptions> {
  return fetchSharedServiceNowActionResource<ServiceNowPutOnHoldOptions>(
    "/oneview/servicenow/put-on-hold-options",
    signal,
  );
}

export async function requestServiceNowIncidentPutOnHold({
  sysId,
  externalVendor,
}: {
  sysId: string;
  externalVendor: string;
}): Promise<ServiceNowPutOnHoldResponse> {
  return fetchApi<ServiceNowPutOnHoldResponse>(
    `/oneview/incidents/${encodeURIComponent(sysId)}/put-on-hold`,
    { method: "POST", body: JSON.stringify({ external_vendor: externalVendor }) },
  );
}

export async function fetchServiceNowOperatorIdentity(signal?: AbortSignal): Promise<ServiceNowOperatorIdentity> {
  return fetchSharedServiceNowActionResource<ServiceNowOperatorIdentity>("/oneview/servicenow/me", signal);
}

export async function requestServiceNowIncidentClaim({
  sysId,
  confirmReassign = false,
}: {
  sysId: string;
  confirmReassign?: boolean;
}): Promise<ServiceNowIncidentClaimResponse> {
  return fetchApi<ServiceNowIncidentClaimResponse>(
    `/oneview/incidents/${encodeURIComponent(sysId)}/claim`,
    { method: "POST", body: JSON.stringify({ confirm_reassign: confirmReassign }) },
  );
}

export async function requestServiceNowIncidentWorkNote({
  sysId,
  workNote,
}: {
  sysId: string;
  workNote: string;
}): Promise<ServiceNowWorkNoteResponse> {
  return fetchApi<ServiceNowWorkNoteResponse>(
    `/oneview/incidents/${encodeURIComponent(sysId)}/work-note`,
    { method: "POST", body: JSON.stringify({ work_note: workNote }) },
  );
}

export async function requestServiceNowIncidentAlertAttachment({
  sysId,
  fileName,
  pngBody,
}: {
  sysId: string;
  fileName: string;
  pngBody: Blob;
}): Promise<ServiceNowAlertAttachmentResponse> {
  const authorization = await authHeaders();
  const params = new URLSearchParams({ file_name: fileName });
  const response = await fetch(
    `${API_BASE_URL}/oneview/incidents/${encodeURIComponent(sysId)}/alert-attachment?${params.toString()}`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "image/png",
        ...authorization,
      },
      body: pngBody,
    },
  );
  if (!response.ok) {
    let errorCode = "request_failed";
    try {
      const errorBody = await response.json() as { error?: unknown };
      if (typeof errorBody?.error === "string" && /^[a-z0-9_]+$/i.test(errorBody.error)) errorCode = errorBody.error;
    } catch {
      // ignore
    }
    throw new OneViewApiError(
      errorCode === "ATTACHMENT_RESULT_UNCERTAIN"
        ? "Não foi possível confirmar o anexo. Verifique o chamado antes de tentar novamente."
        : "Não foi possível anexar os detalhes do alerta.",
      response.status,
      errorCode,
    );
  }
  return response.json() as Promise<ServiceNowAlertAttachmentResponse>;
}

export async function fetchServiceNowIncidentActionOptions(sysId: string, signal?: AbortSignal): Promise<ServiceNowIncidentActionOptions> {
  return fetchApi<ServiceNowIncidentActionOptions>(`/oneview/incidents/${encodeURIComponent(sysId)}/actions`, { signal });
}

export async function requestServiceNowIncidentAction({ sysId, incidentNumber, action, payload, idempotencyKey }: {
  sysId: string; incidentNumber: string; action: ServiceNowIncidentAction; payload: Record<string, string>; idempotencyKey: string;
}): Promise<ServiceNowIncidentActionStatus> {
  return fetchApi<ServiceNowIncidentActionStatus>(`/oneview/incidents/${encodeURIComponent(sysId)}/actions`, {
    method: "POST", body: JSON.stringify({ action, incident_number: incidentNumber, payload, idempotencyKey }),
  });
}

export async function fetchServiceNowIncidentActionStatus(sysId: string, actionId: string, signal?: AbortSignal): Promise<ServiceNowIncidentActionStatus> {
  return fetchApi<ServiceNowIncidentActionStatus>(`/oneview/incidents/${encodeURIComponent(sysId)}/actions?outbox_id=${encodeURIComponent(actionId)}`, { signal });
}

export type CanonicalLinkIncident = { sys_id: string | null; number: string | null; state: string | null; state_display?: string | null; priority?: string | null; priority_display?: string | null; assigned_to: string | null; assigned_to_display?: string | null; assignment_group: string | null; assignment_group_display?: string | null; opened_at?: string | null; updated_at?: string | null; short_description?: string | null; servicenow_url?: string | null; };
export type CanonicalLinkAlert = { id: string; data_source_id?: string | null; source_host_id?: string | null; source_trigger_id?: string | null; problem_name: string | null; trigger_description?: string | null; severity: OneViewSeverity | null; started_at?: string | null; last_seen_at?: string | null; };
export type OperationalSubject = {
  subject_type: "circuit" | "alert_subject";
  subject_key: string;
  circuit_key: string | null;
  data_source_id: string;
  source_host_id: string | null;
  source_trigger_id: string | null;
  fallback_subject_keys?: string[];
};
const incidentDetailCacheTyped = incidentDetailCache as Map<string, { value: OneViewIncident; expiresAt: number }>;
const incidentDetailInFlightTyped = incidentDetailInFlight as Map<string, Promise<OneViewIncident>>;

export function clearIncidentDetailCache() {
  incidentDetailCacheTyped.clear();
  incidentDetailInFlightTyped.clear();
}

export function clearOneViewSessionCaches() {
  clearOneViewReadCache();
  clearIncidentDetailCache();
  clearOperatorReminderCache();
  serviceNowActionResourceCache.clear();
  serviceNowActionResourceInFlight.clear();
  incidentRelatedAlertCache.clear();
  incidentRelatedAlertInFlight.clear();
}

export async function fetchIncidentDetail(sysId: string): Promise<OneViewIncident> {
  const key = String(sysId || "").trim().toLowerCase();
  const cached = incidentDetailCacheTyped.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = incidentDetailInFlightTyped.get(key);
  if (pending) return pending;
  const request = fetchApi<{ item: OneViewIncident }>(`/oneview/incidents/detail/${encodeURIComponent(key)}`)
    .then(({ item }) => {
      incidentDetailCacheTyped.set(key, { value: item, expiresAt: Date.now() + INCIDENT_DETAIL_TTL_MS });
      return item;
    });
  incidentDetailInFlightTyped.set(key, request);
  try {
    return await request;
  } finally {
    incidentDetailInFlightTyped.delete(key);
  }
}

export type CanonicalLink = {
  id: string;
  circuit_key: string | null;
  resolution_status: "resolved" | "unresolved" | "ambiguous";
  data_source_id: string;
  datasource: string;
  source_host_id: string;
  host_name: string | null;
  customer_key: string;
  customer_name: string;
  service_name: string;
  classification: string;
  classification_source: string;
  classification_confidence: string;
  site_key: string | null;
  site_name: string | null;
  link_type: string | null;
  member_key: string | null;
  healthcheck_key: string | null;
  uplink_key: string | null;
  endpoint_ip: string | null;
  carrier_name: string | null;
  carrier_source: string | null;
  carrier_reference: string | null;
  carrier_status?: "identified" | "unknown" | "not_applicable";
  operator_escalation?: boolean;
  strategy: string;
  confidence: string | null;
  trigger_ids: string[];
  alert_ids: string[];
  source_metadata: {
    classification_evidence?: { type?: string; group_name?: string };
    circuit_evidence?: Record<string, unknown>;
    unresolved_reason?: string | null;
    host_name?: string;
  } | null;
  updated_at: string | null;
  active_since_at?: string | null;
  latest_activity_at?: string | null;
  resolved_at?: string | null;
  alert_started_at?: string | null;
  latest_alert_at?: string | null;
  active_alerts: number;
  unack_alerts: number;
  high_alerts: number;
  disaster_alerts: number;
  average_alerts: number;
  warning_alerts: number;
  state: "critical" | "alert" | "attention" | "normal";
  max_severity: OneViewSeverity | null;
  incident_count: number | null;
  incident_correlation_status?: "available" | "degraded";
  open_incident_count?: number | null;
  resolved_incident_count?: number | null;
  closed_incident_count?: number | null;
  cancelled_incident_count?: number | null;
  unknown_incident_count?: number | null;
  has_active_alert?: boolean;
  monitoring_state?: "down" | "normalized";
  servicenow_state?: "none" | "open" | "resolved" | "closed" | "cancelled" | "unknown" | "degraded";
  resolved_recent?: boolean;
  divergence_type?: "a" | "b" | null;
  operational_situation?: "failure_without_incident" | "failure_with_open_incident" | "failure_with_closed_incident" | "normalized_with_open_incident" | "normalized_without_open_incident" | null;
  last_operational_activity_at?: string | null;
  current_alert?: CanonicalLinkAlert | null;
  latest_alert?: CanonicalLinkAlert | null;
  current_incident?: CanonicalLinkIncident | null;
  latest_incident?: CanonicalLinkIncident | null;
  operational_subject?: OperationalSubject | null;
  occurrences_24h?: number;
  occurrences_7d?: number;
  last_failure_at?: string | null;
  last_recovery_at?: string | null;
  is_recurrent?: boolean;
};
export type CanonicalLinkDetail = CanonicalLink & { active_alerts_detail: CanonicalLinkAlert[]; incident_history: CanonicalLinkIncident[]; recent_episodes?: Array<{ started_at: string | null; resolved_at: string | null; active: boolean; duration_seconds: number | null; incident_number: string | null; incident_sys_id: string | null; incident_state: string | null; source_trigger_ids: string[]; alert_titles: string[]; severities: string[] }>; technical: { circuit_key: string | null; resolution_status: CanonicalLink["resolution_status"]; source: string; host_name: string | null; source_host_id: string; trigger_ids: string[]; member_key: string | null; uplink_key: string | null; healthcheck_key: string | null; endpoint_ip: string | null; confidence: string | null; strategy: string; }; integration_status: { servicenow: "available" | "degraded" }; };
export type CanonicalLinksResponse = OneViewResponseMeta & { items: CanonicalLink[]; recent_severe?: CanonicalLink[]; recent_disasters?: CanonicalLink[]; pagination: AlertPagination; totals: { links: number; active_alert_links: number; incident_links: number | null; known_carriers: number; pending_classification: number; operational: { open: number; normalized?: number; without_incident?: number; without_open_incident: number; with_open_incident: number; recurrent?: number; divergences: number; divergence_a: number; divergence_b: number; resolved_today: number } }; integration_status?: { servicenow: "available" | "degraded" }; facets: { customers: OperatorQueueFacet[]; datasources: OperatorQueueFacet[]; classifications: OperatorQueueFacet[]; carriers: OperatorQueueFacet[] } };
export type CanonicalLinksQuery = Record<string, string | number | string[] | AbortSignal | undefined> & { signal?: AbortSignal };
export const DEFAULT_CANONICAL_LINKS_QUERY = {
  tab: "open",
  resolved_window: "today",
  sort: "recent",
  page: 1,
  page_size: 50,
} as const;

export function oneViewLinksPath(params?: CanonicalLinksQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (key === "signal" || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== "" && item !== "all") search.append(key, item);
    } else if (value !== "" && value !== "all") search.set(key, String(value));
  }
  if (!search.has("page")) search.set("page", "1"); if (!search.has("page_size")) search.set("page_size", "50");
  return `/oneview/links?${search}`;
}

export async function fetchCanonicalLinks(params?: CanonicalLinksQuery): Promise<CanonicalLinksResponse> {
  return fetchApi<CanonicalLinksResponse>(oneViewLinksPath(params), { signal: params?.signal });
}
export async function fetchCanonicalLinkDetail(link: Pick<CanonicalLink, "id" | "data_source_id" | "source_host_id">, signal?: AbortSignal): Promise<CanonicalLinkDetail> {
  const query = new URLSearchParams({ data_source_id: link.data_source_id, source_host_id: link.source_host_id });
  return fetchApi<CanonicalLinkDetail>(`/oneview/links/${encodeURIComponent(link.id)}?${query.toString()}`, { signal });
}

/** SN-P0-08 — lookup read-only alerta ↔ incidente via zabbix_event_id. */
export type OperatorReminder = {
  id: string;
  subject_type: "circuit" | "alert_subject";
  subject_key: string | null;
  circuit_key: string | null;
  data_source_id: string;
  source_host_id: string | null;
  source_trigger_id: string | null;
  scheduled_for: string;
  status: "scheduled" | "processing" | "sent" | "cancelled" | "skipped" | "failed";
  created_by: string;
  created_by_name: string;
  initial_alert_id: string | null;
  initial_incident_sys_id: string | null;
  initial_incident_number: string | null;
  context_snapshot: Record<string, unknown>;
  message?: string | null;
  notify_webex?: boolean;
  created_at: string | null;
  updated_at: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  skipped_at: string | null;
  skip_reason: string | null;
  last_error: string | null;
  activity_at?: string | null;
};
type OperatorRemindersResponse = { items: OperatorReminder[] };
const OPERATOR_REMINDER_CACHE_TTL_MS = 45_000;
const operatorReminderCacheTyped = operatorReminderCache as Map<string, { items: OperatorReminder[]; expiresAt: number }>;
const operatorReminderInFlightTyped = operatorReminderInFlight as Map<string, Promise<OperatorReminder[]>>;
type ReminderLinkIdentity = Pick<CanonicalLink, "id" | "data_source_id" | "source_host_id"> & { circuit_key?: string | null; operational_subject?: OperationalSubject | null; subject_type?: OperatorReminder["subject_type"]; subject_key?: string | null; source_trigger_id?: string | null };

export function operatorReminderCacheKey(link: ReminderLinkIdentity) {
  return `${link.data_source_id}:${link.operational_subject?.subject_key || link.subject_key || link.circuit_key || link.id}`;
}

export function getCachedOperatorReminders(link: ReminderLinkIdentity): OperatorReminder[] | null {
  const cached = operatorReminderCacheTyped.get(operatorReminderCacheKey(link));
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) operatorReminderCacheTyped.delete(operatorReminderCacheKey(link));
    return null;
  }
  return cached.items;
}

export function clearOperatorReminderCache() {
  operatorReminderCacheTyped.clear();
  operatorReminderInFlightTyped.clear();
  operatorReminderGeneration.clear();
}

function operatorReminderPath(link: Pick<CanonicalLink, "id" | "data_source_id" | "source_host_id">, reminderId?: string) {
  const query = new URLSearchParams({ data_source_id: link.data_source_id, source_host_id: link.source_host_id });
  const identity = link as ReminderLinkIdentity;
  const subject = identity.operational_subject || (identity.subject_type && identity.subject_key ? {
    subject_type: identity.subject_type, subject_key: identity.subject_key, circuit_key: identity.circuit_key || null,
    data_source_id: identity.data_source_id, source_host_id: identity.source_host_id || null,
    source_trigger_id: identity.source_trigger_id || null,
  } : null);
  if (subject) {
    query.set("subject_type", subject.subject_type);
    query.set("subject_key", subject.subject_key);
    if (subject.circuit_key) query.set("circuit_key", subject.circuit_key);
    if (subject.source_trigger_id) query.set("source_trigger_id", subject.source_trigger_id);
  }
  if (reminderId) query.set("reminder_id", reminderId);
  return `/oneview/links/${encodeURIComponent(link.id)}/reminders?${query.toString()}`;
}
function storeOperatorReminders(link: ReminderLinkIdentity, items: OperatorReminder[]) {
  operatorReminderCacheTyped.set(operatorReminderCacheKey(link), { items, expiresAt: Date.now() + OPERATOR_REMINDER_CACHE_TTL_MS });
  return items;
}
function replaceOperatorReminders(link: ReminderLinkIdentity, items: OperatorReminder[]) {
  const key = operatorReminderCacheKey(link);
  operatorReminderGeneration.set(key, (operatorReminderGeneration.get(key) || 0) + 1);
  return storeOperatorReminders(link, items);
}
export async function fetchOperatorReminders(link: ReminderLinkIdentity, options: { force?: boolean } = {}): Promise<OperatorReminder[]> {
  const cacheKey = operatorReminderCacheKey(link);
  if (!options.force) {
    const cached = getCachedOperatorReminders(link);
    if (cached) return cached;
  }
  const pending = operatorReminderInFlightTyped.get(cacheKey);
  if (pending) return pending;
  const path = operatorReminderPath(link);
  if (options.force) readCache.delete(oneViewReadCacheKey(path));
  const startedAt = performance.now();
  const generation = operatorReminderGeneration.get(cacheKey) || 0;
  const request = fetchApi<OperatorRemindersResponse>(path)
    .then(({ items }) => {
      if ((operatorReminderGeneration.get(cacheKey) || 0) !== generation) {
        return getCachedOperatorReminders(link) || items;
      }
      return storeOperatorReminders(link, items);
    })
    .catch((cause) => {
      console.info(JSON.stringify({
        event: "oneview_reminder_request",
        route: "/api/oneview/links/:id/reminders",
        method: "GET",
        status: cause instanceof OneViewApiError ? cause.status : 0,
        error_code: cause instanceof OneViewApiError ? cause.code : "request_failed",
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      }));
      throw cause;
    })
    .finally(() => operatorReminderInFlightTyped.delete(cacheKey));
  operatorReminderInFlightTyped.set(cacheKey, request);
  return request;
}
export type OperatorReminderWriteOptions = {
  message?: string | null;
  notifyWebex?: boolean;
};

function reminderWriteBody(scheduledFor: string, options?: OperatorReminderWriteOptions) {
  const body: Record<string, unknown> = { scheduled_for: scheduledFor };
  if (options && "message" in options) body.message = options.message || null;
  if (options && "notifyWebex" in options) body.notify_webex = Boolean(options.notifyWebex);
  return body;
}

export async function createOperatorReminder(link: ReminderLinkIdentity, scheduledFor: string, options?: OperatorReminderWriteOptions): Promise<OperatorReminder> {
  const item = (await fetchApi<{ item: OperatorReminder }>(operatorReminderPath(link), {
    method: "POST",
    body: JSON.stringify(reminderWriteBody(scheduledFor, { notifyWebex: false, ...options })),
  })).item;
  replaceOperatorReminders(link, [item]);
  return item;
}
export async function updateOperatorReminder(link: ReminderLinkIdentity, reminderId: string, scheduledFor: string, options?: OperatorReminderWriteOptions): Promise<OperatorReminder> {
  const item = (await fetchApi<{ item: OperatorReminder }>(operatorReminderPath(link), {
    method: "POST",
    body: JSON.stringify({ action: "update", reminder_id: reminderId, ...reminderWriteBody(scheduledFor, options) }),
  })).item;
  replaceOperatorReminders(link, [item]);
  return item;
}
export async function cancelOperatorReminder(link: ReminderLinkIdentity, reminderId: string): Promise<OperatorReminder> {
  const item = (await fetchApi<{ item: OperatorReminder }>(operatorReminderPath(link), {
    method: "POST",
    body: JSON.stringify({ action: "cancel", reminder_id: reminderId }),
  })).item;
  replaceOperatorReminders(link, []);
  return item;
}

/** OV-P0-297 — feed de lembretes ativos entre circuitos, base da aba "Lembretes". */
export type OperatorReminderFeedItem = Omit<OperatorReminder, "created_by"> & { mine: boolean };
export type OperatorReminderStatus = OperatorReminderFeedItem["status"];
export type OperatorReminderFeedFilters = {
  status?: OperatorReminderStatus[];
  scope?: "all" | "mine";
  from?: string;
  to?: string;
  client?: string;
  severity?: string;
  hasIncident?: boolean;
  search?: string;
  sort?: "recent" | "oldest";
  limit?: number;
  offset?: number;
};
export type OperatorReminderFeed = {
  items: OperatorReminderFeedItem[];
  counts: { all: number; mine: number } & Record<OperatorReminderStatus, number>;
  recent_sent_count?: number;
  facets?: { clients: Array<{ value: string; label: string; count: number }> };
  pagination?: { limit: number; offset: number; total_items: number; has_next: boolean };
  checked_at?: string;
};
const OPERATOR_REMINDER_FEED_PATH = "/oneview/reminders";

/** Feed mutations carry persisted subject identity; the path id is only a safe route locator. */
export function operatorReminderIdentity(item: Pick<OperatorReminderFeedItem, "subject_type" | "subject_key" | "circuit_key" | "data_source_id" | "source_host_id" | "source_trigger_id">) {
  return {
    id: item.circuit_key || item.source_host_id || "operational-subject",
    subject_type: item.subject_type,
    subject_key: item.subject_key,
    circuit_key: item.circuit_key,
    data_source_id: item.data_source_id,
    source_host_id: item.source_host_id || "",
    source_trigger_id: item.source_trigger_id,
  };
}

export type OperatorReminderInboxLink = {
  circuit_key: string | null;
  data_source_id: string;
  source_host_id: string | null;
  subject_type: OperatorReminder["subject_type"];
  subject_key: string | null;
  source_trigger_id: string | null;
};

export type OperatorReminderInboxItem = {
  id: string;
  phase: "fired" | "delivered";
  occurred_at: string;
  scheduled_for?: string;
  title: string;
  body: string;
  link: OperatorReminderInboxLink;
  severity?: string | null;
};

export type OperatorReminderInboxResponse = {
  items: OperatorReminderInboxItem[];
  upcoming?: OperatorReminderInboxItem[];
  data_source?: string;
  checked_at?: string;
};

export type OperatorReminderDeepLinkResponse = {
  status: "available" | "unavailable";
  link: CanonicalLinkDetail | null;
  reminder: { id: string; link: OperatorReminderInboxLink; context_snapshot: Record<string, unknown> };
};

export async function fetchOperatorReminderInbox(options: {
  since: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<OperatorReminderInboxResponse> {
  const search = new URLSearchParams({ since: options.since });
  if (options.limit) search.set("limit", String(options.limit));
  return fetchApi<OperatorReminderInboxResponse>(`/oneview/reminders/inbox?${search.toString()}`, {
    signal: options.signal,
  });
}

export async function fetchOperatorReminderDeepLink(item: Pick<OperatorReminderInboxItem, "id" | "link">, signal?: AbortSignal): Promise<OperatorReminderDeepLinkResponse> {
  const { link } = item;
  const search = new URLSearchParams({ reminder_id: item.id, ds: link.data_source_id, subject_type: link.subject_type, subject_key: link.subject_key || "" });
  if (link.source_host_id) search.set("host", link.source_host_id);
  if (link.circuit_key) search.set("circuit", link.circuit_key);
  if (link.source_trigger_id) search.set("trigger", link.source_trigger_id);
  return fetchApi<OperatorReminderDeepLinkResponse>(`/oneview/reminders/resolve-link?${search.toString()}`, { signal });
}

export async function fetchOperatorReminderFeed(options: OperatorReminderFeedFilters & { signal?: AbortSignal; force?: boolean } = {}): Promise<OperatorReminderFeed> {
  const search = new URLSearchParams();
  if (options.status?.length) search.set("status", options.status.join(","));
  if (options.scope && options.scope !== "all") search.set("scope", options.scope);
  if (options.from) search.set("from", options.from);
  if (options.to) search.set("to", options.to);
  if (options.client) search.set("client", options.client);
  if (options.severity) search.set("severity", options.severity);
  if (typeof options.hasIncident === "boolean") search.set("has_incident", String(options.hasIncident));
  if (options.search) search.set("search", options.search);
  if (options.sort) search.set("sort", options.sort);
  if (options.limit) search.set("limit", String(options.limit));
  if (typeof options.offset === "number" && options.offset > 0) search.set("offset", String(options.offset));
  const path = `${OPERATOR_REMINDER_FEED_PATH}${search.size ? `?${search.toString()}` : ""}`;
  if (options.force) readCache.delete(oneViewReadCacheKey(path));
  const startedAt = performance.now();
  try {
    return await fetchApi<OperatorReminderFeed>(path, { signal: options.signal });
  } catch (cause) {
    console.info(JSON.stringify({
      event: "oneview_reminder_request",
      route: OPERATOR_REMINDER_FEED_PATH,
      method: "GET",
      status: cause instanceof OneViewApiError ? cause.status : 0,
      error_code: cause instanceof OneViewApiError ? cause.code : "request_failed",
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    }));
    throw cause;
  }
}

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
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const key = typeof reference === "string"
    ? `event:${reference.trim().toLowerCase()}`
    : reference.sysId
      ? `sys:${reference.sysId.trim().toLowerCase()}`
      : reference.number
        ? `number:${reference.number.trim().toUpperCase()}`
        : `event:${String(reference.sourceEventId || "").trim().toLowerCase()}`;
  const cached = incidentRelatedAlertCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as IncidentRelatedAlertResponse;
  const pending = incidentRelatedAlertInFlight.get(key);
  if (pending) return pending as Promise<IncidentRelatedAlertResponse>;

  // Drawer/detalhe compartilha uma leitura curta por incidente. Writes não passam por este cache.
  const request = fetchApi<IncidentRelatedAlertResponse>(
    `/oneview/incidents/related-alert?${search.toString()}`,
  ).then((value) => {
    incidentRelatedAlertCache.set(key, {
      value,
      expiresAt: Date.now() + INCIDENT_RELATED_ALERT_TTL_MS,
    });
    return value;
  });
  incidentRelatedAlertInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (incidentRelatedAlertInFlight.get(key) === request) incidentRelatedAlertInFlight.delete(key);
  }
}

/** SN-P0-16 / SN-P0-27 — incidentes SN relacionados ao alerta. Sem fallback por host. */
export type AlertRelatedIncident = {
  sys_id: string | null;
  identity_conflict?: boolean;
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
  short_description?: string | null;
  company?: string | null;
  company_display?: string | null;
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
  alert_episode_started_at?: string | null;
  incident_numbers?: string[];
  incident_sys_ids?: string[];
  incidents: AlertRelatedIncident[];
  error?: string;
};

export type FetchAlertRelatedIncidentsParams = {
  sourceEventId?: string | null;
  /** ISO-8601 instant from alert.first_seen_at; BFF normalizes it to UTC. */
  alertEpisodeStartedAt?: string | null;
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
  const episodeStartedAt = String(params.alertEpisodeStartedAt || "").trim();
  if (episodeStartedAt) search.set("alert_episode_started_at", episodeStartedAt);
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
    { signal, oneViewFresh: true },
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

/** ACK externo (Zabbix). Nunca reutiliza `/ack-request` interno e nunca assume sucesso. */
export async function acknowledgeAlert({
  alertId,
  sourceEventId,
  comment,
  idempotencyKey,
}: AcknowledgeAlertInput): Promise<AcknowledgeAlertResponse> {
  const payload = await fetchApi<AcknowledgeAlertResponse>(
    `/oneview/alerts/${encodeURIComponent(alertId)}/source-acknowledge`,
    {
      method: "POST",
      ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
      body: JSON.stringify({
        source_event_id: sourceEventId,
        ...(comment?.trim() ? { comment: comment.trim() } : {}),
      }),
    },
  );
  invalidateAlertReadCache(alertId);
  return payload;
}

/** Drawer-only delegated Zabbix visibility probe. Never calls event.acknowledge. */
export async function probeSourceAckAccess(alertId: string, signal?: AbortSignal): Promise<SourceAckAccessResponse> {
  return fetchApi<SourceAckAccessResponse>(`/oneview/alerts/${encodeURIComponent(alertId)}/source-ack-access`, {
    method: "POST",
    signal,
  });
}

export async function fetchOperationsHealth(signal?: AbortSignal): Promise<OperationsHealthResponse> {
  return fetchApi<OperationsHealthResponse>("/oneview/operations/health", { signal });
}

export async function fetchRuntimeHealth(signal?: AbortSignal): Promise<RuntimeHealthResponse> {
  return fetchApi<RuntimeHealthResponse>("/oneview/runtime-health", { signal });
}

export async function fetchRuntimeHealthSummary(signal?: AbortSignal): Promise<RuntimeHealthResponse> {
  return fetchApi<RuntimeHealthResponse>("/oneview/runtime-health?view=summary", { signal });
}

export const ONEVIEW_FACETS_PATH = "/oneview/clients-summary";

export async function fetchOneViewFacets(signal?: AbortSignal): Promise<OneViewFacetsResponse> {
  return fetchApi<OneViewFacetsResponse>(ONEVIEW_FACETS_PATH, { signal });
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

export function problemIsResolved(alert: {
  resolved_at?: string | null;
  last_reopened_at?: string | null;
  status_source?: string | null;
  status_internal?: string | null;
} | null | undefined): boolean {
  if (!alert) return false;
  const reopened = Date.parse(String(alert.last_reopened_at || ""));
  const resolvedMs = Date.parse(String(alert.resolved_at || ""));
  if (Number.isFinite(reopened) && (!Number.isFinite(resolvedMs) || resolvedMs < reopened)) return false;
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

/** Active: now - episode start. Resolved: proven recovery - start. ACK and suppression do not stop the clock. */
export function problemEpisodeDurationSeconds(alert: {
  first_seen_at?: string | null;
  last_reopened_at?: string | null;
  resolved_at?: string | null;
  status_source?: string | null;
  status_internal?: string | null;
  recovery_duration_seconds?: number | null;
}, now: number): number | null {
  const first = Date.parse(String(alert.first_seen_at || ""));
  const reopened = Date.parse(String(alert.last_reopened_at || ""));
  let start = first;
  if (Number.isFinite(reopened)) {
    if (!Number.isFinite(first) || reopened < first) return null;
    start = reopened;
  }
  if (!Number.isFinite(start)) return null;
  if (problemIsResolved(alert)) {
    const recovery = alert.recovery_duration_seconds;
    if (recovery == null || !Number.isFinite(recovery) || recovery < 0) return null;
    return recovery;
  }
  if (now < start) return null;
  return Math.floor((now - start) / 1000);
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
