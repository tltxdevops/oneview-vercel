const ROUTES = Object.freeze({
  health: Object.freeze({ upstreamPath: "/health", role: "viewer", fallbackSafe: true, query: [] }),
  "dashboard-summary": Object.freeze({ upstreamPath: "/dashboard/summary", role: "viewer", fallbackSafe: true, query: [] }),
  "grafana-summary": Object.freeze({ upstreamPath: "/dashboard/grafana-summary", role: "viewer", fallbackSafe: true, query: [] }),
  alerts: Object.freeze({
    upstreamPath: "/alerts",
    role: "viewer",
    fallbackSafe: true,
    query: ["client_name", "severity", "status_internal", "acknowledged", "limit", "offset"],
  }),
  "clients-summary": Object.freeze({ upstreamPath: "/clients/summary", role: "viewer", fallbackSafe: true, query: [] }),
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
  const liveEnabled = booleanValue(env.ONEVIEW_LIVE_API_ENABLED, false);
  const snapshotFallbackEnabled = booleanValue(env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED, true);
  const apiBaseUrl = String(env.ONEVIEW_API_BASE_URL || "").trim();
  const accessClientId = String(env.CF_ACCESS_CLIENT_ID || "").trim();
  const accessClientSecret = String(env.CF_ACCESS_CLIENT_SECRET || "").trim();

  if (liveEnabled) {
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
    snapshotFallbackEnabled,
    apiBaseUrl,
    accessClientId,
    accessClientSecret,
    timeoutMs: timeoutValue(env.ONEVIEW_API_TIMEOUT_MS),
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
