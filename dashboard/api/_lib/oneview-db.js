import { createHash } from "node:crypto";
import pg from "pg";
import {
  projectServiceNowReferenceFromAlertTags,
  SERVICENOW_PROD_BASE_URL,
} from "./oneview-inc-correlation.js";
import { deriveHistoryEventOperationalScope, deriveOperationalScope } from "./oneview-operational-scope.js";
import { buildAlertRecurrenceReadModel, buildRecurrenceKey, hasRecurrenceIdentity, parseRecurrenceKey } from "./oneview-recurrence.js";
import { getPrimaryDataSourceName } from "./oneview-scope.js";

const { Pool } = pg;

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
  duration: "a.duration_seconds",
  status: `case
    when a.resolved_at is not null or lower(coalesce(a.status_source, '')) = 'resolved'
      or lower(coalesce(a.status_internal, '')) in ('resolved', 'normalized') then 1
    else 0 end`,
  acknowledged_source: "coalesce(a.acknowledged_source, false)",
  acknowledged_at: "a.acknowledged_at",
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

const UNIDENTIFIED_CUSTOMER_SQL = `(
  a.customer_name is null
  or btrim(a.customer_name) = ''
  or lower(btrim(a.customer_name)) in ('cliente não classificado', 'cliente nao classificado', 'cliente não identificado', 'cliente nao identificado')
  or lower(coalesce(a.customer_source, '')) = 'datasource_fallback'
  or lower(coalesce(a.customer_key, '')) = 'unclassified'
)`;

// Identidade de cliente é de leitura: nunca reescreve os alertas históricos.
// A chave só elimina variações seguras de casing/espaços; não faz fuzzy match.
const SAFE_CUSTOMER_KEY_SQL = `case
  when ${UNIDENTIFIED_CUSTOMER_SQL} then 'unclassified'
  else lower(btrim(a.customer_name))
end`;

