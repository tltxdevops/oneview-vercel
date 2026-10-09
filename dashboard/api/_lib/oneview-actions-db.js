import pg from "pg";

const { Pool } = pg;
const ACTIONS_DB_USER = "oneview_actions";

let actionsPool;
let actionsPoolKey = "";

function textValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "sim"].includes(normalized)) return true;
  if (["false", "0", "no", "nao", "não"].includes(normalized)) return false;
  return fallback;
}

function integerValue(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function sslConfig(config) {
  if (config.sslMode === "disable") return undefined;
  return config.rejectUnauthorized === false ? { rejectUnauthorized: false } : true;
}

export function actionsPasswordSource(env = process.env) {
  if (String(env.POSTGRES_ACTIONS_PASSWORD || "").trim()) return "POSTGRES_ACTIONS_PASSWORD";
  if (String(env.ONEVIEW_ACTIONS_PASSWORD || "").trim()) return "ONEVIEW_ACTIONS_PASSWORD";
  return "missing";
}

export function classifyActionsFailure(error) {
  if (error?.code === "actions_database_not_configured") return "missing_env";
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code) || message.includes("getaddrinfo")) return "dns_error";
  if (["ECONNREFUSED", "ECONNRESET"].includes(code) || message.includes("connection refused")) return "connection_refused";
  if (message.includes("unsupported startup parameter") || message.includes("too many clients") || message.includes("remaining connection slots")) {
    return "pool_error";
  }
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "57014"].includes(code) || message.includes("timeout")) return "timeout";
  if (["28P01", "28000"].includes(code) || message.includes("password authentication failed")) return "authentication_failed";
  if (code.includes("CERT") || message.includes("certificate") || message.includes("tls") || message.includes("ssl")) return "ssl_error";
  if (["42501", "42503"].includes(code) || message.includes("permission denied")) return "permission_denied";
  if (["42P01", "42703", "42601", "22P02"].includes(code)) return "query_error";
  if (message.includes("connect")) return "pool_error";
  return "query_error";
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

function poolStatsFor(poolInstance = actionsPool) {
  return {
    db_pool_max: Number(poolInstance?.options?.max || 0),
    db_pool_total: Number(poolInstance?.totalCount || 0),
    db_pool_idle: Number(poolInstance?.idleCount || 0),
    db_pool_waiting: Number(poolInstance?.waitingCount || 0),
  };
}

function logActionsPoolMetric({ operation, retry = 0, durationMs = 0, error, poolInstance = actionsPool } = {}) {
  console.info(JSON.stringify({
    event: "oneview_actions_database_operation",
    operation: String(operation || "actions_database").replace(/[^a-zA-Z0-9_:/.-]/g, "").slice(0, 120) || "actions_database",
    retry: Math.max(0, Number(retry) || 0),
    duration_ms: Math.max(0, Number(durationMs) || 0),
    error_class: error ? classifyActionsFailure(error) : "none",
    ...poolStatsFor(poolInstance),
  }));
}

export function getOneViewActionsDbConfig(env = process.env) {
  const host = textValue(env.ONEVIEW_DB_HOST);
  const database = textValue(env.ONEVIEW_DB_NAME);
  // ONEVIEW_ACTIONS_PASSWORD is the project-standard Production secret.
  // Keep the former name only as a compatibility fallback for older deploys.
  const password = String(env.POSTGRES_ACTIONS_PASSWORD || env.ONEVIEW_ACTIONS_PASSWORD || "");
  const sslMode = textValue(env.ONEVIEW_DB_SSLMODE, "require").toLowerCase();

  if (!host || !database || !password) {
    const error = new Error("oneview_actions_db_config_incomplete");
    error.code = "actions_database_not_configured";
    throw error;
  }
  if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)) {
    const error = new Error("oneview_actions_db_config_invalid");
    error.code = "actions_database_not_configured";
    throw error;
  }

  return Object.freeze({
    host,
    port: integerValue(env.ONEVIEW_DB_PORT, 443, 1, 65535),
    database,
    user: ACTIONS_DB_USER,
    password,
    sslMode,
    rejectUnauthorized: booleanValue(env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED, true),
    poolMax: integerValue(env.ONEVIEW_ACTIONS_DB_POOL_MAX, 1, 1, 3),
    queryTimeoutMs: integerValue(env.ONEVIEW_DB_QUERY_TIMEOUT_MS, 10000, 1000, 30000),
    connectionTimeoutMs: integerValue(env.ONEVIEW_DB_CONNECTION_TIMEOUT_MS, 10000, 1000, 30000),
    idleTimeoutMs: integerValue(env.ONEVIEW_DB_IDLE_TIMEOUT_MS, 5000, 1000, 60000),
    maxLifetimeSeconds: integerValue(env.ONEVIEW_DB_MAX_LIFETIME_SECONDS, 300, 30, 3600),
    statementTimeoutMs: integerValue(env.ONEVIEW_DB_STATEMENT_TIMEOUT_MS, 10000, 1000, 30000),
    idleInTransactionTimeoutMs: integerValue(env.ONEVIEW_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 15000, 1000, 60000),
  });
}

export function getOneViewActionsPool(config = getOneViewActionsDbConfig()) {
  const signature = poolSignature(config);
  if (!actionsPool || actionsPoolKey !== signature) {
    if (actionsPool) actionsPool.end().catch(() => undefined);
    const nextPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: ACTIONS_DB_USER,
      password: config.password,
      max: config.poolMax,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      maxLifetimeSeconds: config.maxLifetimeSeconds,
      allowExitOnIdle: true,
      ssl: sslConfig(config),
      application_name: "oneview-actions-bff",
    });
    nextPool.on("error", (error) => {
      console.error(JSON.stringify({
        event: "oneview_actions_pool_error",
        operation: "idle_client",
        retry: 0,
        duration_ms: 0,
        error_class: classifyActionsFailure(error),
        ...poolStatsFor(nextPool),
      }));
    });
    actionsPool = nextPool;
    actionsPoolKey = signature;
  }
  return actionsPool;
}

export async function withOneViewActionsQuery(work, config = getOneViewActionsDbConfig()) {
  const pool = getOneViewActionsPool(config);
  const startedAt = Date.now();
  let client;
  let failure;
  try {
    client = await pool.connect();
    return await work(client);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (client) client.release(failure);
    logActionsPoolMetric({ operation: "actions_query", durationMs: Date.now() - startedAt, error: failure, poolInstance: pool });
  }
}

export async function withOneViewActionsTransaction(work, config = getOneViewActionsDbConfig()) {
  const pool = getOneViewActionsPool(config);
  const startedAt = Date.now();
  let client;
  let began = false;
  let failure;
  try {
    client = await pool.connect();
    await client.query("begin");
    began = true;
    // PgBouncer in front of this BFF rejects timeout startup parameters. SET LOCAL
    // applies only to this explicit transaction and is reset on commit/rollback.
    await client.query(
      "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
      [String(config.statementTimeoutMs), String(config.idleInTransactionTimeoutMs)],
    );
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    failure = error;
    if (client && began) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    if (client) client.release(failure);
    logActionsPoolMetric({ operation: "actions_transaction", durationMs: Date.now() - startedAt, error: failure, poolInstance: pool });
  }
}

export async function resetOneViewActionsPoolForTests() {
  if (actionsPool) await actionsPool.end().catch(() => undefined);
  actionsPool = undefined;
  actionsPoolKey = "";
}
