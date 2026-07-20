import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getOneViewConfig } from "../api/_lib/oneview-config.js";
import {
  fetchOneViewDatabase,
  getOneViewDbConfig,
  resetOneViewDbPoolForTests,
} from "../api/_lib/oneview-db.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const { Client } = pg;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFilePath = path.join(rootDir, ".env.local");
const inspection = loadLocalEnv(envFilePath);

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function selectedPasswordSource(env = process.env) {
  if (env.POSTGRES_READONLY_PASSWORD) return "POSTGRES_READONLY_PASSWORD";
  return "missing";
}

function safePgCode(error) {
  const code = String(error?.code || "").toUpperCase();
  return /^[A-Z0-9]{2,20}$/.test(code) ? code : null;
}

function sanitizedMessage(error) {
  const code = safePgCode(error);
  const message = String(error?.message || "").toLowerCase();
  if (error?.code === "unsafe_database_user" || message.includes("unsafe_database_user")) return "unsafe database user";
  if (message.includes("missing password") || message.includes("config_incomplete")) return "missing password";
  if (["28P01", "28000"].includes(code) || message.includes("password authentication failed") || message.includes("authentication failed")) {
    return "password authentication failed";
  }
  if (message.includes("unsupported startup parameter") || message.includes("startup parameter")) {
    return "PgBouncer startup parameter rejected";
  }
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || message.includes("timeout")) return "connection timeout";
  if (code?.includes("CERT") || message.includes("certificate") || message.includes("tls") || message.includes("ssl")) {
    return "certificate error";
  }
  return "query failed";
}

function stageResult(stage, status, startedAt, extra = {}) {
  return {
    stage,
    status,
    password_source: extra.passwordSource ?? null,
    pg_code: extra.error ? safePgCode(extra.error) : null,
    pg_severity: extra.error?.severity ? String(extra.error.severity).slice(0, 32) : null,
    sanitized_message: extra.message ?? (extra.error ? sanitizedMessage(extra.error) : null),
    current_user_if_success: extra.currentUser ?? null,
    active_alerts_if_success: Number.isFinite(extra.activeAlerts) ? extra.activeAlerts : null,
    duration_ms: Math.max(Date.now() - startedAt, 0),
  };
}

function output(value) {
  console.info(JSON.stringify(value));
}

const preflight = {
  cwd: process.cwd(),
  env_file_path: envFilePath,
  env_file_exists: inspection.exists,
  env_file_modified_at: inspection.modifiedAt,
  live_db_enabled: bool(process.env.ONEVIEW_LIVE_DB_ENABLED),
  snapshot_mode: bool(process.env.ONEVIEW_SNAPSHOT_MODE),
  snapshot_fallback_enabled: bool(process.env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED),
  read_only_mode: bool(process.env.ONEVIEW_READ_ONLY_MODE, true),
  db_host_present: Boolean(process.env.ONEVIEW_DB_HOST),
  db_port: integer(process.env.ONEVIEW_DB_PORT, 443),
  db_name_present: Boolean(process.env.ONEVIEW_DB_NAME),
  db_user: process.env.ONEVIEW_DB_USER || null,
  db_user_is_allowed_readonly: process.env.ONEVIEW_DB_USER === "oneview_vercel_readonly",
  postgres_readonly_password_present: Boolean(process.env.POSTGRES_READONLY_PASSWORD),
  sslmode: process.env.ONEVIEW_DB_SSLMODE || "require",
  ssl_reject_unauthorized: bool(process.env.ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED, true),
  pool_max: integer(process.env.ONEVIEW_DB_POOL_MAX, 2),
  connection_timeout_ms: integer(process.env.ONEVIEW_DB_CONNECTION_TIMEOUT_MS, 10000),
  query_timeout_ms: integer(process.env.ONEVIEW_DB_QUERY_TIMEOUT_MS, 10000),
};
output(preflight);

for (const issue of inspection.issues) output({ stage: "env_audit", status: "failed", ...issue });
if (inspection.issues.length === 0) output({ stage: "env_audit", status: "ok", issues: 0 });

