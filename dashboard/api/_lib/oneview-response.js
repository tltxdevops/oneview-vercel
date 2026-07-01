import { methodNotAllowed, sendJson } from "./http.js";
import { allowedQueryString, getOneViewConfig, getOneViewRoute } from "./oneview-config.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { fetchOneViewUpstream } from "./oneview-upstream.js";
import { getOneViewSnapshotPayload } from "./oneview-fallback.js";

const FORBIDDEN_KEY = /(?:authorization|cookie|token|password|senha|secret|credential|dsn|api_url|payload_raw|payload_normalized|host_name|hostname|host_ip)/i;
const PRIVATE_VALUE = /(?:https?:\/\/[^\s]+|\b(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\b)/i;
const FALLBACK_STATUS = new Set([502, 503, 504]);

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

function sendOneViewJson(res, status, payload, source) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (source) res.setHeader("X-OneView-Data-Source", source);
  return sendJson(res, status, sanitizeOneViewPayload(payload));
}

function publicUpstreamStatus(error) {
  const status = Number(error?.status);
  return [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504].includes(status) ? status : 502;
}

export function createOneViewHandler(routeName, dependencies = {}) {
  const authorize = dependencies.authorize || requireOneViewAuth;
  const configProvider = dependencies.configProvider || getOneViewConfig;
  const upstream = dependencies.upstream || fetchOneViewUpstream;
  const fallback = dependencies.fallback || getOneViewSnapshotPayload;

  return async function oneViewHandler(req, res) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const route = getOneViewRoute(routeName);
    if (!route) return sendOneViewJson(res, 404, { error: "not_found" });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!(await authorize(req, res, route.role))) return undefined;

    let config;
    try {
      config = configProvider();
    } catch {
      return sendOneViewJson(res, 503, { error: "live_api_not_configured" });
    }

    if (!config.liveEnabled) {
      if (!config.snapshotFallbackEnabled || !route.fallbackSafe) {
        return sendOneViewJson(res, 503, { error: "live_api_disabled" });
      }
      try {
        const payload = await fallback(routeName, req);
        return sendOneViewJson(res, 200, payload, "snapshot");
      } catch {
        return sendOneViewJson(res, 503, { error: "snapshot_unavailable" });
      }
    }

    try {
      const payload = await upstream(route, allowedQueryString(req, route), config);
      return sendOneViewJson(res, 200, payload, "live");
    } catch (error) {
      const status = publicUpstreamStatus(error);
      if (config.snapshotFallbackEnabled && route.fallbackSafe && FALLBACK_STATUS.has(status)) {
        try {
          const payload = await fallback(routeName, req);
          return sendOneViewJson(res, 200, payload, "snapshot");
        } catch {
          return sendOneViewJson(res, 503, { error: "snapshot_unavailable" });
        }
      }
      return sendOneViewJson(res, status, { error: error?.code || "upstream_request_failed" });
    }
  };
}
