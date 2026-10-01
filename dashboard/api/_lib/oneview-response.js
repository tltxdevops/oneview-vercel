import { methodNotAllowed, sendJson } from "./http.js";
import { getOneViewConfig, getOneViewRoute } from "./oneview-config.js";
import { fetchOneViewDatabase } from "./oneview-db.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewSnapshotPayload } from "./oneview-fallback.js";
import { invalidateOneViewSummaryCache, withOneViewSummaryCache } from "./oneview-runtime-cache.js";

const FORBIDDEN_KEY = /(?:authorization|cookie|token|password|senha|secret|credential|dsn|api_url|payload_raw|payload_normalized)/i;
const PRIVATE_VALUE = /(?:https?:\/\/[^\s]+|\blocalhost\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b)/i;
const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

export function sanitizeOneViewPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeOneViewPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !FORBIDDEN_KEY.test(key))
        .map(([key, child]) => [key, sanitizeOneViewPayload(child)]),
    );
  }
  if (typeof value === "string" && PRIVATE_VALUE.test(value)) return "[redacted]";
  return value;
}

function sendOneViewJson(res, status, payload, source, fallbackCode = null) {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (source) res.setHeader("X-OneView-Data-Source", source);
  const sanitized = sanitizeOneViewPayload(payload);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    if (source) sanitized.data_source = source;
    if (source) sanitized.fallback_code = fallbackCode;
    sanitized.checked_at = new Date().toISOString();
  }
  return sendJson(res, status, sanitized);
}

function responseRows(payload) {
  if (Array.isArray(payload?.items)) return payload.items.length;
  if (Array.isArray(payload?.clients)) return payload.clients.length;
  if (Array.isArray(payload?.data_sources)) return payload.data_sources.length;
  return 0;
}

function safeFallbackCode(error) {
  const code = String(error?.code || "");
  if (code === "unsafe_database_user") return code;
  return code.startsWith("database_") ? code : "database_unavailable";
}

function applicationErrorStatus(error) {
  if (error?.code === "invalid_query") return 400;
  if (error?.code === "not_found") return 404;
  return null;
}

function routeTemplate(routeName) {
  if (routeName === "attention-required") return "/api/oneview/attention-required";
  if (routeName === "alert-detail") return "/api/oneview/alerts/:id";
  if (routeName === "alert-history") return "/api/oneview/alerts/:id/history";
  if (routeName === "history") return "/api/oneview/history";
  if (routeName === "operations-health") return "/api/oneview/operations/health";
  if (routeName === "runtime-health") return "/api/oneview/runtime-health";
  return `/api/oneview/${routeName}`;
}

function requestErrorClass(status) {
  const code = Number(status);
  if (code >= 500) return "http_5xx";
  if (code >= 400) return "http_4xx";
  return "none";
}

function writeRequestLog(logger, routeName, startedAt, source, payload, fallbackCode = null, status = 200) {
  const code = Number(status);
  logger(JSON.stringify({
    event: "oneview_request",
    route: routeTemplate(routeName),
    data_source: source,
    duration_ms: Math.max(Date.now() - startedAt, 0),
    rows: responseRows(payload),
    fallback_code: fallbackCode,
    status: Number.isInteger(code) ? code : 0,
    error_class: requestErrorClass(code),
  }));
}

export function createOneViewHandler(routeName, dependencies = {}) {
  const authorize = dependencies.authorize || requireOneViewAuth;
  const configProvider = dependencies.configProvider || getOneViewConfig;
  const database = dependencies.database || fetchOneViewDatabase;
  const fallback = dependencies.fallback || getOneViewSnapshotPayload;
  const logger = dependencies.logger || console.info;
  const runtimeSummaryCacheEnabled = dependencies.database === undefined;

  return async function oneViewHandler(req, res) {
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const startedAt = Date.now();

    const route = getOneViewRoute(routeName);
    if (!route) return sendOneViewJson(res, 404, { error: "not_found" });
    if (!(await authorize(req, res, route.role))) return undefined;

    const finish = (status, payload, source, fallbackCode = null) => {
      writeRequestLog(logger, routeName, startedAt, source, payload, fallbackCode, status);
      return sendOneViewJson(res, status, payload, source, fallbackCode);
    };

    let config;
    try {
      config = configProvider();
    } catch {
      return finish(503, { error: "live_data_not_configured" }, "database");
    }

    if (config.snapshotMode) {
      try {
        const payload = await fallback(routeName, req, config);
        return finish(200, payload, "snapshot", "snapshot_mode");
      } catch (error) {
        const status = applicationErrorStatus(error);
        if (status) return finish(status, { error: error.code }, "snapshot", "snapshot_mode");
        return finish(503, { error: "snapshot_unavailable" }, "snapshot", "snapshot_unavailable");
      }
    }

    if (!config.liveEnabled) {
      if (!config.snapshotFallbackEnabled || !route.fallbackSafe) {
        return finish(503, { error: "live_database_disabled" }, "database");
      }
      try {
        const payload = await fallback(routeName, req, config);
        return finish(200, payload, "snapshot", "live_database_disabled");
      } catch (error) {
        const status = applicationErrorStatus(error);
        if (status) return finish(status, { error: error.code }, "snapshot", "live_database_disabled");
        return finish(503, { error: "snapshot_unavailable" }, "snapshot", "snapshot_unavailable");
      }
    }

    if (config.dbConfigErrorCode === "unsafe_database_user") {
      if (config.snapshotFallbackEnabled && route.fallbackSafe) {
        try {
          const payload = await fallback(routeName, req, config);
          return finish(200, payload, "snapshot", "unsafe_database_user");
        } catch {
          return finish(503, { error: "snapshot_unavailable" }, "snapshot", "snapshot_unavailable");
        }
      }
      return finish(503, { error: "unsafe_database_user" }, "database", "unsafe_database_user");
    }

    try {
      const forceSummaryRefresh = routeName === "dashboard-summary"
        && String(Array.isArray(req.query?.refresh) ? req.query.refresh[0] : req.query?.refresh || "") === "1";
      if (forceSummaryRefresh) invalidateOneViewSummaryCache();
      const payload = routeName === "dashboard-summary" && runtimeSummaryCacheEnabled
        ? await withOneViewSummaryCache(() => database(routeName, req, config), { bypass: forceSummaryRefresh })
        : await database(routeName, req, config);
      return finish(200, payload, "database");
    } catch (error) {
      const applicationStatus = applicationErrorStatus(error);
      if (applicationStatus) return finish(applicationStatus, { error: error.code }, "database");
      const fallbackCode = safeFallbackCode(error);
      if (config.snapshotFallbackEnabled && route.fallbackSafe) {
        try {
          const payload = await fallback(routeName, req, config);
          return finish(200, payload, "snapshot", fallbackCode);
        } catch (fallbackError) {
          const fallbackStatus = applicationErrorStatus(fallbackError);
          if (fallbackStatus) return finish(fallbackStatus, { error: fallbackError.code }, "snapshot", fallbackCode);
          return finish(503, { error: "snapshot_unavailable" }, "snapshot", "snapshot_unavailable");
        }
      }
      return finish(503, { error: fallbackCode }, "database");
    }
  };
}
