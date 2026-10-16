import { createHash } from "node:crypto";
import pg from "pg";
import {
  projectServiceNowReferenceFromAlertTags,
  SERVICENOW_PROD_BASE_URL,
} from "./oneview-inc-correlation.js";
import { deriveHistoryEventOperationalScope, deriveOperationalScope } from "./oneview-operational-scope.js";
import { buildAlertRecurrenceReadModel, buildRecurrenceKey, hasRecurrenceIdentity, parseRecurrenceKey } from "./oneview-recurrence.js";
import {
  DEDICATED_DATASOURCE_CUSTOMER_LABELS,
  getOperationalDataSourceNames,
  ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES,
  splitAlertCustomerFilter,
} from "./oneview-scope.js";
import { deriveAlertTemporalIntegrity } from "./oneview-temporal-integrity.js";
import { OPERATOR_TAG_EXISTS_SQL } from "./oneview-operator-tags.js";
import { discoverOperatorCircuits } from "./oneview-operator-circuits.js";
import { buildOperationalSubject } from "./oneview-operational-subject.js";
import { getAckRequestConfig } from "./oneview-ack-request.js";
import { sourceAckCapability } from "./oneview-source-acknowledge.js";
import { buildHostNetwork } from "./oneview-host-network.js";
import {
  classifyOperationalQueue,
  describeDatasourceSync,
  describeSuppression,
  isOperationalQueueView,
  operationalQueueSql,
  ORIGIN_SNAPSHOT_JOIN_SQL,
  recoveryDurationSeconds,
  recoveryEvidenceOf,
  timeToAckSeconds,
} from "./oneview-operational-queue.js";
import { getServiceNowActionsConfig } from "./oneview-servicenow-actions.js";
import {
  classifyCustomerIntegrity,
  classifyIncidentIdentityIntegrity,
  classifyHostRegistry,
  classifyLinkHealth,
  classifyServiceNowWriteReadiness,
  classifyWriteReadiness,
  classifyTheoWebexHealth,
  classifyZabbixSourceTruth,
  fraportProbeForSource,
  THEO_DISPATCHER_HEARTBEAT_WORKER_ID,
  THEO_HEALTH_ACTION_TYPES,
} from "./oneview-runtime-health-truth.js";

const { Pool } = pg;

const OPERATIONAL_DATA_SOURCE_NAME_SET = new Set(ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES);

function operationalDataSourceNames(value = getOperationalDataSourceNames()) {
  const values = Array.isArray(value) ? value : [value];
  const allowed = values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => OPERATIONAL_DATA_SOURCE_NAME_SET.has(item));
  return [...new Set(allowed)];
}

const MAX_ALERT_PAGE_SIZE = 100;
const DEFAULT_ALERT_PAGE_SIZE = 50;
const MAX_ATTENTION_LIMIT = 200;
const DEFAULT_ATTENTION_LIMIT = 100;
const MAX_FILTER_VALUES = 20;
const MAX_SYNC_LOG_LIMIT = 50;
const DEFAULT_SYNC_LOG_LIMIT = 20;
const DEFAULT_OPERATIONAL_TIMEZONE = "America/Sao_Paulo";
const INTERNAL_ACKNOWLEDGEMENT_TYPES = ["internal"];
const INTERNAL_ACKNOWLEDGEMENT_STATUSES = ["recorded", "pending", "processing", "success", "completed"];

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

/**
 * OV-P0-52 — host operacional (sem "Host protegido").
 * Cadeia de apresentação: visible → technical → name (FE aplica "Host não informado").
 * Redação técnica permanece em histórico/logs via aliasForHost.
 */
function operationalHostFields(row) {
  return {
    host_visible_name: nullableText(sanitizeText(row?.host_visible_name, "", 240)),
    host_technical_name: nullableText(sanitizeText(row?.host_technical_name, "", 240)),
    host_name: nullableText(sanitizeText(row?.host_name, "", 240)),
  };
}

function operationalProblemName(row, fallback = "Alerta sincronizado") {
  return sanitizeText(row?.problem_name, fallback, 700);
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

function queryTokenValues(req, key) {
  return [...new Set(queryValues(req, key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(0, MAX_FILTER_VALUES);
}

function oneQueryValue(req, key) {
  return queryValues(req, key)[0] || "";
}

const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03", "53300",
]);

function sanitizedPgCode(error) {
  const code = String(error?.code || "");
  return /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function databaseFailureCode(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["28P01", "28000"].includes(code) || message.includes("password authentication failed")) {
    return "database_authentication_failed";
  }
  if (code === "42501" || code === "42503") return "database_permission_denied";
  if (code === "40P01") return "database_deadlock";
  if (["42601", "42704", "42883", "42P02"].includes(code)) return "database_query_rejected";
  if (code === "57014" || message.includes("canceling statement") || message.includes("statement timeout")) {
    return "database_timeout";
  }
  if (
    ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)
    || (message.includes("timeout") && !message.includes("timeout exceeded when trying to connect"))
  ) {
    return "database_timeout";
  }
  if (code.includes("CERT") || message.includes("certificate") || message.includes("tls") || message.includes("ssl")) {
    return "database_tls_failed";
  }
  if (["42P01", "42703"].includes(code)) return "database_schema_unavailable";
  if (
    TRANSIENT_CONNECTION_CODES.has(code)
    || message.includes("connection terminated")
    || message.includes("connection refused")
    || message.includes("timeout exceeded when trying to connect")
  ) {
    return "database_unavailable";
  }
  return "database_unavailable";
}

export function classifyOneViewDatabaseError(error) {
  return databaseFailureCode(error);
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
    config.statementTimeoutMs,
    config.idleTimeoutMs,
    config.maxLifetimeSeconds,
    config.idleInTransactionTimeoutMs,
  ]);
}

function poolSslConfig(config) {
  if (config.sslMode === "disable") return undefined;
  if (config.rejectUnauthorized === false) return { rejectUnauthorized: false };
  return true;
}

const ALERT_SEVERITIES = new Set(["disaster", "critical", "high", "average", "warning", "information", "not_classified"]);
const CUSTOMER_CONFIDENCES = new Set(["high", "medium", "low", "unclassified"]);
const ALERT_SORTS = Object.freeze({
  last_seen_at: "a.last_seen_at",
  first_seen_at: "a.first_seen_at",
  resolved_at: "a.resolved_at",
  severity: `case a.severity
    when 'disaster' then 7 when 'critical' then 6 when 'high' then 5 when 'average' then 4
    when 'warning' then 2 when 'information' then 1 else 0 end`,
  client: `case
    when a.customer_name is null or btrim(a.customer_name) = ''
      or lower(coalesce(a.customer_source, '')) = 'datasource_fallback'
      or lower(coalesce(a.customer_key, '')) = 'unclassified'
      then 'Cliente não identificado'
    else lower(btrim(a.customer_name))
  end`,
  datasource: "d.name",
  host: "a.host_name",
  problem: "a.problem_name",
  duration: `case
    when a.resolved_at is not null and a.first_seen_at is not null and a.resolved_at >= a.first_seen_at
      then floor(extract(epoch from (a.resolved_at - a.first_seen_at)))
    when a.resolved_at is null and a.first_seen_at is not null and a.first_seen_at <= now()
      then floor(extract(epoch from (now() - a.first_seen_at)))
    else null
  end`,
  status: `case
    when a.resolved_at is not null or lower(coalesce(a.status_source, '')) = 'resolved'
      or lower(coalesce(a.status_internal, '')) in ('resolved', 'normalized') then 1
    else 0 end`,
  acknowledged_source: "coalesce(a.acknowledged_source, false)",
  acknowledged_at: "a.acknowledged_at",
});

const RESOLVED_ALERT_SQL = `(
  lower(coalesce(a.status_source, '')) = 'resolved'
)`;

const ACTIVE_ALERT_SQL = `(
  a.resolved_at is null
  and lower(coalesce(a.status_source, 'active')) = 'active'
  and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')
)`;

const SOURCE_ACK_SQL = `coalesce(a.acknowledged_source, false) = true`;
const SOURCE_UNACK_SQL = `coalesce(a.acknowledged_source, false) = false`;
const PROVEN_SOURCE_ACK_CLOCK_SQL = `(
  select min(h.occurred_at)
    from alert_history h
   where h.alert_id = a.id
     and h.occurred_at is not null
     and lower(coalesce(h.action_type, '')) in ('acknowledged', 'ack_message')
     and h.occurred_at >= coalesce(a.last_reopened_at, a.first_seen_at)
     and (
       nullif(btrim(coalesce(h.source_event_id, '')), '') is null
       or h.source_event_id = a.source_event_id
     )
)`;
/** Operational pending: active origin-unacked only. Resolved never counts. */
const OPERATIONAL_PENDING_SQL = `(${ACTIVE_ALERT_SQL} and ${SOURCE_UNACK_SQL})`;

const UNIDENTIFIED_CUSTOMER_SQL = `(
  a.customer_name is null
  or btrim(a.customer_name) = ''
  or lower(btrim(a.customer_name)) in ('cliente não classificado', 'cliente nao classificado', 'cliente não identificado', 'cliente nao identificado')
  or lower(coalesce(a.customer_source, '')) = 'datasource_fallback'
  or lower(coalesce(a.customer_key, '')) = 'unclassified'
)`;

function dedicatedDatasourceCustomerCaseSql(valueKind) {
  return Object.entries(DEDICATED_DATASOURCE_CUSTOMER_LABELS)
    .map(([key, label]) => {
      const value = valueKind === "key" ? key : String(label).replace(/'/g, "''");
      return `when lower(btrim(d.name)) = '${key}' and (${UNIDENTIFIED_CUSTOMER_SQL}) then '${value}'`;
    })
    .join("\n  ");
}

// Identidade de cliente é de leitura: nunca reescreve os alertas históricos.
// A chave só elimina variações seguras de casing/espaços; não faz fuzzy match.
const SAFE_CUSTOMER_KEY_SQL = `case
  ${dedicatedDatasourceCustomerCaseSql("key")}
  when ${UNIDENTIFIED_CUSTOMER_SQL} then 'unclassified'
  else lower(btrim(a.customer_name))
end`;

// Preferências oficiais conhecidas; o fallback mantém capitalização determinística.
const SAFE_CUSTOMER_NAME_SQL = `case
  ${dedicatedDatasourceCustomerCaseSql("name")}
  when ${UNIDENTIFIED_CUSTOMER_SQL} then 'Cliente não identificado'
  when lower(btrim(a.customer_name)) = 'ailos' then 'Ailos'
  when lower(btrim(a.customer_name)) = 'jfsc' then 'JFSC'
  when lower(btrim(a.customer_name)) in ('solarwinds', 'sollarwinds') then 'Congás'
  else initcap(lower(btrim(a.customer_name)))
end`;

// Reconhecimento interno novo é append-only. O campo legado continua sendo
// lido para compatibilidade, mas a API de ação não atualiza public.alerts.
const INTERNAL_ACKNOWLEDGED_SQL = `(coalesce(a.acknowledged_internal, false) or exists (
  select 1
    from alert_acknowledgements internal_ack
   where internal_ack.alert_id = a.id
     and internal_ack.acknowledgement_type in ('internal','internal_acknowledgement')
     and internal_ack.status in ('recorded','pending','processing','success','completed')
))`;

// ACK OneView Ã© a Ãºltima aÃ§Ã£o delegada criada pelo OneView. NÃ£o altera nem
// deriva o estado do alerta, que continua vindo de status_source/acknowledged_source.
const LATEST_ONEVIEW_ACK_STATUS_SQL = `(select ack.status
  from alert_acknowledgements ack
 where ack.alert_id = a.id
   and ack.acknowledgement_type = 'source'
 order by ack.requested_at desc, ack.id desc
 limit 1)`;

const ONEVIEW_ACK_PENDING_SQL = `${LATEST_ONEVIEW_ACK_STATUS_SQL} in ('pending', 'processing')`;

export function isResolvedAlert(alert) {
  const sourceStatus = textValue(alert?.status_source).toLowerCase();
  const internalStatus = textValue(alert?.status_internal).toLowerCase();
  return Boolean(alert?.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

export function operationalTimezone(value = DEFAULT_OPERATIONAL_TIMEZONE) {
  const candidate = textValue(value, DEFAULT_OPERATIONAL_TIMEZONE);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_OPERATIONAL_TIMEZONE;
  }
}

function zonedDateTimeToUtc(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rendered = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const renderedUtc = Date.UTC(
      Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day),
      Number(rendered.hour), Number(rendered.minute), Number(rendered.second),
    );
    guess += target - renderedUtc;
  }
  return new Date(guess);
}

export function operationalDayBounds(timeZone = DEFAULT_OPERATIONAL_TIMEZONE, now = new Date()) {
  const zone = operationalTimezone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const current = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const year = Number(current.year);
  const month = Number(current.month);
  const day = Number(current.day);
  const nextCalendarDay = new Date(Date.UTC(year, month - 1, day + 1));
  const start = zonedDateTimeToUtc({ year, month, day }, zone);
  const end = zonedDateTimeToUtc({
    year: nextCalendarDay.getUTCFullYear(),
    month: nextCalendarDay.getUTCMonth() + 1,
    day: nextCalendarDay.getUTCDate(),
  }, zone);
  return Object.freeze({
    timeZone: zone,
    from: start.toISOString(),
    to: end.toISOString(),
  });
}

export function dailyOperationalMetricQueries(
  timeZone = DEFAULT_OPERATIONAL_TIMEZONE,
  now = new Date(),
  dataSourceNames = getOperationalDataSourceNames(),
) {
  const day = operationalDayBounds(timeZone, now);
  const values = [operationalDataSourceNames(dataSourceNames), day.from, day.to];
  return Object.freeze({
    day,
    resolved: Object.freeze({
      text: `select count(*)::int as value
               from alerts a
               join data_sources d on d.id = a.data_source_id
              where d.name = any($1::text[])
                and a.resolved_at >= $2::timestamptz
                and a.resolved_at < $3::timestamptz`,
      values,
    }),
    sourceAcknowledged: Object.freeze({
      text: `select count(*)::int as value
               from alerts a
               join data_sources d on d.id = a.data_source_id
              where d.name = any($1::text[])
                and a.acknowledged_source = true
                and a.acknowledged_at >= $2::timestamptz
                and a.acknowledged_at < $3::timestamptz`,
      values,
    }),
    oneViewAcknowledged: Object.freeze({
      text: `select count(*)::int as value
               from alert_acknowledgements ack
               join alerts a on a.id = ack.alert_id
               join data_sources d on d.id = a.data_source_id
              where d.name = any($1::text[])
                and ack.acknowledgement_type = any($4::text[])
                and ack.status = any($5::text[])
                and ack.requested_at >= $2::timestamptz
                and ack.requested_at < $3::timestamptz`,
      values: [...values, INTERNAL_ACKNOWLEDGEMENT_TYPES, INTERNAL_ACKNOWLEDGEMENT_STATUSES],
    }),
  });
}

export function countDailyOperationalMetrics({ alerts = [], acknowledgements = [] } = {}, timeZone = DEFAULT_OPERATIONAL_TIMEZONE, now = new Date()) {
  const day = operationalDayBounds(timeZone, now);
  const withinDay = (value) => {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp)
      && timestamp >= Date.parse(day.from)
      && timestamp < Date.parse(day.to);
  };
  return Object.freeze({
    resolved_today: alerts.filter((alert) => withinDay(alert?.resolved_at)).length,
    source_acknowledgements_today: alerts.filter((alert) => (
      alert?.acknowledged_source === true && withinDay(alert?.acknowledged_at ?? alert?.acknowledged_source_at)
    )).length,
    oneview_acknowledgements_today: acknowledgements.filter((acknowledgement) => (
      INTERNAL_ACKNOWLEDGEMENT_TYPES.includes(textValue(acknowledgement?.acknowledgement_type).toLowerCase())
      && INTERNAL_ACKNOWLEDGEMENT_STATUSES.includes(textValue(acknowledgement?.status).toLowerCase())
      && withinDay(acknowledgement?.requested_at)
    )).length,
    operational_day: day,
  });
}

export function isActiveAlert(alert) {
  return !isResolvedAlert(alert)
    && textValue(alert?.status_source, "active").toLowerCase() === "active";
}

export function isSourceAcknowledged(alert) {
  return Boolean(alert?.acknowledged_source);
}

export function isOperationalPendingAlert(alert) {
  return isActiveAlert(alert) && !isSourceAcknowledged(alert);
}

export function isOneViewAckPending(alert) {
  const status = textValue(alert?.oneview_ack?.status ?? alert?.oneview_ack_status ?? alert?.source_ack_status).toLowerCase();
  return status === "pending" || status === "processing";
}

export function summarizeOperationalAckCounts(alerts = []) {
  const items = Array.isArray(alerts) ? alerts : [];
  return Object.freeze({
    acknowledged_source: items.filter(isSourceAcknowledged).length,
    unacknowledged_source: items.filter((item) => !isSourceAcknowledged(item)).length,
    operational_pending: items.filter(isOperationalPendingAlert).length,
    oneview_ack_pending: items.filter(isOneViewAckPending).length,
    active: items.filter(isActiveAlert).length,
    resolved: items.filter(isResolvedAlert).length,
  });
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
    lowMinutes: integerValue(env.ONEVIEW_LOW_UNACK_MINUTES, 60, { min: 1, max: 1440 }),
  });
}

export function buildAttentionRequiredQuery(
  req,
  thresholds = getAttentionThresholds(),
  dataSourceNames = getOperationalDataSourceNames(),
) {
  const limit = positiveInteger(oneQueryValue(req, "limit"), DEFAULT_ATTENTION_LIMIT, { maximum: MAX_ATTENTION_LIMIT });
  const firstSeenFrom = isoFilterDate(oneQueryValue(req, "first_seen_from"));
  const firstSeenTo = isoFilterDate(oneQueryValue(req, "first_seen_to"));
  if (firstSeenFrom && firstSeenTo && Date.parse(firstSeenFrom) > Date.parse(firstSeenTo)) {
    throw requestError("invalid_query");
  }
  const values = [
    thresholds.disasterMinutes,
    thresholds.highMinutes,
    thresholds.averageMinutes,
    thresholds.lowMinutes,
    operationalDataSourceNames(dataSourceNames),
  ];
  const clauses = [
    ACTIVE_ALERT_SQL,
    "coalesce(a.acknowledged_source, false) = false",
    `exists (
      select 1
      from data_sources scope_d
      where scope_d.id = a.data_source_id
        and scope_d.name = any($5::text[])
    )`,
    "a.first_seen_at is not null",
    `(
      (a.severity in ('disaster', 'critical') and a.first_seen_at < now() - ($1::int * interval '1 minute'))
      or (a.severity = 'high' and a.first_seen_at < now() - ($2::int * interval '1 minute'))
      or (a.severity = 'average' and a.first_seen_at < now() - ($3::int * interval '1 minute'))
      or (a.severity in ('warning', 'information', 'not_classified') and a.first_seen_at < now() - ($4::int * interval '1 minute'))
    )`,
  ];
  if (firstSeenFrom) {
    values.push(firstSeenFrom);
    clauses.push(`a.first_seen_at >= $${values.length}::timestamptz`);
  }
  if (firstSeenTo) {
    values.push(firstSeenTo);
    clauses.push(`a.first_seen_at <= $${values.length}::timestamptz`);
  }
  return {
    limit,
    values,
    firstSeenFrom,
    firstSeenTo,
    whereSql: clauses.join("\n    and "),
    orderSql: `
      case a.severity
        when 'disaster' then 1 when 'critical' then 1
        when 'high' then 2
        when 'average' then 3
        else 4
      end asc,
      unacknowledged_minutes desc,
      a.id desc
    `,
  };
}

