import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOneViewDbPoolStats } from "../api/_lib/oneview-db.js";
import { sessionUserFromRequest, sessionUserFromToken } from "../api/_lib/microsoft-sso.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadLocalEnv(path.join(rootDir, ".env.local"));

const host = "127.0.0.1";
const port = Number.parseInt(process.env.ONEVIEW_LOCAL_BFF_PORT || "8787", 10);
const startedAt = new Date().toISOString();
const version = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version || "0.0.0";
const codeHash = createHash("sha256");
for (const file of [
  "scripts/dev-oneview-bff.mjs",
  "api/_lib/auth.js",
  "api/_lib/microsoft-sso.js",
  "api/_lib/oneview-response.js",
  "api/_lib/oneview-db.js",
  "api/_lib/oneview-config.js",
  "api/_lib/oneview-fallback.js",
  "api/oneview/dashboard-summary.js",
  "api/oneview/alerts.js",
  "api/oneview/alerts/[id].js",
  "api/oneview/alerts/[id]/history.js",
  "api/oneview/operations/health.js",
  "api/oneview/runtime-health.js",
  "api/oneview/links.js",
  "api/oneview/links/[id].js",
  "api/oneview/links/[id]/reminders.js",
  "api/oneview/attention-required.js",
  "api/oneview/history.js",
  "api/oneview/clients-summary.js",
  "api/oneview/incidents.js",
  "api/oneview/incidents/detail/[id].js",
  "api/oneview/incidents/related-alert.js",
  "api/oneview/alerts/related-incidents.js",
  "api/oneview/operator-queue.js",
  "api/_lib/oneview-incidents.js",
  "api/_lib/oneview-incidents-read-model.js",
  "api/_lib/oneview-incident-detail.js",
  "api/_lib/oneview-incident-relation.js",
  "api/_lib/oneview-alert-incidents.js",
  "api/_lib/oneview-operator-queue.js",
  "api/_lib/oneview-runtime-health-truth.js",
  "api/_lib/oneview-links.js",
  "api/_lib/oneview-operator-reminders.js",
  "api/_lib/servicenow-client.js",
  "api/_lib/servicenow-normalize.js",
]) codeHash.update(readFileSync(path.join(rootDir, file)));
const codeVersion = codeHash.digest("hex").slice(0, 16);
const loadState = {
  generation: 0,
  reset_at: startedAt,
  cache: { implemented: false, entries: 0 },
  deduplicators: { implemented: false, pending: 0 },
};

const routes = new Map([
  ["/api/oneview/health", "health"],
  ["/api/oneview/dashboard-summary", "dashboard-summary"],
  ["/api/oneview/grafana-summary", "grafana-summary"],
  ["/api/oneview/alerts", "alerts"],
  ["/api/oneview/alerts/related-incidents", "alert-related-incidents"],
  ["/api/oneview/attention-required", "attention-required"],
  ["/api/oneview/clients-summary", "clients-summary"],
  ["/api/oneview/history", "history"],
  ["/api/oneview/data-sources", "data-sources"],
  ["/api/oneview/sync-logs", "sync-logs"],
  ["/api/oneview/operations/health", "operations-health"],
  ["/api/oneview/runtime-health", "runtime-health"],
  ["/api/oneview/links", "links"],
  ["/api/oneview/incidents", "incidents"],
  ["/api/oneview/incidents/related-alert", "incident-related-alert"],
  ["/api/oneview/operator-queue", "operator-queue"],
  ["/api/oneview/client-sharing/destinations", "client-sharing-destinations"],
  ["/api/oneview/client-sharing/preview", "client-sharing-preview"],
  ["/api/oneview/client-sharing/send", "client-sharing-send"],
  ["/api/oneview/client-sharing/smoke", "client-sharing-smoke"],
]);

const handlers = new Map();