let runtimeConfig;
let configGuardResult;
{
  const startedAt = Date.now();
  try {
    runtimeConfig = getOneViewConfig(process.env);
    const accepted = runtimeConfig.liveEnabled && runtimeConfig.dbConfig?.user === "oneview_vercel_readonly";
    configGuardResult = {
      stage: "config_guard",
      status: accepted ? "ok" : "failed",
      accepts_oneview_vercel_readonly: accepted,
      unsafe_database_user: runtimeConfig.dbConfigErrorCode === "unsafe_database_user",
      selected_password_source: selectedPasswordSource(),
      duration_ms: Math.max(Date.now() - startedAt, 0),
    };
  } catch (error) {
    configGuardResult = {
      stage: "config_guard",
      status: "failed",
      accepts_oneview_vercel_readonly: false,
      unsafe_database_user: error?.code === "unsafe_database_user",
      selected_password_source: selectedPasswordSource(),
      duration_ms: Math.max(Date.now() - startedAt, 0),
    };
  }
  output(configGuardResult);
}

let dnsResult;
{
  const startedAt = Date.now();
  try {
    await dns.lookup(process.env.ONEVIEW_DB_HOST || "");
    dnsResult = { stage: "dns", status: "ok", duration_ms: Math.max(Date.now() - startedAt, 0) };
  } catch {
    dnsResult = { stage: "dns", status: "failed", duration_ms: Math.max(Date.now() - startedAt, 0) };
  }
  output(dnsResult);
}

function testTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ stage: "tcp", status, duration_ms: Math.max(Date.now() - startedAt, 0) });
    };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.once("connect", () => finish("ok"));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? "refused" : "failed"));
  });
}

const tcpResult = await testTcp(
  process.env.ONEVIEW_DB_HOST || "",
  integer(process.env.ONEVIEW_DB_PORT, 443),
  10000,
);
output(tcpResult);

function sslConfig(config) {
  if (config.sslMode === "disable") return undefined;
  return config.rejectUnauthorized === false ? { rejectUnauthorized: false } : true;
}

async function directPgAttempt() {
  const stage = "pg_configured_candidate";
  const passwordSource = selectedPasswordSource();
  const password = process.env.POSTGRES_READONLY_PASSWORD;
  const startedAt = Date.now();
  if (!password) return stageResult(stage, "failed", startedAt, { passwordSource, message: "missing password" });
  let client;
  try {
    const config = getOneViewDbConfig(process.env);
    client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: sslConfig(config),
      connectionTimeoutMillis: config.connectionTimeoutMs,
      query_timeout: config.queryTimeoutMs,
      application_name: "oneview-local-diagnostic",
    });
    await client.connect();
    const identity = await client.query("select current_user, current_database(), now()");
    const counts = await client.query("select count(*)::int as total from v_active_alerts");
    return stageResult(stage, "ok", startedAt, {
      passwordSource,
      currentUser: identity.rows[0]?.current_user || null,
      activeAlerts: Number(counts.rows[0]?.total),
    });
  } catch (error) {
    return stageResult(stage, "failed", startedAt, { passwordSource, error });
  } finally {
    await client?.end().catch(() => undefined);
  }
}

const configuredResult = await directPgAttempt();
output(configuredResult);

let helperResult;
{
  const startedAt = Date.now();
  try {
    const payload = await fetchOneViewDatabase("health", { query: {} }, runtimeConfig);
    helperResult = stageResult("bff_db_helper", "ok", startedAt, {
      passwordSource: selectedPasswordSource(),
      currentUser: runtimeConfig?.dbConfig?.user || null,
      activeAlerts: Number(payload?.counts?.active_alerts),
    });
  } catch (error) {
    helperResult = stageResult("bff_db_helper", "failed", startedAt, {
      passwordSource: selectedPasswordSource(),
      error,
    });
  } finally {
    await resetOneViewDbPoolForTests();
  }
  output(helperResult);
}

function determineRootCause() {
  if (configGuardResult.unsafe_database_user || !preflight.db_user_is_allowed_readonly) return "unsafe_database_user";
  if (!preflight.postgres_readonly_password_present) return "missing_readonly_password";
  if (dnsResult.status !== "ok") return "dns_failure";
  if (tcpResult.status !== "ok") return "tcp_timeout";
  if (configuredResult.sanitized_message === "certificate error") return "tls_failure";
  if (configuredResult.sanitized_message === "password authentication failed") return "password_authentication_failed";
  if (configuredResult.status === "ok" && helperResult.status !== "ok") return "db_helper_configuration_mismatch";
  if (configuredResult.status === "ok" && helperResult.status === "ok") return "database_connection_ok";
  return "db_helper_configuration_mismatch";
}

const rootCause = determineRootCause();
output({
  stage: "comparison",
  pg_configured_candidate: configuredResult.status,
  bff_db_helper_result: helperResult.status,
});
output({ root_cause: rootCause });
process.exitCode = rootCause === "database_connection_ok" ? 0 : 1;
