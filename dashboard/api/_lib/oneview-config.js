import { getOneViewDbConfig } from "./oneview-db.js";

const ROUTES = Object.freeze({
  health: Object.freeze({ upstreamPath: "/health", role: "viewer", fallbackSafe: true, query: [] }),
  "dashboard-summary": Object.freeze({ upstreamPath: "/dashboard/summary", role: "viewer", fallbackSafe: true, query: [] }),
  "grafana-summary": Object.freeze({ upstreamPath: "/dashboard/grafana-summary", role: "viewer", fallbackSafe: true, query: [] }),
  alerts: Object.freeze({
    upstreamPath: "/alerts",
    role: "viewer",
    fallbackSafe: true,
    query: ["client_name", "severity", "status_internal", "acknowledged", "host", "service", "limit", "offset"],
  }),
  "clients-summary": Object.freeze({ upstreamPath: "/clients/summary", role: "viewer", fallbackSafe: true, query: [] }),
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

export function getOneViewRoute(name) {
  return ROUTES[name] || null;
}

export function getOneViewConfig(env = process.env) {
  const snapshotMode = booleanValue(env.ONEVIEW_SNAPSHOT_MODE, false);
  const liveDbEnabled = booleanValue(env.ONEVIEW_LIVE_DB_ENABLED, false);
  const liveMode = liveDbEnabled && !snapshotMode ? "database" : "snapshot";
  const liveEnabled = liveMode === "database";
  const snapshotFallbackEnabled = booleanValue(env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED, false);
  let dbConfig = null;

  if (liveEnabled) {
    try {
      dbConfig = getOneViewDbConfig(env);
    } catch {
      // A falha será tratada pelo handler e só usará snapshot quando
      // ONEVIEW_SNAPSHOT_FALLBACK_ENABLED=true.
      dbConfig = null;
    }
  }

  return Object.freeze({
    snapshotMode,
    liveEnabled,
    liveMode,
    snapshotFallbackEnabled,
    timeoutMs: timeoutValue(env.ONEVIEW_API_TIMEOUT_MS),
    dbConfig,
  });
}

export function allowedQueryString(req, route) {
  const params = new URLSearchParams();
  for (const key of route.query) {
    const raw = req.query?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || value === "") continue;
    const normalized = String(value).slice(0, 200);
    params.set(key, normalized);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
