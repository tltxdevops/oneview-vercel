import { createHash } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const MAX_ALERT_PAGE_SIZE = 100;
const DEFAULT_ALERT_PAGE_SIZE = 50;
const MAX_ATTENTION_LIMIT = 200;
const DEFAULT_ATTENTION_LIMIT = 100;
const MAX_FILTER_VALUES = 20;
const MAX_SYNC_LOG_LIMIT = 50;
const DEFAULT_SYNC_LOG_LIMIT = 20;

const URL_PATTERN = /https?:\/\/[^\s,;)]+/gi;
const PRIVATE_IP_PATTERN = /\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\b/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gi;
const IPV6_PATTERN = /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi;
const SECRET_PATTERN = /\b(?:token|password|senha|secret|authorization|bearer)\b/gi;
const FORBIDDEN_STRUCTURED_KEY = /(?:ip|address|inventory|payload|token|password|senha|secret|authorization|credential|dsn|api_url)/i;

let pool;
let poolKey = "";

function textValue(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function nullableText(value) {
  const normalized = textValue(value);
  return normalized || null;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "sim"].includes(normalized)) return true;
  if (["false", "0", "no", "nao", "não"].includes(normalized)) return false;
  return fallback;
}

function integerValue(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function isoDate(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function sanitizeText(value, fallback = "", maxLength = 700) {
  return textValue(value, fallback)
    .replace(URL_PATTERN, "[ENDPOINT_PROTEGIDO]")
    .replace(PRIVATE_IP_PATTERN, "[IP_PROTEGIDO]")
    .replace(IPV4_PATTERN, "[IP_PROTEGIDO]")
    .replace(IPV6_PATTERN, "[IP_PROTEGIDO]")
    .replace(SECRET_PATTERN, "[DADO_PROTEGIDO]")
    .slice(0, maxLength);
}

function isNumericIdentifier(value) {
  return /^\d+$/.test(textValue(value));
}

export function resolveAckActorName(...candidates) {
  for (const candidate of candidates) {
    const normalized = nullableText(sanitizeText(candidate, "", 160));
    if (normalized && !isNumericIdentifier(normalized)) return normalized;
  }
  return null;
}

function sanitizeStructuredValue(value, depth = 0) {
  if (depth > 4 || value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeText(value, "", 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeStructuredValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !FORBIDDEN_STRUCTURED_KEY.test(key))
        .slice(0, 50)
        .map(([key, child]) => [sanitizeText(key, "campo", 80), sanitizeStructuredValue(child, depth + 1)]),
    );
  }
  return null;
}

function mapSafeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => ({
    tag: sanitizeText(item?.tag, "tag", 120),
    value: sanitizeText(item?.value, "", 240),
  }));
}