export function attentionRequiredState(
  alert,
  thresholds = getAttentionThresholds(),
  now = Date.now(),
  options = {},
) {
  const severity = textValue(alert?.severity).toLowerCase();
  const firstSeenAt = Date.parse(alert?.first_seen_at || alert?.started_at || "");
  const active = isActiveAlert(alert);
  const acknowledgedAtOrigin = Boolean(alert?.acknowledged_source);
  const threshold = severity === "disaster" || severity === "critical"
    ? thresholds.disasterMinutes
    : severity === "high"
      ? thresholds.highMinutes
      : severity === "average"
        ? thresholds.averageMinutes
        : ["warning", "information", "not_classified"].includes(severity)
          ? thresholds.lowMinutes
          : null;
  const ageMilliseconds = Number.isNaN(firstSeenAt) ? 0 : Math.max(now - firstSeenAt, 0);
  const unacknowledgedMinutes = Math.floor(ageMilliseconds / 60000);
  const firstSeenFromMs = options.firstSeenFrom ? Date.parse(options.firstSeenFrom) : NaN;
  const firstSeenToMs = options.firstSeenTo ? Date.parse(options.firstSeenTo) : NaN;
  const withinFrom = Number.isNaN(firstSeenFromMs) || (!Number.isNaN(firstSeenAt) && firstSeenAt >= firstSeenFromMs);
  const withinTo = Number.isNaN(firstSeenToMs) || (!Number.isNaN(firstSeenAt) && firstSeenAt <= firstSeenToMs);
  return {
    matches: Boolean(
      active
      && !acknowledgedAtOrigin
      && threshold !== null
      && ageMilliseconds > threshold * 60000
      && withinFrom
      && withinTo,
    ),
    unacknowledgedMinutes,
  };
}