// Preferências oficiais conhecidas; o fallback mantém capitalização determinística.
const SAFE_CUSTOMER_NAME_SQL = `case
  when ${UNIDENTIFIED_CUSTOMER_SQL} then 'Cliente não identificado'
  when lower(btrim(a.customer_name)) = 'ailos' then 'Ailos'
  when lower(btrim(a.customer_name)) = 'jfsc' then 'JFSC'
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
  primaryDataSourceName = getPrimaryDataSourceName(),
) {
  const day = operationalDayBounds(timeZone, now);
  const values = [primaryDataSourceName, day.from, day.to];
  return Object.freeze({
    day,
    resolved: Object.freeze({
      text: `select count(*)::int as value
               from alerts a
               join data_sources d on d.id = a.data_source_id
              where d.name = $1
                and a.resolved_at >= $2::timestamptz
                and a.resolved_at < $3::timestamptz`,
      values,
    }),
    sourceAcknowledged: Object.freeze({
      text: `select count(*)::int as value
               from alerts a
               join data_sources d on d.id = a.data_source_id
              where d.name = $1
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
              where d.name = $1
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
  primaryDataSourceName = getPrimaryDataSourceName(),
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
    primaryDataSourceName,
  ];
  const clauses = [
    ACTIVE_ALERT_SQL,
    "coalesce(a.acknowledged_source, false) = false",
    `exists (
      select 1
      from data_sources scope_d
      where scope_d.id = a.data_source_id
        and scope_d.name = $5
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

export function buildAlertListQuery(req, primaryDataSourceName = getPrimaryDataSourceName()) {
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

  if (severities.some((value) => !ALERT_SEVERITIES.has(value))) throw requestError("invalid_query");
  if (customerConfidences.some((value) => !CUSTOMER_CONFIDENCES.has(value))) throw requestError("invalid_query");
  if (!["active", "resolved", "all"].includes(status)) throw requestError("invalid_query");
  if (acknowledged && !["true", "false"].includes(acknowledged)) throw requestError("invalid_query");
  if (acknowledgedSource && !["true", "false"].includes(acknowledgedSource)) throw requestError("invalid_query");
  if (acknowledgedInternal && !["true", "false"].includes(acknowledgedInternal)) throw requestError("invalid_query");
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
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw requestError("invalid_query");

  push("d.name = ?", primaryDataSourceName);
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
  if (status === "active") clauses.push(ACTIVE_ALERT_SQL);
  if (status === "resolved") clauses.push(RESOLVED_ALERT_SQL);
  if (acknowledged) {
    push(
      `(coalesce(a.acknowledged_source, false) or ${INTERNAL_ACKNOWLEDGED_SQL}) = ?`,
      acknowledged === "true",
    );
  }
  if (acknowledgedSource) push("coalesce(a.acknowledged_source, false) = ?", acknowledgedSource === "true");
  if (acknowledgedInternal) push(`${INTERNAL_ACKNOWLEDGED_SQL} = ?`, acknowledgedInternal === "true");
  if (search) {
    if (searchField === "host") {
      push(
        "coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ?",
        `%${search}%`,
      );
    } else if (searchField === "problem") {
      push("coalesce(a.problem_name, '') ilike ?", `%${search}%`);
    } else if (searchField === "customer") {
      push("coalesce(a.customer_name, a.client_name, a.customer_key, '') ilike ?", `%${search}%`);
    } else if (searchField === "eventid") {
      push("coalesce(a.source_event_id, a.id::text, '') ilike ?", `%${search}%`);
    } else {
      push(
        "(coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '') ilike ? or coalesce(a.problem_name, '') ilike $CURRENT or coalesce(a.service_name, '') ilike $CURRENT or coalesce(a.customer_name, a.client_name, '') ilike $CURRENT or coalesce(a.source_event_id, a.id::text, '') ilike $CURRENT)",
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
    whereSql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    orderSql: `${ALERT_SORTS[sort]} ${direction}${nullableSort}, ${secondarySql}, a.id desc`,
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

const CANONICAL_CUSTOMER_DISPLAY_NAMES = Object.freeze({
  ailos: "Ailos",
  jfsc: "JFSC",
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

export function safeCustomerIdentity(alert) {
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
  const customerName = normalizedCustomerName(alert?.customer_name);
  if (textValue(alert?.customer_source).toLowerCase() === "datasource_fallback") return "unclassified";
  if (["cliente nao classificado", "cliente nao identificado"].includes(customerName)) return "unclassified";
  if (!customerName) return "legacy";
  return textValue(alert?.customer_confidence).toLowerCase() === "high" ? "complete" : "partial";
}

function mapAlertRows(rows) {
  // OV-P0-109 — URL deep-link a partir do baseUrl local (sem HTTP ServiceNow por row).
  // Aceita base URL mesmo sem credenciais API (link abre no browser do usuário).
  return rows.map((row) => {
    const hosts = operationalHostFields(row);
    const enrichmentState = classifyAlertEnrichment(row);
    const customerIdentity = safeCustomerIdentity(row);
    // Escopo derivado no BFF (OV-P0-56) — usa evidência do row original; não reescreve customer_name.
    const operationalScope = deriveOperationalScope({
      ...row,
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
      source_host_id: null,
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
    return {
      id: textValue(row.id),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      host_name: hosts.host_visible_name || hosts.host_technical_name || hosts.host_name || "Host não informado",
      problem_name: operationalProblemName(row),
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

async function fetchAlertList(req, config, primaryDataSourceName) {
  const { page, pageSize, offset, params, whereSql, orderSql, baseParams, baseWhereSql } = buildAlertListQuery(
    req,
    primaryDataSourceName,
  );

  const [summaryRow, temporalRow, itemRows] = await Promise.all([
    queryRow(config, `
      select
        count(*)::int as total,
        count(*) filter (where ${ACTIVE_ALERT_SQL})::int as active,
        count(*) filter (where ${RESOLVED_ALERT_SQL})::int as resolved,
        count(*) filter (where coalesce(a.acknowledged_source, false))::int as acknowledged_source,
        count(*) filter (where not coalesce(a.acknowledged_source, false))::int as unacknowledged_source,
        count(*) filter (where a.severity = 'information')::int as information,
        count(*) filter (where a.severity = 'warning')::int as warning,
        count(*) filter (where a.severity = 'average')::int as average,
        count(*) filter (where a.severity in ('high', 'critical'))::int as high,
        count(*) filter (where a.severity = 'disaster')::int as disaster,
        count(*) filter (where a.severity = 'not_classified')::int as not_classified
      from alerts a
      join data_sources d on d.id = a.data_source_id
      ${whereSql}
    `, params),
    queryRow(config, `
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
      ${baseWhereSql}
    `, baseParams),
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
          a.host_groups,
          a.event_tags,
          a.trigger_tags,
          a.host_tags,
          a.service_name,
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

  const totalItems = integerValue(summaryRow?.total, 0);
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);

  return {
    generated_at: generatedAt(),
    items: mapAlertRows(itemRows),
    filtered_summary: alertFilteredSummary(summaryRow),
    temporal_counts: alertTemporalCounts(temporalRow),
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
  primaryDataSourceName = getPrimaryDataSourceName(),
) {
  const { limit, values, whereSql, orderSql } = buildAttentionRequiredQuery(req, thresholds, primaryDataSourceName);
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

async function fetchAlertDetailPayload(req, config, primaryDataSourceName) {
  const id = alertId(req);
  const [row, ackHistoryRows] = await Promise.all([
    queryRow(
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
        a.suppressed, a.suppressed_until, a.maintenance_status,
        a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds,
        a.created_at, a.updated_at,
        ((select count(*)::int from alert_history h where h.alert_id = a.id)
          + (select count(*)::int from alert_acknowledgements ack
              where ack.alert_id = a.id
                and ack.acknowledgement_type in ('internal','internal_acknowledgement')
                and ack.status in ('recorded','pending','processing','success','completed'))) as history_count,
        (select count(*)::int from alert_acknowledgements ack where ack.alert_id = a.id) as acknowledgement_count
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where a.id = $1
        and d.name = $2
      limit 1
    `,
      [id, primaryDataSourceName],
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
        and d.name = $2
        and (
          lower(coalesce(h.action_type, '')) in ('acknowledged', 'ack_message')
          or lower(coalesce(h.action_type, '')) like '%ack%'
        )
        and lower(coalesce(h.action_type, '')) <> 'internal_acknowledged'
      order by h.occurred_at desc nulls last, h.created_at desc, h.id desc
      limit 100
    `,
      [id, primaryDataSourceName],
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
      occurred_at: isoDate(historyRow.occurred_at ?? historyRow.created_at, generatedAt()),
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

async function fetchAlertHistoryPayload(req, config, primaryDataSourceName) {
  const id = alertId(req);
  const alert = await queryRow(
    config,
    `select a.id, a.source_event_id, a.host_name, a.acknowledged_source,
            a.acknowledged_at, a.acknowledged_by
       from alerts a
       join data_sources d on d.id = a.data_source_id
      where a.id = $1 and d.name = $2
      limit 1`,
    [id, primaryDataSourceName],
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
      join data_sources d on d.id = a.data_source_id
      where h.alert_id = $1
        and d.name = $2
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
        'oneview'::text as source
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where ack.alert_id = $1
        and d.name = $2
        and ack.acknowledgement_type in ('internal','internal_acknowledgement')
        and ack.status in ('recorded','pending','processing','success','completed')
      order by occurred_at desc nulls last, created_at desc, id desc
    `,
    [id, primaryDataSourceName],
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

async function fetchOperationsHealthPayload(config, primaryDataSourceName) {
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
      where d.name = $1
      order by d.display_order asc, d.name asc
    `,
    [primaryDataSourceName],
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

async function fetchDataSourceRows(config, primaryDataSourceName) {
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
      where d.name = $1
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
    [primaryDataSourceName],
  );
}

async function fetchDataSourcesPayload(config, primaryDataSourceName) {
  return {
    generated_at: generatedAt(),
    items: mapDataSourceRows(await fetchDataSourceRows(config, primaryDataSourceName)),
  };
}

async function fetchSyncLogRows(config, limit = DEFAULT_SYNC_LOG_LIMIT, primaryDataSourceName = getPrimaryDataSourceName()) {
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
      where d.name = $1
      order by coalesce(sl.finished_at, sl.created_at, sl.started_at) desc, sl.id desc
      limit $2
    `,
    [primaryDataSourceName, limit],
  );
}

