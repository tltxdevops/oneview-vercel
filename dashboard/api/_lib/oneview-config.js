import { getAttentionThresholds, getOneViewDbConfig, operationalTimezone } from "./oneview-db.js";
import { getPrimaryDataSourceName } from "./oneview-scope.js";

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

export function getOneViewRoute(name) {
  return ROUTES[name] || null;
}

export function getOneViewConfig(env = process.env) {
  const snapshotMode = booleanValue(env.ONEVIEW_SNAPSHOT_MODE, false);
  const liveDbEnabled = booleanValue(env.ONEVIEW_LIVE_DB_ENABLED, false);
  const liveMode = liveDbEnabled && !snapshotMode ? "database" : "snapshot";
  const liveEnabled = liveMode === "database";
  const snapshotFallbackEnabled = booleanValue(env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED, false);
  const ackRequestEnabled = booleanValue(env.ONEVIEW_ACK_REQUEST_ENABLED, false);
  const ackExecutionEnabled = booleanValue(env.ONEVIEW_ACK_EXECUTION_ENABLED, false);
  const authenticatedActionsEnabled = booleanValue(env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS, false);
  const actionsDatabaseConfigured = Boolean(String(env.POSTGRES_ACTIONS_PASSWORD || "").trim());
  let dbConfig = null;
  let dbConfigErrorCode = null;

  if (liveEnabled) {
    try {
      dbConfig = getOneViewDbConfig(env);
    } catch (error) {
      // A falha será tratada pelo handler e só usará snapshot quando
      // ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=true.
      dbConfig = null;
      dbConfigErrorCode = error?.code === "unsafe_database_user" ? "unsafe_database_user" : null;
    }
  }

  return Object.freeze({
    snapshotMode,
    liveEnabled,
    liveMode,
    snapshotFallbackEnabled,
    ackRequestEnabled,
    ackExecutionEnabled,
    ackEnabled: authenticatedActionsEnabled && ackRequestEnabled && !ackExecutionEnabled && actionsDatabaseConfigured,
    timeoutMs: timeoutValue(env.ONEVIEW_API_TIMEOUT_MS),
    attentionThresholds: getAttentionThresholds(env),
    operationalTimezone: operationalTimezone(env.ONEVIEW_OPERATIONAL_TIMEZONE),
    alertStaleMinutes: alertStaleMinutes(env.ONEVIEW_ALERT_STALE_MINUTES),
    primaryDataSourceName: getPrimaryDataSourceName(env),
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