function mapSafeGroups(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => ({
    id: nullableText(item?.groupid ?? item?.id),
    name: sanitizeText(item?.name, "Grupo", 240),
  }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceInternalHost(value, rawHost, hostAlias, fallback = "", maxLength = 700) {
  const sanitized = sanitizeText(value, fallback, maxLength);
  if (!rawHost) return sanitized;
  return sanitized.replace(new RegExp(escapeRegExp(rawHost), "gi"), hostAlias);
}

function genericFailureDetail(error) {
  return textValue(error) ? "Falha registrada; detalhes técnicos protegidos." : null;
}

function aliasMapFromHosts(hosts) {
  const uniqueHosts = [...new Set(hosts.map((host) => textValue(host)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  return new Map(uniqueHosts.map((host) => {
    const digest = createHash("sha256").update(host).digest("hex").slice(0, 8).toUpperCase();
    return [host, `Host protegido ${digest}`];
  }));
}

function aliasForHost(rawHost, aliases) {
  const normalized = textValue(rawHost);
  if (!normalized) return "-";
  if (aliases?.has(normalized)) return aliases.get(normalized);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8).toUpperCase();
  return `Host protegido ${digest}`;
}

function requestError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function queryValues(req, key) {
  const raw = req.query?.[key];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values
    .map((value) => textValue(value).slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_FILTER_VALUES);
}

function oneQueryValue(req, key) {
  return queryValues(req, key)[0] || "";
}

function databaseFailureCode(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["28P01", "28000"].includes(code) || message.includes("password authentication failed")) {
    return "database_authentication_failed";
  }
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "57014"].includes(code) || message.includes("timeout")) return "database_timeout";
  if (code.includes("CERT") || message.includes("certificate") || message.includes("tls") || message.includes("ssl")) {
    return "database_tls_failed";
  }
  if (["42P01", "42703"].includes(code)) return "database_schema_unavailable";
  return "database_unavailable";
}

function poolSignature(config) {
  return JSON.stringify([
    config.host,
    config.port,
    config.database,
    config.user,
    config.sslMode,
    config.rejectUnauthorized,
    config.poolMax,
    config.connectionTimeoutMs,
    config.queryTimeoutMs,
  ]);
}

function poolSslConfig(config) {
  if (config.sslMode === "disable") return undefined;
  if (config.rejectUnauthorized === false) return { rejectUnauthorized: false };
  return true;
}

const ALERT_SEVERITIES = new Set(["disaster", "high", "average", "warning", "information", "not_classified"]);
const CUSTOMER_CONFIDENCES = new Set(["high", "medium", "low", "unclassified"]);
const ALERT_SORTS = Object.freeze({
  last_seen_at: "a.last_seen_at",
  first_seen_at: "a.first_seen_at",
  resolved_at: "a.resolved_at",
  severity: `case a.severity
    when 'disaster' then 5 when 'high' then 4 when 'average' then 3
    when 'warning' then 2 when 'information' then 1 else 0 end`,
  client: "coalesce(a.customer_name, a.client_name)",
  datasource: "d.name",
  host: "a.host_name",
  problem: "a.problem_name",
  duration: "a.duration_seconds",
  status: `case
    when a.resolved_at is not null or lower(coalesce(a.status_source, '')) = 'resolved'
      or lower(coalesce(a.status_internal, '')) in ('resolved', 'normalized') then 1
    else 0 end`,
  acknowledged_source: "coalesce(a.acknowledged_source, false)",
});

const RESOLVED_ALERT_SQL = `(
  a.resolved_at is not null
  or lower(coalesce(a.status_source, '')) = 'resolved'
  or lower(coalesce(a.status_internal, '')) in ('resolved', 'normalized')
)`;

const ACTIVE_ALERT_SQL = `(
  a.resolved_at is null
  and lower(coalesce(a.status_source, 'active')) = 'active'
  and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')
)`;

export function isResolvedAlert(alert) {
  const sourceStatus = textValue(alert?.status_source).toLowerCase();
  const internalStatus = textValue(alert?.status_internal).toLowerCase();
  return Boolean(alert?.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

export function isActiveAlert(alert) {
  return !isResolvedAlert(alert)
    && textValue(alert?.status_source, "active").toLowerCase() === "active";
}

function positiveInteger(value, fallback, { maximum } = {}) {
  if (value === "") return fallback;
  if (!/^\d+$/.test(value)) throw requestError("invalid_query");
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw requestError("invalid_query");
  return maximum ? Math.min(parsed, maximum) : parsed;
}

export function getAttentionThresholds(env = process.env) {
  return Object.freeze({
    disasterMinutes: integerValue(env.ONEVIEW_DISASTER_UNACK_MINUTES, 5, { min: 1, max: 1440 }),
    highMinutes: integerValue(env.ONEVIEW_HIGH_UNACK_MINUTES, 15, { min: 1, max: 1440 }),
    averageMinutes: integerValue(env.ONEVIEW_AVERAGE_UNACK_MINUTES, 30, { min: 1, max: 1440 }),
  });
}

export function buildAttentionRequiredQuery(req, thresholds = getAttentionThresholds()) {
  const limit = positiveInteger(oneQueryValue(req, "limit"), DEFAULT_ATTENTION_LIMIT, { maximum: MAX_ATTENTION_LIMIT });
  const values = [
    thresholds.disasterMinutes,
    thresholds.highMinutes,
    thresholds.averageMinutes,
  ];
  const whereSql = `
    ${ACTIVE_ALERT_SQL}
    and coalesce(a.acknowledged_source, false) = false
    and a.first_seen_at is not null
    and (
      (a.severity = 'disaster' and a.first_seen_at < now() - ($1::int * interval '1 minute'))
      or (a.severity = 'high' and a.first_seen_at < now() - ($2::int * interval '1 minute'))
      or (a.severity = 'average' and a.first_seen_at < now() - ($3::int * interval '1 minute'))
    )
  `;
  return {
    limit,
    values,
    whereSql,
    orderSql: `
      case a.severity when 'disaster' then 1 when 'high' then 2 when 'average' then 3 else 4 end asc,
      unacknowledged_minutes desc,
      a.id desc
    `,
  };
}

export function attentionRequiredState(alert, thresholds = getAttentionThresholds(), now = Date.now()) {
  const severity = textValue(alert?.severity).toLowerCase();
  const firstSeenAt = Date.parse(alert?.first_seen_at || alert?.started_at || "");
  const active = isActiveAlert(alert);
  const acknowledgedAtOrigin = Boolean(alert?.acknowledged_source);
  const threshold = severity === "disaster"
    ? thresholds.disasterMinutes
    : severity === "high"
      ? thresholds.highMinutes
      : severity === "average"
        ? thresholds.averageMinutes
        : null;
  const ageMilliseconds = Number.isNaN(firstSeenAt) ? 0 : Math.max(now - firstSeenAt, 0);
  const unacknowledgedMinutes = Math.floor(ageMilliseconds / 60000);
  return {
    matches: Boolean(active && !acknowledgedAtOrigin && threshold !== null && ageMilliseconds > threshold * 60000),
    unacknowledgedMinutes,
  };
}

export function compareAttentionRequiredEntries(left, right) {
  const severityRank = { disaster: 1, high: 2, average: 3 };
  const severityDifference = (severityRank[left?.alert?.severity] ?? 4) - (severityRank[right?.alert?.severity] ?? 4);
  if (severityDifference !== 0) return severityDifference;
  return integerValue(right?.unacknowledgedMinutes, 0) - integerValue(left?.unacknowledgedMinutes, 0);
}

function isoFilterDate(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw requestError("invalid_query");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw requestError("invalid_query");
  return parsed.toISOString();
}

export function buildAlertListQuery(req) {
  const params = [];
  const clauses = [];
  const push = (clause, value) => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };

  const page = positiveInteger(oneQueryValue(req, "page"), 1);
  const pageSize = positiveInteger(oneQueryValue(req, "page_size"), DEFAULT_ALERT_PAGE_SIZE, { maximum: MAX_ALERT_PAGE_SIZE });
  const clients = queryValues(req, "client").map((value) => value.slice(0, 160));
  const customers = queryValues(req, "customer").map((value) => value.slice(0, 160));
  const datasources = queryValues(req, "datasource").map((value) => value.slice(0, 160));
  const customerConfidences = queryValues(req, "customer_confidence").map((value) => value.toLowerCase());
  const severities = queryValues(req, "severity").map((value) => value.toLowerCase());
  const status = (oneQueryValue(req, "status") || "active").toLowerCase();
  const acknowledged = oneQueryValue(req, "acknowledged").toLowerCase();
  const acknowledgedSource = oneQueryValue(req, "acknowledged_source").toLowerCase();
  const acknowledgedInternal = oneQueryValue(req, "acknowledged_internal").toLowerCase();
  const search = oneQueryValue(req, "search").slice(0, 200);
  const hostSearch = oneQueryValue(req, "host_search").slice(0, 200);
  const problemSearch = oneQueryValue(req, "problem_search").slice(0, 200);
  const dateFrom = isoFilterDate(oneQueryValue(req, "date_from"));
  const dateTo = isoFilterDate(oneQueryValue(req, "date_to"));
  const firstSeenFrom = isoFilterDate(oneQueryValue(req, "first_seen_from"));
  const lastSeenFrom = isoFilterDate(oneQueryValue(req, "last_seen_from"));
  const sort = (oneQueryValue(req, "sort") || "last_seen_at").toLowerCase();
  const order = (oneQueryValue(req, "order") || "desc").toLowerCase();

  if (severities.some((value) => !ALERT_SEVERITIES.has(value))) throw requestError("invalid_query");
  if (customerConfidences.some((value) => !CUSTOMER_CONFIDENCES.has(value))) throw requestError("invalid_query");
  if (!["active", "resolved", "all"].includes(status)) throw requestError("invalid_query");
  if (acknowledged && !["true", "false"].includes(acknowledged)) throw requestError("invalid_query");
  if (acknowledgedSource && !["true", "false"].includes(acknowledgedSource)) throw requestError("invalid_query");
  if (acknowledgedInternal && !["true", "false"].includes(acknowledgedInternal)) throw requestError("invalid_query");
  if (!Object.hasOwn(ALERT_SORTS, sort) || !["asc", "desc"].includes(order)) throw requestError("invalid_query");
  if (dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) throw requestError("invalid_query");
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw requestError("invalid_query");

  if (clients.length) push("a.client_name = any(?::text[])", clients);
  if (customers.length) push("coalesce(a.customer_key, 'unclassified') = any(?::text[])", customers);
  if (datasources.length) push("d.name = any(?::text[])", datasources);
  if (customerConfidences.length) {
    push("coalesce(a.customer_confidence, 'unclassified') = any(?::text[])", customerConfidences);
  }
  if (severities.length) push("a.severity = any(?::text[])", severities);
  if (status === "active") clauses.push(ACTIVE_ALERT_SQL);
  if (status === "resolved") clauses.push(RESOLVED_ALERT_SQL);
  if (acknowledged) {
    push(
      "(coalesce(a.acknowledged_source, false) or coalesce(a.acknowledged_internal, false)) = ?",
      acknowledged === "true",
    );
  }
  if (acknowledgedSource) push("coalesce(a.acknowledged_source, false) = ?", acknowledgedSource === "true");
  if (acknowledgedInternal) push("coalesce(a.acknowledged_internal, false) = ?", acknowledgedInternal === "true");
  if (search) {
    push(
      "(coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ? or coalesce(a.problem_name, '') ilike $CURRENT or coalesce(a.service_name, '') ilike $CURRENT or coalesce(a.customer_name, a.client_name, '') ilike $CURRENT or coalesce(d.name, '') ilike $CURRENT)",
      `%${search}%`,
    );
    const current = `$${params.length}`;
    clauses[clauses.length - 1] = clauses[clauses.length - 1].replaceAll("$CURRENT", current);
  }
  if (hostSearch) {
    push(
      "coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ?",
      `%${hostSearch}%`,
    );
  }
  if (problemSearch) {
    push("coalesce(a.problem_name, '') ilike ?", `%${problemSearch}%`);
  }
  if (dateFrom) push("a.last_seen_at >= ?", dateFrom);
  if (dateTo) push("a.last_seen_at <= ?", dateTo);
  if (firstSeenFrom) push("a.first_seen_at >= ?", firstSeenFrom);
  if (lastSeenFrom) push("a.last_seen_at >= ?", lastSeenFrom);

  const direction = order.toUpperCase();
  return {
    page,
    pageSize,
    offset,
    params,
    whereSql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    orderSql: `${ALERT_SORTS[sort]} ${direction}${sort === "resolved_at" ? " nulls last" : ""}, a.last_seen_at desc, a.id desc`,
    filters: {
      clients,
      customers,
      datasources,
      customerConfidences,
      severities,
      status,
      acknowledged,
      acknowledgedSource,
      acknowledgedInternal,
      search,
      hostSearch,
      problemSearch,
      dateFrom,
      dateTo,
      firstSeenFrom,
      lastSeenFrom,
      sort,
      order,
    },
  };
}

function generatedAt() {
  return new Date().toISOString();
}

function normalizedCustomerName(value) {
  return textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function classifyAlertEnrichment(alert) {
  const customerName = normalizedCustomerName(alert?.customer_name);
  if (customerName === "cliente nao classificado") return "unclassified";
  if (!customerName) return "legacy";
  return textValue(alert?.customer_confidence).toLowerCase() === "high" ? "complete" : "partial";
}

function mapAlertRows(rows) {
  const aliases = aliasMapFromHosts(rows.map((row) => row.host_name));
  return rows.map((row) => {
    const hostAlias = aliasForHost(row.host_name, aliases);
    const enrichmentState = classifyAlertEnrichment(row);
    return {
      id: textValue(row.id),
      data_source_id: textValue(row.data_source_id),
      datasource_name: sanitizeText(row.datasource_name ?? row.data_source_name, "Datasource OneView", 160),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      customer_name: nullableText(sanitizeText(row.customer_name, "", 160)),
      customer_key: nullableText(sanitizeText(row.customer_key, "", 160)),
      customer_source: nullableText(sanitizeText(row.customer_source, "", 120)),
      customer_confidence: nullableText(sanitizeText(row.customer_confidence, "", 40)),
      enrichment_status: ["complete", "partial"].includes(enrichmentState) ? "enriched" : "pending",
      enrichment_state: enrichmentState,
      source_type: "zabbix",
      source_event_id: textValue(row.source_event_id, textValue(row.id)),
      source_problem_id: nullableText(row.source_problem_id),
      source_trigger_id: nullableText(row.source_trigger_id),
      source_host_id: null,
      host_name: hostAlias,
      host_visible_name: nullableText(sanitizeText(row.host_visible_name, "", 240)),
      host_technical_name: nullableText(sanitizeText(row.host_technical_name, "", 240)),
      host_ip: null,
      host_group: null,
      host_groups: mapSafeGroups(row.host_groups),
      event_tags: mapSafeTags(row.event_tags),
      trigger_tags: mapSafeTags(row.trigger_tags),
      host_tags: mapSafeTags(row.host_tags),
      service_name: nullableText(replaceInternalHost(row.service_name, row.host_name, hostAlias, "", 240)),
      item_name: nullableText(sanitizeText(row.item_name, "", 300)),
      item_key: nullableText(sanitizeText(row.item_key, "", 300)),
      trigger_description: nullableText(sanitizeText(row.trigger_description, "", 700)),
      operational_data: nullableText(sanitizeText(row.operational_data, "", 700)),
      problem_name: replaceInternalHost(row.problem_name, row.host_name, hostAlias, "Alerta sincronizado", 700),
      severity: textValue(row.severity, "not_classified"),
      status_source: textValue(row.status_source, "active"),
      status_internal: textValue(row.status_internal, "new"),
      acknowledged_source: Boolean(row.acknowledged_source),
      acknowledged_internal: Boolean(row.acknowledged_internal),
      acknowledged_at: isoDate(row.acknowledged_at ?? row.acknowledged_source_at ?? row.acknowledged_internal_at),
      acknowledged_by: resolveAckActorName(row.acknowledged_by),
      ack_request_status: ["pending", "processing"].includes(textValue(row.ack_request_status))
        ? textValue(row.ack_request_status)
        : null,
      suppressed: Boolean(row.suppressed),
      suppressed_until: isoDate(row.suppressed_until),
      maintenance_status: nullableText(sanitizeText(row.maintenance_status, "", 80)),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
      started_at: isoDate(row.first_seen_at, generatedAt()),
      last_seen_at: isoDate(row.last_seen_at, generatedAt()),
      resolved_at: isoDate(row.resolved_at),
      source_recovery_event_id: nullableText(sanitizeText(row.source_recovery_event_id, "", 120)),
      duration_seconds: integerValue(row.duration_seconds, 0),
      created_at: isoDate(row.created_at ?? row.first_seen_at, generatedAt()),
      updated_at: isoDate(row.updated_at ?? row.last_seen_at, generatedAt()),
    };
  });
}

function mapTopHosts(rows, aliases) {
  return rows.map((row) => ({
    host_name: aliasForHost(row.host_name, aliases),
    count: integerValue(row.count ?? row.active_alerts, 0),
  }));
}

function mapLongestDurationRows(rows, aliases) {
  return rows.map((row) => {
    const hostAlias = aliasForHost(row.host_name, aliases);
    return {
      id: textValue(row.id),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      host_name: hostAlias,
      problem_name: replaceInternalHost(row.problem_name, row.host_name, hostAlias, "Alerta sincronizado", 700),
      severity: textValue(row.severity, "not_classified"),
      duration_seconds: integerValue(row.duration_seconds, 0),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
    };
  });
}

function mapDataSourceRows(rows) {
  return rows.map((row) => ({
    id: textValue(row.id),
    name: sanitizeText(row.name, "Datasource OneView", 160),
    client_name: sanitizeText(row.client_name, textValue(row.name, "Cliente OneView"), 160),
    type: "zabbix",
    environment: textValue(row.environment, "internal") === "external" ? "external" : "internal",
    problem_group_filter: null,
    status: ["active", "inactive", "error"].includes(textValue(row.status)) ? textValue(row.status) : "inactive",
    sync_enabled: Boolean(row.sync_enabled),
    sync_interval_seconds: integerValue(row.sync_interval_seconds, 300, { min: 15, max: 86400 }),
    via_vpn: Boolean(row.via_vpn),
    observation: null,
    last_sync_at: isoDate(row.last_sync_at),
    last_sync_status: nullableText(row.last_sync_status),
    last_sync_error: genericFailureDetail(row.last_sync_error),
    last_success_at: isoDate(row.last_success_at),
    last_error: genericFailureDetail(row.last_error),
    failure_count: integerValue(row.failure_count, 0),
    sync_locked_at: isoDate(row.sync_locked_at),
    sync_lock_owner: null,
    display_order: integerValue(row.display_order, 100),
    created_at: isoDate(row.created_at, generatedAt()),
    updated_at: isoDate(row.updated_at, generatedAt()),
    has_token: Boolean(row.has_token),
    alerts_count: integerValue(row.alerts_count, 0),
    pending_reason: genericFailureDetail(row.last_sync_error || row.last_error),
  }));
}

function mapSyncLogRows(rows) {
  return rows.map((row) => ({
    id: textValue(row.id),
    datasource: sanitizeText(row.datasource, "Datasource OneView", 160),
    data_source_id: textValue(row.data_source_id),
    status: textValue(row.status, "unknown").toLowerCase(),
    fetched: integerValue(row.fetched, 0),
    upserted: integerValue(row.upserted, 0),
    detail: textValue(row.status).toLowerCase() === "success"
      ? "Sincronização concluída."
      : "Falha registrada; detalhes técnicos protegidos.",
    created_at: isoDate(row.created_at, generatedAt()),
  }));
}

async function queryRows(config, text, values = []) {
  const result = await getOneViewDbPool(config).query({ text, values });
  return result.rows;
}

async function queryRow(config, text, values = []) {
  const rows = await queryRows(config, text, values);
  return rows[0] || null;
}

async function fetchAlertList(req, config) {
  const { page, pageSize, offset, params, whereSql, orderSql } = buildAlertListQuery(req);

  const [totalRow, itemRows] = await Promise.all([
    queryRow(config, `select count(*)::int as total from alerts a join data_sources d on d.id = a.data_source_id ${whereSql}`, params),
    queryRows(
      config,
      `
        select
          a.id,
          a.data_source_id,
          d.name as datasource_name,
          a.client_name,
          a.customer_name,
          a.customer_key,
          a.customer_source,
          a.customer_confidence,
          a.source_event_id,
          a.source_problem_id,
          a.source_trigger_id,
          a.source_host_id,
          a.host_name,
          a.host_visible_name,
          a.host_technical_name,
          a.service_name,
          a.problem_name,
          a.severity,
          a.status_source,
          a.status_internal,
          a.acknowledged_source,
          a.acknowledged_internal,
          a.acknowledged_at,
          a.acknowledged_by,
          (select ack.status
             from alert_acknowledgements ack
            where ack.alert_id = a.id and ack.status in ('pending','processing')
            order by ack.requested_at desc, ack.id desc
            limit 1) as ack_request_status,
          a.suppressed,
          a.suppressed_until,
          a.maintenance_status,
          a.first_seen_at,
          a.last_seen_at,
          a.resolved_at,
          a.duration_seconds,
          a.created_at,
          a.updated_at
        from alerts a
        join data_sources d on d.id = a.data_source_id
        ${whereSql}
        order by ${orderSql}
        limit $${params.length + 1}
        offset $${params.length + 2}
      `,
      [...params, pageSize, offset],
    ),
  ]);

  const totalItems = integerValue(totalRow?.total, 0);
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);

  return {
    generated_at: generatedAt(),
    items: mapAlertRows(itemRows),
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_previous: page > 1 && totalPages > 0,
    },
  };
}

function attentionThresholdPayload(thresholds) {
  return {
    disaster_minutes: thresholds.disasterMinutes,
    high_minutes: thresholds.highMinutes,
    average_minutes: thresholds.averageMinutes,
  };
}

function mapAttentionRows(rows) {
  const aliases = aliasMapFromHosts(rows.map((row) => row.host_name));
  return rows.map((row) => {
    const hostAlias = aliasForHost(row.host_name, aliases);
    return {
      id: textValue(row.id),
      customer_name: nullableText(sanitizeText(row.customer_name, "", 160)),
      customer_confidence: sanitizeText(row.customer_confidence, "unclassified", 40),
      datasource_name: sanitizeText(row.datasource_name, "Datasource OneView", 160),
      host_visible_name: row.host_visible_name
        ? sanitizeText(row.host_visible_name, hostAlias, 240)
        : hostAlias,
      problem: replaceInternalHost(row.problem_name, row.host_name, hostAlias, "Alerta sincronizado", 700),
      severity: textValue(row.severity, "average"),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
      last_seen_at: isoDate(row.last_seen_at, generatedAt()),
      unacknowledged_minutes: integerValue(row.unacknowledged_minutes, 0),
      acknowledged: false,
    };
  });
}

async function fetchAttentionRequiredPayload(req, config, thresholds = getAttentionThresholds()) {
  const { limit, values, whereSql, orderSql } = buildAttentionRequiredQuery(req, thresholds);
  const [severityRows, customerRows, datasourceRows, itemRows] = await Promise.all([
    queryRows(
      config,
      `select a.severity, count(*)::int as count from public.alerts a where ${whereSql} group by a.severity`,
      values,
    ),
    queryRows(
      config,
      `
        select coalesce(a.customer_name, 'Sem classificação') as customer_name, count(*)::int as count
        from public.alerts a
        where ${whereSql}
        group by coalesce(a.customer_name, 'Sem classificação')
        order by count desc, customer_name asc
      `,
      values,
    ),
    queryRows(
      config,
      `
        select d.name as datasource_name, count(*)::int as count
        from public.alerts a
        join public.data_sources d on d.id = a.data_source_id
        where ${whereSql}
        group by d.name
        order by count desc, datasource_name asc
      `,
      values,
    ),
    queryRows(
      config,
      `
        select
          a.id,
          a.customer_name,
          a.customer_confidence,
          d.name as datasource_name,
          a.host_name,
          a.host_visible_name,
          a.problem_name,
          a.severity,
          a.first_seen_at,
          a.last_seen_at,
          floor(extract(epoch from (now() - a.first_seen_at)) / 60)::int as unacknowledged_minutes
        from public.alerts a
        join public.data_sources d on d.id = a.data_source_id
        where ${whereSql}
        order by ${orderSql}
        limit $4
      `,
      [...values, limit],
    ),
  ]);
  const severityCounts = Object.fromEntries(
    severityRows.map((row) => [textValue(row.severity), integerValue(row.count, 0)]),
  );
  const disaster = integerValue(severityCounts.disaster, 0);
  const high = integerValue(severityCounts.high, 0);
  const average = integerValue(severityCounts.average, 0);

  return {
    summary: {
      total: disaster + high + average,
      disaster,
      high,
      average,
      by_customer: customerRows.map((row) => ({
        customer_name: sanitizeText(row.customer_name, "Sem classificação", 160),
        count: integerValue(row.count, 0),
      })),
      by_datasource: datasourceRows.map((row) => ({
        datasource_name: sanitizeText(row.datasource_name, "Datasource OneView", 160),
        count: integerValue(row.count, 0),
      })),
    },
    thresholds: attentionThresholdPayload(thresholds),
    items: mapAttentionRows(itemRows),
  };
}

function alertId(req) {
  const value = oneQueryValue(req, "id").slice(0, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(value)) throw requestError("invalid_query");
  return value;
}

async function fetchAlertDetailPayload(req, config) {
  const id = alertId(req);
  const row = await queryRow(
    config,
    `
      select
        a.id, a.data_source_id, d.name as datasource_name, a.client_name,
        a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
        a.source_event_id, a.source_problem_id, a.source_trigger_id, a.source_host_id,
        a.source_recovery_event_id,
        a.host_name, a.host_visible_name, a.host_technical_name,
        a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
        a.service_name, a.item_name, a.item_key, a.trigger_description, a.operational_data,
        a.problem_name,
        a.severity, a.status_source, a.status_internal,
        a.acknowledged_source, a.acknowledged_internal,
        a.acknowledged_at, a.acknowledged_by,
        (select ack.status
           from alert_acknowledgements ack
          where ack.alert_id = a.id and ack.status in ('pending','processing')
          order by ack.requested_at desc, ack.id desc
          limit 1) as ack_request_status,
        a.suppressed, a.suppressed_until, a.maintenance_status,
        a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds,
        a.created_at, a.updated_at,
        (select count(*)::int from alert_history h where h.alert_id = a.id) as history_count,
        (select count(*)::int from alert_acknowledgements ack where ack.alert_id = a.id) as acknowledgement_count
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where a.id = $1
      limit 1
    `,
    [id],
  );
  if (!row) throw requestError("not_found", 404);
  const item = mapAlertRows([row])[0];
  return {
    generated_at: generatedAt(),
    item: {
      ...item,
      history_count: integerValue(row.history_count, 0),
      acknowledgement_count: integerValue(row.acknowledgement_count, 0),
    },
  };
}

const HISTORY_TITLES = Object.freeze({
  problem_created: "Alerta identificado",
  problem_seen: "Ocorrência atualizada",
  severity_changed: "Severidade alterada",
  acknowledged: "Alerta reconhecido na origem",
  internal_acknowledged: "Reconhecido no OneView",
  ack_message: "Comentário adicionado ao reconhecimento",
  suppressed: "Alerta suprimido",
  unsuppressed: "Supressão encerrada",
  maintenance: "Evento de manutenção",
  recovered: "Alerta resolvido",
  reopened: "Alerta reaberto",
  status_changed: "Status alterado",
});

export function historyTitle(eventType) {
  const normalized = textValue(eventType).toLowerCase();
  if (HISTORY_TITLES[normalized]) return HISTORY_TITLES[normalized];
  if (normalized === "created_from_zabbix") return "Alerta identificado";
  if (normalized === "resolved_by_reconciliation") return "Alerta resolvido";
  if (normalized.includes("severity")) return "Severidade alterada";
  if (normalized.includes("recovery") || normalized.includes("resolved")) return "Alerta resolvido";
  if (normalized === "internal_acknowledged") return "Reconhecido no OneView";
  if (normalized.includes("ack")) return "Alerta reconhecido na origem";
  if (normalized.includes("status")) return "Status alterado";
  return "Atualização do alerta";
}

function historyHasRecovery(eventType) {
  const normalized = textValue(eventType).toLowerCase();
  return normalized === "recovered"
    || normalized === "resolved_by_reconciliation"
    || normalized.includes("recovery")
    || normalized.includes("resolved");
}

function historyHasAcknowledgement(eventType) {
  const normalized = textValue(eventType).toLowerCase();
  return normalized === "acknowledged" || normalized === "ack_message" || normalized.includes("ack");
}

function historyDescription(_eventType, value) {
  return nullableText(sanitizeText(value, "", 500));
}

export function historyValueIsMeaningful(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return !["", "-", "new", "novo", "null", "none", "undefined", "n/a", "na"].includes(normalized);
  }
  if (Array.isArray(value)) return value.some((item) => historyValueIsMeaningful(item));
  if (typeof value === "object") return Object.values(value).some((item) => historyValueIsMeaningful(item));
  return true;
}