async function fetchSyncLogsPayload(req, config, primaryDataSourceName) {
  const rawLimit = Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit;
  const limit = integerValue(rawLimit, DEFAULT_SYNC_LOG_LIMIT, { min: 1, max: MAX_SYNC_LOG_LIMIT });
  return {
    generated_at: generatedAt(),
    items: mapSyncLogRows(await fetchSyncLogRows(config, limit, primaryDataSourceName)),
  };
}

async function fetchHealthPayload(
  config,
  acknowledgementEnabled = false,
  alertStaleMinutes = 15,
  primaryDataSourceName = getPrimaryDataSourceName(),
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
            where d.name = $1) as total_alerts,
          (select count(*)::int
             from alerts a
             join data_sources d on d.id = a.data_source_id
            where d.name = $1 and ${ACTIVE_ALERT_SQL}) as active_alerts
      `,
      [primaryDataSourceName],
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
  primaryDataSourceName = getPrimaryDataSourceName(),
) {
  const dailyMetrics = dailyOperationalMetricQueries(timeZone, new Date(), primaryDataSourceName);
  const scopeValues = [primaryDataSourceName];
  const dayValues = [primaryDataSourceName, dailyMetrics.day.from, dailyMetrics.day.to];
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
    queryRow(config, `select count(*)::int as value from alerts a join data_sources d on d.id = a.data_source_id where d.name = $1`, scopeValues),
    queryRow(config, `select count(*)::int as value from alerts a join data_sources d on d.id = a.data_source_id where d.name = $1 and ${ACTIVE_ALERT_SQL}`, scopeValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and a.resolved_at >= $2::timestamptz and a.resolved_at < $3::timestamptz`, dayValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and a.acknowledged_source = true
        and a.acknowledged_at >= $2::timestamptz and a.acknowledged_at < $3::timestamptz`, dayValues),
    queryRow(config, `select count(*)::int as value
      from alert_acknowledgements ack
      join alerts a on a.id = ack.alert_id
      join data_sources d on d.id = a.data_source_id
      where d.name = $1
        and ack.acknowledgement_type = any($4::text[])
        and ack.status = any($5::text[])
        and ack.requested_at >= $2::timestamptz and ack.requested_at < $3::timestamptz`,
    [...dayValues, INTERNAL_ACKNOWLEDGEMENT_TYPES, INTERNAL_ACKNOWLEDGEMENT_STATUSES]),
    queryRows(config, `select a.severity, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}
      group by a.severity order by count desc, a.severity asc`, scopeValues),
    queryRows(config, `select a.status_internal, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}
      group by a.status_internal order by count desc, a.status_internal asc`, scopeValues),
    queryRows(
      config,
      `select ${SAFE_CUSTOMER_NAME_SQL} as client_name, count(*)::int as count
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = $1 and a.status_source = 'active' and a.resolved_at is null
        group by ${SAFE_CUSTOMER_NAME_SQL}
        order by count desc, client_name asc`,
      scopeValues,
    ),
    queryRows(
      config,
      `
        select coalesce(a.service_name, '-') as service_name, coalesce(d.environment, 'internal') as environment, count(*)::int as count
        from alerts a join data_sources d on d.id = a.data_source_id
        where d.name = $1 and ${ACTIVE_ALERT_SQL}
        group by coalesce(a.service_name, '-'), coalesce(d.environment, 'internal')
        order by count desc, service_name asc
        limit 20
      `,
      scopeValues,
    ),
    queryRows(config, `select a.host_name, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}
      group by a.host_name order by count desc, a.host_name asc limit 10`, scopeValues),
    queryRow(config, `select count(*)::int as value
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}
        and coalesce(a.acknowledged_source, false) = false`, scopeValues),
    queryRows(
      config,
      `select a.id, ${SAFE_CUSTOMER_NAME_SQL} as client_name, a.host_name, a.problem_name,
              a.severity, a.duration_seconds::int, a.first_seen_at
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = $1 and a.status_source = 'active' and a.resolved_at is null
        order by a.duration_seconds desc nulls last
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
      where d.name = $1`, scopeValues),
    queryRow(config, `select coalesce(avg(extract(epoch from (coalesce(a.normalized_at, a.resolved_at, a.updated_at) - a.first_seen_at))), 0)::int as avg_normalization_time_seconds
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and (a.status_source = 'resolved' or a.status_internal = 'normalized')`, scopeValues),
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

async function fetchGrafanaSummaryPayload(config, primaryDataSourceName) {
  const scopeValues = [primaryDataSourceName];
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
      where d.name = $1 and ${ACTIVE_ALERT_SQL}`, scopeValues),
    queryRow(
      config,
      `
        select count(*)::int as value
        from alerts a
        join data_sources d on d.id = a.data_source_id
        where d.name = $1 and ${ACTIVE_ALERT_SQL}
          and (coalesce(a.acknowledged_source, false) = true
            or ${INTERNAL_ACKNOWLEDGED_SQL})
      `,
      scopeValues,
    ),
    queryRows(config, `select a.severity, count(*)::int as count
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}
      group by a.severity order by count desc, a.severity asc`, scopeValues),
    queryRows(
      config,
      `select ${SAFE_CUSTOMER_NAME_SQL} as client, count(*)::int as count
         from alerts a
         join data_sources d on d.id = a.data_source_id
        where d.name = $1 and a.status_source = 'active' and a.resolved_at is null
        group by ${SAFE_CUSTOMER_NAME_SQL}
        order by count desc, client asc`,
      scopeValues,
    ),
    queryRow(config, `select max(a.last_seen_at) as last_updated_at
      from alerts a join data_sources d on d.id = a.data_source_id
      where d.name = $1 and ${ACTIVE_ALERT_SQL}`, scopeValues),
    fetchDataSourceRows(config, primaryDataSourceName),
    fetchSyncLogRows(config, 8, primaryDataSourceName),
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

