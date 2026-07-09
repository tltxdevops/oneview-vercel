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
  const liveDbEnabled = booleanValue(env.ONEVIEW_LIVE_DB_ENABLED, false);
  const liveApiEnabled = booleanValue(env.ONEVIEW_LIVE_API_ENABLED, false);
  const liveMode = liveDbEnabled ? "database" : liveApiEnabled ? "upstream" : "snapshot";
  const liveEnabled = liveMode !== "snapshot";
  const snapshotFallbackEnabled = booleanValue(env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED, true);
  const apiBaseUrl = String(env.ONEVIEW_API_BASE_URL || "").trim();
  const accessClientId = String(env.CF_ACCESS_CLIENT_ID || "").trim();
  const accessClientSecret = String(env.CF_ACCESS_CLIENT_SECRET || "").trim();
  const dbConfig = liveMode === "database" ? getOneViewDbConfig(env) : null;

  if (liveMode === "upstream") {
    let parsedUrl;
    try {
      parsedUrl = new URL(apiBaseUrl);
    } catch {
      throw new Error("oneview_live_config_invalid");
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      throw new Error("oneview_live_config_invalid");
    }
    if (!accessClientId || !accessClientSecret) {
      throw new Error("oneview_live_config_incomplete");
    }
  }

  return Object.freeze({
    liveEnabled,
    liveMode,
    snapshotFallbackEnabled,
    apiBaseUrl,
    accessClientId,
    accessClientSecret,
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