function acknowledgementGroupKey(item) {
  const scope = textValue(item.event_type).toLowerCase() === "internal_acknowledged" ? "internal" : "source";
  if (item.acknowledge_id) return `${scope}:acknowledge:${item.acknowledge_id}`;
  return [
    `${scope}:acknowledge-fallback`,
    item.source_event_id || "event",
    item.occurred_at,
    item.ack_actor_name || (item.ack_actor_unresolved ? "unresolved" : "unknown"),
    item.origin || item.source || "origin",
  ].join("|");
}

function acknowledgementComment(item) {
  const description = nullableText(item.description);
  if (!description) return null;
  if (textValue(item.event_type).toLowerCase() === "ack_message") return description;
  const normalized = description.toLowerCase();
  if (["alerta reconhecido", "reconhecimento registrado", "observação do reconhecimento"].includes(normalized)) return null;
  return description;
}

function latestIso(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function earliestIso(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

export function consolidateAlertHistoryItems(sourceItems) {
  const sorted = [...sourceItems].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
  const acknowledgements = new Map();
  const consolidated = [];

  for (const sourceItem of sorted) {
    const item = {
      ...sourceItem,
      grouped_event_count: 1,
      first_occurred_at: sourceItem.occurred_at,
      last_occurred_at: sourceItem.occurred_at,
      comment: historyHasAcknowledgement(sourceItem.event_type) ? acknowledgementComment(sourceItem) : null,
    };
    if (!historyHasAcknowledgement(item.event_type)) {
      consolidated.push(item);
      continue;
    }

    const key = acknowledgementGroupKey(item);
    const existing = acknowledgements.get(key);
    if (!existing) {
      item.event_type = textValue(item.event_type).toLowerCase() === "internal_acknowledged"
        ? "internal_acknowledged"
        : "acknowledged";
      item.title = HISTORY_TITLES[item.event_type];
      item.description = null;
      acknowledgements.set(key, item);
      consolidated.push(item);
      continue;
    }

    existing.grouped_event_count += 1;
    existing.first_occurred_at = earliestIso(existing.first_occurred_at, item.occurred_at);
    existing.last_occurred_at = latestIso(existing.last_occurred_at, item.occurred_at);
    existing.occurred_at = existing.last_occurred_at;
    existing.created_at = latestIso(existing.created_at, item.created_at);
    existing.ack_actor_name ||= item.ack_actor_name;
    existing.actor_name = existing.ack_actor_name;
    existing.ack_actor_unresolved = !existing.ack_actor_name
      && (existing.ack_actor_unresolved || item.ack_actor_unresolved);
    existing.comment ||= item.comment;
    existing.previous_value = historyValueIsMeaningful(existing.previous_value)
      ? existing.previous_value
      : item.previous_value;
    existing.current_value = historyValueIsMeaningful(existing.current_value)
      ? existing.current_value
      : item.current_value;
    existing.legacy = existing.legacy || item.legacy;
  }

  return consolidated
    .map(({ acknowledge_id: _acknowledgeId, ...item }) => item)
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
}

function historySummary(items) {
  const acknowledgements = items.filter((item) => historyHasAcknowledgement(item.event_type));
  const actors = [...new Set(acknowledgements.map((item) => item.ack_actor_name).filter(Boolean))];
  return {
    acknowledgement_count: acknowledgements.length,
    first_ack_at: acknowledgements.at(-1)?.occurred_at ?? null,
    latest_ack_at: acknowledgements[0]?.occurred_at ?? null,
    has_ack_comment: acknowledgements.some((item) => Boolean(item.comment)),
    ack_actor_summary: acknowledgements.length === 0
      ? "Sem ACK"
      : actors.length > 1
        ? "Mais de um responsável"
        : actors[0] || "Responsável não resolvido",
  };
}

function historySource(value, legacy = false) {
  if (legacy) return "Histórico legado";
  const normalized = textValue(value).toLowerCase();
  if (normalized.includes("zabbix")) return "Zabbix";
  return "OneView";
}

function historyIsLegacy(actionType, actionSource) {
  const type = textValue(actionType).toLowerCase();
  const source = textValue(actionSource).toLowerCase();
  return source.includes("worker_zabbix_sync")
    || ["created_from_zabbix", "resolved_by_reconciliation"].includes(type);
}

async function fetchAlertHistoryPayload(req, config) {
  const id = alertId(req);
  const alert = await queryRow(
    config,
    "select id, source_event_id, host_name from alerts where id = $1 limit 1",
    [id],
  );
  if (!alert) throw requestError("not_found", 404);

  const rows = await queryRows(
    config,
    `
      select
        h.id::text as id,
        h.action_type::text as event_type,
        h.message::text as description,
        coalesce(h.previous_value, to_jsonb(h.previous_status)) as previous_value,
        coalesce(h.current_value, to_jsonb(h.new_status)) as current_value,
        h.source_event_id,
        h.occurred_at,
        h.created_at,
        nullif(h.actor_name, '')::text as actor_name_candidate,
        nullif(h.operator_name, '')::text as operator_name_candidate,
        nullif(a.acknowledged_by, '')::text as acknowledged_by_candidate,
        coalesce(
          h.current_value ->> 'acknowledgeid',
          h.previous_value ->> 'acknowledgeid',
          h.metadata ->> 'acknowledgeid'
        )::text as acknowledge_id,
        nullif(h.actor_type, '')::text as actor_type,
        coalesce(h.action_source, 'legacy')::text as action_source,
        coalesce(h.source, 'legacy')::text as source
      from alert_history h
      join alerts a on a.id = h.alert_id
      where h.alert_id = $1
      order by h.occurred_at desc nulls last, h.created_at desc, h.id desc
    `,
    [id],
  );
  const alias = aliasForHost(alert.host_name);
  const mappedItems = rows.map((row) => {
    const eventType = textValue(row.event_type, "updated");
    const isAcknowledgement = historyHasAcknowledgement(eventType);
    const ackActorName = isAcknowledgement
      ? resolveAckActorName(row.actor_name_candidate, row.operator_name_candidate, row.acknowledged_by_candidate)
      : null;
    const actorName = isAcknowledgement
      ? ackActorName
      : resolveAckActorName(row.actor_name_candidate, row.operator_name_candidate);
    const legacy = historyIsLegacy(row.event_type, row.action_source);
    const previousValue = sanitizeStructuredValue(row.previous_value);
    const currentValue = sanitizeStructuredValue(row.current_value);
    return {
      id: textValue(row.id),
      event_type: eventType,
      title: historyTitle(row.event_type),
      description: historyDescription(
        eventType,
        replaceInternalHost(row.description, alert.host_name, alias, "", 500),
      ),
      previous_value: legacy && !historyValueIsMeaningful(previousValue) ? null : previousValue,
      current_value: legacy && !historyValueIsMeaningful(currentValue) ? null : currentValue,
      source_event_id: nullableText(sanitizeText(row.source_event_id ?? alert.source_event_id, "", 120)),
      occurred_at: isoDate(row.occurred_at ?? row.created_at, generatedAt()),
      created_at: isoDate(row.created_at, generatedAt()),
      actor_name: actorName,
      ack_actor_name: ackActorName,
      ack_actor_unresolved: isAcknowledgement && !ackActorName && [
        row.actor_name_candidate,
        row.operator_name_candidate,
        row.acknowledged_by_candidate,
      ].some((value) => isNumericIdentifier(value)),
      acknowledge_id: nullableText(sanitizeText(row.acknowledge_id, "", 120)),
      actor_type: nullableText(sanitizeText(row.actor_type, "", 40)),
      source: historySource(row.source, legacy),
      origin: sanitizeText(row.action_source, "legacy", 120),
      legacy,
    };
  });
  const items = consolidateAlertHistoryItems(mappedItems);
  const summary = historySummary(items);
  return {
    generated_at: generatedAt(),
    alert_id: id,
    source_total_items: rows.length,
    total_items: items.length,
    history_available: true,
    history_partial: items.some((item) => item.legacy),
    first_event_at: items.at(-1)?.occurred_at ?? null,
    last_event_at: items[0]?.occurred_at ?? null,
    has_recovery: items.some((item) => historyHasRecovery(item.event_type)),
    has_ack: items.some((item) => historyHasAcknowledgement(item.event_type)),
    ...summary,
    items,
  };
}

export function classifyOperationalSource(source, now = Date.now()) {
  const syncEnabled = Boolean(source.sync_enabled);
  const sourceStatus = textValue(source.status).toLowerCase();
  const lastSyncStatus = textValue(source.last_sync_status).toLowerCase();
  const intervalSeconds = integerValue(source.sync_interval_seconds, 300, { min: 15, max: 86400 });
  const lastActivityAt = isoDate(source.last_activity_at);
  const activityAge = lastActivityAt ? Math.max((now - Date.parse(lastActivityAt)) / 1000, 0) : Number.POSITIVE_INFINITY;

  if (!syncEnabled) return { status: "disabled", reason_code: "sync_disabled", lastActivityAt, intervalSeconds };
  if (sourceStatus === "error" || lastSyncStatus === "failed" || integerValue(source.failure_count, 0) > 0) {
    return { status: "error", reason_code: "recent_sync_failure", lastActivityAt, intervalSeconds };
  }
  if (!lastActivityAt || activityAge > intervalSeconds * 3) {
    return { status: "stale", reason_code: lastActivityAt ? "activity_stale" : "no_activity", lastActivityAt, intervalSeconds };
  }
  if (sourceStatus !== "active" || !["success", "ok"].includes(lastSyncStatus)) {
    return { status: "warning", reason_code: "sync_incomplete", lastActivityAt, intervalSeconds };
  }
  return { status: "healthy", reason_code: "healthy", lastActivityAt, intervalSeconds };
}

async function fetchOperationsHealthPayload(config) {
  const rows = await queryRows(
    config,
    `
      select
        d.id, d.name, d.client_name, d.status, d.sync_enabled,
        d.sync_interval_seconds, d.last_sync_status, d.last_sync_at,
        d.last_success_at, d.failure_count, d.last_worker_heartbeat_at,
        greatest(
          d.last_worker_heartbeat_at,
          d.last_sync_at,
          d.last_success_at,
          latest.latest_sync_at
        ) as last_activity_at
      from data_sources d
      left join lateral (
        select max(coalesce(sl.finished_at, sl.started_at, sl.created_at)) as latest_sync_at
        from sync_logs sl
        where sl.data_source_id = d.id
      ) latest on true
      order by d.display_order asc, d.name asc
    `,
  );
  const now = Date.now();
  const items = rows.map((row) => {
    const health = classifyOperationalSource(row, now);
    return {
      id: textValue(row.id),
      name: sanitizeText(row.name, "Datasource OneView", 160),
      client_name: sanitizeText(row.client_name, textValue(row.name, "Cliente OneView"), 160),
      source_status: ["active", "inactive", "error"].includes(textValue(row.status)) ? textValue(row.status) : "inactive",
      operational_status: health.status,
      reason_code: health.reason_code,
      sync_enabled: Boolean(row.sync_enabled),
      sync_interval_seconds: health.intervalSeconds,
      last_sync_status: nullableText(row.last_sync_status),
      last_sync_at: isoDate(row.last_sync_at),
      last_success_at: isoDate(row.last_success_at),
      last_activity_at: health.lastActivityAt,
      failure_count: integerValue(row.failure_count, 0),
    };
  });
  const summary = Object.fromEntries(["healthy", "warning", "error", "stale", "disabled"].map((status) => [
    status,
    items.filter((item) => item.operational_status === status).length,
  ]));
  const enabledItems = items.filter((item) => item.sync_enabled);
  const workerActivity = enabledItems
    .map((item) => item.last_activity_at)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  const workerWindow = Math.min(...enabledItems.map((item) => item.sync_interval_seconds * 3), 900);
  const workerStatus = !workerActivity
    ? "unknown"
    : now - Date.parse(workerActivity) > workerWindow * 1000 ? "stale" : "healthy";
  const overallStatus = summary.error > 0
    ? "error"
    : summary.stale > 0 ? "stale" : summary.warning > 0 || summary.disabled > 0 ? "warning" : "healthy";

  return {
    generated_at: generatedAt(),
    status: overallStatus,
    summary: { total: items.length, ...summary },
    worker: { status: workerStatus, last_activity_at: workerActivity },
    items,
  };
}

async function fetchDataSourceRows(config) {
  return queryRows(
    config,
    `
      select
        d.id,
        d.name,
        d.client_name,
        d.environment,
        d.status,
        d.sync_enabled,
        d.sync_interval_seconds,
        d.via_vpn,
        d.last_sync_at,
        d.last_sync_status,
        d.last_sync_error,
        d.last_success_at,
        d.last_error,
        d.failure_count,
        d.sync_locked_at,
        d.sync_lock_owner,
        d.display_order,
        d.created_at,
        d.updated_at,
        (d.token_encrypted is not null and d.token_encrypted <> '') as has_token,
        count(a.id)::int as alerts_count
      from data_sources d
      left join v_active_alerts a on a.data_source_id = d.id
      group by
        d.id,
        d.name,
        d.client_name,
        d.environment,
        d.status,
        d.sync_enabled,
        d.sync_interval_seconds,
        d.via_vpn,
        d.last_sync_at,
        d.last_sync_status,
        d.last_sync_error,
        d.last_success_at,
        d.last_error,
        d.failure_count,
        d.sync_locked_at,
        d.sync_lock_owner,
        d.display_order,
        d.created_at,
        d.updated_at,
        d.token_encrypted
      order by d.display_order asc, d.name asc
    `,
  );
}

async function fetchDataSourcesPayload(config) {
  return {
    generated_at: generatedAt(),
    items: mapDataSourceRows(await fetchDataSourceRows(config)),
  };
}

async function fetchSyncLogRows(config, limit = DEFAULT_SYNC_LOG_LIMIT) {
  return queryRows(
    config,
    `
      select
        sl.id,
        coalesce(d.name, d.client_name, 'Datasource OneView') as datasource,
        sl.data_source_id,
        sl.status,
        sl.fetched_count as fetched,
        sl.upserted_count as upserted,
        coalesce(sl.finished_at, sl.created_at, sl.started_at) as created_at
      from sync_logs sl
      join data_sources d on d.id = sl.data_source_id
      order by coalesce(sl.finished_at, sl.created_at, sl.started_at) desc, sl.id desc
      limit $1
    `,
    [limit],
  );
}

async function fetchSyncLogsPayload(req, config) {
  const rawLimit = Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit;
  const limit = integerValue(rawLimit, DEFAULT_SYNC_LOG_LIMIT, { min: 1, max: MAX_SYNC_LOG_LIMIT });
  return {
    generated_at: generatedAt(),
    items: mapSyncLogRows(await fetchSyncLogRows(config, limit)),
  };
}

async function fetchHealthPayload(config, acknowledgementEnabled = false, alertStaleMinutes = 15) {
  const [reachableRow, countsRow] = await Promise.all([
    queryRow(config, "select 1 as reachable"),
    queryRow(
      config,
      `
        select
          (select count(*)::int from alerts) as total_alerts,
          (select count(*)::int from v_active_alerts) as active_alerts
      `,
    ),
  ]);

  return {
    status: "ok",
    database_reachable: integerValue(reachableRow?.reachable, 0) === 1,
    counts: {
      total_alerts: integerValue(countsRow?.total_alerts, 0),
      active_alerts: integerValue(countsRow?.active_alerts, 0),
    },
    capabilities: {
      acknowledgement: acknowledgementEnabled === true,
    },
    thresholds: {
      alert_stale_minutes: integerValue(alertStaleMinutes, 15, { min: 1, max: 1440 }),
    },
  };
}

async function fetchDashboardSummaryPayload(config) {
  const [
    totalAlertsRow,
    activeAlertsRow,
    resolvedTodayRow,
    severityRows,
    statusRows,
    clientRows,
    serviceRows,
    topHostRows,
    unacknowledgedRow,
    longestDurationRows,
    ackMetricsRow,
    normalizationMetricsRow,
  ] = await Promise.all([
    queryRow(config, "select count(*)::int as value from alerts"),
    queryRow(config, "select count(*)::int as value from v_active_alerts"),
    queryRow(
      config,
      `select count(*)::int as value
         from alerts
        where resolved_at >= date_trunc('day', now())
          and resolved_at < date_trunc('day', now()) + interval '1 day'`,
    ),
    queryRows(config, "select severity, count(*)::int as count from v_active_alerts group by severity order by count desc, severity asc"),
    queryRows(config, "select status_internal, count(*)::int as count from v_active_alerts group by status_internal order by count desc, status_internal asc"),
    queryRows(
      config,
      "select coalesce(customer_name, 'Cliente não classificado') as client_name, count(*)::int as count from alerts where status_source = 'active' and resolved_at is null group by coalesce(customer_name, 'Cliente não classificado') order by count desc, client_name asc",
    ),
    queryRows(
      config,
      `
        select coalesce(service_name, '-') as service_name, coalesce(environment, 'internal') as environment, count(*)::int as count
        from v_active_alerts
        group by coalesce(service_name, '-'), coalesce(environment, 'internal')
        order by count desc, service_name asc
        limit 20
      `,
    ),
    queryRows(config, "select host_name, active_alerts::int as count from v_alert_top_hosts limit 10"),
    queryRow(config, "select count(*)::int as value from v_alert_unacknowledged"),
    queryRows(
      config,
      "select id, coalesce(customer_name, 'Cliente não classificado') as client_name, host_name, problem_name, severity, duration_seconds::int, first_seen_at from alerts where status_source = 'active' and resolved_at is null order by duration_seconds desc nulls last limit 10",
    ),
    queryRow(config, "select avg_ack_time_seconds::int as avg_ack_time_seconds from v_alert_ack_metrics"),
    queryRow(config, "select avg_normalization_time_seconds::int as avg_normalization_time_seconds from v_alert_normalization_metrics"),
  ]);

  const aliases = aliasMapFromHosts([
    ...topHostRows.map((row) => row.host_name),
    ...longestDurationRows.map((row) => row.host_name),
  ]);
  const alertsTotal = integerValue(totalAlertsRow?.value, 0);
  const activeTotal = integerValue(activeAlertsRow?.value, 0);

  return {
    generated_at: generatedAt(),
    alerts_total: alertsTotal,
    alerts_sample_size: activeTotal,
    active_total: activeTotal,
    resolved_today: integerValue(resolvedTodayRow?.value, 0),
    resolved_total: Math.max(alertsTotal - activeTotal, 0),
    by_severity: severityRows.map((row) => ({
      severity: textValue(row.severity, "not_classified"),
      count: integerValue(row.count, 0),
    })),
    by_status: statusRows.map((row) => ({
      status_internal: textValue(row.status_internal, "new"),
      count: integerValue(row.count, 0),
    })),
    by_client: clientRows.map((row) => ({
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      count: integerValue(row.count, 0),
    })),
    by_service: serviceRows.map((row) => ({
      service_name: sanitizeText(row.service_name, "-", 240),
      environment: textValue(row.environment, "internal"),
      count: integerValue(row.count, 0),
    })),
    top_hosts: mapTopHosts(topHostRows, aliases),
    unacknowledged_total: integerValue(unacknowledgedRow?.value, 0),
    longest_duration: mapLongestDurationRows(longestDurationRows, aliases),
    avg_ack_time_seconds: integerValue(ackMetricsRow?.avg_ack_time_seconds, 0),
    avg_normalization_time_seconds: integerValue(normalizationMetricsRow?.avg_normalization_time_seconds, 0),
  };
}

async function fetchGrafanaSummaryPayload(config) {
  const [
    activeAlertsRow,
    acknowledgedRow,
    severityRows,
    clientRows,
    lastUpdatedRow,
    dataSourceRows,
    syncLogRows,
  ] = await Promise.all([
    queryRow(config, "select count(*)::int as value from v_active_alerts"),
    queryRow(
      config,
      `
        select count(*)::int as value
        from v_active_alerts
        where coalesce(acknowledged_source, false) = true
           or coalesce(acknowledged_internal, false) = true
      `,
    ),
    queryRows(config, "select severity, count(*)::int as count from v_active_alerts group by severity order by count desc, severity asc"),
    queryRows(
      config,
      "select coalesce(customer_name, 'Cliente não classificado') as client, count(*)::int as count from alerts where status_source = 'active' and resolved_at is null group by coalesce(customer_name, 'Cliente não classificado') order by count desc, client asc",
    ),
    queryRow(config, "select max(last_seen_at) as last_updated_at from v_active_alerts"),
    fetchDataSourceRows(config),
    fetchSyncLogRows(config, 8),
  ]);

  const severityMap = Object.fromEntries(severityRows.map((row) => [textValue(row.severity), integerValue(row.count, 0)]));
  const total = integerValue(activeAlertsRow?.value, 0);
  const acknowledged = integerValue(acknowledgedRow?.value, 0);

  return {
    generated_at: generatedAt(),
    total,
    acknowledged,
    unacknowledged: Math.max(total - acknowledged, 0),
    average: integerValue(severityMap.average, 0) + integerValue(severityMap.warning, 0),
    high: integerValue(severityMap.high, 0),
    disaster: integerValue(severityMap.disaster, 0),
    by_client: clientRows.map((row) => ({
      client: sanitizeText(row.client, "Cliente OneView", 160),
      count: integerValue(row.count, 0),
    })),
    last_updated_at: isoDate(lastUpdatedRow?.last_updated_at),
    data_sources: mapDataSourceRows(dataSourceRows).map((source) => ({
      id: source.id,
      name: source.name,
      status: source.status,
      last_sync_at: source.last_sync_at,
      last_sync_status: source.last_sync_status,
      alerts_count: source.alerts_count,
    })),
    sync_logs: mapSyncLogRows(syncLogRows),
  };
}

async function fetchClientsSummaryPayload(config) {
  const [items, customerRows, datasourceRows] = await Promise.all([
    mapDataSourceRows(await fetchDataSourceRows(config)),
    queryRows(
      config,
      `
        select
          coalesce(a.customer_name, 'Cliente não classificado') as name,
          coalesce(a.customer_key, 'unclassified') as key,
          count(*)::int as alerts_count,
          count(*) filter (where a.customer_confidence = 'high')::int as high_confidence_count,
          count(*) filter (where a.customer_confidence = 'low')::int as low_confidence_count
        from alerts a
        where a.status_source = 'active' and a.resolved_at is null
        group by coalesce(a.customer_name, 'Cliente não classificado'), coalesce(a.customer_key, 'unclassified')
        order by alerts_count desc, name asc
      `,
    ),
    queryRows(
      config,
      `
        select d.id, d.name, count(a.id)::int as alerts_count
        from data_sources d
        left join alerts a
          on a.data_source_id = d.id
         and a.status_source = 'active'
         and a.resolved_at is null
        group by d.id, d.name
        order by alerts_count desc, d.name asc
      `,
    ),
  ]);
  return {
    generated_at: generatedAt(),
    clients: items.map((source) => ({
      id: source.id,
      name: source.client_name || source.name,
      status: source.status,
      alerts_count: source.alerts_count ?? 0,
      last_sync_at: source.last_sync_at,
    })),
    customers: customerRows.map((row) => ({
      key: sanitizeText(row.key, "unclassified", 160),
      name: sanitizeText(row.name, "Cliente não classificado", 160),
      alerts_count: integerValue(row.alerts_count, 0),
      high_confidence_count: integerValue(row.high_confidence_count, 0),
      low_confidence_count: integerValue(row.low_confidence_count, 0),
      enrichment_status: row.key === "unclassified" ? "pending" : "enriched",
    })),
    datasources: datasourceRows.map((row) => ({
      id: textValue(row.id),
      name: sanitizeText(row.name, "Datasource OneView", 160),
      alerts_count: integerValue(row.alerts_count, 0),
    })),
  };
}

export function getOneViewDbConfig(env = process.env) {
  const host = textValue(env.ONEVIEW_DB_HOST);
  const database = textValue(env.ONEVIEW_DB_NAME);
  const user = textValue(env.ONEVIEW_DB_USER);
  const readOnlyMode = booleanValue(env.ONEVIEW_READ_ONLY_MODE, true);
  if (readOnlyMode && user && user !== "oneview_vercel_readonly") {
    const error = new Error("unsafe_database_user");
    error.code = "unsafe_database_user";
    throw error;
  }

  const password = String(env.POSTGRES_READONLY_PASSWORD || "");
  const sslMode = textValue(env.ONEVIEW_DB_SSLMODE, "require").toLowerCase();

  if (!host || !database || !user || !password) {
    throw new Error("oneview_db_config_incomplete");
  }
  if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error("oneview_db_config_invalid");
  }

  return Object.freeze({
    host,
    port: integerValue(env.ONEVIEW_DB_PORT, 443, { min: 1, max: 65535 }),
    database,
    user,
    password,
    sslMode,
    rejectUnauthorized: booleanValue(env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED, true),
    poolMax: integerValue(env.ONEVIEW_DB_POOL_MAX, 2, { min: 1, max: 10 }),
    queryTimeoutMs: integerValue(env.ONEVIEW_DB_QUERY_TIMEOUT_MS, 10000, { min: 1000, max: 30000 }),
    connectionTimeoutMs: integerValue(env.ONEVIEW_DB_CONNECTION_TIMEOUT_MS, 10000, { min: 1000, max: 30000 }),
  });
}

export function getOneViewDbPool(config = getOneViewDbConfig()) {
  const signature = poolSignature(config);
  if (!pool || poolKey !== signature) {
    if (pool) {
      pool.end().catch(() => undefined);
    }
    pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.poolMax,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      ssl: poolSslConfig(config),
      application_name: "oneview-vercel-bff",
    });
    pool.on("error", (error) => {
      console.error(JSON.stringify({
        event: "oneview_database_pool_error",
        code: databaseFailureCode(error),
      }));
    });
    poolKey = signature;
  }
  return pool;
}

