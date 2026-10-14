import { getAttentionThresholds, getOneViewDbConfig, operationalTimezone } from "./oneview-db.js";
import { getOperationalDataSourceNames } from "./oneview-scope.js";

const ROUTES = Object.freeze({
  health: Object.freeze({ upstreamPath: "/health", role: "viewer", fallbackSafe: true, query: [] }),
  "dashboard-summary": Object.freeze({ upstreamPath: "/dashboard/summary", role: "viewer", fallbackSafe: true, query: ["refresh"] }),
  "grafana-summary": Object.freeze({ upstreamPath: "/dashboard/grafana-summary", role: "viewer", fallbackSafe: true, query: [] }),
  alerts: Object.freeze({
    upstreamPath: "/alerts",
    role: "viewer",
    fallbackSafe: true,
    query: [
      "page",
      "page_size",
      "client",
      "customer",
      "datasource",
      "customer_confidence",
      "severity",
      "status",
      "acknowledged",
      "acknowledged_source",
      "acknowledged_internal",
      "search",
      "search_field",
      "host_search",
      "problem_search",
      "date_from",
      "date_to",
      "first_seen_from",
      "first_seen_to",
      "last_seen_from",
      "last_seen_to",
      "resolved_from",
      "resolved_to",
      "acknowledged_from",
      "acknowledged_to",
      "sort",
      "order",
      "sort_secondary",
    ],
  }),
  "attention-required": Object.freeze({
    upstreamPath: "/attention-required",
    role: "viewer",
    fallbackSafe: true,
    query: ["limit", "first_seen_from", "first_seen_to"],
  }),
  "alert-detail": Object.freeze({ upstreamPath: "/alerts/:id", role: "viewer", fallbackSafe: true, query: ["id"] }),
  "alert-history": Object.freeze({ upstreamPath: "/alerts/:id/history", role: "viewer", fallbackSafe: true, query: ["id"] }),
  history: Object.freeze({
    upstreamPath: "/history",
    role: "viewer",
    fallbackSafe: true,
    query: [
      "page",
      "page_size",
      "customer",
      "datasource",
      "event_type",
      "search",
      "occurred_from",
      "occurred_to",
    ],
  }),
  "operations-health": Object.freeze({ upstreamPath: "/operations/health", role: "viewer", fallbackSafe: true, query: [] }),
  "runtime-health": Object.freeze({ upstreamPath: "/runtime-health", role: "viewer", fallbackSafe: false, query: ["view"] }),
  "clients-summary": Object.freeze({
    upstreamPath: "/clients/summary",
    role: "viewer",
    fallbackSafe: true,
    query: ["status", "first_seen_from", "first_seen_to", "limit"],
  }),
  "data-sources": Object.freeze({ upstreamPath: "/data-sources", role: "viewer", fallbackSafe: true, query: [] }),
  "sync-logs": Object.freeze({ upstreamPath: "/sync-logs/latest", role: "viewer", fallbackSafe: true, query: ["limit"] }),
});

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function timeoutValue(value) {
  const parsed = Number.parseInt(String(value || "8000"), 10);
  if (!Number.isFinite(parsed)) return 8000;
  return Math.min(Math.max(parsed, 1000), 30000);
}

function alertStaleMinutes(value) {
  const parsed = Number.parseInt(String(value || "15"), 10);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(Math.max(parsed, 1), 1440);
}

/**
 * OV-P0-100 — runtime de produção (Vercel production ou override explícito).
 * Preview/development/local não entram aqui.
 */
export function isOneViewProductionRuntime(env = process.env) {
  const vercelEnv = String(env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "production") return true;
  const runtimeEnv = String(env.ONEVIEW_RUNTIME_ENV || "").trim().toLowerCase();
  return runtimeEnv === "production";
}

export function getOneViewRoute(name) {
  return ROUTES[name] || null;
}

export function getOneViewConfig(env = process.env) {
  const productionRuntime = isOneViewProductionRuntime(env);
  const snapshotModeRequested = booleanValue(env.ONEVIEW_SNAPSHOT_MODE, false);
  const snapshotFallbackRequested = booleanValue(env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED, false);
  // OV-P0-100: em produção nunca servir snapshot antigo/multi-datasource (silencioso).
  // Artefatos e caminho local permanecem; só o gate muda o comportamento efetivo.
  const snapshotMode = productionRuntime ? false : snapshotModeRequested;
  const snapshotFallbackEnabled = productionRuntime ? false : snapshotFallbackRequested;
  const liveDbEnabled = booleanValue(env.ONEVIEW_LIVE_DB_ENABLED, false);
  const liveMode = liveDbEnabled && !snapshotMode ? "database" : "snapshot";
  const liveEnabled = liveMode === "database";
  const ackRequestEnabled = booleanValue(env.ONEVIEW_ACK_REQUEST_ENABLED, false);
  const ackExecutionEnabled = booleanValue(env.ONEVIEW_ACK_EXECUTION_ENABLED, false);
  const actionsDatabaseConfigured = Boolean(String(env.POSTGRES_ACTIONS_PASSWORD || env.ONEVIEW_ACTIONS_PASSWORD || "").trim());
  let dbConfig = null;
  let dbConfigErrorCode = null;

  if (liveEnabled) {
    try {
      dbConfig = getOneViewDbConfig(env);
    } catch (error) {
      // A falha será tratada pelo handler e só usará snapshot quando
      // ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=true (e fora de produção).
      dbConfig = null;
      dbConfigErrorCode = error?.code === "unsafe_database_user" ? "unsafe_database_user" : null;
    }
  }

  return Object.freeze({
    productionRuntime,
    snapshotMode,
    snapshotModeRequested,
    liveEnabled,
    liveMode,
    snapshotFallbackEnabled,
    snapshotFallbackRequested,
    ackRequestEnabled,
    ackExecutionEnabled,
    ackEnabled: ackRequestEnabled && !ackExecutionEnabled && actionsDatabaseConfigured,
    timeoutMs: timeoutValue(env.ONEVIEW_API_TIMEOUT_MS),
    attentionThresholds: getAttentionThresholds(env),
    operationalTimezone: operationalTimezone(env.ONEVIEW_OPERATIONAL_TIMEZONE),
    alertStaleMinutes: alertStaleMinutes(env.ONEVIEW_ALERT_STALE_MINUTES),
    operationalDataSourceNames: getOperationalDataSourceNames(),
    dbConfig,
    dbConfigErrorCode,
  });
}

export function allowedQueryString(req, route) {
  const params = new URLSearchParams();
  for (const key of route.query) {
    const raw = req.query?.[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      params.append(key, String(value).slice(0, 200));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