async function getHandler(routeName) {
  if (!handlers.has(routeName)) {
    const modulePath = routeName === "alert-detail"
      ? path.join("alerts", "[id].js")
      : routeName === "alert-history"
        ? path.join("alerts", "[id]", "history.js")
        : routeName === "alert-ack-request"
        ? path.join("alerts", "[id]", "ack-request.js")
        : routeName === "alert-source-acknowledge"
        ? path.join("alerts", "[id]", "source-acknowledge.js")
        : routeName === "link-detail"
          ? path.join("links", "[id].js")
          : routeName === "link-reminders"
            ? path.join("links", "[id]", "reminders.js")
            : routeName === "incident-detail"
              ? path.join("incidents", "detail", "[id].js")
        : routeName === "operations-health"
          ? path.join("operations", "health.js")
        : routeName === "runtime-health"
          ? "runtime-health.js"
          : routeName === "incident-related-alert"
            ? path.join("incidents", "related-alert.js")
          : routeName === "alert-related-incidents"
            ? path.join("alerts", "related-incidents.js")
          : routeName === "client-sharing-destinations"
            ? path.join("client-sharing", "destinations.js")
          : routeName === "client-sharing-preview"
            ? path.join("client-sharing", "preview.js")
          : routeName === "client-sharing-send"
            ? path.join("client-sharing", "send.js")
          : routeName === "client-sharing-smoke"
            ? path.join("client-sharing", "smoke.js")
          : `${routeName}.js`;
    const moduleUrl = pathToFileURL(path.join(rootDir, "api", "oneview", modulePath)).href;
    const module = await import(moduleUrl);
    handlers.set(routeName, module.default);
  }
  return handlers.get(routeName);
}

function resolveRoute(pathname) {
  const exact = routes.get(pathname);
  if (exact) return { routeName: exact, params: {} };
  const incidentDetail = pathname.match(/^\/api\/oneview\/incidents\/detail\/([^/]+)$/);
  if (incidentDetail) return { routeName: "incident-detail", params: { id: decodeURIComponent(incidentDetail[1]) } };
  const linkReminders = pathname.match(/^\/api\/oneview\/links\/([^/]+)\/reminders$/);
  if (linkReminders) return { routeName: "link-reminders", params: { id: decodeURIComponent(linkReminders[1]) } };
  const linkDetail = pathname.match(/^\/api\/oneview\/links\/([^/]+)$/);
  if (linkDetail) return { routeName: "link-detail", params: { id: decodeURIComponent(linkDetail[1]) } };
  const sourceAcknowledge = pathname.match(/^\/api\/oneview\/alerts\/([^/]+)\/source-acknowledge$/);
  if (sourceAcknowledge) return { routeName: "alert-source-acknowledge", params: { id: decodeURIComponent(sourceAcknowledge[1]) } };
  const ackRequest = pathname.match(/^\/api\/oneview\/alerts\/([^/]+)\/ack-request$/);
  if (ackRequest) return { routeName: "alert-ack-request", params: { id: decodeURIComponent(ackRequest[1]) } };
  const history = pathname.match(/^\/api\/oneview\/alerts\/([^/]+)\/history$/);
  if (history) return { routeName: "alert-history", params: { id: decodeURIComponent(history[1]) } };
  const detail = pathname.match(/^\/api\/oneview\/alerts\/([^/]+)$/);
  if (detail) return { routeName: "alert-detail", params: { id: decodeURIComponent(detail[1]) } };
  return null;
}

function routeTemplate(routeName) {
  if (routeName === "attention-required") return "/api/oneview/attention-required";
  if (routeName === "history") return "/api/oneview/history";
  if (routeName === "alert-detail") return "/api/oneview/alerts/:id";
  if (routeName === "alert-history") return "/api/oneview/alerts/:id/history";
  if (routeName === "alert-ack-request") return "/api/oneview/alerts/:id/ack-request";
  if (routeName === "alert-source-acknowledge") return "/api/oneview/alerts/:id/source-acknowledge";
  if (routeName === "link-detail") return "/api/oneview/links/:id";
  if (routeName === "link-reminders") return "/api/oneview/links/:id/reminders";
  if (routeName === "incident-detail") return "/api/oneview/incidents/detail/:id";
  if (routeName === "operations-health") return "/api/oneview/operations/health";
  if (routeName === "runtime-health") return "/api/oneview/runtime-health";
  if (routeName === "incidents") return "/api/oneview/incidents";
  if (routeName === "incident-related-alert") return "/api/oneview/incidents/related-alert";
  if (routeName === "alert-related-incidents") return "/api/oneview/alerts/related-incidents";
  return `/api/oneview/${routeName}`;
}

function attachVercelResponseHelpers(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  return res;
}

function buildQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    const current = query[key];
    query[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return query;
}

function sendLocalJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maximumBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("request_body_too_large");
      error.code = "request_body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_body");
    return parsed;
  } catch {
    const error = new Error("invalid_json_body");
    error.code = "invalid_json_body";
    throw error;
  }
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function controlledLoadProbe(req) {
  if (req.headers["x-oneview-load-probe"] !== "1") return false;
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const user = sessionUserFromRequest(req) || sessionUserFromToken(bearer);
  return user?.id === "oneview-load-test";
}