export function getOneViewDbPoolStats() {
  return {
    initialized: Boolean(pool),
    max: Number(pool?.options?.max || 0),
    total: Number(pool?.totalCount || 0),
    idle: Number(pool?.idleCount || 0),
    waiting: Number(pool?.waitingCount || 0),
  };
}

export async function fetchOneViewDatabase(routeName, req, config) {
  const dbConfig = config?.dbConfig || getOneViewDbConfig();
  try {
    switch (routeName) {
      case "health":
        return fetchHealthPayload(dbConfig, config?.ackEnabled, config?.alertStaleMinutes);
      case "dashboard-summary":
        return fetchDashboardSummaryPayload(dbConfig);
      case "grafana-summary":
        return fetchGrafanaSummaryPayload(dbConfig);
      case "alerts":
        return fetchAlertList(req, dbConfig);
      case "attention-required":
        return fetchAttentionRequiredPayload(req, dbConfig, config?.attentionThresholds);
      case "alert-detail":
        return fetchAlertDetailPayload(req, dbConfig);
      case "alert-history":
        return fetchAlertHistoryPayload(req, dbConfig);
      case "operations-health":
        return fetchOperationsHealthPayload(dbConfig);
      case "clients-summary":
        return fetchClientsSummaryPayload(dbConfig);
      case "data-sources":
        return fetchDataSourcesPayload(dbConfig);
      case "sync-logs":
        return fetchSyncLogsPayload(req, dbConfig);
      default:
        throw new Error("oneview_route_not_supported");
    }
  } catch (error) {
    if (error?.code === "invalid_query" || error?.code === "not_found") throw error;
    const failure = new Error("database_request_failed");
    failure.code = databaseFailureCode(error);
    throw failure;
  }
}

export async function resetOneViewDbPoolForTests() {
  if (pool) {
    await pool.end().catch(() => undefined);
  }
  pool = undefined;
  poolKey = "";
}