export function compareAttentionRequiredEntries(left, right) {
  const severityRank = {
    disaster: 1,
    critical: 1,
    high: 2,
    average: 3,
    warning: 4,
    information: 4,
    not_classified: 4,
  };
  const severityDifference = (severityRank[left?.alert?.severity] ?? 5) - (severityRank[right?.alert?.severity] ?? 5);
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

const INCIDENT_REFERENCE_TAG_ROWS_SQL = `
  select lower(coalesce(tag->>'tag', tag->>'name', '')) as name,
         btrim(coalesce(tag->>'value', '')) as value
    from jsonb_array_elements(
      case when jsonb_typeof(coalesce(a.event_tags, '[]'::jsonb)) = 'array' then coalesce(a.event_tags, '[]'::jsonb) else '[]'::jsonb end
      || case when jsonb_typeof(coalesce(a.trigger_tags, '[]'::jsonb)) = 'array' then coalesce(a.trigger_tags, '[]'::jsonb) else '[]'::jsonb end
      || case when jsonb_typeof(coalesce(a.host_tags, '[]'::jsonb)) = 'array' then coalesce(a.host_tags, '[]'::jsonb) else '[]'::jsonb end
      || case when jsonb_typeof(a.payload_normalized->'tags') = 'array' then a.payload_normalized->'tags' else '[]'::jsonb end
    ) tag
`;

/** Strict identity: one sys_id tag, else one unique INC tag, else one source event match. */
function incidentCorrelationSql({ statesParam = null, numberParam = null } = {}) {
  const incidentMatch = (alias) => [
    statesParam ? `${alias}.state::text = any(${statesParam}::text[])` : null,
    numberParam ? `upper(${alias}.number::text) like ${numberParam}` : null,
  ].filter(Boolean).join(" and ") || "true";
  return `exists (
    with tag_rows as (${INCIDENT_REFERENCE_TAG_ROWS_SQL}), refs as (
      select array_agg(distinct lower(value)) filter (
               where name = '__zbx_servicenow_sys_id' and value ~* '^[a-f0-9]{32}$'
             ) as sys_ids,
             array_agg(distinct upper(value)) filter (
               where name = '__zbx_servicenow_number' and value ~* '^INC[0-9]+$'
             ) as numbers
        from tag_rows
    )
    select 1 from refs
     where case
       when cardinality(coalesce(sys_ids, array[]::text[])) > 0 then
         cardinality(sys_ids) = 1 and exists (
           select 1 from servicenow_incidents i
            where lower(i.sys_id::text) = sys_ids[1] and ${incidentMatch("i")}
         )
       when cardinality(coalesce(numbers, array[]::text[])) > 0 then
         cardinality(numbers) = 1
         and (select count(*) from servicenow_incidents i where upper(i.number::text) = numbers[1]) = 1
         and exists (
           select 1 from servicenow_incidents i
            where upper(i.number::text) = numbers[1] and ${incidentMatch("i")}
         )
       else
         (select count(*) from servicenow_incidents i
           where coalesce(
             nullif(btrim(i.correlation_id::text), ''),
             nullif(btrim(i.raw_payload->>'zabbix_event_id'), ''),
             nullif(btrim(i.raw_payload->>'u_zabbix_event_id'), '')
           ) = coalesce(a.source_event_id::text, a.source_problem_id::text)
         ) = 1
         and exists (
           select 1 from servicenow_incidents i
            where coalesce(
              nullif(btrim(i.correlation_id::text), ''),
              nullif(btrim(i.raw_payload->>'zabbix_event_id'), ''),
              nullif(btrim(i.raw_payload->>'u_zabbix_event_id'), '')
            ) = coalesce(a.source_event_id::text, a.source_problem_id::text)
              and ${incidentMatch("i")}
         )
     end
  )`;
}

const ALERT_LIST_INCLUDE_PARTS = Object.freeze(["items", "summary", "temporal"]);

export function parseAlertListInclude(raw) {
  const value = textValue(raw).trim().toLowerCase();
  if (!value) return { items: true, summary: true, temporal: true };
  const parts = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (!parts.length) return { items: true, summary: true, temporal: true };
  if (parts.some((part) => !ALERT_LIST_INCLUDE_PARTS.includes(part))) throw requestError("invalid_query");
  return {
    items: parts.includes("items"),
    summary: parts.includes("summary"),
    temporal: parts.includes("temporal"),
  };
}

export function buildAlertListQuery(req, dataSourceNames = getOperationalDataSourceNames()) {
  const params = [];
  const clauses = [];
  const push = (clause, value) => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };

  const page = positiveInteger(oneQueryValue(req, "page"), 1);
  const pageSize = positiveInteger(oneQueryValue(req, "page_size"), DEFAULT_ALERT_PAGE_SIZE, { maximum: MAX_ALERT_PAGE_SIZE });
  const clients = queryValues(req, "client").map((value) => value.slice(0, 160));
  const rawCustomers = queryValues(req, "customer").map((value) => value.slice(0, 160));
  const rawDatasources = queryValues(req, "datasource").map((value) => value.slice(0, 160));
  const splitCustomers = splitAlertCustomerFilter(rawCustomers, getOperationalDataSourceNames());
  const customers = splitCustomers.customers;
  const datasources = [...new Set([...rawDatasources, ...splitCustomers.datasources])];
  const customerConfidences = queryValues(req, "customer_confidence").map((value) => value.toLowerCase());
  const severities = queryValues(req, "severity").map((value) => value.toLowerCase());
  const operationalView = oneQueryValue(req, "operational_view").toLowerCase();
  const status = (oneQueryValue(req, "status") || (operationalView ? "all" : "active")).toLowerCase();
  const acknowledged = oneQueryValue(req, "acknowledged").toLowerCase();
  const acknowledgedSource = oneQueryValue(req, "acknowledged_source").toLowerCase();
  const acknowledgedInternal = oneQueryValue(req, "acknowledged_internal").toLowerCase();
  const oneviewAckStatuses = queryTokenValues(req, "oneview_ack_status").map((value) => value.toLowerCase());
  const ackActor = oneQueryValue(req, "ack_actor").slice(0, 160);
  const search = oneQueryValue(req, "search").slice(0, 200);
  const searchField = (oneQueryValue(req, "search_field") || "all").toLowerCase();
  const hostSearch = oneQueryValue(req, "host_search").slice(0, 200);
  const problemSearch = oneQueryValue(req, "problem_search").slice(0, 200);
  const dateFrom = isoFilterDate(oneQueryValue(req, "date_from"));
  const dateTo = isoFilterDate(oneQueryValue(req, "date_to"));
  const firstSeenFrom = isoFilterDate(oneQueryValue(req, "first_seen_from"));
  const firstSeenTo = isoFilterDate(oneQueryValue(req, "first_seen_to"));
  const lastSeenFrom = isoFilterDate(oneQueryValue(req, "last_seen_from"));
  const lastSeenTo = isoFilterDate(oneQueryValue(req, "last_seen_to"));
  const resolvedFrom = isoFilterDate(oneQueryValue(req, "resolved_from"));
  const resolvedTo = isoFilterDate(oneQueryValue(req, "resolved_to"));
  const acknowledgedFrom = isoFilterDate(oneQueryValue(req, "acknowledged_from"));
  const acknowledgedTo = isoFilterDate(oneQueryValue(req, "acknowledged_to"));
  const sort = (oneQueryValue(req, "sort") || "last_seen_at").toLowerCase();
  const order = (oneQueryValue(req, "order") || "desc").toLowerCase();
  const sortSecondary = (oneQueryValue(req, "sort_secondary") || "").toLowerCase();
  const recurrenceKeyRaw = oneQueryValue(req, "recurrence_key");
  const recurrenceKey = recurrenceKeyRaw ? parseRecurrenceKey(recurrenceKeyRaw) : null;
  const excludeOperator = oneQueryValue(req, "exclude_operator").toLowerCase();
  const incidentStates = queryTokenValues(req, "incident_state");
  const incidentNumber = oneQueryValue(req, "incident_number").trim().toUpperCase().slice(0, 40);

  if (severities.some((value) => !ALERT_SEVERITIES.has(value))) throw requestError("invalid_query");
  if (customerConfidences.some((value) => !CUSTOMER_CONFIDENCES.has(value))) throw requestError("invalid_query");
  if (!["active", "resolved", "all"].includes(status)) throw requestError("invalid_query");
  if (operationalView && !isOperationalQueueView(operationalView)) throw requestError("invalid_query");
  if (acknowledged && !["true", "false"].includes(acknowledged)) throw requestError("invalid_query");
  if (acknowledgedSource && !["true", "false"].includes(acknowledgedSource)) throw requestError("invalid_query");
  if (acknowledgedInternal && !["true", "false"].includes(acknowledgedInternal)) throw requestError("invalid_query");
  if (oneviewAckStatuses.some((value) => !["pending", "processing", "success", "cancelled", "failed"].includes(value))) throw requestError("invalid_query");
  if (!["all", "host", "problem", "customer", "eventid"].includes(searchField)) throw requestError("invalid_query");
  if (!Object.hasOwn(ALERT_SORTS, sort) || !["asc", "desc"].includes(order)) throw requestError("invalid_query");
  if (sortSecondary && (!Object.hasOwn(ALERT_SORTS, sortSecondary) || sortSecondary === sort)) {
    throw requestError("invalid_query");
  }
  if (dateFrom && dateTo && Date.parse(dateFrom) > Date.parse(dateTo)) throw requestError("invalid_query");
  if (firstSeenFrom && firstSeenTo && Date.parse(firstSeenFrom) > Date.parse(firstSeenTo)) throw requestError("invalid_query");
  if (lastSeenFrom && lastSeenTo && Date.parse(lastSeenFrom) > Date.parse(lastSeenTo)) throw requestError("invalid_query");
  if (resolvedFrom && resolvedTo && Date.parse(resolvedFrom) > Date.parse(resolvedTo)) throw requestError("invalid_query");
  if (acknowledgedFrom && acknowledgedTo && Date.parse(acknowledgedFrom) > Date.parse(acknowledgedTo)) throw requestError("invalid_query");
  if (recurrenceKeyRaw && !recurrenceKey) throw requestError("invalid_query");
  if (excludeOperator && !["true", "false"].includes(excludeOperator)) throw requestError("invalid_query");
  if (incidentStates.some((value) => !/^[1-8]$/.test(value))) throw requestError("invalid_query");
  if (incidentNumber && !/^INC\d{0,20}$/.test(incidentNumber)) throw requestError("invalid_query");
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw requestError("invalid_query");

  push("d.name = any(?::text[])", operationalDataSourceNames(dataSourceNames));
  if (recurrenceKey) {
    push("a.data_source_id::text = ?", recurrenceKey.data_source_id);
    push("a.source_host_id::text = ?", recurrenceKey.source_host_id);
    push("a.source_trigger_id::text = ?", recurrenceKey.source_trigger_id);
  }
  if (clients.length) push("a.client_name = any(?::text[])", clients);
  if (customers.length) {
    const includesUnidentified = customers.some((value) => value.toLowerCase() === "unclassified");
    const identifiedKeys = customers.filter((value) => value.toLowerCase() !== "unclassified");
    if (includesUnidentified && identifiedKeys.length) {
      push(`(${UNIDENTIFIED_CUSTOMER_SQL} or ${SAFE_CUSTOMER_KEY_SQL} = any(?::text[]))`, identifiedKeys);
    } else if (includesUnidentified) {
      clauses.push(UNIDENTIFIED_CUSTOMER_SQL);
    } else {
      push(`${SAFE_CUSTOMER_KEY_SQL} = any(?::text[])`, identifiedKeys);
    }
  }
  if (datasources.length) push("d.name = any(?::text[])", datasources);
  if (customerConfidences.length) {
    push("coalesce(a.customer_confidence, 'unclassified') = any(?::text[])", customerConfidences);
  }
  if (severities.length) push("a.severity = any(?::text[])", severities);
  // operational_view defines the queue; status remains an optional intersection.
  // status_internal alone never selects history.
  const viewClause = operationalView ? operationalQueueSql(operationalView) : null;
  if (viewClause) clauses.push(viewClause);
  if (status === "active") clauses.push(ACTIVE_ALERT_SQL);
  if (status === "resolved") clauses.push(RESOLVED_ALERT_SQL);
  // OV-P0-248: Home only. /alertas remains unfiltered unless it explicitly opts in.
  if (excludeOperator === "true") clauses.push(`not (${OPERATOR_TAG_EXISTS_SQL})`);
  if (incidentStates.length || incidentNumber) {
    let statesParam = null;
    let numberParam = null;
    if (incidentStates.length) {
      params.push(incidentStates);
      statesParam = `$${params.length}`;
    }
    if (incidentNumber) {
      params.push(`${incidentNumber}%`);
      numberParam = `$${params.length}`;
    }
    clauses.push(incidentCorrelationSql({ statesParam, numberParam }));
  }
  if (acknowledged) {
    push(
      `(coalesce(a.acknowledged_source, false) or ${INTERNAL_ACKNOWLEDGED_SQL}) = ?`,
      acknowledged === "true",
    );
  }
  if (acknowledgedSource) push("coalesce(a.acknowledged_source, false) = ?", acknowledgedSource === "true");
  if (acknowledgedInternal) push(`${INTERNAL_ACKNOWLEDGED_SQL} = ?`, acknowledgedInternal === "true");
  if (oneviewAckStatuses.length) {
    const expandedStatuses = [...new Set(oneviewAckStatuses.flatMap((value) => value === "pending" ? ["pending", "processing"] : [value]))];
    push(`${LATEST_ONEVIEW_ACK_STATUS_SQL} = any(?::text[])`, expandedStatuses);
  }
  if (ackActor) {
    push(
      `(coalesce(a.acknowledged_by, '') ilike ? or exists (
        select 1
          from alert_acknowledgements ack_actor
         where ack_actor.alert_id = a.id
           and ack_actor.acknowledgement_type = 'source'
           and coalesce(ack_actor.operator_name, '') ilike $CURRENT
      ))`,
      `%${ackActor}%`,
    );
    const current = `$${params.length}`;
    clauses[clauses.length - 1] = clauses[clauses.length - 1].replaceAll("$CURRENT", current);
  }
  if (search) {
    if (searchField === "host") {
      push(
        "coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ?",
        `%${search}%`,
      );
    } else if (searchField === "problem") {
      push("coalesce(a.problem_name, '') ilike ?", `%${search}%`);
    } else if (searchField === "customer") {
      push(
        "(coalesce(a.customer_name, '') ilike $CURRENT or coalesce(a.client_name, '') ilike $CURRENT or coalesce(a.customer_key, '') ilike $CURRENT or " + SAFE_CUSTOMER_NAME_SQL + " ilike $CURRENT)",
        `%${search}%`,
      );
      const current = `$${params.length}`;
      clauses[clauses.length - 1] = clauses[clauses.length - 1].replaceAll("$CURRENT", current);
    } else if (searchField === "eventid") {
      push("coalesce(a.source_event_id, a.id::text, '') ilike ?", `%${search}%`);
    } else {
      push(
        `(coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike $CURRENT or coalesce(a.problem_name, '') ilike $CURRENT or coalesce(a.service_name, '') ilike $CURRENT or coalesce(a.customer_name, '') ilike $CURRENT or coalesce(a.client_name, '') ilike $CURRENT or coalesce(a.customer_key, '') ilike $CURRENT or coalesce(a.source_event_id, a.id::text, '') ilike $CURRENT or ${SAFE_CUSTOMER_NAME_SQL} ilike $CURRENT or lower(d.name) ilike $CURRENT)`,
        `%${search}%`,
      );
      const current = `$${params.length}`;
      clauses[clauses.length - 1] = clauses[clauses.length - 1].replaceAll("$CURRENT", current);
    }
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

  const baseParams = [...params];
  const baseWhereSql = clauses.length ? `where ${clauses.join(" and ")}` : "";

  if (dateFrom) push("a.last_seen_at >= ?", dateFrom);
  if (dateTo) push("a.last_seen_at <= ?", dateTo);
  if (firstSeenFrom) push("a.first_seen_at >= ?", firstSeenFrom);
  if (firstSeenTo) push("a.first_seen_at <= ?", firstSeenTo);
  if (lastSeenFrom) push("a.last_seen_at >= ?", lastSeenFrom);
  if (lastSeenTo) push("a.last_seen_at <= ?", lastSeenTo);
  if (resolvedFrom) push("a.resolved_at >= ?", resolvedFrom);
  if (resolvedTo) push("a.resolved_at <= ?", resolvedTo);
  if (acknowledgedFrom) push("a.acknowledged_at >= ?", acknowledgedFrom);
  if (acknowledgedTo) push("a.acknowledged_at <= ?", acknowledgedTo);

  const scopeClauses = viewClause ? clauses.filter((clause) => clause !== viewClause) : clauses;
  const direction = order.toUpperCase();
  const nullableSort = sort === "resolved_at" || sort === "acknowledged_at" ? " nulls last" : "";
  const secondarySql = sortSecondary
    ? `${ALERT_SORTS[sortSecondary]} DESC${sortSecondary === "resolved_at" || sortSecondary === "acknowledged_at" ? " nulls last" : ""}`
    : sort === "severity"
      ? "a.first_seen_at desc, a.last_seen_at desc"
      : "a.last_seen_at desc";
  return {
    page,
    pageSize,
    offset,
    params,
    baseParams,
    baseWhereSql,
    scopeParams: params,
    scopeWhereSql: scopeClauses.length ? `where ${scopeClauses.join(" and ")}` : "",
    whereSql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    orderSql: `${ALERT_SORTS[sort]} ${direction}${nullableSort}, ${secondarySql}, a.id desc`,
    filters: {
      clients,
      customers,
      datasources,
      customerConfidences,
      severities,
      status,
      operationalView,
      acknowledged,
      acknowledgedSource,
      acknowledgedInternal,
      oneviewAckStatus: oneviewAckStatuses[0] || "",
      oneviewAckStatuses,
      ackActor,
      search,
      searchField,
      hostSearch,
      problemSearch,
      dateFrom,
      dateTo,
      firstSeenFrom,
      firstSeenTo,
      lastSeenFrom,
      lastSeenTo,
      resolvedFrom,
      resolvedTo,
      acknowledgedFrom,
      acknowledgedTo,
      sort,
      order,
      sortSecondary,
      recurrenceKey: recurrenceKeyRaw || null,
      excludeOperator: excludeOperator === "true",
      incidentState: incidentStates[0] || null,
      incidentStates,
      incidentNumber: incidentNumber || null,
    },
    include: parseAlertListInclude(oneQueryValue(req, "include")),
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

const CANONICAL_CUSTOMER_DISPLAY_NAMES = Object.freeze({
  ailos: "Ailos",
  jfsc: "JFSC",
  solarwinds: "Congás",
  sollarwinds: "Congás",
});

export function canonicalCustomerKey(value) {
  return textValue(value).toLowerCase();
}

export function canonicalCustomerDisplayName(value) {
  const original = textValue(value);
  const key = canonicalCustomerKey(original);
  if (!key) return "";
  if (CANONICAL_CUSTOMER_DISPLAY_NAMES[key]) return CANONICAL_CUSTOMER_DISPLAY_NAMES[key];
  return key.replace(/(^|[\s_-])([\p{L}])/gu, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

export function dedicatedDatasourceCustomerIdentity(alert) {
  const datasource = canonicalCustomerKey(alert?.datasource_name ?? alert?.data_source_name);
  const label = DEDICATED_DATASOURCE_CUSTOMER_LABELS[datasource];
  if (!label) return null;
  const customerNameOriginal = textValue(alert?.customer_name);
  const source = textValue(alert?.customer_source).toLowerCase();
  const key = canonicalCustomerKey(alert?.customer_key);
  const unidentified = !customerNameOriginal
    || source === "datasource_fallback"
    || key === "unclassified"
    || ["cliente nao classificado", "cliente nao identificado"].includes(normalizedCustomerName(customerNameOriginal));
  if (!unidentified) return null;
  return {
    customerName: label,
    customerNameOriginal: label,
    customerKey: datasource,
    unidentified: false,
    customerSource: "dedicated_datasource",
  };
}

export function safeCustomerIdentity(alert) {
  const dedicated = dedicatedDatasourceCustomerIdentity(alert);
  if (dedicated) {
    return {
      customerName: dedicated.customerName,
      customerNameOriginal: dedicated.customerNameOriginal,
      customerKey: dedicated.customerKey,
      unidentified: false,
    };
  }
  const customerNameOriginal = textValue(alert?.customer_name);
  const normalizedName = normalizedCustomerName(customerNameOriginal);
  const source = textValue(alert?.customer_source).toLowerCase();
  const key = canonicalCustomerKey(alert?.customer_key);
  const unidentified = !customerNameOriginal
    || source === "datasource_fallback"
    || key === "unclassified"
    || ["cliente nao classificado", "cliente nao identificado"].includes(normalizedName);
  return {
    customerName: unidentified ? null : canonicalCustomerDisplayName(customerNameOriginal),
    customerNameOriginal: unidentified ? null : customerNameOriginal,
    customerKey: unidentified ? "unclassified" : canonicalCustomerKey(customerNameOriginal),
    unidentified,
  };
}

export function classifyAlertEnrichment(alert) {
  if (dedicatedDatasourceCustomerIdentity(alert)) return "complete";
  const customerName = normalizedCustomerName(alert?.customer_name);
  if (textValue(alert?.customer_source).toLowerCase() === "datasource_fallback") return "unclassified";
  if (["cliente nao classificado", "cliente nao identificado"].includes(customerName)) return "unclassified";
  if (!customerName) return "legacy";
  return textValue(alert?.customer_confidence).toLowerCase() === "high" ? "complete" : "partial";
}

export function oneViewAckReadModel(row = {}) {
  const status = textValue(row.oneview_ack_status);
  return {
    status: ["pending", "processing", "success", "cancelled", "failed"].includes(status) ? status : "none",
    requested_at: isoDate(row.oneview_ack_requested_at),
    processed_at: isoDate(row.oneview_ack_processed_at),
    actor_name: resolveAckActorName(row.oneview_ack_actor_name),
    reason: nullableText(sanitizeText(row.oneview_ack_reason, "", 160)),
    message: nullableText(sanitizeText(row.oneview_ack_message, "", 500)),
  };
}

// Estado do alerta vem da origem/read-model; nunca do resultado da ação ACK.
export function alertStatusReadModel(row = {}) {
  const sourceStatus = textValue(row.status_source).toLowerCase();
  const internalStatus = textValue(row.status_internal).toLowerCase();
  if (["cancelled", "canceled"].includes(sourceStatus)) return "cancelled";
  if (sourceStatus === "active") return "active";
  if (sourceStatus === "resolved" || Boolean(row.resolved_at) || ["resolved", "normalized"].includes(internalStatus)) return "resolved";
  return sourceStatus || "unknown";
}

export function operatorLinkReadModel(row = {}) {
  const candidate = discoverOperatorCircuits([row])[0] || null;
  if (!candidate) return null;
  const sourceHostId = nullableText(row.source_host_id ?? candidate.source_host_id);
  const sourceTriggerId = nullableText(row.source_trigger_id);
  const dataSourceId = textValue(row.data_source_id ?? candidate.data_source_id);
  if (!dataSourceId || !sourceHostId || !sourceTriggerId) return null;
  const operationalSubject = buildOperationalSubject({
    ...candidate,
    data_source_id: dataSourceId,
    source_host_id: sourceHostId,
    current_alert: { source_trigger_id: sourceTriggerId },
  });
  if (!operationalSubject) return null;
  return {
    id: textValue(candidate.circuit_key, sourceHostId),
    circuit_key: nullableText(candidate.circuit_key),
    resolution_status: ["resolved", "unresolved", "ambiguous"].includes(candidate.resolution_status)
      ? candidate.resolution_status
      : "unresolved",
    data_source_id: dataSourceId,
    source_host_id: sourceHostId,
    source_trigger_id: sourceTriggerId,
    service_name: nullableText(sanitizeText(candidate.service_name, "", 240)),
    carrier_name: nullableText(sanitizeText(candidate.carrier_name, "", 120)),
    link_type: nullableText(sanitizeText(candidate.link_type, "", 120)),
    member_key: nullableText(sanitizeText(candidate.member_key, "", 120)),
    uplink_key: nullableText(sanitizeText(candidate.uplink_key, "", 120)),
    site_name: nullableText(sanitizeText(candidate.site_name, "", 160)),
    operational_subject: operationalSubject,
  };
}

function mapAlertRows(rows) {
  // OV-P0-109 — URL deep-link a partir do baseUrl local (sem HTTP ServiceNow por row).
  // Aceita base URL mesmo sem credenciais API (link abre no browser do usuário).
  return rows.map((row) => {
    const hosts = operationalHostFields(row);
    const temporal = deriveAlertTemporalIntegrity(row);
    const suppression = describeSuppression(row);
    const datasourceSync = describeDatasourceSync(row);
    const enrichmentState = classifyAlertEnrichment(row);
    const customerIdentity = safeCustomerIdentity(row);
    const scopeCustomer = customerIdentity.unidentified
      ? row
      : {
        ...row,
        customer_name: customerIdentity.customerNameOriginal,
        customer_key: customerIdentity.customerKey,
      };
    // Escopo derivado no BFF (OV-P0-56) — usa identidade resolvida (ex.: MAPS dedicado).
    const operationalScope = deriveOperationalScope({
      ...scopeCustomer,
      host_name: hosts.host_name,
      host_visible_name: hosts.host_visible_name,
      host_technical_name: hosts.host_technical_name,
      host_groups: mapSafeGroups(row.host_groups),
    });
    // Extrai referência SN das tags cruas (antes do sanitize que mascara URLs).
    const servicenowReference = projectServiceNowReferenceFromAlertTags({
      event_tags: row.event_tags,
      trigger_tags: row.trigger_tags,
      host_tags: row.host_tags,
    }, {
      baseUrl: SERVICENOW_PROD_BASE_URL,
      allowLinkTagFallback: false,
    });
    return {
      id: textValue(row.id),
      data_source_id: textValue(row.data_source_id),
      datasource_name: sanitizeText(row.datasource_name ?? row.data_source_name, "Datasource OneView", 160),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      client_name_original: sanitizeText(row.client_name, "Cliente OneView", 160),
      customer_name: nullableText(sanitizeText(customerIdentity.customerName, "", 160)),
      customer_name_original: nullableText(sanitizeText(customerIdentity.customerNameOriginal, "", 160)),
      customer_key: nullableText(sanitizeText(customerIdentity.customerKey, "", 160)),
      customer_source: nullableText(sanitizeText(row.customer_source, "", 120)),
      customer_confidence: nullableText(sanitizeText(row.customer_confidence, "", 40)),
      operational_scope: operationalScope.operational_scope,
      operational_scope_label: operationalScope.operational_scope_label,
      enrichment_status: ["complete", "partial"].includes(enrichmentState) ? "enriched" : "pending",
      enrichment_state: enrichmentState,
      source_type: "zabbix",
      source_event_id: textValue(row.source_event_id, textValue(row.id)),
      source_problem_id: nullableText(row.source_problem_id),
      source_trigger_id: nullableText(row.source_trigger_id),
      source_host_id: nullableText(row.source_host_id),
      operator_link: operatorLinkReadModel(row),
      recurrence_key: buildRecurrenceKey(row),
      host_name: hosts.host_name,
      host_visible_name: hosts.host_visible_name,
      host_technical_name: hosts.host_technical_name,
      host_ip: null,
      host_group: null,
      host_groups: mapSafeGroups(row.host_groups),
      event_tags: mapSafeTags(row.event_tags),
      trigger_tags: mapSafeTags(row.trigger_tags),
      host_tags: mapSafeTags(row.host_tags),
      servicenow_reference: servicenowReference,
      service_name: nullableText(sanitizeText(row.service_name, "", 240)),
      item_name: nullableText(sanitizeText(row.item_name, "", 300)),
      item_key: nullableText(sanitizeText(row.item_key, "", 300)),
      trigger_description: nullableText(sanitizeText(row.trigger_description, "", 700)),
      operational_data: nullableText(sanitizeText(row.operational_data, "", 700)),
      problem_name: operationalProblemName(row),
      severity: textValue(row.severity, "not_classified"),
      status_source: textValue(row.status_source, "active"),
      status_internal: textValue(row.status_internal, "new"),
      alert_status: alertStatusReadModel(row),
      acknowledged_source: Boolean(row.acknowledged_source),
      acknowledged_internal: Boolean(row.acknowledged_internal),
      acknowledged_source_at: isoDate(row.acknowledged_source_at ?? row.acknowledged_at),
      acknowledged_source_by: resolveAckActorName(row.acknowledged_source_by ?? row.acknowledged_by),
      acknowledged_internal_at: isoDate(row.acknowledged_internal_at),
      acknowledged_internal_by: resolveAckActorName(row.acknowledged_internal_by),
      acknowledged_internal_comment: nullableText(sanitizeText(row.acknowledged_internal_comment, "", 500)),
      acknowledged_at: isoDate(row.acknowledged_source_at ?? row.acknowledged_at ?? row.acknowledged_internal_at),
      acknowledged_by: resolveAckActorName(row.acknowledged_source_by ?? row.acknowledged_by ?? row.acknowledged_internal_by),
      ack_request_status: ["pending", "processing"].includes(textValue(row.ack_request_status))
        ? textValue(row.ack_request_status)
        : null,
      source_ack_status: ["pending", "processing", "failed", "cancelled"].includes(textValue(row.oneview_ack_status ?? row.source_ack_status))
        ? textValue(row.oneview_ack_status ?? row.source_ack_status)
        : null,
      ...sourceAckCapability({
        datasourceName: row.datasource_name ?? row.data_source_name,
        syncEnabled: row.sync_enabled,
      }),
      oneview_ack: oneViewAckReadModel(row),
      suppressed: suppression.state === "active",
      suppressed_until: suppression.suppress_until || isoDate(row.suppressed_until),
      maintenance_status: nullableText(sanitizeText(row.maintenance_status, "", 80)),
      suppression,
      operational_queue: classifyOperationalQueue(row),
      recovery_evidence: recoveryEvidenceOf(row),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
      last_reopened_at: isoDate(row.last_reopened_at),
      ack_history_first_at: isoDate(row.ack_history_first_at),
      started_at: isoDate(row.first_seen_at, generatedAt()),
      last_seen_at: isoDate(row.last_seen_at, generatedAt()),
      resolved_at: isoDate(row.resolved_at),
      source_recovery_event_id: nullableText(sanitizeText(row.source_recovery_event_id, "", 120)),
      datasource_last_success_at: datasourceSync.last_success_at,
      datasource_sync_state: datasourceSync.state,
      duration_seconds: temporal.duration_seconds,
      recovery_duration_seconds: recoveryDurationSeconds(row),
      time_to_ack_seconds: timeToAckSeconds(row),
      temporal_integrity: temporal.temporal_integrity,
      created_at: isoDate(row.created_at ?? row.first_seen_at, generatedAt()),
      updated_at: isoDate(row.updated_at ?? row.last_seen_at, generatedAt()),
    };
  });
}

function mapTopHosts(rows) {
  return rows.map((row) => {
    const hosts = operationalHostFields(row);
    return {
      host_name: hosts.host_visible_name || hosts.host_technical_name || hosts.host_name || "Host não informado",
      count: integerValue(row.count ?? row.active_alerts, 0),
    };
  });
}

function mapLongestDurationRows(rows) {
  return rows.map((row) => {
    const hosts = operationalHostFields(row);
    const temporal = deriveAlertTemporalIntegrity(row);
    return {
      id: textValue(row.id),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      host_name: hosts.host_visible_name || hosts.host_technical_name || hosts.host_name || "Host não informado",
      problem_name: operationalProblemName(row),
      severity: textValue(row.severity, "not_classified"),
      duration_seconds: temporal.duration_seconds,
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

const requestDbTelemetry = new WeakMap();

export function readRequestDbTelemetry(req) {
  return requestDbTelemetry.get(req) || null;
}

function rememberRequestDbTelemetry(req, stats) {
  if (!req || typeof req !== "object") return;
  requestDbTelemetry.set(req, stats);
}

function logSanitizedDatabaseError(error, { operation }) {
  const errorClass = databaseFailureCode(error);
  console.error(JSON.stringify({
    event: "oneview_database_error",
    operation: safeOperationName(operation),
    pg_code: sanitizedPgCode(error),
    database_timeout: errorClass === "database_timeout",
    database_unavailable: errorClass === "database_unavailable",
  }));
}

/**
 * One checkout, one transaction, PgBouncer-safe timeouts.
 * SET LOCAL via set_config(..., true) never goes through startup parameters.
 */
export async function withOneViewReadonlyTransaction(config, work, { pool: poolOverride, req, operation = "readonly_transaction" } = {}) {
  const poolInstance = poolOverride || getOneViewDbPool(config);
  const connectStarted = Date.now();
  const stats = {
    pool_wait_ms: 0,
    db_query_count: 0,
    db_query_total_ms: 0,
    route_duration_ms: 0,
    pool_total: 0,
    pool_idle: 0,
    pool_waiting: 0,
  };
  let client;
  let began = false;
  let failure;
  const startedAt = Date.now();
  try {
    client = await poolInstance.connect();
    stats.pool_wait_ms = Math.max(0, Date.now() - connectStarted);
    await client.query("BEGIN");
    began = true;
    await client.query(
      "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
      [String(config.statementTimeoutMs), String(config.idleInTransactionTimeoutMs)],
    );
    const query = async (text, values = []) => {
      const queryStarted = Date.now();
      stats.db_query_count += 1;
      try {
        return await client.query({ text, values });
      } finally {
        stats.db_query_total_ms += Math.max(0, Date.now() - queryStarted);
      }
    };
    const result = await work(query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error;
    if (client && began) await client.query("ROLLBACK").catch(() => undefined);
    logSanitizedDatabaseError(error, { operation, poolInstance });
    throw error;
  } finally {
    if (client) client.release(failure);
    const poolStats = poolStatsFor(poolInstance);
    stats.route_duration_ms = Math.max(0, Date.now() - startedAt);
    stats.pool_total = poolStats.db_pool_total;
    stats.pool_idle = poolStats.db_pool_idle;
    stats.pool_waiting = poolStats.db_pool_waiting;
    rememberRequestDbTelemetry(req, stats);
    logOneViewDbPoolMetric({
      operation,
      durationMs: stats.route_duration_ms,
      error: failure,
      poolInstance,
    });
  }
}

async function queryRows(config, text, values = []) {
  const result = await getOneViewDbPool(config).query({ text, values });
  return result.rows;
}

async function queryRow(config, text, values = []) {
  const rows = await queryRows(config, text, values);
  return rows[0] || null;
}

/**
 * Agregação de severidades do filtered_summary (GET /api/oneview/alerts).
 *
 * by_severity (faixa visual obrigatória): information, warning, average, high, disaster.
 * - Contagens usam severidades persistidas reais (sem colapsar Warning↔Information).
 * - Disaster nunca entra em High.
 * - critical legado: agregado em high somente no summary; item.severity permanece "critical".
 * - not_classified: fora de by_severity (campo irmão), não entra na faixa das cinco.
 * - Zero válido → 0. Falha de query propaga erro (não inventa contagens).
 * - Campo legado `low` (warning+information+not_classified) removido — não era consumido pelo FE.
 */
function alertFilteredSummary(row) {
  return {
    total: integerValue(row?.total, 0),
    active: integerValue(row?.active, 0),
    resolved: integerValue(row?.resolved, 0),
    acknowledged_source: integerValue(row?.acknowledged_source, 0),
    unacknowledged_source: integerValue(row?.unacknowledged_source, 0),
    operational_pending: integerValue(row?.operational_pending, 0),
    oneview_ack_pending: integerValue(row?.oneview_ack_pending, 0),
    by_severity: {
      information: integerValue(row?.information, 0),
      warning: integerValue(row?.warning, 0),
      average: integerValue(row?.average, 0),
      high: integerValue(row?.high, 0),
      disaster: integerValue(row?.disaster, 0),
    },
    not_classified: integerValue(row?.not_classified, 0),
  };
}

function alertTemporalCounts(row) {
  const group = (prefix, include30Days = false) => ({
    "15m": integerValue(row?.[`${prefix}_15m`], 0),
    "1h": integerValue(row?.[`${prefix}_1h`], 0),
    "6h": integerValue(row?.[`${prefix}_6h`], 0),
    "24h": integerValue(row?.[`${prefix}_24h`], 0),
    "7d": integerValue(row?.[`${prefix}_7d`], 0),
    ...(include30Days ? { "30d": integerValue(row?.[`${prefix}_30d`], 0) } : {}),
  });
  return {
    created: group("created"),
    updated: group("updated"),
    resolved: group("resolved", true),
  };
}

async function fetchAlertList(req, config, dataSourceNames) {
  const {
    page, pageSize, offset, params, whereSql, orderSql, baseParams, baseWhereSql, include,
    scopeParams, scopeWhereSql,
  } = buildAlertListQuery(
    req,
    dataSourceNames,
  );

  const summarySql = `
      select
        count(*)::int as total,
        count(*) filter (where ${ACTIVE_ALERT_SQL})::int as active,
        count(*) filter (where ${RESOLVED_ALERT_SQL})::int as resolved,
        count(*) filter (where ${SOURCE_ACK_SQL})::int as acknowledged_source,
        count(*) filter (where ${SOURCE_UNACK_SQL})::int as unacknowledged_source,
        count(*) filter (where ${OPERATIONAL_PENDING_SQL})::int as operational_pending,
        count(*) filter (where ${ONEVIEW_ACK_PENDING_SQL})::int as oneview_ack_pending,
        count(*) filter (where a.severity = 'information')::int as information,
        count(*) filter (where a.severity = 'warning')::int as warning,
        count(*) filter (where a.severity = 'average')::int as average,
        count(*) filter (where a.severity in ('high', 'critical'))::int as high,
        count(*) filter (where a.severity = 'disaster')::int as disaster,
        count(*) filter (where a.severity = 'not_classified')::int as not_classified
      from alerts a
      join data_sources d on d.id = a.data_source_id
      ${ORIGIN_SNAPSHOT_JOIN_SQL}
      ${whereSql}
    `;
  const temporalSql = `
      select
        count(*) filter (where a.first_seen_at >= now() - interval '15 minutes')::int as created_15m,
        count(*) filter (where a.first_seen_at >= now() - interval '1 hour')::int as created_1h,
        count(*) filter (where a.first_seen_at >= now() - interval '6 hours')::int as created_6h,
        count(*) filter (where a.first_seen_at >= now() - interval '24 hours')::int as created_24h,
        count(*) filter (where a.first_seen_at >= now() - interval '7 days')::int as created_7d,
        count(*) filter (where a.last_seen_at >= now() - interval '15 minutes')::int as updated_15m,
        count(*) filter (where a.last_seen_at >= now() - interval '1 hour')::int as updated_1h,
        count(*) filter (where a.last_seen_at >= now() - interval '6 hours')::int as updated_6h,
        count(*) filter (where a.last_seen_at >= now() - interval '24 hours')::int as updated_24h,
        count(*) filter (where a.last_seen_at >= now() - interval '7 days')::int as updated_7d,
        count(*) filter (where a.resolved_at >= now() - interval '15 minutes')::int as resolved_15m,
        count(*) filter (where a.resolved_at >= now() - interval '1 hour')::int as resolved_1h,
        count(*) filter (where a.resolved_at >= now() - interval '6 hours')::int as resolved_6h,
        count(*) filter (where a.resolved_at >= now() - interval '24 hours')::int as resolved_24h,
        count(*) filter (where a.resolved_at >= now() - interval '7 days')::int as resolved_7d,
        count(*) filter (where a.resolved_at >= now() - interval '30 days')::int as resolved_30d
      from alerts a
      join data_sources d on d.id = a.data_source_id
      ${ORIGIN_SNAPSHOT_JOIN_SQL}
      ${baseWhereSql}
    `;
  const itemsSql = `
        select
          a.id,
          a.data_source_id,
          d.name as datasource_name,
          d.sync_enabled,
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
          a.host_groups,
          a.event_tags,
          a.trigger_tags,
          a.host_tags,
          a.service_name,
          a.item_name,
          a.item_key,
          a.trigger_description,
          a.operational_data,
          a.problem_name,
          a.severity,
          a.status_source,
          a.status_internal,
          a.acknowledged_source,
          ${INTERNAL_ACKNOWLEDGED_SQL} as acknowledged_internal,
          a.acknowledged_at as acknowledged_source_at,
          a.acknowledged_by as acknowledged_source_by,
          (select ack.requested_at
             from alert_acknowledgements ack
            where ack.alert_id = a.id
              and ack.acknowledgement_type in ('internal','internal_acknowledgement')
              and ack.status in ('recorded','pending','processing','success','completed')
            order by ack.requested_at desc, ack.id desc
            limit 1) as acknowledged_internal_at,
          (select ack.operator_name
             from alert_acknowledgements ack
            where ack.alert_id = a.id
              and ack.acknowledgement_type in ('internal','internal_acknowledgement')
              and ack.status in ('recorded','pending','processing','success','completed')
            order by ack.requested_at desc, ack.id desc
            limit 1) as acknowledged_internal_by,
          (select ack.message
             from alert_acknowledgements ack
            where ack.alert_id = a.id
              and ack.acknowledgement_type in ('internal','internal_acknowledgement')
              and ack.status in ('recorded','pending','processing','success','completed')
            order by ack.requested_at desc, ack.id desc
            limit 1) as acknowledged_internal_comment,
          (select ack.status
             from alert_acknowledgements ack
            where ack.alert_id = a.id and ack.status in ('pending','processing')
            order by ack.requested_at desc, ack.id desc
            limit 1) as ack_request_status,
          oneview_ack.status as oneview_ack_status,
          oneview_ack.requested_at as oneview_ack_requested_at,
          oneview_ack.processed_at as oneview_ack_processed_at,
          oneview_ack.operator_name as oneview_ack_actor_name,
          oneview_ack.result_payload ->> 'reason' as oneview_ack_reason,
          oneview_ack.message as oneview_ack_message,
          a.suppressed,
          a.suppressed_until,
          a.maintenance_status,
          a.payload_normalized->>'suppressed' as payload_suppressed,
          a.payload_normalized->>'suppressed_source' as payload_suppressed_source,
          a.payload_normalized->>'suppression_confirmation' as payload_suppression_confirmation,
          a.payload_normalized->>'suppression_origin' as payload_suppression_origin,
          a.payload_normalized->>'suppression_maintenance_id' as payload_suppression_maintenance_id,
          a.payload_normalized->>'suppression_user_id' as payload_suppression_user_id,
          a.payload_normalized->>'suppress_until' as payload_suppress_until,
          a.payload_normalized->>'suppress_until_kind' as payload_suppress_until_kind,
          a.payload_normalized->'suppression_data' as payload_suppression_data,
          a.first_seen_at,
          a.last_reopened_at,
          ${PROVEN_SOURCE_ACK_CLOCK_SQL} as ack_history_first_at,
          a.last_seen_at,
          origin_snap.origin_snapshot_id,
          origin_snap.origin_snapshot_started_at,
          origin_snap.origin_snapshot_finished_at,
          origin_snap.origin_snapshot_fetched,
          origin_snap.origin_snapshot_mode,
          origin_snap.origin_snapshot_complete,
          a.payload_normalized->>'origin_seen_in_complete_snapshot' as payload_origin_seen_in_complete_snapshot,
          a.resolved_at,
          a.source_recovery_event_id,
          d.last_success_at,
          d.last_sync_at,
          d.last_sync_status,
          d.sync_interval_seconds,
          a.duration_seconds,
          a.created_at,
          a.updated_at
        from alerts a
        join data_sources d on d.id = a.data_source_id
        ${ORIGIN_SNAPSHOT_JOIN_SQL}
        left join lateral (
          select ack.status, ack.requested_at, ack.processed_at, ack.operator_name, ack.result_payload, ack.message
            from alert_acknowledgements ack
           where ack.alert_id = a.id and ack.acknowledgement_type = 'source'
           order by ack.requested_at desc, ack.id desc
           limit 1
        ) oneview_ack on true
        ${whereSql}
        order by ${orderSql}
        limit $${params.length + 1}
        offset $${params.length + 2}
      `;
  const queueSql = `
      select
        count(*) filter (where ${operationalQueueSql("pending")})::int as pending,
        count(*) filter (where ${operationalQueueSql("acknowledged")})::int as acknowledged,
        count(*) filter (where ${operationalQueueSql("suppressed")})::int as suppressed,
        count(*) filter (where ${operationalQueueSql("history")})::int as history,
        count(*) filter (where ${operationalQueueSql("unconfirmed")})::int as unconfirmed
      from alerts a
      join data_sources d on d.id = a.data_source_id
      ${ORIGIN_SNAPSHOT_JOIN_SQL}
      ${scopeWhereSql}
    `;
  const syncSql = `
      select d.name, d.last_success_at, d.last_sync_at, d.last_sync_status, d.sync_interval_seconds,
             origin_snap.origin_snapshot_id, origin_snap.origin_snapshot_started_at,
             origin_snap.origin_snapshot_fetched, origin_snap.origin_snapshot_mode,
             origin_snap.origin_snapshot_complete
        from data_sources d
        ${ORIGIN_SNAPSHOT_JOIN_SQL}
       where d.name = any($1::text[])
       order by d.display_order, d.name
    `;
  const read = await withOneViewReadonlyTransaction(config, async (query) => {
    const summaryResult = include.summary ? await query(summarySql, params) : null;
    const queueResult = include.summary ? await query(queueSql, scopeParams) : null;
    const syncResult = include.summary ? await query(syncSql, [operationalDataSourceNames(dataSourceNames)]) : null;
    const temporalResult = include.temporal ? await query(temporalSql, baseParams) : null;
    const itemResult = include.items ? await query(itemsSql, [...params, pageSize, offset]) : null;
    return {
      summaryRow: summaryResult?.rows?.[0] || null,
      queueRow: queueResult?.rows?.[0] || null,
      syncRows: syncResult?.rows || [],
      temporalRow: temporalResult?.rows?.[0] || null,
      itemRows: itemResult?.rows || [],
    };
  }, { req, operation: "alerts_list" });
  const { summaryRow, queueRow, syncRows, temporalRow, itemRows } = read;

  const items = include.items ? mapAlertRows(itemRows) : [];
  const itemCount = items.length;
  const totalItems = include.summary
    ? integerValue(summaryRow?.total, 0)
    : offset + itemCount;
  const hasNext = include.summary
    ? (totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize)) > page
    : include.items && itemCount === pageSize;
  const totalPages = include.summary
    ? (totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize))
    : (itemCount === 0 && page === 1 ? 0 : page + (hasNext ? 1 : 0));

  const payload = {
    generated_at: generatedAt(),
    items,
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: hasNext,
      has_previous: page > 1 && (include.summary ? totalPages > 0 : true),
    },
  };
  if (include.summary) payload.filtered_summary = alertFilteredSummary(summaryRow);
  if (include.summary && queueRow) {
    payload.operational_queues = {
      pending: integerValue(queueRow.pending, 0),
      acknowledged: integerValue(queueRow.acknowledged, 0),
      suppressed: integerValue(queueRow.suppressed, 0),
      history: integerValue(queueRow.history, 0),
      unconfirmed: integerValue(queueRow.unconfirmed, 0),
    };
  }
  payload.origin_sync = syncRows.map((row) => {
    const sync = describeDatasourceSync(row);
    return {
      datasource_name: textValue(row.name),
      state: sync.state,
      stale: sync.stale,
      last_success_at: sync.last_success_at,
      snapshot_id: sync.snapshot?.id || null,
      snapshot_started_at: sync.snapshot?.started_at || null,
      snapshot_fetched: sync.snapshot?.fetched ?? null,
      snapshot_mode: sync.snapshot?.mode || null,
      snapshot_complete: sync.snapshot?.complete,
      snapshot_available: Boolean(sync.snapshot?.available),
    };
  });
  if (include.temporal) payload.temporal_counts = alertTemporalCounts(temporalRow);
  return payload;
}

function attentionThresholdPayload(thresholds) {
  return {
    disaster_minutes: thresholds.disasterMinutes,
    high_minutes: thresholds.highMinutes,
    average_minutes: thresholds.averageMinutes,
    low_minutes: thresholds.lowMinutes,
  };
}

function mapAttentionRows(rows) {
  return rows.map((row) => {
    const hosts = operationalHostFields(row);
    const operationalScope = deriveOperationalScope({
      ...row,
      host_name: hosts.host_name,
      host_visible_name: hosts.host_visible_name,
      host_technical_name: hosts.host_technical_name,
      host_groups: mapSafeGroups(row.host_groups),
    });
    return {
      id: textValue(row.id),
      customer_name: nullableText(sanitizeText(row.customer_name, "", 160)),
      customer_confidence: sanitizeText(row.customer_confidence, "unclassified", 40),
      operational_scope: operationalScope.operational_scope,
      operational_scope_label: operationalScope.operational_scope_label,
      datasource_name: sanitizeText(row.datasource_name, "Datasource OneView", 160),
      host_visible_name: hosts.host_visible_name,
      host_technical_name: hosts.host_technical_name,
      host_name: hosts.host_name,
      problem: operationalProblemName(row),
      severity: textValue(row.severity, "average"),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
      last_seen_at: isoDate(row.last_seen_at, generatedAt()),
      unacknowledged_minutes: integerValue(row.unacknowledged_minutes, 0),
      acknowledged: false,
    };
  });
}

async function fetchAttentionRequiredPayload(
  req,
  config,
  thresholds = getAttentionThresholds(),
  dataSourceNames = getOperationalDataSourceNames(),
) {
  const { limit, values, whereSql, orderSql } = buildAttentionRequiredQuery(req, thresholds, dataSourceNames);
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
          a.customer_key,
          a.customer_source,
          a.customer_confidence,
          d.name as datasource_name,
          a.host_name,
          a.host_visible_name,
          a.host_technical_name,
          a.host_groups,
          a.problem_name,
          a.severity,
          a.first_seen_at,
          a.last_seen_at,
          floor(extract(epoch from (now() - a.first_seen_at)) / 60)::int as unacknowledged_minutes
        from public.alerts a
        join public.data_sources d on d.id = a.data_source_id
        where ${whereSql}
        order by ${orderSql}
        limit $6
      `,
      [...values, limit],
    ),
  ]);
  const severityCounts = Object.fromEntries(
    severityRows.map((row) => [textValue(row.severity), integerValue(row.count, 0)]),
  );
  const disaster = integerValue(severityCounts.disaster, 0);
  const critical = integerValue(severityCounts.critical, 0);
  const high = integerValue(severityCounts.high, 0);
  const average = integerValue(severityCounts.average, 0);
  const low = integerValue(severityCounts.warning, 0)
    + integerValue(severityCounts.information, 0)
    + integerValue(severityCounts.not_classified, 0);

  return {
    summary: {
      total: disaster + critical + high + average + low,
      disaster,
      critical,
      high,
      average,
      low,
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

async function fetchAlertDetailPayload(req, config, dataSourceNames) {
  const id = alertId(req);
  const [row, ackHistoryRows] = await Promise.all([
    queryRow(
      config,
      `
      select
        a.id, a.data_source_id, d.name as datasource_name, d.sync_enabled, a.client_name,
        a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
        a.source_event_id, a.source_problem_id, a.source_trigger_id, a.source_host_id,
        a.source_recovery_event_id,
        a.host_name, a.host_visible_name, a.host_technical_name,
        host_inventory.interfaces as host_interfaces,
        a.host_groups, a.event_tags, a.trigger_tags, a.host_tags,
        a.service_name, a.item_name, a.item_key, a.trigger_description, a.operational_data,
        a.problem_name,
        a.severity, a.status_source, a.status_internal,
        a.acknowledged_source, ${INTERNAL_ACKNOWLEDGED_SQL} as acknowledged_internal,
        a.acknowledged_at as acknowledged_source_at, a.acknowledged_by as acknowledged_source_by,
        (select ack.requested_at
           from alert_acknowledgements ack
          where ack.alert_id = a.id
            and ack.acknowledgement_type in ('internal','internal_acknowledgement')
            and ack.status in ('recorded','pending','processing','success','completed')
          order by ack.requested_at desc, ack.id desc
          limit 1) as acknowledged_internal_at,
        (select ack.operator_name
           from alert_acknowledgements ack
          where ack.alert_id = a.id
            and ack.acknowledgement_type in ('internal','internal_acknowledgement')
            and ack.status in ('recorded','pending','processing','success','completed')
          order by ack.requested_at desc, ack.id desc
          limit 1) as acknowledged_internal_by,
        (select ack.message
           from alert_acknowledgements ack
          where ack.alert_id = a.id
            and ack.acknowledgement_type in ('internal','internal_acknowledgement')
            and ack.status in ('recorded','pending','processing','success','completed')
          order by ack.requested_at desc, ack.id desc
          limit 1) as acknowledged_internal_comment,
        (select ack.status
           from alert_acknowledgements ack
          where ack.alert_id = a.id and ack.status in ('pending','processing')
          order by ack.requested_at desc, ack.id desc
          limit 1) as ack_request_status,
        oneview_ack.status as oneview_ack_status,
        oneview_ack.requested_at as oneview_ack_requested_at,
        oneview_ack.processed_at as oneview_ack_processed_at,
        oneview_ack.operator_name as oneview_ack_actor_name,
        oneview_ack.result_payload ->> 'reason' as oneview_ack_reason,
        oneview_ack.message as oneview_ack_message,
        a.suppressed, a.suppressed_until, a.maintenance_status,
        a.payload_normalized->>'suppressed' as payload_suppressed,
        a.payload_normalized->>'suppressed_source' as payload_suppressed_source,
        a.payload_normalized->>'suppression_confirmation' as payload_suppression_confirmation,
        a.payload_normalized->>'suppression_origin' as payload_suppression_origin,
        a.payload_normalized->>'suppression_maintenance_id' as payload_suppression_maintenance_id,
        a.payload_normalized->>'suppression_user_id' as payload_suppression_user_id,
        a.payload_normalized->>'suppress_until' as payload_suppress_until,
        a.payload_normalized->>'suppress_until_kind' as payload_suppress_until_kind,
        a.payload_normalized->'suppression_data' as payload_suppression_data,
        a.first_seen_at, a.last_reopened_at, ${PROVEN_SOURCE_ACK_CLOCK_SQL} as ack_history_first_at,
        a.last_seen_at, a.resolved_at, a.duration_seconds,
        a.created_at, a.updated_at,
        ((select count(*)::int from alert_history h where h.alert_id = a.id)
          + (select count(*)::int from alert_acknowledgements ack
              where ack.alert_id = a.id
                and ack.acknowledgement_type in ('internal','internal_acknowledgement')
                and ack.status in ('recorded','pending','processing','success','completed'))) as history_count,
        (select count(*)::int from alert_acknowledgements ack where ack.alert_id = a.id) as acknowledgement_count
      from alerts a
      join data_sources d on d.id = a.data_source_id
      left join zabbix_host_inventory host_inventory
        on host_inventory.data_source_id = a.data_source_id
       and host_inventory.source_host_id = a.source_host_id
      left join lateral (
        select ack.status, ack.requested_at, ack.processed_at, ack.operator_name, ack.result_payload, ack.message
          from alert_acknowledgements ack
         where ack.alert_id = a.id and ack.acknowledgement_type = 'source'
         order by ack.requested_at desc, ack.id desc
         limit 1
      ) oneview_ack on true
      where a.id = $1
        and d.name = any($2::text[])
      limit 1
    `,
      [id, operationalDataSourceNames(dataSourceNames)],
    ),
    queryRows(
      config,
      `
      select
        h.id::text as id,
        h.action_type::text as event_type,
        h.message::text as description,
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
        )::text as acknowledge_id
      from alert_history h
      join alerts a on a.id = h.alert_id
      join data_sources d on d.id = a.data_source_id
      where h.alert_id = $1
        and d.name = any($2::text[])
        and (
          lower(coalesce(h.action_type, '')) in ('acknowledged', 'ack_message')
          or lower(coalesce(h.action_type, '')) like '%ack%'
        )
        and lower(coalesce(h.action_type, '')) <> 'internal_acknowledged'
      order by h.occurred_at desc nulls last, h.created_at desc, h.id desc
      limit 100
    `,
      [id, operationalDataSourceNames(dataSourceNames)],
    ),
  ]);
  if (!row) throw requestError("not_found", 404);

  let recurrenceSiblings = [];
  if (hasRecurrenceIdentity(row)) {
    recurrenceSiblings = await queryRows(
      config,
      `
      select
        a.id::text as id,
        a.data_source_id::text as data_source_id,
        a.source_host_id::text as source_host_id,
        a.source_trigger_id::text as source_trigger_id,
        a.first_seen_at,
        a.resolved_at,
        a.duration_seconds,
        a.acknowledged_at as acknowledged_source_at,
        a.acknowledged_by as acknowledged_source_by,
        a.event_tags,
        a.trigger_tags,
        a.host_tags
      from alerts a
      where a.data_source_id = $1
        and a.source_host_id = $2
        and a.source_trigger_id = $3
      order by a.first_seen_at asc nulls last, a.id asc
      limit 500
    `,
      [row.data_source_id, row.source_host_id, row.source_trigger_id],
    );
  }

  const item = mapAlertRows([row])[0];
  const recurrence = buildAlertRecurrenceReadModel({
    current: row,
    siblings: recurrenceSiblings,
  });
  const previousEpisode = recurrence.previous_episode_id
    ? recurrenceSiblings.find((sibling) => textValue(sibling.id) === recurrence.previous_episode_id) || null
    : null;
  const recurrence_previous = previousEpisode ? {
    occurrence_at: recurrence.previous_occurrence_at,
    recovery_at: recurrence.previous_recovery_at,
    duration_seconds: recurrence.previous_duration_seconds,
    temporal_integrity: recurrence.previous_temporal_integrity,
    acknowledged_at: recurrence.previous_acknowledged_at,
    acknowledged_by: resolveAckActorName(recurrence.previous_acknowledged_by),
    incident: projectServiceNowReferenceFromAlertTags(previousEpisode, {
      baseUrl: SERVICENOW_PROD_BASE_URL,
      allowLinkTagFallback: false,
    }),
  } : null;
  const same_problem = hasRecurrenceIdentity(row)
    ? await queryRow(
      config,
      `
      select
        count(distinct nullif(a.source_host_id::text, ''))::int as other_hosts,
        count(distinct nullif(lower(btrim(coalesce(a.customer_name, a.client_name))), ''))::int as customers,
        min(a.first_seen_at) as period_from,
        max(coalesce(a.resolved_at, a.last_seen_at)) as period_to
      from alerts a
      where a.data_source_id = $1
        and a.source_trigger_id = $2
        and a.source_host_id <> $3
      `,
      [row.data_source_id, row.source_trigger_id, row.source_host_id],
    )
    : null;
  const sourceAckHistoryItems = (ackHistoryRows || []).map((historyRow) => {
    const eventType = textValue(historyRow.event_type, "acknowledged");
    const ackActorName = resolveAckActorName(
      historyRow.actor_name_candidate,
      historyRow.operator_name_candidate,
      historyRow.acknowledged_by_candidate,
    );
    return {
      id: textValue(historyRow.id),
      event_type: eventType,
      title: historyTitle(eventType),
      description: historyDescription(eventType, historyRow.description),
      previous_value: null,
      current_value: null,
      source_event_id: nullableText(sanitizeText(historyRow.source_event_id ?? row.source_event_id, "", 120)),
      occurred_at: isoDate(historyRow.occurred_at ?? historyRow.created_at),
      created_at: isoDate(historyRow.created_at, generatedAt()),
      actor_name: ackActorName,
      ack_actor_name: ackActorName,
      ack_actor_unresolved: !ackActorName && [
        historyRow.actor_name_candidate,
        historyRow.operator_name_candidate,
        historyRow.acknowledged_by_candidate,
      ].some((value) => isNumericIdentifier(value)),
      acknowledge_id: nullableText(sanitizeText(historyRow.acknowledge_id, "", 120)),
      actor_type: null,
      source: "Zabbix",
      origin: "zabbix",
      legacy: false,
    };
  });
  const source_ack = resolveSourceAck({
    acknowledged_source: item.acknowledged_source,
    acknowledged_source_by: item.acknowledged_source_by,
    acknowledged_by: item.acknowledged_by,
    acknowledged_source_at: item.acknowledged_source_at,
    acknowledged_at: item.acknowledged_at,
  }, sourceAckHistoryItems);
  return {
    generated_at: generatedAt(),
    item: {
      ...item,
      host_network: buildHostNetwork(row.host_interfaces),
      ...recurrence,
      recurrence_previous,
      same_problem: same_problem ? {
        other_hosts: integerValue(same_problem.other_hosts, 0),
        customers: integerValue(same_problem.customers, 0),
        period_from: isoDate(same_problem.period_from),
        period_to: isoDate(same_problem.period_to),
      } : null,
      history_count: integerValue(row.history_count, 0),
      acknowledgement_count: integerValue(row.acknowledgement_count, 0),
      source_ack,
    },
  };
}

const HISTORY_TITLES = Object.freeze({
  problem_created: "Alerta identificado",
  problem_seen: "Ocorrência atualizada",
  severity_changed: "Severidade alterada",
  acknowledged: "Alerta reconhecido na origem",
  internal_acknowledged: "Reconhecido no OneView",
  oneview_ack_requested: "Solicita\u00e7\u00e3o de ACK criada",
  oneview_ack_processing: "Processamento do ACK iniciado",
  oneview_ack_confirmed: "ACK confirmado na origem",
  oneview_ack_cancelled: "ACK cancelado",
  oneview_ack_failed: "ACK falhou",
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
  if (normalized.startsWith("oneview_ack_")) return HISTORY_TITLES[normalized] || "AÃ§Ã£o de ACK OneView";
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
  if (normalized.startsWith("oneview_ack_")) return false;
  return normalized === "acknowledged" || normalized === "ack_message" || normalized.includes("ack");
}

export function humanizeOneViewAckReason(reason) {
  const normalized = textValue(reason).toLowerCase();
  const reasons = {
    alert_resolved_before_ack: "Alerta resolvido antes do reconhecimento",
    source_event_resolved_before_ack: "Alerta resolvido antes do reconhecimento",
    source_already_acknowledged: "Alerta j\u00e1 estava reconhecido na origem",
    delegated_zabbix_user_not_found: "Usu\u00e1rio n\u00e3o dispon\u00edvel nesta origem",
    delegated_zabbix_user_ambiguous: "Usu\u00e1rio amb\u00edguo nesta origem",
    delegated_zabbix_user_not_permitted: "Usu\u00e1rio sem permiss\u00e3o nesta origem",
    delegated_ack_datasource_not_allowed: "Reconhecimento delegado n\u00e3o homologado para esta origem",
    delegated_ack_version_unsupported: "Vers\u00e3o da origem n\u00e3o compat\u00edvel com reconhecimento delegado",
    delegated_token_verification_failed: "N\u00e3o foi poss\u00edvel validar a identidade delegada",
    zabbix_event_not_found: "Evento n\u00e3o encontrado na origem",
    zabbix_event_not_active: "Evento n\u00e3o est\u00e1 mais ativo na origem",
    zabbix_permission_denied: "Sem permiss\u00e3o para reconhecer na origem",
    source_ack_not_confirmed: "Reconhecimento n\u00e3o foi confirmado pela origem",
  };
  return reasons[normalized] || null;
}

function historyDescription(eventType, value, reason) {
  const normalized = textValue(eventType).toLowerCase();
  const humanReason = humanizeOneViewAckReason(reason);
  if (["oneview_ack_cancelled", "oneview_ack_failed"].includes(normalized) && humanReason) return humanReason;
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
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
}

function historySummary(items, { acknowledgedSource = false } = {}) {
  const acknowledgements = items.filter((item) => historyHasAcknowledgement(item.event_type)
    && textValue(item.event_type).toLowerCase() !== "internal_acknowledged");
  const actors = [...new Set(acknowledgements.map((item) => item.ack_actor_name).filter(Boolean))];
  return {
    acknowledgement_count: acknowledgements.length,
    first_ack_at: acknowledgements.at(-1)?.occurred_at ?? null,
    latest_ack_at: acknowledgements[0]?.occurred_at ?? null,
    has_ack_comment: acknowledgements.some((item) => Boolean(item.comment)),
    ack_actor_summary: acknowledgements.length === 0
      ? (acknowledgedSource ? "ACK atual confirmado pela origem" : "Sem ACK")
      : actors.length > 1
        ? "Mais de um responsável"
        : actors[0] || "Responsável não resolvido",
  };
}

/**
 * Resolve o ACK da origem a partir do estado do alerta + eventos de histórico.
 * Prioridade do responsável: actor_name → operator_name → acknowledged_by (já resolvidos via resolveAckActorName).
 * Comentário vem apenas de message/description dos eventos acknowledged/ack_message.
 */
export function resolveSourceAck(alertFields = {}, historyItems = []) {
  const acknowledged = Boolean(alertFields?.acknowledged_source);
  const sourceHistory = (historyItems || []).filter((item) => {
    const eventType = textValue(item?.event_type).toLowerCase();
    if (eventType === "internal_acknowledged") return false;
    return historyHasAcknowledgement(eventType);
  });
  const consolidated = consolidateAlertHistoryItems(sourceHistory);
  const latest = consolidated.find((item) => historyHasAcknowledgement(item.event_type));

  if (latest) {
    return Object.freeze({
      acknowledged: true,
      actor_name: resolveAckActorName(
        latest.ack_actor_name,
        latest.actor_name,
        alertFields?.acknowledged_source_by,
        alertFields?.acknowledged_by,
      ),
      acknowledged_at: isoDate(latest.occurred_at || alertFields?.acknowledged_source_at || alertFields?.acknowledged_at),
      comment: nullableText(sanitizeText(latest.comment, "", 500)),
      acknowledge_id: nullableText(sanitizeText(latest.acknowledge_id, "", 120)),
      history_available: true,
    });
  }

  if (acknowledged) {
    return Object.freeze({
      acknowledged: true,
      actor_name: resolveAckActorName(
        alertFields?.acknowledged_source_by,
        alertFields?.acknowledged_by,
      ),
      acknowledged_at: isoDate(alertFields?.acknowledged_source_at || alertFields?.acknowledged_at),
      comment: null,
      acknowledge_id: null,
      history_available: false,
    });
  }

  return Object.freeze({
    acknowledged: false,
    actor_name: null,
    acknowledged_at: null,
    comment: null,
    acknowledge_id: null,
    history_available: false,
  });
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

async function fetchAlertHistoryPayload(req, config, dataSourceNames) {
  const id = alertId(req);
  const alert = await queryRow(
    config,
    `select a.id, a.source_event_id, a.host_name, a.acknowledged_source,
            a.acknowledged_at, a.acknowledged_by
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where a.id = $1 and d.name = any($2::text[])
      limit 1`,
    [id, operationalDataSourceNames(dataSourceNames)],
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
        coalesce(h.source, 'legacy')::text as source,
        null::text as result_reason
      from alert_history h
      join alerts a on a.id = h.alert_id
      join data_sources d on d.id = a.data_source_id
      where h.alert_id = $1
        and d.name = any($2::text[])
      union all
      select
        ack.id::text as id,
        'internal_acknowledged'::text as event_type,
        nullif(ack.message, '')::text as description,
        null::jsonb as previous_value,
        null::jsonb as current_value,
        ack.source_event_id,
        ack.requested_at as occurred_at,
        ack.created_at,
        nullif(ack.operator_name, '')::text as actor_name_candidate,
        nullif(ack.operator_name, '')::text as operator_name_candidate,
        null::text as acknowledged_by_candidate,
        ack.id::text as acknowledge_id,
        nullif(ack.actor_type, '')::text as actor_type,
        'oneview_internal'::text as action_source,
        'oneview'::text as source,
        null::text as result_reason
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where ack.alert_id = $1
        and d.name = any($2::text[])
        and ack.acknowledgement_type in ('internal','internal_acknowledgement')
        and ack.status in ('recorded','pending','processing','success','completed')
      union all
      select
        (ack.id::text || ':request') as id,
        'oneview_ack_requested'::text as event_type,
        nullif(ack.message, '')::text as description,
        null::jsonb as previous_value,
        null::jsonb as current_value,
        ack.source_event_id,
        ack.requested_at as occurred_at,
        ack.created_at,
        nullif(ack.operator_name, '')::text as actor_name_candidate,
        nullif(ack.operator_name, '')::text as operator_name_candidate,
        null::text as acknowledged_by_candidate,
        ack.id::text as acknowledge_id,
        nullif(ack.actor_type, '')::text as actor_type,
        'oneview_source_ack'::text as action_source,
        'oneview'::text as source,
        null::text as result_reason
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where ack.alert_id = $1
        and d.name = any($2::text[])
        and ack.acknowledgement_type = 'source'
      union all
      select
        (ack.id::text || ':status') as id,
        case ack.status
          when 'processing' then 'oneview_ack_processing'
          when 'success' then 'oneview_ack_confirmed'
          when 'cancelled' then 'oneview_ack_cancelled'
          when 'failed' then 'oneview_ack_failed'
        end::text as event_type,
        nullif(ack.message, '')::text as description,
        null::jsonb as previous_value,
        null::jsonb as current_value,
        ack.source_event_id,
        coalesce(ack.processed_at, ack.updated_at, ack.requested_at) as occurred_at,
        ack.created_at,
        nullif(ack.operator_name, '')::text as actor_name_candidate,
        nullif(ack.operator_name, '')::text as operator_name_candidate,
        null::text as acknowledged_by_candidate,
        ack.id::text as acknowledge_id,
        nullif(ack.actor_type, '')::text as actor_type,
        'oneview_source_ack'::text as action_source,
        'oneview'::text as source,
        ack.result_payload ->> 'reason' as result_reason
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where ack.alert_id = $1
        and d.name = any($2::text[])
        and ack.acknowledgement_type = 'source'
        and ack.status in ('processing','success','cancelled','failed')
      order by occurred_at desc nulls last, created_at desc, id desc
    `,
    [id, operationalDataSourceNames(dataSourceNames)],
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
        row.result_reason,
      ),
      previous_value: legacy && !historyValueIsMeaningful(previousValue) ? null : previousValue,
      current_value: legacy && !historyValueIsMeaningful(currentValue) ? null : currentValue,
      source_event_id: nullableText(sanitizeText(row.source_event_id ?? alert.source_event_id, "", 120)),
      occurred_at: isoDate(row.occurred_at ?? row.created_at),
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
  const consolidated = consolidateAlertHistoryItems(mappedItems);
  const items = consolidated.map(({ acknowledge_id: _acknowledgeId, ...item }) => item);
  const summary = historySummary(items, { acknowledgedSource: Boolean(alert.acknowledged_source) });
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
    has_ack: items.some((item) => historyHasAcknowledgement(item.event_type))
      || Boolean(alert.acknowledged_source),
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

async function fetchOperationsHealthPayload(config, dataSourceNames) {
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
      where d.name = any($1::text[])
      order by d.display_order asc, d.name asc
    `,
    [operationalDataSourceNames(dataSourceNames)],
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

async function fetchDataSourceRows(config, dataSourceNames) {
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
      where d.name = any($1::text[])
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
    [operationalDataSourceNames(dataSourceNames)],
  );
}

async function fetchDataSourcesPayload(config, dataSourceNames) {
  return {
    generated_at: generatedAt(),
    items: mapDataSourceRows(await fetchDataSourceRows(config, dataSourceNames)),
  };
}

async function fetchSyncLogRows(config, limit = DEFAULT_SYNC_LOG_LIMIT, dataSourceNames = getOperationalDataSourceNames()) {
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
      where d.name = any($1::text[])
      order by coalesce(sl.finished_at, sl.created_at, sl.started_at) desc, sl.id desc
      limit $2
    `,
    [operationalDataSourceNames(dataSourceNames), limit],
  );
}

async function fetchSyncLogsPayload(req, config, dataSourceNames) {
  const rawLimit = Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit;
  const limit = integerValue(rawLimit, DEFAULT_SYNC_LOG_LIMIT, { min: 1, max: MAX_SYNC_LOG_LIMIT });
  return {
    generated_at: generatedAt(),
    items: mapSyncLogRows(await fetchSyncLogRows(config, limit, dataSourceNames)),
  };
}

async function fetchHealthPayload(
  config,
  acknowledgementEnabled = false,
  alertStaleMinutes = 15,
  dataSourceNames = getOperationalDataSourceNames(),
) {
  const [reachableRow, countsRow] = await Promise.all([
    queryRow(config, "select 1 as reachable"),
    queryRow(
      config,
      `
        select
          (select count(*)::int
             from alerts a
             join data_sources d on d.id = a.data_source_id
            where d.name = any($1::text[])) as total_alerts,
          (select count(*)::int
             from alerts a
             join data_sources d on d.id = a.data_source_id
            where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}) as active_alerts
      `,
      [operationalDataSourceNames(dataSourceNames)],
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

async function fetchDashboardSummaryPayload(
  config,
  timeZone = DEFAULT_OPERATIONAL_TIMEZONE,
  dataSourceNames = getOperationalDataSourceNames(),
) {
  const scopedDataSourceNames = operationalDataSourceNames(dataSourceNames);
  const dailyMetrics = dailyOperationalMetricQueries(timeZone, new Date(), scopedDataSourceNames);
  const scopeValues = [scopedDataSourceNames];
  const dayValues = [scopedDataSourceNames, dailyMetrics.day.from, dailyMetrics.day.to];
  const [
    totalAlertsRow,
    activeAlertsRow,
    resolvedTodayRow,
    sourceAcknowledgedTodayRow,
    oneViewAcknowledgedTodayRow,
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
    queryRow(config, `select count(*)::int as value from alerts a join data_sources d on d.id = a.data_source_id where d.name = any($1::text[])`, scopeValues),
    queryRow(config, `select count(*)::int as value from alerts a join data_sources d on d.id = a.data_source_id where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}`, scopeValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and a.resolved_at >= $2::timestamptz and a.resolved_at < $3::timestamptz`, dayValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and a.acknowledged_source = true
        and a.acknowledged_at >= $2::timestamptz and a.acknowledged_at < $3::timestamptz`, dayValues),
    queryRow(config, `select count(*)::int as value
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[])
        and ack.acknowledgement_type = any($4::text[])
        and ack.status = any($5::text[])
        and ack.requested_at >= $2::timestamptz and ack.requested_at < $3::timestamptz`,
    [...dayValues, INTERNAL_ACKNOWLEDGEMENT_TYPES, INTERNAL_ACKNOWLEDGEMENT_STATUSES]),
    queryRows(config, `select a.severity, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
      group by a.severity order by count desc, a.severity asc`, scopeValues),
    queryRows(config, `select a.status_internal, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
      group by a.status_internal order by count desc, a.status_internal asc`, scopeValues),
    queryRows(
      config,
      `select ${SAFE_CUSTOMER_NAME_SQL} as client_name, count(*)::int as count
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and a.status_source = 'active' and a.resolved_at is null
        group by ${SAFE_CUSTOMER_NAME_SQL}
        order by count desc, client_name asc`,
      scopeValues,
    ),
    queryRows(
      config,
      `
        select coalesce(a.service_name, '-') as service_name, coalesce(d.environment, 'internal') as environment, count(*)::int as count
        from alerts a join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
        group by coalesce(a.service_name, '-'), coalesce(d.environment, 'internal')
        order by count desc, service_name asc
        limit 20
      `,
      scopeValues,
    ),
    queryRows(config, `select a.host_name, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
      group by a.host_name order by count desc, a.host_name asc limit 10`, scopeValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${OPERATIONAL_PENDING_SQL}`, scopeValues),
    queryRows(
      config,
      `select a.id, ${SAFE_CUSTOMER_NAME_SQL} as client_name, a.host_name, a.problem_name,
              a.severity, floor(extract(epoch from (now() - a.first_seen_at)))::int as duration_seconds, a.first_seen_at
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and a.status_source = 'active' and a.resolved_at is null
          and a.first_seen_at is not null and a.first_seen_at <= now()
        order by floor(extract(epoch from (now() - a.first_seen_at))) desc nulls last
        limit 10`,
      scopeValues,
    ),
    queryRow(config, `with first_ack as (
        select h.alert_id, min(h.created_at) as ack_at
        from alert_history h
        where h.new_status = 'acknowledged' or h.action_type in ('ack_requested', 'acknowledged')
        group by h.alert_id
      )
      select coalesce(avg(extract(epoch from (first_ack.ack_at - a.first_seen_at))), 0)::int as avg_ack_time_seconds
      from alerts a
      join data_sources d on d.id = a.data_source_id
      join first_ack on first_ack.alert_id = a.id
      where d.name = any($1::text[])
        and first_ack.ack_at >= a.first_seen_at
        and (a.resolved_at is null or a.resolved_at >= a.first_seen_at)`, scopeValues),
    queryRow(config, `select coalesce(avg(extract(epoch from (a.resolved_at - a.first_seen_at))), 0)::int as avg_normalization_time_seconds
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[])
        and (a.status_source = 'resolved' or a.status_internal = 'normalized')
        and a.first_seen_at is not null
        and a.resolved_at is not null
        and a.resolved_at >= a.first_seen_at`, scopeValues),
  ]);

  const alertsTotal = integerValue(totalAlertsRow?.value, 0);
  const activeTotal = integerValue(activeAlertsRow?.value, 0);

  return {
    generated_at: generatedAt(),
    alerts_total: alertsTotal,
    alerts_sample_size: activeTotal,
    active_total: activeTotal,
    resolved_today: integerValue(resolvedTodayRow?.value, 0),
    source_acknowledgements_today: integerValue(sourceAcknowledgedTodayRow?.value, 0),
    oneview_acknowledgements_today: integerValue(oneViewAcknowledgedTodayRow?.value, 0),
    operational_day: {
      timezone: dailyMetrics.day.timeZone,
      from: dailyMetrics.day.from,
      to: dailyMetrics.day.to,
    },
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
    top_hosts: mapTopHosts(topHostRows),
    unacknowledged_total: integerValue(unacknowledgedRow?.value, 0),
    longest_duration: mapLongestDurationRows(longestDurationRows),
    avg_ack_time_seconds: integerValue(ackMetricsRow?.avg_ack_time_seconds, 0),
    avg_normalization_time_seconds: integerValue(normalizationMetricsRow?.avg_normalization_time_seconds, 0),
  };
}

async function fetchGrafanaSummaryPayload(config, dataSourceNames = getOperationalDataSourceNames()) {
  const scopedDataSourceNames = operationalDataSourceNames(dataSourceNames);
  const scopeValues = [scopedDataSourceNames];
  const [
    activeAlertsRow,
    acknowledgedRow,
    severityRows,
    clientRows,
    lastUpdatedRow,
    dataSourceRows,
    syncLogRows,
  ] = await Promise.all([
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}`, scopeValues),
    queryRow(
      config,
      `
        select count(*)::int as value
        from alerts a
        join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
          and ${SOURCE_ACK_SQL}
      `,
      scopeValues,
    ),
    queryRows(config, `select a.severity, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
      group by a.severity order by count desc, a.severity asc`, scopeValues),
    queryRows(
      config,
      `select ${SAFE_CUSTOMER_NAME_SQL} as client, count(*)::int as count
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and a.status_source = 'active' and a.resolved_at is null
        group by ${SAFE_CUSTOMER_NAME_SQL}
        order by count desc, client asc`,
      scopeValues,
    ),
    queryRow(config, `select max(a.last_seen_at) as last_updated_at
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}`, scopeValues),
    fetchDataSourceRows(config, scopedDataSourceNames),
    fetchSyncLogRows(config, 8, scopedDataSourceNames),
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

async function fetchClientsSummaryPayload(req, config, dataSourceNames = getOperationalDataSourceNames()) {
  const scopedDataSourceNames = operationalDataSourceNames(dataSourceNames);
  const status = (oneQueryValue(req, "status") || "active").toLowerCase();
  if (!["active", "all"].includes(status)) throw requestError("invalid_query");

  const firstSeenFromRaw = oneQueryValue(req, "first_seen_from");
  const firstSeenToRaw = oneQueryValue(req, "first_seen_to");
  const firstSeenFrom = firstSeenFromRaw ? isoFilterDate(firstSeenFromRaw) : null;
  const firstSeenTo = firstSeenToRaw ? isoFilterDate(firstSeenToRaw) : null;
  if (firstSeenFrom && firstSeenTo && Date.parse(firstSeenFrom) > Date.parse(firstSeenTo)) {
    throw requestError("invalid_query");
  }

  // OV-P0-42B: modo janela (Home) — top clientes ativos por first_seen_at.
  if (firstSeenFrom) {
    if (status !== "active") throw requestError("invalid_query");
    const limit = positiveInteger(oneQueryValue(req, "limit") || "5", 5, { maximum: 50 });
    const values = [scopedDataSourceNames, firstSeenFrom];
    let toSql = "";
    if (firstSeenTo) {
      values.push(firstSeenTo);
      toSql = ` and a.first_seen_at <= $${values.length}::timestamptz`;
    }
    const rows = await queryRows(
      config,
      `
        select
          ${SAFE_CUSTOMER_KEY_SQL} as customer_key,
          ${SAFE_CUSTOMER_NAME_SQL} as customer_name,
          count(*)::int as count
        from alerts a
        join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[])
          and ${ACTIVE_ALERT_SQL}
          and a.first_seen_at >= $2::timestamptz
          ${toSql}
        group by ${SAFE_CUSTOMER_KEY_SQL}, ${SAFE_CUSTOMER_NAME_SQL}
        order by count desc, customer_name asc
      `,
      values,
    );

    let totalActive = 0;
    let unclassifiedCount = 0;
    const identified = [];
    for (const row of rows) {
      const count = integerValue(row.count, 0);
      totalActive += count;
      const key = sanitizeText(row.customer_key, "unclassified", 160);
      if (key === "unclassified") {
        unclassifiedCount = count;
        continue;
      }
      identified.push({
        customer_key: key,
        customer_name: sanitizeText(row.customer_name, "Cliente não identificado", 160),
        count,
      });
    }

    return {
      generated_at: generatedAt(),
      window: {
        field: "first_seen_at",
        from: firstSeenFrom,
        to: firstSeenTo,
      },
      total_active: totalActive,
      top_clients: identified.slice(0, limit),
      unclassified_count: unclassifiedCount,
      partial: identified.length > limit,
      clients: [],
      customers: [],
      datasources: [],
    };
  }

  const severityRankSql = `case lower(coalesce(a.severity, ''))
    when 'disaster' then 7 when 'critical' then 6 when 'high' then 5 when 'average' then 4
    when 'warning' then 2 when 'information' then 1 else 0 end`;
  const [items, customerRows, datasourceRows] = await Promise.all([
    mapDataSourceRows(await fetchDataSourceRows(config, scopedDataSourceNames)),
    queryRows(
      config,
      `
        select
          ${SAFE_CUSTOMER_NAME_SQL} as name,
          ${SAFE_CUSTOMER_KEY_SQL} as key,
          count(*)::int as alerts_count,
          count(*) filter (where lower(coalesce(a.severity, '')) = 'disaster')::int as disaster_count,
          count(*) filter (where lower(coalesce(a.severity, '')) = 'critical')::int as critical_count,
          count(*) filter (where lower(coalesce(a.severity, '')) = 'high')::int as high_count,
          count(*) filter (where coalesce(a.acknowledged_source, false) = false)::int as unacknowledged_count,
          count(*) filter (where a.customer_confidence = 'high')::int as high_confidence_count,
          count(*) filter (where a.customer_confidence = 'low')::int as low_confidence_count,
          max(${severityRankSql})::int as max_severity_rank
        from alerts a
        join data_sources d on d.id = a.data_source_id
        where d.name = any($1::text[]) and ${ACTIVE_ALERT_SQL}
        group by ${SAFE_CUSTOMER_NAME_SQL}, ${SAFE_CUSTOMER_KEY_SQL}
        order by alerts_count desc, name asc
      `,
      [scopedDataSourceNames],
    ),
    queryRows(
      config,
      `
        select d.id, d.name, count(a.id)::int as alerts_count
        from data_sources d
        left join alerts a
          on a.data_source_id = d.id
         and ${ACTIVE_ALERT_SQL}
        where d.name = any($1::text[])
        group by d.id, d.name
        order by alerts_count desc, d.name asc
      `,
      [scopedDataSourceNames],
    ),
  ]);
  const severityFromRank = (rank) => {
    if (rank >= 7) return "disaster";
    if (rank >= 6) return "critical";
    if (rank >= 5) return "high";
    if (rank >= 4) return "average";
    if (rank >= 2) return "warning";
    if (rank >= 1) return "information";
    return "not_classified";
  };
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
      name: sanitizeText(row.name, "Cliente não identificado", 160),
      alerts_count: integerValue(row.alerts_count, 0),
      disaster_count: integerValue(row.disaster_count, 0) + integerValue(row.critical_count, 0),
      high_count: integerValue(row.high_count, 0),
      unacknowledged_count: integerValue(row.unacknowledged_count, 0),
      max_severity: severityFromRank(integerValue(row.max_severity_rank, 0)),
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

export const GLOBAL_HISTORY_EVENT_TYPES = Object.freeze({
  operational: [
    "problem_created",
    "created_from_zabbix",
    "acknowledged",
    "ack_message",
    "severity_changed",
    "recovered",
    "maintenance",
    "suppressed",
    "unsuppressed",
  ],
  identified: ["problem_created", "created_from_zabbix"],
  actions: [
    "acknowledged",
    "ack_message",
    "severity_changed",
    "recovered",
    "maintenance",
    "suppressed",
    "unsuppressed",
  ],
  ack: ["acknowledged"],
  ack_comment: ["ack_message"],
  acks: ["acknowledged", "ack_message"],
  resolution: ["recovered"],
  severity: ["severity_changed"],
  maintenance: ["maintenance", "suppressed", "unsuppressed"],
  update: ["problem_seen", "status_changed", "reopened", "problem_created", "created_from_zabbix"],
});

export function buildGlobalHistoryScopeClauses(req, dataSourceNames = getOperationalDataSourceNames()) {
  const customers = queryValues(req, "customer").map((value) => value.slice(0, 160));
  const datasources = queryValues(req, "datasource").map((value) => value.slice(0, 160));
  const eventType = oneQueryValue(req, "event_type").toLowerCase();
  const actors = queryTokenValues(req, "actor").map((value) => value.slice(0, 160));
  const search = oneQueryValue(req, "search").slice(0, 200);
  const hostSearch = oneQueryValue(req, "host_search").slice(0, 200);
  const problemSearch = oneQueryValue(req, "problem_search").slice(0, 200);
  const commentSearch = oneQueryValue(req, "comment_search").slice(0, 200);
  const severities = queryTokenValues(req, "severity").map((value) => value.toLowerCase());
  const occurredFrom = isoFilterDate(oneQueryValue(req, "occurred_from"));
  const occurredTo = isoFilterDate(oneQueryValue(req, "occurred_to"));
  if (eventType && eventType !== "all" && !Object.hasOwn(GLOBAL_HISTORY_EVENT_TYPES, eventType)) {
    throw requestError("invalid_query");
  }
  if (occurredFrom && occurredTo && Date.parse(occurredFrom) > Date.parse(occurredTo)) {
    throw requestError("invalid_query");
  }
  if (severities.some((value) => !ALERT_SEVERITIES.has(value))) throw requestError("invalid_query");

  const params = [operationalDataSourceNames(dataSourceNames)];
  const clauses = [
    `d.name = any($1::text[])`,
    `lower(coalesce(h.action_type, '')) <> 'internal_acknowledged'`,
    `lower(coalesce(h.action_source, '')) <> 'oneview_internal'`,
  ];
  const push = (clause, value) => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };

  if (customers.length) {
    const unclassified = customers.filter((value) => value === "unclassified");
    const named = customers.filter((value) => value !== "unclassified");
    const parts = [];
    if (named.length) {
      params.push(named);
      parts.push(`${SAFE_CUSTOMER_KEY_SQL} = any($${params.length})`);
    }
    if (unclassified.length) parts.push(UNIDENTIFIED_CUSTOMER_SQL);
    if (parts.length) clauses.push(`(${parts.join(" or ")})`);
  }
  if (datasources.length) {
    params.push(datasources);
    clauses.push(`d.name = any($${params.length})`);
  }
  if (eventType && eventType !== "all") {
    params.push(GLOBAL_HISTORY_EVENT_TYPES[eventType]);
    clauses.push(`lower(coalesce(h.action_type, '')) = any($${params.length})`);
  }
  if (actors.length) {
    if (actors.length === 1) push("lower(coalesce(nullif(h.actor_name, ''), nullif(h.operator_name, ''), '')) = lower(?)", actors[0]);
    else push("lower(coalesce(nullif(h.actor_name, ''), nullif(h.operator_name, ''), '')) = any(?::text[])", actors.map((value) => value.toLowerCase()));
  }
  if (severities.length) push("lower(coalesce(a.severity, 'not_classified')) = any(?::text[])", severities);
  if (hostSearch) push("coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ?", `%${hostSearch}%`);
  if (problemSearch) push("coalesce(a.problem_name, '') ilike ?", `%${problemSearch}%`);
  if (commentSearch) push("coalesce(h.message, '') ilike ?", `%${commentSearch}%`);
  if (occurredFrom) push("coalesce(h.occurred_at, h.created_at) >= ?::timestamptz", occurredFrom);
  if (occurredTo) push("coalesce(h.occurred_at, h.created_at) < ?::timestamptz", occurredTo);
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    clauses.push(`(
      coalesce(a.host_name, '') ilike $${idx}
      or coalesce(a.problem_name, '') ilike $${idx}
      or coalesce(h.message, '') ilike $${idx}
      or coalesce(h.actor_name, '') ilike $${idx}
      or coalesce(h.operator_name, '') ilike $${idx}
      or ${SAFE_CUSTOMER_NAME_SQL} ilike $${idx}
      or coalesce(d.name, '') ilike $${idx}
    )`);
  }

  return { clauses, params };
}

const GLOBAL_HISTORY_SORTS = Object.freeze({
  occurred: "coalesce(h.occurred_at, h.created_at)",
  client: `lower(${SAFE_CUSTOMER_NAME_SQL})`,
  host: "lower(coalesce(a.host_visible_name, a.host_technical_name, a.host_name, ''))",
  problem: "lower(coalesce(a.problem_name, ''))",
  actor: "lower(coalesce(nullif(h.actor_name, ''), nullif(h.operator_name, ''), ''))",
  severity: `case lower(coalesce(a.severity, 'not_classified'))
    when 'disaster' then 7 when 'critical' then 6 when 'high' then 5 when 'average' then 4
    when 'warning' then 2 when 'information' then 1 else 0 end`,
  description: "lower(coalesce(h.message, ''))",
});

export function globalHistoryOrderSql(req) {
  const sort = (oneQueryValue(req, "sort") || "occurred").toLowerCase();
  const order = (oneQueryValue(req, "order") || "desc").toLowerCase();
  if (!Object.hasOwn(GLOBAL_HISTORY_SORTS, sort) || !["asc", "desc"].includes(order)) {
    throw requestError("invalid_query");
  }
  const nulls = sort === "occurred" ? " nulls last" : "";
  return `${GLOBAL_HISTORY_SORTS[sort]} ${order.toUpperCase()}${nulls}, h.id desc`;
}

async function fetchGlobalHistoryPayload(req, config, dataSourceNames = getOperationalDataSourceNames()) {
  const page = positiveInteger(oneQueryValue(req, "page"), 1);
  const pageSize = positiveInteger(oneQueryValue(req, "page_size"), DEFAULT_ALERT_PAGE_SIZE, { maximum: MAX_ALERT_PAGE_SIZE });
  const { clauses, params } = buildGlobalHistoryScopeClauses(req, dataSourceNames);
  const orderSql = globalHistoryOrderSql(req);

  const whereSql = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const fromSql = `
    from alert_history h
    join alerts a on a.id = h.alert_id
    left join data_sources d on d.id = a.data_source_id
    ${whereSql}
  `;
  const countRow = await queryRow(config, `select count(*)::int as total ${fromSql}`, params);
  const totalItems = integerValue(countRow?.total, 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const rows = await queryRows(
    config,
    `
      select
        h.id::text as id,
        a.id::text as alert_id,
        h.action_type::text as event_type,
        h.message::text as description,
        h.occurred_at,
        h.created_at,
        nullif(h.actor_name, '')::text as actor_name_candidate,
        nullif(h.operator_name, '')::text as operator_name_candidate,
        nullif(a.acknowledged_by, '')::text as acknowledged_by_candidate,
        coalesce(h.action_source, 'legacy')::text as action_source,
        coalesce(h.source, 'legacy')::text as source,
        coalesce(h.previous_value, to_jsonb(h.previous_status)) as previous_value,
        coalesce(h.current_value, to_jsonb(h.new_status)) as current_value,
        ${SAFE_CUSTOMER_NAME_SQL} as customer_name,
        ${SAFE_CUSTOMER_KEY_SQL} as customer_key,
        a.customer_name as customer_name_raw,
        a.customer_key as customer_key_raw,
        a.customer_source,
        coalesce(d.name, 'Fonte não identificada')::text as datasource_name,
        a.host_name,
        a.host_visible_name,
        a.host_technical_name,
        a.host_groups,
        a.problem_name,
        a.severity
      ${fromSql}
      order by ${orderSql}
      limit $${params.length + 1} offset $${params.length + 2}
    `,
    [...params, pageSize, offset],
  );

  const items = rows.map((row) => {
    const eventTypeValue = textValue(row.event_type, "updated");
    const isAcknowledgement = historyHasAcknowledgement(eventTypeValue);
    const actorName = resolveAckActorName(
      row.actor_name_candidate,
      row.operator_name_candidate,
      isAcknowledgement ? row.acknowledged_by_candidate : null,
    );
    const legacy = historyIsLegacy(row.event_type, row.action_source);
    const previousValue = sanitizeStructuredValue(row.previous_value);
    const currentValue = sanitizeStructuredValue(row.current_value);
    const operationalScope = deriveHistoryEventOperationalScope({
      customer_name: row.customer_name_raw,
      customer_key: row.customer_key_raw,
      customer_source: row.customer_source,
      host_name: row.host_name,
      host_visible_name: row.host_visible_name,
      host_technical_name: row.host_technical_name,
      host_groups: row.host_groups,
    });
    return {
      id: textValue(row.id),
      alert_id: textValue(row.alert_id),
      event_type: eventTypeValue,
      title: historyTitle(eventTypeValue),
      description: historyDescription(eventTypeValue, row.description),
      occurred_at: isoDate(row.occurred_at ?? row.created_at),
      actor_name: actorName,
      source: historySource(row.source, legacy),
      // customer_* preservados do contrato SAFE existente (sem reescrever histórico).
      customer_name: sanitizeText(row.customer_name, "Cliente não identificado", 160),
      customer_key: sanitizeText(row.customer_key, "unclassified", 160),
      operational_scope: operationalScope.operational_scope,
      operational_scope_label: operationalScope.operational_scope_label,
      datasource_name: sanitizeText(row.datasource_name, "Fonte não identificada", 160),
      host_name: sanitizeText(
        row.host_visible_name || row.host_technical_name || row.host_name,
        "Host não identificado",
        200,
      ),
      problem_name: sanitizeText(row.problem_name, "Alerta sem descrição", 300),
      severity: sanitizeText(row.severity, "not_classified", 40),
      previous_value: legacy && !historyValueIsMeaningful(previousValue) ? null : previousValue,
      current_value: legacy && !historyValueIsMeaningful(currentValue) ? null : currentValue,
      legacy,
    };
  });

  return {
    generated_at: generatedAt(),
    items,
    pagination: {
      page: safePage,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: safePage < totalPages,
      has_previous: safePage > 1,
    },
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
    // Serverless: conexões curtas evitam reuso de socket obsoleto após freeze/restore.
    idleTimeoutMs: integerValue(env.ONEVIEW_DB_IDLE_TIMEOUT_MS, 5000, { min: 1000, max: 60000 }),
    maxLifetimeSeconds: integerValue(env.ONEVIEW_DB_MAX_LIFETIME_SECONDS, 300, { min: 30, max: 3600 }),
    statementTimeoutMs: integerValue(env.ONEVIEW_DB_STATEMENT_TIMEOUT_MS, 10000, { min: 1000, max: 30000 }),
    idleInTransactionTimeoutMs: integerValue(env.ONEVIEW_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 15000, { min: 1000, max: 60000 }),
  });
}

function poolStatsFor(poolInstance = pool) {
  return {
    db_pool_max: Number(poolInstance?.options?.max || 0),
    db_pool_total: Number(poolInstance?.totalCount || 0),
    db_pool_idle: Number(poolInstance?.idleCount || 0),
    db_pool_waiting: Number(poolInstance?.waitingCount || 0),
  };
}

function safeOperationName(value) {
  return String(value || "database").replace(/[^a-zA-Z0-9_:/.-]/g, "").slice(0, 120) || "database";
}

/** Sanitized operational metric: never include SQL, connection strings, credentials or driver messages. */
export function logOneViewDbPoolMetric({
  logger = console.info,
  event = "oneview_database_operation",
  operation = "database",
  retry = 0,
  attempt,
  durationMs = 0,
  error,
  poolInstance = pool,
} = {}) {
  const errorClass = error ? databaseFailureCode(error) : "none";
  logger(JSON.stringify({
    event,
    operation: safeOperationName(operation),
    retry: Math.max(0, Number(retry) || 0),
    ...(attempt === undefined ? {} : { attempt: Math.max(1, Number(attempt) || 1) }),
    duration_ms: Math.max(0, Number(durationMs) || 0),
    error_class: errorClass,
    ...(error ? { code: errorClass } : {}),
    ...poolStatsFor(poolInstance),
  }));
}

export function getOneViewDbPool(config = getOneViewDbConfig()) {
  const signature = poolSignature(config);
  if (!pool || poolKey !== signature) {
    if (pool) {
      pool.end().catch(() => undefined);
    }
    const nextPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.poolMax,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      maxLifetimeSeconds: config.maxLifetimeSeconds,
      allowExitOnIdle: true,
      ssl: poolSslConfig(config),
      application_name: "oneview-vercel-bff",
    });
    nextPool.on("error", (error) => {
      logOneViewDbPoolMetric({
        logger: console.error,
        event: "oneview_database_pool_error",
        operation: "idle_client",
        error,
        poolInstance: nextPool,
      });
    });
    pool = nextPool;
    poolKey = signature;
  }
  return pool;
}

export function getOneViewDbPoolStats() {
  return {
    initialized: Boolean(pool),
    max: poolStatsFor().db_pool_max,
    total: poolStatsFor().db_pool_total,
    idle: poolStatsFor().db_pool_idle,
    waiting: poolStatsFor().db_pool_waiting,
  };
}

export async function fetchOneViewDatabase(routeName, req, config) {
  const dbConfig = config?.dbConfig || getOneViewDbConfig();
  const dataSourceNames = operationalDataSourceNames(
    config?.operationalDataSourceNames || getOperationalDataSourceNames(),
  );
  try {
    switch (routeName) {
      case "health":
        return fetchHealthPayload(dbConfig, config?.ackEnabled, config?.alertStaleMinutes, dataSourceNames);
      case "dashboard-summary":
        return fetchDashboardSummaryPayload(dbConfig, config?.operationalTimezone, dataSourceNames);
      case "grafana-summary":
        return fetchGrafanaSummaryPayload(dbConfig, dataSourceNames);
      case "alerts":
        return fetchAlertList(req, dbConfig, dataSourceNames);
      case "attention-required":
        return fetchAttentionRequiredPayload(req, dbConfig, config?.attentionThresholds, dataSourceNames);
      case "alert-detail":
        return fetchAlertDetailPayload(req, dbConfig, dataSourceNames);
      case "alert-history":
        return fetchAlertHistoryPayload(req, dbConfig, dataSourceNames);
      case "history":
        return fetchGlobalHistoryPayload(req, dbConfig, dataSourceNames);
      case "operations-health":
        return fetchOperationsHealthPayload(dbConfig, dataSourceNames);
      case "runtime-health": {
        const view = oneQueryValue(req, "view");
        if (view && view !== "summary") throw requestError("invalid_query");
        return fetchRuntimeHealthPayload(dbConfig, {
          summaryOnly: view === "summary",
        });
      }
      case "clients-summary":
        return fetchClientsSummaryPayload(req, dbConfig, dataSourceNames);
      case "data-sources":
        return fetchDataSourcesPayload(dbConfig, dataSourceNames);
      case "sync-logs":
        return fetchSyncLogsPayload(req, dbConfig, dataSourceNames);
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

/**
 * SN-P0-08 — lookup read-only por source_event_id (sem gravar relação).
 * Match estrito: alerts.source_event_id = zabbix_event_id.
 */
export async function findAlertBySourceEventId(
  sourceEventId,
  config = getOneViewDbConfig(),
) {
  const eventId = String(sourceEventId || "").trim();
  if (!eventId || !/^[A-Za-z0-9._:-]{1,80}$/.test(eventId)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }

  const row = await queryRow(
    config,
    `
    select
      a.id::text as id,
      a.data_source_id::text as data_source_id,
      a.source_event_id,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.customer_name,
      a.customer_key,
      a.customer_source,
      a.client_name,
      a.severity,
      a.status_source,
      a.problem_name,
      a.trigger_description,
      a.created_at,
      a.first_seen_at,
      a.resolved_at,
      d.name::text as datasource_name
    from alerts a
    left join data_sources d on d.id = a.data_source_id
    where a.source_event_id = $1
       or a.source_problem_id = $1
    order by a.first_seen_at desc nulls last, a.last_seen_at desc nulls last, a.id desc
    limit 1
    `,
    [eventId],
  );

  if (!row) return null;
  return mapIncidentRelatedAlertRow(row, { sourceEventId: eventId });
}

function mapIncidentRelatedAlertRow(row, { sourceEventId = null } = {}) {
  const host = nullableText(
    sanitizeText(
      row.host_visible_name || row.host_technical_name || row.host_name,
      "",
      240,
    ),
  );
  const identity = safeCustomerIdentity({
    customer_name: row.customer_name,
    customer_key: row.customer_key,
    customer_source: row.customer_source,
    datasource_name: row.datasource_name,
    client_name: row.client_name,
  });
  let customer = identity.customerName
    || nullableText(sanitizeText(row.customer_name || row.client_name, "", 160));
  if (textValue(row.datasource_name).toLowerCase() === "maps") {
    customer = DEDICATED_DATASOURCE_CUSTOMER_LABELS.maps || customer;
  }
  const statusSource = textValue(row.status_source, row.resolved_at ? "resolved" : "active").toLowerCase();
  const status = statusSource === "resolved" || row.resolved_at ? "resolved" : "active";

  return {
    id: textValue(row.id),
    data_source_id: textValue(row.data_source_id),
    source_event_id: textValue(row.source_event_id, sourceEventId),
    host: host || "—",
    customer: customer || "—",
    problem: nullableText(sanitizeText(row.problem_name || row.trigger_description, "", 700)) || "—",
    severity: textValue(row.severity, "not_classified"),
    status,
    created_at: isoDate(row.created_at),
    first_seen_at: isoDate(row.first_seen_at),
    resolved_at: isoDate(row.resolved_at),
  };
}

/** Lookup reverso incidente → alerta: somente tag explícita ou Event ID. */
export async function findAlertForIncidentReverseLookup(
  { sysId = null, number = null, zabbixEventId = null } = {},
  config = getOneViewDbConfig(),
) {
  const result = await findAlertByExplicitServiceNowReference({ sysId, number }, config);
  if (result.alert) return result;

  const eventId = textValue(zabbixEventId);
  if (eventId) {
    try {
      const alert = await findAlertBySourceEventId(eventId, config);
      if (alert) return { relation_source: "event_id", alert };
    } catch (error) {
      if (error?.code !== "invalid_query") throw error;
    }
  }

  return { relation_source: "none", alert: null };
}

const RUNTIME_STATUS = Object.freeze({
  HEALTHY: "HEALTHY", DEGRADED: "DEGRADED", DOWN: "DOWN", STALE: "STALE",
  READY_DISABLED: "READY_DISABLED", CONFIG_MISSING: "CONFIG_MISSING", UNKNOWN: "UNKNOWN",
});

function runtimeErrorKind(error) {
  const value = String(error || "").toLowerCase();
  return /(auth|token|unauthori[sz]ed|forbidden|tls|certificate|network|econn|timeout)/.test(value);
}

export function classifyRuntimeHealth({ enabled = true, configured = true, lastSuccessAt = null, intervalSeconds = 60, lastError = null, now = Date.now() } = {}) {
  if (!configured) return RUNTIME_STATUS.CONFIG_MISSING;
  // A known TLS/auth/network issue blocks a safe activation even while the
  // source is disabled. It is configuration work, not a healthy ready state.
  if (runtimeErrorKind(lastError)) return enabled ? RUNTIME_STATUS.DOWN : RUNTIME_STATUS.CONFIG_MISSING;
  if (!enabled) return RUNTIME_STATUS.READY_DISABLED;
  const timestamp = Date.parse(String(lastSuccessAt || ""));
  if (Number.isNaN(timestamp)) return RUNTIME_STATUS.UNKNOWN;
  const ratio = Math.max(0, now - timestamp) / (Math.max(1, Number(intervalSeconds) || 60) * 1000);
  if (ratio <= 2 && !lastError) return RUNTIME_STATUS.HEALTHY;
  if (ratio <= 3) return RUNTIME_STATUS.DEGRADED;
  if (ratio <= 5) return RUNTIME_STATUS.STALE;
  return lastError ? RUNTIME_STATUS.DOWN : RUNTIME_STATUS.STALE;
}

export function classifyRuntimeDatasource({ enabled = false, configured = false, lastSuccessAt = null, intervalSeconds = 60, lastError = null, failureCount = 0, now = Date.now() } = {}) {
  // data_sources preserves the error text after a later successful cycle.
  // failure_count is the persisted signal that the error is still current.
  const currentFailure = integerValue(failureCount, 0) > 0;
  const currentError = currentFailure ? lastError : null;
  let status = classifyRuntimeHealth({ enabled, configured, lastSuccessAt, intervalSeconds, lastError: currentError, now });
  if (enabled && configured && currentFailure && status === RUNTIME_STATUS.HEALTHY) status = RUNTIME_STATUS.DEGRADED;
  const activationBlocker = currentFailure && runtimeErrorKind(lastError);
  return {
    status,
    currentError: (enabled && currentFailure) || activationBlocker ? lastError : null,
    lastHistoricalError: lastError && !currentFailure ? lastError : null,
  };
}

function runtimeComponent({
  id, category, name, enabled = true, status = RUNTIME_STATUS.UNKNOWN, connectivity = "unknown", auth = "unknown",
  freshness = null, last_success_at = null, last_observed_at = null, last_error_at = null, interval_seconds = null,
  duration_ms = null, hostname = null, version = null, failure_count = 0, current_error = null, last_historical_error = null,
  detail = null, badge = null, badge_label = null, cause = null, recommended_action = null, dimensions = null,
  last_source_event_at = null, last_db_event_at = null, last_successful_sync_at = null, source_db_lag_seconds = null,
  active_truth = null, metrics = null, warning = null, checked_at = null,
} = {}) {
  return {
    id, category, name, enabled, status, connectivity, auth, freshness, last_success_at, last_observed_at,
    last_error_at, interval_seconds, duration_ms, hostname, version, failure_count,
    current_error: sanitizeText(current_error, "", 180) || null,
    last_historical_error: sanitizeText(last_historical_error, "", 180) || null,
    detail,
    badge: badge || null,
    badge_label: badge_label || null,
    cause: cause || null,
    recommended_action: recommended_action || null,
    dimensions: dimensions || null,
    last_source_event_at: last_source_event_at || null,
    last_db_event_at: last_db_event_at || null,
    last_successful_sync_at: last_successful_sync_at || last_success_at || null,
    source_db_lag_seconds: source_db_lag_seconds == null ? null : Number(source_db_lag_seconds),
    active_truth: active_truth || null,
    metrics: metrics || null,
    warning: warning || null,
    checked_at: checked_at || null,
  };
}

function runtimeFreshness(lastSuccessAt, intervalSeconds, now = Date.now()) {
  const timestamp = Date.parse(String(lastSuccessAt || ""));
  if (Number.isNaN(timestamp)) return { age_seconds: null, ratio: null };
  const age = Math.max(0, Math.round((now - timestamp) / 1000));
  return { age_seconds: age, ratio: Number((age / Math.max(1, intervalSeconds)).toFixed(2)) };
}

export function runtimeOverallStatus(components) {
  const statuses = components.map((item) => item.status);
  if (statuses.includes(RUNTIME_STATUS.DOWN)) return RUNTIME_STATUS.DOWN;
  if (statuses.some((status) => [RUNTIME_STATUS.STALE, RUNTIME_STATUS.DEGRADED, RUNTIME_STATUS.CONFIG_MISSING].includes(status))) return RUNTIME_STATUS.DEGRADED;
  if (statuses.includes(RUNTIME_STATUS.UNKNOWN)) return RUNTIME_STATUS.UNKNOWN;
  return RUNTIME_STATUS.HEALTHY;
}

const REQUIRED_ZABBIX_RUNTIME_SOURCES = Object.freeze([
  "teletex-http", "rhp", "maps", "fraport-for", "fraport-poa", "castrolanda", "zurich",
]);

const ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG = new Set([]);

const RUNTIME_WORKERS = Object.freeze([
  { workerName: "zabbix_sync", name: "Zabbix Sync", intervalSeconds: 60 },
  { workerName: "recovery", name: "Recovery", intervalSeconds: 60 },
  { workerName: "servicenow_sync", name: "ServiceNow Sync", intervalSeconds: 30 },
  { workerName: "theo_dispatcher", name: "Theo Dispatcher", intervalSeconds: 60 },
  { workerName: "zabbix_ack_worker", name: "Zabbix ACK", intervalSeconds: 15 },
]);
function metadataDate(value, key) {
  return isoDate(value?.[key]);
}

export function classifyRuntimeWorker({ heartbeatAt = null, lastSuccessAt = null, lastError = null, reportedStatus = null, intervalSeconds = 60, now = Date.now() } = {}) {
  const heartbeat = Date.parse(String(heartbeatAt || ""));
  if (Number.isNaN(heartbeat)) return RUNTIME_STATUS.UNKNOWN;
  if (String(reportedStatus || "").toLowerCase() === "stopped") return RUNTIME_STATUS.DOWN;
  const heartbeatRatio = Math.max(0, now - heartbeat) / (Math.max(1, Number(intervalSeconds) || 60) * 1000);
  if (heartbeatRatio > 2) return RUNTIME_STATUS.STALE;
  if (lastError) return RUNTIME_STATUS.DEGRADED;
  const success = Date.parse(String(lastSuccessAt || ""));
  if (Number.isNaN(success)) return RUNTIME_STATUS.UNKNOWN;
  const successRatio = Math.max(0, now - success) / (Math.max(1, Number(intervalSeconds) || 60) * 1000);
  return successRatio <= 2 ? RUNTIME_STATUS.HEALTHY : RUNTIME_STATUS.STALE;
}

async function fetchRuntimeHealthPayload(config, { summaryOnly = false } = {}) {
  const startedAt = Date.now();
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const [
    probe,
    sources,
    serviceNow,
    workerHeartbeats,
    theoSignals,
    sourceFacts,
    customerIntegrityRow,
    incidentIdentityIntegrityRow,
    linkInventoryRow,
    hostRegistryRow,
    outboxTotals,
  ] = await Promise.all([
    queryRow(config, "select 1 as reachable"),
    queryRows(config, `select d.id, d.name, d.sync_enabled, d.sync_interval_seconds, d.last_success_at, d.last_sync_at, d.last_sync_error, d.last_error, d.failure_count, (d.token_encrypted is not null and d.token_encrypted <> '') as has_token, nullif(btrim(d.api_url), '') is not null as has_api_url from data_sources d where coalesce(d.type, 'zabbix') = 'zabbix' order by d.display_order, d.name`),
    queryRows(config, `select s.last_success_at, s.watermark_sys_updated_on, to_jsonb(s)->>'last_error' as last_error, to_jsonb(s)->>'status' as status from servicenow_sync_state s where s.sync_key = 'incident' limit 1`),
    queryRows(config, `select worker_id, status, hostname, version, last_seen_at, last_cycle_at, last_error, metadata, updated_at from worker_heartbeats where worker_id = any($1::text[])`, [summaryOnly
      ? [THEO_DISPATCHER_HEARTBEAT_WORKER_ID]
      : RUNTIME_WORKERS.map((worker) => worker.workerName)]),
    queryRow(config, `
      select
        (select coalesce(processed_at, updated_at)
           from integration_outbox
          where action_type = any($1::text[])
            and status = 'success'
          order by coalesce(processed_at, updated_at) desc nulls last
          limit 1) as last_success_at,
        (select action_type
           from integration_outbox
          where action_type = any($1::text[])
            and status = 'success'
          order by coalesce(processed_at, updated_at) desc nulls last
          limit 1) as last_success_action_type,
        (select updated_at
           from integration_outbox
          where action_type = any($1::text[])
            and status = 'failed'
          order by updated_at desc
          limit 1) as last_failed_at,
        (select last_error
           from integration_outbox
          where action_type = any($1::text[])
            and status = 'failed'
          order by updated_at desc
          limit 1) as last_failed_error,
        (select count(*)::int
           from integration_outbox
          where action_type = any($1::text[])
            and status in ('pending', 'processing')) as pending,
        (select count(*)::int
           from integration_outbox
          where action_type = any($1::text[])
            and status in ('pending', 'processing')
            and attempts > 0) as retrying,
        (select min(created_at)
           from integration_outbox
          where action_type = any($1::text[])
            and status in ('pending', 'processing')) as oldest_pending_at
    `, [THEO_HEALTH_ACTION_TYPES]).catch(() => ({ query_failed: true })),
    queryRows(config, `
      select
        d.name as source_name,
        max(a.last_seen_at) as last_db_event_at,
        count(*) filter (where ${ACTIVE_ALERT_SQL})::int as db_active
      from data_sources d
      left join alerts a on a.data_source_id = d.id
      where coalesce(d.type, 'zabbix') = 'zabbix'
      group by d.name
    `).catch(() => []),
    summaryOnly ? Promise.resolve(null) : queryRow(config, `
      select
        count(*) filter (
          where ${ACTIVE_ALERT_SQL}
            and ${UNIDENTIFIED_CUSTOMER_SQL}
            and coalesce(nullif(btrim(a.host_name), ''), nullif(btrim(a.host_visible_name), ''), nullif(btrim(a.source_host_id::text), '')) is not null
        )::int as active_classifiable_but_unclassified,
        count(*) filter (
          where ${ACTIVE_ALERT_SQL}
            and ${UNIDENTIFIED_CUSTOMER_SQL}
            and exists (
              select 1 from alerts classified
              where classified.data_source_id = a.data_source_id
                and classified.source_host_id is not distinct from a.source_host_id
                and not (${UNIDENTIFIED_CUSTOMER_SQL.replaceAll("a.", "classified.")})
            )
        )::int as db_classified_host_but_alert_unclassified
      from alerts a
    `).catch(() => ({ active_classifiable_but_unclassified: 0, db_classified_host_but_alert_unclassified: 0 })),
    summaryOnly ? Promise.resolve(null) : queryRow(config, `
      select count(*)::int as duplicate_incident_numbers
        from (
          select number
            from servicenow_incidents
           where nullif(btrim(number::text), '') is not null
           group by number
          having count(distinct sys_id) > 1
        ) conflicts
    `).catch(() => ({ duplicate_incident_numbers: null })),
    summaryOnly ? Promise.resolve(null) : queryRow(config, `
      select
        count(*)::int as total_links,
        count(*) filter (
          where lower(coalesce(l.classification, '')) not in ('', 'link', 'wan_link', 'lan_link', 'p2p', 'mpls', 'internet')
            and lower(coalesce(l.classification, '')) ~ '(server|firewall|switch|router|host|camera|printer)'
        )::int as non_link_contamination,
        count(*) filter (
          where nullif(btrim(l.customer_key), '') is not null
            and nullif(btrim(l.customer_name), '') is not null
            and exists (
              select 1 from alerts a
              where a.data_source_id::text = l.data_source_id::text
                and a.source_host_id::text = l.source_host_id::text
                and ${ACTIVE_ALERT_SQL}
                and nullif(btrim(a.customer_key), '') is not null
                and lower(btrim(a.customer_key)) <> lower(btrim(l.customer_key))
            )
        )::int as customer_mismatch,
        count(*) filter (where nullif(btrim(l.carrier_name), '') is not null)::int as carrier_known
      from zabbix_link_inventory l
    `).catch(() => null),
    summaryOnly ? Promise.resolve(null) : queryRow(config, `
      select
        count(distinct a.source_host_id)::int as total,
        count(distinct a.source_host_id) filter (where not (${UNIDENTIFIED_CUSTOMER_SQL}))::int as classified,
        count(distinct a.source_host_id) filter (
          where ${UNIDENTIFIED_CUSTOMER_SQL}
            and coalesce(nullif(btrim(a.host_name), ''), nullif(btrim(a.source_host_id::text), '')) is null
        )::int as source_insufficient,
        count(distinct a.source_host_id) filter (
          where ${UNIDENTIFIED_CUSTOMER_SQL}
            and coalesce(nullif(btrim(a.host_name), ''), nullif(btrim(a.source_host_id::text), '')) is not null
        )::int as needs_mapping
      from alerts a
      where a.source_host_id is not null
    `).catch(() => null),
    summaryOnly ? Promise.resolve(null) : queryRow(config, `
      select
        count(*) filter (where status in ('pending', 'processing'))::int as pending,
        count(*) filter (where status = 'failed')::int as failed
      from integration_outbox
    `).catch(() => ({ pending: 0, failed: 0 })),
  ]);

  const components = [];
  const duration = Date.now() - startedAt;
  const reachable = integerValue(probe?.reachable, 0) === 1;
  components.push(runtimeComponent({
    id: "vercel-bff", category: "PLATFORM", name: "Vercel/BFF",
    status: reachable ? RUNTIME_STATUS.HEALTHY : RUNTIME_STATUS.DOWN,
    connectivity: reachable ? "reachable" : "unreachable", auth: "authenticated",
    last_success_at: reachable ? generatedAt() : null, last_observed_at: generatedAt(),
    duration_ms: duration, detail: "Observação da requisição BFF", checked_at: checkedAt,
  }));
  components.push(runtimeComponent({
    id: "postgresql", category: "PLATFORM", name: "PostgreSQL",
    status: reachable ? RUNTIME_STATUS.HEALTHY : RUNTIME_STATUS.DOWN,
    connectivity: reachable ? "reachable" : "unreachable", auth: "configured",
    last_success_at: reachable ? generatedAt() : null, last_observed_at: generatedAt(),
    duration_ms: duration, detail: "SELECT 1 pelo pool BFF", checked_at: checkedAt,
  }));
  components.push(runtimeComponent({
    id: "pgbouncer", category: "PLATFORM", name: "PgBouncer",
    status: RUNTIME_STATUS.UNKNOWN, connectivity: "unknown", auth: "unknown",
    detail: "Sem telemetria independente do pool", checked_at: checkedAt,
  }));

  const factsByName = new Map((sourceFacts || []).map((row) => [String(row.source_name || "").trim().toLowerCase(), row]));
  const sourcesByName = new Map(sources.map((source) => [String(source.name || "").trim().toLowerCase(), source]));
  const sourceNames = [...new Set([...REQUIRED_ZABBIX_RUNTIME_SOURCES, ...sourcesByName.keys()])];

  for (const sourceName of sourceNames) {
    const source = sourcesByName.get(sourceName) || null;
    const facts = factsByName.get(sourceName) || {};
    const interval = integerValue(source?.sync_interval_seconds, 60, { min: 15, max: 86400 });
    const lastSuccess = isoDate(source?.last_success_at);
    const lastError = source?.last_error || source?.last_sync_error || null;
    const enabled = Boolean(source?.sync_enabled);
    const configured = Boolean(source?.has_token) && Boolean(source?.has_api_url) && !ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG.has(sourceName);
    const failureCount = integerValue(source?.failure_count, 0);
    const lastDbEventAt = isoDate(facts.last_db_event_at);
    // Castrolanda silent clock from 286A evidence when DB has that watermark.
    const lastSourceEventAt = sourceName === "castrolanda" && lastDbEventAt
      ? lastDbEventAt
      : lastDbEventAt;
    const truth = classifyZabbixSourceTruth({
      sourceName,
      enabled,
      configured,
      lastSuccessAt: lastSuccess,
      lastSyncAt: isoDate(source?.last_sync_at),
      lastDbEventAt,
      lastSourceEventAt,
      intervalSeconds: interval,
      lastError,
      failureCount,
      probe: fraportProbeForSource(sourceName),
      activeTruth: {
        source_active: null,
        db_active: integerValue(facts.db_active, 0),
        missing: null,
        extra: null,
        extra_explained: null,
        evidence_at: checkedAt,
      },
      now,
    });
    const missingSource = !source;
    const detail = missingSource
      ? "Fonte esperada ainda não cadastrada"
      : truth.detail
        || (ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG.has(sourceName)
          ? "Endpoint/token externo pendente"
          : "Evidência persistida em data_sources");
    components.push(runtimeComponent({
      id: `zabbix:${textValue(source?.id, sourceName)}`,
      category: "ZABBIX",
      name: sanitizeText(source?.name || sourceName, "Zabbix", 160),
      enabled,
      status: truth.status,
      connectivity: truth.dimensions?.SOURCE_CONNECTIVITY?.status === RUNTIME_STATUS.HEALTHY
        ? "observed"
        : truth.dimensions?.SOURCE_CONNECTIVITY?.status === RUNTIME_STATUS.DEGRADED
          ? "degraded"
          : truth.dimensions?.SOURCE_CONNECTIVITY?.status === RUNTIME_STATUS.DOWN
            ? "error"
            : lastSuccess ? "observed" : "unknown",
      auth: configured ? "configured" : "missing",
      freshness: runtimeFreshness(lastSourceEventAt || lastSuccess, interval, now),
      last_success_at: lastSuccess,
      last_observed_at: isoDate(source?.last_sync_at),
      last_error_at: failureCount > 0 ? isoDate(source?.last_sync_at) : null,
      interval_seconds: interval,
      failure_count: failureCount,
      current_error: failureCount > 0 ? lastError : null,
      last_historical_error: failureCount === 0 && lastError ? lastError : null,
      detail,
      badge: truth.badge,
      badge_label: truth.badge_label,
      cause: truth.cause,
      recommended_action: truth.recommended_action,
      dimensions: truth.dimensions,
      last_source_event_at: truth.last_source_event_at,
      last_db_event_at: truth.last_db_event_at,
      last_successful_sync_at: truth.last_successful_sync_at,
      source_db_lag_seconds: truth.source_db_lag_seconds,
      active_truth: truth.active_truth,
      checked_at: truth.checked_at || checkedAt,
    }));
  }

  const sn = serviceNow[0] || {};
  const snInterval = 30;
  const snEnabled = String(process.env.SERVICENOW_INCIDENTS_ENABLED || "").toLowerCase() === "true";
  const snConfigured = snEnabled || Boolean(sn.last_success_at || sn.watermark_sys_updated_on);
  const snStatus = classifyRuntimeHealth({
    enabled: snEnabled,
    configured: snConfigured,
    lastSuccessAt: sn.last_success_at,
    intervalSeconds: snInterval,
    lastError: sn.last_error,
    now,
  });
  const snBase = {
    enabled: snEnabled,
    status: snStatus,
    connectivity: sn.last_success_at ? "observed" : "unknown",
    auth: snConfigured ? "configured" : "missing",
    freshness: runtimeFreshness(sn.last_success_at, snInterval, now),
    last_success_at: isoDate(sn.last_success_at),
    last_observed_at: isoDate(sn.watermark_sys_updated_on),
    interval_seconds: snInterval,
    current_error: sn.last_error,
    checked_at: checkedAt,
  };
  components.push(runtimeComponent({ id: "servicenow-read-model", category: "SERVICENOW", name: "ServiceNow PROD Read Model", ...snBase, detail: "Leitura local PostgreSQL" }));
  const workersByName = new Map(workerHeartbeats.map((worker) => [String(worker.worker_id || "").toLowerCase(), worker]));
  if (!summaryOnly) {
  components.push(runtimeComponent({ id: "servicenow-watermark", category: "SERVICENOW", name: "ServiceNow Watermark", ...snBase, status: sn.watermark_sys_updated_on ? snStatus : RUNTIME_STATUS.UNKNOWN, detail: "watermark_sys_updated_on" }));
  components.push(runtimeComponent({ id: "servicenow-collector", category: "SERVICENOW", name: "ServiceNow Collector", ...snBase, detail: "Sem HTTP ServiceNow nesta requisição" }));

  const snActions = getServiceNowActionsConfig(process.env);
  const snWrite = classifyServiceNowWriteReadiness({
    executorReady: Boolean(snActions?.requestEnabled),
    executionEnabled: false,
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "servicenow-write",
    category: "SERVICENOW",
    name: "ServiceNow Write",
    enabled: Boolean(snActions?.requestEnabled),
    status: snWrite.status,
    connectivity: "not_applicable",
    auth: snActions?.requestEnabled ? "configured" : "missing",
    detail: snWrite.detail,
    recommended_action: snWrite.recommended_action,
    metrics: {
      outbox_pending: integerValue(outboxTotals?.pending, 0),
      outbox_failed: integerValue(outboxTotals?.failed, 0),
      execution_enabled: false,
    },
    checked_at: checkedAt,
  }));

  for (const definition of RUNTIME_WORKERS) {
    const worker = workersByName.get(definition.workerName) || null;
    const lastSuccess = metadataDate(worker?.metadata, "last_success_at");
    const lastHeartbeat = isoDate(worker?.last_seen_at);
    const status = classifyRuntimeWorker({
      heartbeatAt: lastHeartbeat,
      lastSuccessAt: lastSuccess,
      lastError: worker?.last_error,
      reportedStatus: worker?.status,
      intervalSeconds: definition.intervalSeconds,
      now,
    });
    components.push(runtimeComponent({
      id: `worker:${definition.workerName}`,
      category: "WORKERS",
      name: definition.name,
      status,
      connectivity: lastHeartbeat ? "observed" : "unknown",
      auth: "not_applicable",
      freshness: runtimeFreshness(lastHeartbeat, definition.intervalSeconds, now),
      last_success_at: lastSuccess,
      last_observed_at: lastHeartbeat,
      hostname: nullableText(sanitizeText(worker?.hostname, "", 160)),
      version: nullableText(sanitizeText(worker?.version, "", 160)),
      current_error: worker?.last_error,
      detail: worker ? "Heartbeat persistido em worker_heartbeats" : "Heartbeat individual ainda não persistido",
      interval_seconds: definition.intervalSeconds,
      checked_at: checkedAt,
    }));
  }

  components.push(runtimeComponent({
    id: "fast-event",
    category: "WORKERS",
    name: "Fast Event",
    status: RUNTIME_STATUS.UNKNOWN,
    connectivity: "unknown",
    auth: "not_applicable",
    detail: "Sem telemetria Fast Event no BFF",
    checked_at: checkedAt,
  }));

  const customerIntegrity = classifyCustomerIntegrity({
    activeClassifiableButUnclassified: integerValue(customerIntegrityRow?.active_classifiable_but_unclassified, 0),
    dbClassifiedHostButAlertUnclassified: integerValue(customerIntegrityRow?.db_classified_host_but_alert_unclassified, 0),
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "customer-integrity",
    category: "INTEGRATIONS",
    name: "Customer Integrity",
    status: customerIntegrity.status,
    connectivity: "not_applicable",
    auth: "not_applicable",
    detail: customerIntegrity.detail,
    metrics: customerIntegrity.metrics,
    checked_at: checkedAt,
  }));

  const incidentIdentityIntegrity = classifyIncidentIdentityIntegrity({
    duplicateIncidentNumbers: incidentIdentityIntegrityRow?.duplicate_incident_numbers,
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "servicenow-incident-identity-integrity",
    category: "SERVICENOW",
    name: "ServiceNow Incident Identity Integrity",
    status: incidentIdentityIntegrity.status,
    connectivity: "not_applicable",
    auth: "not_applicable",
    detail: incidentIdentityIntegrity.detail,
    metrics: incidentIdentityIntegrity.metrics,
    checked_at: checkedAt,
  }));

  const hostRegistry = classifyHostRegistry({
    total: hostRegistryRow?.total,
    classified: hostRegistryRow?.classified,
    sourceInsufficient: hostRegistryRow?.source_insufficient,
    needsMapping: hostRegistryRow?.needs_mapping,
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "host-registry",
    category: "INTEGRATIONS",
    name: "Host Registry",
    status: hostRegistry.status,
    connectivity: "not_applicable",
    auth: "not_applicable",
    detail: hostRegistry.detail,
    warning: hostRegistry.warning,
    metrics: hostRegistry.metrics,
    checked_at: checkedAt,
  }));

  const linkHealth = classifyLinkHealth({
    total: linkInventoryRow?.total_links,
    customerMismatch: linkInventoryRow?.customer_mismatch,
    nonLinkContamination: linkInventoryRow?.non_link_contamination,
    carrierKnown: linkInventoryRow?.carrier_known,
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "link-inventory",
    category: "INTEGRATIONS",
    name: "Link Inventory",
    status: linkHealth.status,
    connectivity: "not_applicable",
    auth: "not_applicable",
    detail: linkHealth.detail,
    warning: linkHealth.warning,
    metrics: linkHealth.metrics,
    checked_at: checkedAt,
  }));

  const ackConfig = getAckRequestConfig(process.env);
  const ack = classifyWriteReadiness({
    apiSupported: true,
    executorReady: true,
    executionEnabled: Boolean(ackConfig.executionEnabled),
    label: "Zabbix ACK",
    waitingReason: "Aguardando SSO/permissão de escrita/canário autorizado.",
    checkedAt,
  });
  components.push(runtimeComponent({
    id: "zabbix-ack",
    category: "INTEGRATIONS",
    name: "Zabbix ACK",
    enabled: Boolean(ackConfig.requestEnabled),
    status: ack.status,
    connectivity: "not_applicable",
    auth: ackConfig.requestEnabled ? "configured" : "missing",
    detail: ack.detail,
    recommended_action: ack.recommended_action,
    metrics: ack.metrics,
    checked_at: checkedAt,
  }));
  }

  const theoEnabled = String(process.env.THEO_ONEVIEW_AUTOMATION_ENABLED || "").toLowerCase() === "true";
  const theoConfigured = Boolean(String(process.env.THEO_ONEVIEW_URL || "").trim() && String(process.env.THEO_ONEVIEW_TOKEN || "").trim() && String(process.env.CRON_SECRET || "").trim());
  const theoWorker = workersByName.get(THEO_DISPATCHER_HEARTBEAT_WORKER_ID) || null;
  const theoHealth = classifyTheoWebexHealth({
    automationEnabled: theoEnabled,
    configured: theoConfigured,
    heartbeatAt: isoDate(theoWorker?.last_seen_at),
    lastSuccessAt: isoDate(theoSignals?.last_success_at),
    lastSuccessActionType: nullableText(sanitizeText(theoSignals?.last_success_action_type, "", 80)),
    lastFailedAt: isoDate(theoSignals?.last_failed_at),
    lastError: theoSignals?.last_failed_error || null,
    pendingCount: integerValue(theoSignals?.pending, 0),
    retryCount: integerValue(theoSignals?.retrying, 0),
    oldestPendingAt: isoDate(theoSignals?.oldest_pending_at),
    signalsQueryFailed: Boolean(theoSignals?.query_failed),
    heartbeatQueryFailed: false,
    now,
  });
  components.push(runtimeComponent({
    id: "theo-webex",
    category: "INTEGRATIONS",
    name: "Theo/Webex",
    enabled: theoEnabled,
    status: theoHealth.status,
    connectivity: theoHealth.last_success_at || theoWorker ? "observed" : "unknown",
    auth: theoConfigured ? "configured" : "missing",
    last_success_at: theoHealth.last_success_at,
    last_observed_at: isoDate(theoWorker?.last_seen_at) || theoHealth.last_success_at,
    last_error_at: theoHealth.last_error_at,
    failure_count: theoHealth.semantic === "FAILED" || theoHealth.current_error ? 1 : 0,
    current_error: theoHealth.current_error,
    detail: theoHealth.detail,
    cause: theoHealth.cause,
    metrics: {
      semantic_status: theoHealth.semantic,
      heartbeat: theoHealth.heartbeat,
      pending: theoHealth.pending,
      retrying: theoHealth.retrying,
      last_success_action_type: theoHealth.last_success_action_type,
      dispatch_means: "theo_accepted_http",
    },
    checked_at: checkedAt,
  }));

  return { overall_status: runtimeOverallStatus(components), generated_at: generatedAt(), components };
}

const EXPLICIT_SERVICENOW_TAG_SQL = `
  exists (
    select 1 from jsonb_array_elements(coalesce(a.event_tags, '[]'::jsonb)) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = $1
       and lower(btrim(coalesce(tag->>'value', ''))) = lower($2)
  )
  or exists (
    select 1 from jsonb_array_elements(coalesce(a.trigger_tags, '[]'::jsonb)) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = $1
       and lower(btrim(coalesce(tag->>'value', ''))) = lower($2)
  )
  or exists (
    select 1 from jsonb_array_elements(coalesce(a.host_tags, '[]'::jsonb)) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = $1
       and lower(btrim(coalesce(tag->>'value', ''))) = lower($2)
  )
  or exists (
    select 1 from jsonb_array_elements(
      case when jsonb_typeof(a.payload_normalized->'tags') = 'array'
        then a.payload_normalized->'tags' else '[]'::jsonb end
    ) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = $1
       and lower(btrim(coalesce(tag->>'value', ''))) = lower($2)
  )
  or lower(btrim(coalesce(a.payload_normalized->'tags'->>$1, ''))) = lower($2)
`;

async function findAlertByExplicitServiceNowTag(tagName, value, config) {
  const row = await queryRow(
    config,
    `
    select
      a.id::text as id,
      a.data_source_id::text as data_source_id,
      a.source_event_id,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.customer_name,
      a.customer_key,
      a.customer_source,
      a.client_name,
      a.problem_name,
      a.trigger_description,
      a.severity,
      a.status_source,
      a.first_seen_at,
      a.created_at,
      a.resolved_at,
      d.name::text as datasource_name
    from alerts a
    left join data_sources d on d.id = a.data_source_id
    where (${EXPLICIT_SERVICENOW_TAG_SQL})
    order by a.last_seen_at desc nulls last, a.updated_at desc nulls last, a.id desc
    limit 1
    `,
    [tagName, value],
  );

  if (!row) return null;
  return mapIncidentRelatedAlertRow(row);
}

/**
 * OV-P0-137 — relação reversa incidente → alerta por tags explícitas.
 * Prioridade sys_id → number. Nunca infere por host e inclui alertas resolvidos.
 */
export async function findAlertByExplicitServiceNowReference(
  { sysId = null, number = null } = {},
  config = getOneViewDbConfig(),
) {
  const normalizedSysId = textValue(sysId).toLowerCase();
  if (/^[a-f0-9]{32}$/.test(normalizedSysId)) {
    const alert = await findAlertByExplicitServiceNowTag(
      "__zbx_servicenow_sys_id",
      normalizedSysId,
      config,
    );
    if (alert) return { relation_source: "sys_id", alert };
  }

  const normalizedNumber = textValue(number).toUpperCase();
  if (/^INC\d{1,32}$/.test(normalizedNumber)) {
    const alert = await findAlertByExplicitServiceNowTag(
      "__zbx_servicenow_number",
      normalizedNumber,
      config,
    );
    if (alert) return { relation_source: "number", alert };
  }

  return { relation_source: "none", alert: null };
}

/** OV-P0-206 — read-only lookup for the explicit Theo canary target. */
export async function findTheoCanaryAlert(
  alertId,
  config = getOneViewDbConfig(),
) {
  const normalizedId = textValue(alertId).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/.test(normalizedId)) return null;
  return queryRow(
    config,
    `
    select
      a.id::text as id,
      a.client_name,
      a.customer_name,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.host_ip,
      a.problem_name,
      a.trigger_description,
      a.operational_data,
      a.severity,
      a.status_source,
      a.resolved_at,
      a.first_seen_at,
      a.last_seen_at,
      a.event_tags,
      a.trigger_tags,
      a.host_tags
    from alerts a
    join data_sources d on d.id = a.data_source_id
    where a.id = $1
      and coalesce(d.type, 'zabbix') = 'zabbix'
      and lower(coalesce(a.status_source, '')) = 'active'
      and a.resolved_at is null
      and lower(coalesce(a.severity, '')) in ('high', 'disaster')
    limit 1
    `,
    [normalizedId],
  );
}

/**
 * OV-P0-214 — resolves only the alert explicitly identified by the Worker
 * producer. This is read-only enrichment; it never broadens to host/customer
 * matching and deliberately permits every authorized Zabbix datasource.
 */
export async function findTheoProducedAlert(
  { alertId, dataSourceId = null, sourceEventId = null } = {},
  config = getOneViewDbConfig(),
) {
  const normalizedId = textValue(alertId).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/.test(normalizedId)) return null;
  const normalizedDataSourceId = textValue(dataSourceId).toLowerCase() || null;
  const normalizedSourceEventId = textValue(sourceEventId) || null;
  return queryRow(
    config,
    `
    select
      a.id::text as id,
      a.data_source_id::text as data_source_id,
      a.source_event_id::text as source_event_id,
      a.client_name,
      a.customer_name,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.host_ip,
      a.problem_name,
      a.trigger_description,
      a.operational_data,
      a.severity,
      a.status_source,
      a.status_internal,
      a.resolved_at,
      a.first_seen_at,
      a.last_seen_at,
      a.event_tags,
      a.trigger_tags,
      a.host_tags
    from alerts a
    join data_sources d on d.id = a.data_source_id
    where a.id = $1
      and coalesce(d.type, 'zabbix') = 'zabbix'
      and ($2::text is null or a.data_source_id::text = $2)
      and ($3::text is null or a.source_event_id::text = $3)
    limit 1
    `,
    [normalizedId, normalizedDataSourceId, normalizedSourceEventId],
  );
}

export { SAFE_CUSTOMER_NAME_SQL, SAFE_CUSTOMER_KEY_SQL };