function loadManifest() {
  return {
    pid: process.pid,
    code_hash: codeVersion,
    version,
    started_at: startedAt,
    pool: getOneViewDbPoolStats(),
    load_state: loadState,
    checked_at: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || !isAllowedOrigin(req.headers.origin)) {
    sendLocalJson(res, 403, { error: "local_access_only" });
    return;
  }

  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (url.pathname === "/__oneview/load/pool") {
    if (req.method !== "GET" || !controlledLoadProbe(req)) {
      sendLocalJson(res, req.method === "GET" ? 403 : 405, { error: req.method === "GET" ? "probe_forbidden" : "method_not_allowed" });
      return;
    }
    sendLocalJson(res, 200, { pool: getOneViewDbPoolStats(), generation: loadState.generation, pid: process.pid, checked_at: new Date().toISOString() });
    return;
  }
  if (url.pathname === "/__oneview/load/state") {
    if (req.method !== "GET" || !controlledLoadProbe(req)) {
      sendLocalJson(res, req.method === "GET" ? 403 : 405, { error: req.method === "GET" ? "probe_forbidden" : "method_not_allowed" });
      return;
    }
    sendLocalJson(res, 200, loadManifest());
    return;
  }
  if (url.pathname === "/__oneview/load/reset") {
    if (req.method !== "POST" || !controlledLoadProbe(req)) {
      sendLocalJson(res, req.method === "POST" ? 403 : 405, { error: req.method === "POST" ? "probe_forbidden" : "method_not_allowed" });
      return;
    }
    loadState.generation += 1;
    loadState.reset_at = new Date().toISOString();
    loadState.cache.entries = 0;
    loadState.deduplicators.pending = 0;
    sendLocalJson(res, 200, { status: "reset", generation: loadState.generation, pid: process.pid, load_state: loadState, checked_at: new Date().toISOString() });
    return;
  }
  const route = resolveRoute(url.pathname);
  if (!route) {
    sendLocalJson(res, 404, { error: "not_found" });
    return;
  }

  try {
    req.query = { ...buildQuery(url), ...route.params };
    if ((route.routeName === "alert-ack-request" && req.method === "POST")
      || (route.routeName === "alert-source-acknowledge" && req.method === "POST")
      || (route.routeName === "link-reminders" && ["POST", "PATCH", "DELETE"].includes(req.method || ""))
      || (["client-sharing-preview", "client-sharing-send", "client-sharing-smoke"].includes(route.routeName) && req.method === "POST")) {
      try {
        req.body = await readJsonBody(req);
      } catch (error) {
        sendLocalJson(res, error?.code === "request_body_too_large" ? 413 : 400, { error: error?.code || "invalid_json_body" });
        return;
      }
    }
    const handler = await getHandler(route.routeName);
    await handler(req, attachVercelResponseHelpers(res));
  } catch {
    console.error(JSON.stringify({ event: "oneview_local_bff_error", route: routeTemplate(route.routeName), code: "handler_failed" }));
    if (!res.headersSent) sendLocalJson(res, 500, { error: "local_bff_error" });
    else res.end();
  }
});

server.listen(port, host, () => {
  const requiredDbKeys = ["ONEVIEW_DB_HOST", "ONEVIEW_DB_NAME", "ONEVIEW_DB_USER"];
  const missing = requiredDbKeys.filter((key) => !process.env[key]);
  if (!process.env.POSTGRES_READONLY_PASSWORD) {
    missing.push("POSTGRES_READONLY_PASSWORD");
  }
  if (process.env.ONEVIEW_ACK_REQUEST_ENABLED === "true" && !process.env.POSTGRES_ACTIONS_PASSWORD) {
    missing.push("POSTGRES_ACTIONS_PASSWORD");
  }
  console.info(JSON.stringify({
    event: "oneview_local_bff_ready",
    ready: true,
    pid: process.pid,
    code_hash: codeVersion,
    version,
    started_at: startedAt,
    pool_max: Number(getOneViewDbPoolStats().max || process.env.ONEVIEW_DB_POOL_MAX || 0),
    live_db_enabled: process.env.ONEVIEW_LIVE_DB_ENABLED === "true",
    snapshot_fallback_enabled: process.env.ONEVIEW_SNAPSHOT_FALLBACK_ENABLED === "true",
    auth_required: process.env.ONEVIEW_API_AUTH_REQUIRED !== "false",
    missing_config_keys: missing,
  }));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.info(JSON.stringify({ event: "oneview_local_bff_stop", signal }));
  const timeout = setTimeout(() => process.exit(0), 1500);
  timeout.unref();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