async function fetchClientsSummaryPayload(req, config, primaryDataSourceName) {
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
    const values = [primaryDataSourceName, firstSeenFrom];
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
        where d.name = $1
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
    mapDataSourceRows(await fetchDataSourceRows(config, primaryDataSourceName)),
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
        where d.name = $1 and ${ACTIVE_ALERT_SQL}
        group by ${SAFE_CUSTOMER_NAME_SQL}, ${SAFE_CUSTOMER_KEY_SQL}
        order by alerts_count desc, name asc
      `,
      [primaryDataSourceName],
    ),
    queryRows(
      config,
      `
        select d.id, d.name, count(a.id)::int as alerts_count
        from data_sources d
        left join alerts a
          on a.data_source_id = d.id
         and ${ACTIVE_ALERT_SQL}
        where d.name = $1
        group by d.id, d.name
        order by alerts_count desc, d.name asc
      `,
      [primaryDataSourceName],
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

async function fetchGlobalHistoryPayload(req, config, primaryDataSourceName) {
  const page = positiveInteger(oneQueryValue(req, "page"), 1);
  const pageSize = positiveInteger(oneQueryValue(req, "page_size"), DEFAULT_ALERT_PAGE_SIZE, { maximum: MAX_ALERT_PAGE_SIZE });
  const customers = queryValues(req, "customer").map((value) => value.slice(0, 160));
  const datasources = queryValues(req, "datasource").map((value) => value.slice(0, 160));
  const eventType = oneQueryValue(req, "event_type").toLowerCase();
  const search = oneQueryValue(req, "search").slice(0, 200);
  const occurredFrom = isoFilterDate(oneQueryValue(req, "occurred_from"));
  const occurredTo = isoFilterDate(oneQueryValue(req, "occurred_to"));
  if (eventType && eventType !== "all" && !Object.hasOwn(GLOBAL_HISTORY_EVENT_TYPES, eventType)) {
    throw requestError("invalid_query");
  }
  if (occurredFrom && occurredTo && Date.parse(occurredFrom) > Date.parse(occurredTo)) {
    throw requestError("invalid_query");
  }

  const params = [primaryDataSourceName];
  const clauses = [
    `d.name = $1`,
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
      order by coalesce(h.occurred_at, h.created_at) desc nulls last, h.id desc
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
      occurred_at: isoDate(row.occurred_at ?? row.created_at, generatedAt()),
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
  const primaryDataSourceName = config?.primaryDataSourceName || getPrimaryDataSourceName();
  try {
    switch (routeName) {
      case "health":
        return fetchHealthPayload(dbConfig, config?.ackEnabled, config?.alertStaleMinutes, primaryDataSourceName);
      case "dashboard-summary":
        return fetchDashboardSummaryPayload(dbConfig, config?.operationalTimezone, primaryDataSourceName);
      case "grafana-summary":
        return fetchGrafanaSummaryPayload(dbConfig, primaryDataSourceName);
      case "alerts":
        return fetchAlertList(req, dbConfig, primaryDataSourceName);
      case "attention-required":
        return fetchAttentionRequiredPayload(req, dbConfig, config?.attentionThresholds, primaryDataSourceName);
      case "alert-detail":
        return fetchAlertDetailPayload(req, dbConfig, primaryDataSourceName);
      case "alert-history":
        return fetchAlertHistoryPayload(req, dbConfig, primaryDataSourceName);
      case "history":
        return fetchGlobalHistoryPayload(req, dbConfig, primaryDataSourceName);
      case "operations-health":
        return fetchOperationsHealthPayload(dbConfig, primaryDataSourceName);
      case "runtime-health":
        return fetchRuntimeHealthPayload(dbConfig);
      case "clients-summary":
        return fetchClientsSummaryPayload(req, dbConfig, primaryDataSourceName);
      case "data-sources":
        return fetchDataSourcesPayload(dbConfig, primaryDataSourceName);
      case "sync-logs":
        return fetchSyncLogsPayload(req, dbConfig, primaryDataSourceName);
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
  primaryDataSourceName = getPrimaryDataSourceName(),
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
      a.source_event_id,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.customer_name,
      a.client_name,
      a.severity,
      a.status_source,
      a.resolved_at
    from alerts a
    join data_sources d on d.id = a.data_source_id
    where a.source_event_id = $1
      and d.name = $2
    order by a.last_seen_at desc nulls last, a.updated_at desc nulls last, a.id desc
    limit 1
    `,
    [eventId, primaryDataSourceName],
  );

  if (!row) return null;

  const host = nullableText(
    sanitizeText(
      row.host_visible_name || row.host_technical_name || row.host_name,
      "",
      240,
    ),
  );
  const customer = nullableText(
    sanitizeText(row.customer_name || row.client_name, "", 160),
  );
  const statusSource = textValue(row.status_source, row.resolved_at ? "resolved" : "active").toLowerCase();
  const status = statusSource === "resolved" || row.resolved_at ? "resolved" : "active";

  return {
    id: textValue(row.id),
    source_event_id: textValue(row.source_event_id, eventId),
    host: host || "—",
    customer: customer || "—",
    severity: textValue(row.severity, "not_classified"),
    status,
  };
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

