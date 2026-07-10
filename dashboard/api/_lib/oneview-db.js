import pg from "pg";

const { Pool } = pg;

const MAX_ALERT_LIMIT = 5000;
const MAX_SYNC_LOG_LIMIT = 50;
const DEFAULT_SYNC_LOG_LIMIT = 20;

const URL_PATTERN = /https?:\/\/[^\s,;)]+/gi;
const PRIVATE_IP_PATTERN = /\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\b/gi;
const SECRET_PATTERN = /\b(?:token|password|senha|secret|authorization|bearer)\b/gi;

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
    .replace(SECRET_PATTERN, "[DADO_PROTEGIDO]")
    .slice(0, maxLength);
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
  return new Map(uniqueHosts.map((host, index) => [host, `Host protegido ${String(index + 1).padStart(4, "0")}`]));
}

function aliasForHost(rawHost, aliases) {
  const normalized = textValue(rawHost);
  if (!normalized) return "-";
  return aliases.get(normalized) ?? "Host protegido";
}

function databaseFailureCode(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["28P01", "28000"].includes(code)) return "database_authentication_failed";
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

function alertWhere(req) {
  const params = [];
  const clauses = [];
  const one = (key) => {
    const value = req.query?.[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const push = (clause, value) => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };

  const clientName = textValue(one("client_name")).slice(0, 160);
  const severity = textValue(one("severity")).slice(0, 40);
  const statusInternal = textValue(one("status_internal")).slice(0, 40);
  const host = textValue(one("host")).slice(0, 160);
  const service = textValue(one("service")).slice(0, 160);
  const acknowledged = textValue(one("acknowledged")).toLowerCase();

  if (clientName) push("a.client_name = ?", clientName);
  if (severity) push("a.severity = ?", severity);
  if (statusInternal) push("a.status_internal = ?", statusInternal);
  if (host) push("coalesce(a.host_name, '') ilike ?", `%${host}%`);
  if (service) push("coalesce(a.service_name, '') ilike ?", `%${service}%`);
  if (acknowledged === "true" || acknowledged === "false") {
    push("(coalesce(a.acknowledged_source, false) or coalesce(a.acknowledged_internal, false)) = ?", acknowledged === "true");
  }

  return {
    params,
    sql: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
  };
}

function generatedAt() {
  return new Date().toISOString();
}

function mapAlertRows(rows) {
  const aliases = aliasMapFromHosts(rows.map((row) => row.host_name));
  return rows.map((row) => {
    const hostAlias = aliasForHost(row.host_name, aliases);
    return {
      id: textValue(row.id),
      data_source_id: textValue(row.data_source_id),
      datasource_name: sanitizeText(row.datasource_name ?? row.data_source_name, "Datasource OneView", 160),
      client_name: sanitizeText(row.client_name, "Cliente OneView", 160),
      source_type: "zabbix",
      source_event_id: textValue(row.source_event_id, textValue(row.id)),
      source_problem_id: nullableText(row.source_problem_id),
      source_trigger_id: nullableText(row.source_trigger_id),
      source_host_id: null,
      host_name: hostAlias,
      host_ip: null,
      host_group: null,
      service_name: nullableText(replaceInternalHost(row.service_name, row.host_name, hostAlias, "", 240)),
      problem_name: replaceInternalHost(row.problem_name, row.host_name, hostAlias, "Alerta sincronizado", 700),
      severity: textValue(row.severity, "not_classified"),
      status_source: textValue(row.status_source, "active"),
      status_internal: textValue(row.status_internal, "new"),
      acknowledged_source: Boolean(row.acknowledged_source),
      acknowledged_internal: Boolean(row.acknowledged_internal),
      first_seen_at: isoDate(row.first_seen_at, generatedAt()),
      started_at: isoDate(row.first_seen_at, generatedAt()),
      last_seen_at: isoDate(row.last_seen_at, generatedAt()),
      resolved_at: null,
      duration_seconds: integerValue(row.duration_seconds, 0),
      fingerprint: textValue(row.fingerprint, `db-${textValue(row.id)}`),
      payload_normalized: {},
      created_at: isoDate(row.first_seen_at, generatedAt()),
      updated_at: isoDate(row.last_seen_at, generatedAt()),
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
  const { params, sql } = alertWhere(req);
  const offset = integerValue(Array.isArray(req.query?.offset) ? req.query.offset[0] : req.query?.offset, 0, { min: 0, max: 500000 });
  const limit = integerValue(Array.isArray(req.query?.limit) ? req.query.limit[0] : req.query?.limit, 500, { min: 1, max: MAX_ALERT_LIMIT });

  const [totalRow, itemRows] = await Promise.all([
    queryRow(config, `select count(*)::int as total from v_active_alerts a ${sql}`, params),
    queryRows(
      config,
      `
        select
          a.id,
          a.data_source_id,
          a.data_source_name as datasource_name,
          a.client_name,
          a.source_event_id,
          a.source_problem_id,
          a.source_trigger_id,
          a.source_host_id,
          a.host_name,
          a.host_ip,
          a.host_group,
          a.service_name,
          a.problem_name,
          a.severity,
          a.status_source,
          a.status_internal,
          a.acknowledged_source,
          a.acknowledged_internal,
          a.first_seen_at,
          a.last_seen_at,
          a.duration_seconds,
          a.fingerprint
        from v_active_alerts a
        ${sql}
        order by a.last_seen_at desc, a.first_seen_at desc, a.id desc
        limit $${params.length + 1}
        offset $${params.length + 2}
      `,
      [...params, limit, offset],
    ),
  ]);

  return {
    generated_at: generatedAt(),
    total: integerValue(totalRow?.total, 0),
    limit,
    offset,
    items: mapAlertRows(itemRows),
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

async function fetchHealthPayload(config) {
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
  };
}

async function fetchDashboardSummaryPayload(config) {
  const [
    totalAlertsRow,
    activeAlertsRow,
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
    queryRows(config, "select severity, count(*)::int as count from v_active_alerts group by severity order by count desc, severity asc"),
    queryRows(config, "select status_internal, count(*)::int as count from v_active_alerts group by status_internal order by count desc, status_internal asc"),
    queryRows(config, "select client_name, count(*)::int as count from v_active_alerts group by client_name order by count desc, client_name asc"),
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
    queryRows(config, "select id, client_name, host_name, problem_name, severity, duration_seconds::int, first_seen_at from v_alert_longest_duration limit 10"),
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
    queryRows(config, "select client_name as client, count(*)::int as count from v_active_alerts group by client_name order by count desc, client_name asc"),
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
  const items = mapDataSourceRows(await fetchDataSourceRows(config));
  return {
    generated_at: generatedAt(),
    clients: items.map((source) => ({
      id: source.id,
      name: source.client_name || source.name,
      status: source.status,
      alerts_count: source.alerts_count ?? 0,
      last_sync_at: source.last_sync_at,
    })),
  };
}

export function getOneViewDbConfig(env = process.env) {
  const host = textValue(env.ONEVIEW_DB_HOST);
  const database = textValue(env.ONEVIEW_DB_NAME);
  const user = textValue(env.ONEVIEW_DB_USER);
  const password = String(env.POSTGRES_APP_PASSWORD || "");
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
      statement_timeout: config.queryTimeoutMs,
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

export async function fetchOneViewDatabase(routeName, req, config) {
  const dbConfig = config?.dbConfig || getOneViewDbConfig();
  try {
    switch (routeName) {
      case "health":
        return fetchHealthPayload(dbConfig);
      case "dashboard-summary":
        return fetchDashboardSummaryPayload(dbConfig);
      case "grafana-summary":
        return fetchGrafanaSummaryPayload(dbConfig);
      case "alerts":
        return fetchAlertList(req, dbConfig);
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
