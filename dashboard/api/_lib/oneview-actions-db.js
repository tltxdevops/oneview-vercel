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
  });
}

export function getOneViewActionsPool(config = getOneViewActionsDbConfig()) {
  const signature = poolSignature(config);
  if (!actionsPool || actionsPoolKey !== signature) {
    if (actionsPool) actionsPool.end().catch(() => undefined);
    actionsPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: ACTIONS_DB_USER,
      password: config.password,
      max: config.poolMax,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      ssl: sslConfig(config),
      application_name: "oneview-actions-bff",
    });
    actionsPool.on("error", () => {
      console.error(JSON.stringify({ event: "oneview_actions_pool_error", code: "database_unavailable" }));
    });
    actionsPoolKey = signature;
  }
  return actionsPool;
}

export async function withOneViewActionsTransaction(work, config = getOneViewActionsDbConfig()) {
  const client = await getOneViewActionsPool(config).connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resetOneViewActionsPoolForTests() {
  if (actionsPool) await actionsPool.end().catch(() => undefined);
  actionsPool = undefined;
  actionsPoolKey = "";
}