export function classifyRuntimeDatasource({ enabled = false, configured = false, lastSuccessAt = null, intervalSeconds = 60, lastError = null, now = Date.now() } = {}) {
  const status = classifyRuntimeHealth({ enabled, configured, lastSuccessAt, intervalSeconds, lastError, now });
  const activationBlocker = runtimeErrorKind(lastError);
  return {
    status,
    currentError: enabled || activationBlocker ? lastError : null,
    lastHistoricalError: !enabled && !activationBlocker ? lastError : null,
  };
}

function runtimeComponent({ id, category, name, enabled = true, status = RUNTIME_STATUS.UNKNOWN, connectivity = "unknown", auth = "unknown", freshness = null, last_success_at = null, last_observed_at = null, interval_seconds = null, duration_ms = null, version = null, failure_count = 0, current_error = null, last_historical_error = null, detail = null }) {
  return {
    id, category, name, enabled, status, connectivity, auth, freshness, last_success_at, last_observed_at,
    interval_seconds, duration_ms, version, failure_count,
    current_error: sanitizeText(current_error, "", 180) || null,
    last_historical_error: sanitizeText(last_historical_error, "", 180) || null,
    detail,
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

// Maps is a placeholder datasource until its dedicated collector configuration
// is registered. An encrypted legacy token alone is not activation-ready config.
const ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG = new Set(["maps"]);

async function fetchRuntimeHealthPayload(config) {
  const startedAt = Date.now();
  const now = Date.now();
  const [probe, sources, serviceNow, outbox] = await Promise.all([
    queryRow(config, "select 1 as reachable"),
    queryRows(config, `select d.id, d.name, d.sync_enabled, d.sync_interval_seconds, d.last_success_at, d.last_sync_at, d.last_sync_error, d.last_error, d.failure_count, (d.token_encrypted is not null and d.token_encrypted <> '') as has_token, nullif(btrim(d.api_url), '') is not null as has_api_url from data_sources d where coalesce(d.type, 'zabbix') = 'zabbix' order by d.display_order, d.name`),
    queryRows(config, `select s.last_success_at, s.watermark_sys_updated_on, to_jsonb(s)->>'last_error' as last_error, to_jsonb(s)->>'status' as status from servicenow_sync_state s where s.sync_key = 'incident' limit 1`),
    queryRow(config, `select count(*) filter (where status in ('pending','processing'))::int as pending, count(*) filter (where status = 'failed')::int as failed, max(created_at) filter (where status in ('success','done')) as last_success_at from integration_outbox where action_type like 'webex_%' or action_type like 'theo_%'`),
  ]);
  const components = [];
  const duration = Date.now() - startedAt;
  const reachable = integerValue(probe?.reachable, 0) === 1;
  components.push(runtimeComponent({ id: "vercel-bff", category: "PLATFORM", name: "Vercel/BFF", status: reachable ? RUNTIME_STATUS.HEALTHY : RUNTIME_STATUS.DOWN, connectivity: reachable ? "reachable" : "unreachable", auth: "authenticated", last_success_at: reachable ? generatedAt() : null, last_observed_at: generatedAt(), duration_ms: duration, detail: "Observação da requisição BFF" }));
  components.push(runtimeComponent({ id: "postgresql", category: "PLATFORM", name: "PostgreSQL", status: reachable ? RUNTIME_STATUS.HEALTHY : RUNTIME_STATUS.DOWN, connectivity: reachable ? "reachable" : "unreachable", auth: "configured", last_success_at: reachable ? generatedAt() : null, last_observed_at: generatedAt(), duration_ms: duration, detail: "SELECT 1 pelo pool BFF" }));
  components.push(runtimeComponent({ id: "pgbouncer", category: "PLATFORM", name: "PgBouncer", status: RUNTIME_STATUS.UNKNOWN, connectivity: "unknown", auth: "unknown", detail: "Sem telemetria independente do pool" }));
  const sourcesByName = new Map(sources.map((source) => [String(source.name || "").trim().toLowerCase(), source]));
  const sourceNames = [...new Set([...REQUIRED_ZABBIX_RUNTIME_SOURCES, ...sourcesByName.keys()])];
  for (const sourceName of sourceNames) {
    const source = sourcesByName.get(sourceName) || null;
    const interval = integerValue(source?.sync_interval_seconds, 60, { min: 15, max: 86400 });
    const lastSuccess = isoDate(source?.last_success_at);
    const lastError = source?.last_error || source?.last_sync_error || null;
    const enabled = Boolean(source?.sync_enabled);
    const configured = Boolean(source?.has_token) && Boolean(source?.has_api_url) && !ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG.has(sourceName);
    const classification = classifyRuntimeDatasource({ enabled, configured, lastSuccessAt: lastSuccess, intervalSeconds: interval, lastError, now });
    const missingSource = !source;
    const detail = missingSource
      ? "Fonte esperada ainda não cadastrada"
      : ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG.has(sourceName)
        ? "Configuração do collector Maps não registrada"
        : "Evidência persistida em data_sources";
    components.push(runtimeComponent({
      id: `zabbix:${textValue(source?.id, sourceName)}`,
      category: "ZABBIX",
      name: sanitizeText(source?.name || sourceName, "Zabbix", 160),
      enabled,
      status: classification.status,
      connectivity: classification.currentError ? "error" : lastSuccess ? "observed" : "unknown",
      auth: configured ? "configured" : "missing",
      freshness: runtimeFreshness(lastSuccess, interval, now),
      last_success_at: lastSuccess,
      last_observed_at: isoDate(source?.last_sync_at),
      interval_seconds: interval,
      failure_count: integerValue(source?.failure_count, 0),
      current_error: classification.currentError,
      last_historical_error: classification.lastHistoricalError,
      detail,
    }));
  }
  const sn = serviceNow[0] || {};
  const snInterval = 30;
  const snEnabled = String(process.env.SERVICENOW_INCIDENTS_ENABLED || "").toLowerCase() === "true";
  const snConfigured = snEnabled || Boolean(sn.last_success_at || sn.watermark_sys_updated_on);
  const snStatus = classifyRuntimeHealth({ enabled: snEnabled, configured: snConfigured, lastSuccessAt: sn.last_success_at, intervalSeconds: snInterval, lastError: sn.last_error, now });
  const snBase = { enabled: snEnabled, status: snStatus, connectivity: sn.last_success_at ? "observed" : "unknown", auth: snConfigured ? "configured" : "missing", freshness: runtimeFreshness(sn.last_success_at, snInterval, now), last_success_at: isoDate(sn.last_success_at), last_observed_at: isoDate(sn.watermark_sys_updated_on), interval_seconds: snInterval, current_error: sn.last_error };
  components.push(runtimeComponent({ id: "servicenow-read-model", category: "SERVICENOW", name: "ServiceNow PROD Read Model", ...snBase, detail: "Leitura local PostgreSQL" }));
  components.push(runtimeComponent({ id: "servicenow-watermark", category: "SERVICENOW", name: "ServiceNow Watermark", ...snBase, status: sn.watermark_sys_updated_on ? snStatus : RUNTIME_STATUS.UNKNOWN, detail: "watermark_sys_updated_on" }));
  components.push(runtimeComponent({ id: "servicenow-collector", category: "SERVICENOW", name: "ServiceNow Collector", ...snBase, detail: "Sem HTTP ServiceNow nesta requisição" }));
  for (const name of ["Zabbix Sync", "Recovery", "ServiceNow Sync"]) components.push(runtimeComponent({ id: `timer:${name.toLowerCase().replace(/\s+/g, "-")}`, category: "WORKERS", name, status: RUNTIME_STATUS.UNKNOWN, detail: "Heartbeat individual não persistido" }));
  const theoEnabled = String(process.env.THEO_ENABLED || process.env.WORKER_WEBEX_NOC_ENABLED || "").toLowerCase() === "true";
  const theoConfigured = Boolean(String(process.env.THEO_URL || process.env.WEBEX_BOT_TOKEN || "").trim());
  const theoError = Number(outbox?.failed || 0) > 0 ? "outbox_failed" : null;
  const theoStatus = !theoConfigured ? RUNTIME_STATUS.CONFIG_MISSING : !theoEnabled ? RUNTIME_STATUS.READY_DISABLED : theoError ? RUNTIME_STATUS.DOWN : Number(outbox?.pending || 0) > 0 ? RUNTIME_STATUS.DEGRADED : classifyRuntimeHealth({ enabled: true, configured: true, lastSuccessAt: outbox?.last_success_at, intervalSeconds: 60, now });
  components.push(runtimeComponent({ id: "theo-webex", category: "INTEGRATIONS", name: "Theo/Webex", enabled: theoEnabled, status: theoStatus, connectivity: outbox?.last_success_at ? "observed" : "unknown", auth: theoConfigured ? "configured" : "missing", last_success_at: isoDate(outbox?.last_success_at), failure_count: integerValue(outbox?.failed, 0), current_error: theoError, detail: `outbox pending=${integerValue(outbox?.pending, 0)}` }));
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
`;

async function findAlertByExplicitServiceNowTag(tagName, value, config) {
  const row = await queryRow(
    config,
    `
    select
      a.id::text as id,
      a.source_event_id,
      a.host_name,
      a.host_visible_name,
      a.host_technical_name,
      a.customer_name,
      a.client_name,
      a.problem_name,
      a.trigger_description,
      a.severity,
      a.status_source,
      a.first_seen_at,
      a.resolved_at
    from alerts a
    where (${EXPLICIT_SERVICENOW_TAG_SQL})
    order by a.last_seen_at desc nulls last, a.updated_at desc nulls last, a.id desc
    limit 1
    `,
    [tagName, value],
  );

  if (!row) return null;
  const host = nullableText(sanitizeText(
    row.host_visible_name || row.host_technical_name || row.host_name,
    "",
    240,
  ));
  const customer = nullableText(sanitizeText(row.customer_name || row.client_name, "", 160));
  const problem = nullableText(sanitizeText(row.problem_name || row.trigger_description, "", 700));
  const statusSource = textValue(row.status_source, row.resolved_at ? "resolved" : "active").toLowerCase();

  return {
    id: textValue(row.id),
    source_event_id: textValue(row.source_event_id),
    host: host || "—",
    customer: customer || "—",
    problem: problem || "—",
    severity: textValue(row.severity, "not_classified"),
    status: statusSource === "resolved" || row.resolved_at ? "resolved" : "active",
    first_seen_at: isoDate(row.first_seen_at),
    resolved_at: isoDate(row.resolved_at),
  };
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
