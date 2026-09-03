import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionToken } from "../api/_lib/session.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const baseUrl = process.env.ONEVIEW_LOCAL_BFF_URL || "http://127.0.0.1:8787";
const expectedSource = process.env.ONEVIEW_EXPECT_DATA_SOURCE || "database";
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(parsedBaseUrl.hostname)) {
  throw new Error("ONEVIEW_LOCAL_BFF_URL deve apontar para localhost");
}
if (!["database", "snapshot", "any"].includes(expectedSource)) {
  throw new Error("ONEVIEW_EXPECT_DATA_SOURCE inválido");
}

const noCache = "no-store, no-cache, max-age=0, must-revalidate";
const forbidden = [
  /postgres(?:ql)?:\/\//i,
  /DATABASE_URL/i,
  /POSTGRES_(?:READONLY|APP)_PASSWORD/i,
  /payload_raw/i,
  /payload_normalized/i,
  /token_encrypted/i,
  /api_url/i,
  /\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function firstCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function controlledAuthHeaders() {
  const supplied = String(process.env.ONEVIEW_LOCAL_TEST_BEARER_TOKEN || "").trim();
  if (supplied) return { Authorization: `Bearer ${supplied}` };
  if (!process.env.APP_SESSION_SECRET && !process.env.ONEVIEW_SESSION_SECRET) {
    throw new Error("Sessão local de teste indisponível");
  }
  const domain = firstCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS).toLowerCase().replace(/^@+/, "") || "teletex.com.br";
  const token = createSessionToken({
    id: "oneview-local-readonly-check",
    email: `oneview-local-readonly-check@${domain}`,
    name: "OneView Local Read-only Check",
    roles: ["viewer"],
  });
  return { Authorization: `Bearer ${token.token}` };
}

const authHeaders = controlledAuthHeaders();

function countRows(body) {
  if (Array.isArray(body?.items)) return body.items.length;
  if (Array.isArray(body?.clients)) return body.clients.length;
  if (Array.isArray(body?.data_sources)) return body.data_sources.length;
  return 0;
}

function totals(body) {
  const counts = body?.counts || {};
  return {
    total_alerts: Number(counts.total_alerts ?? body?.alerts_total ?? body?.total ?? 0),
    active_alerts: Number(counts.active_alerts ?? body?.active_total ?? 0),
  };
}

async function checkRoute(name, path) {
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store", redirect: "error", headers: authHeaders });
  const raw = await response.text();
  assert(response.status === 200, `${name}: HTTP ${response.status}`);
  for (const pattern of forbidden) assert(!pattern.test(raw), `${name}: conteúdo sensível detectado`);

  const body = JSON.parse(raw);
  const headerSource = response.headers.get("x-oneview-data-source");
  assert(headerSource === "database" || headerSource === "snapshot", `${name}: header de fonte ausente`);
  assert(body.data_source === headerSource, `${name}: fonte divergente entre header e body`);
  assert(response.headers.get("cache-control") === noCache, `${name}: Cache-Control inválido`);
  assert(typeof body.checked_at === "string" && !Number.isNaN(Date.parse(body.checked_at)), `${name}: checked_at inválido`);
  assert(body.fallback_code === null || typeof body.fallback_code === "string", `${name}: fallback_code inválido`);
  if (headerSource === "database") assert(body.fallback_code === null, `${name}: database com fallback_code inesperado`);
  if (expectedSource !== "any") assert(headerSource === expectedSource, `${name}: fonte ${headerSource}; esperada ${expectedSource}`);

  const result = { name, source: headerSource, checked_at: body.checked_at, rows: countRows(body), ...totals(body) };
  console.info(JSON.stringify({ event: "oneview_local_check", status: "ok", ...result }));
  return { body, result };
}

async function checkExpectedError(name, path, expectedStatus, expectedCode) {
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store", redirect: "error", headers: authHeaders });
  const raw = await response.text();
  for (const pattern of forbidden) assert(!pattern.test(raw), `${name}: conteúdo sensível detectado`);
  const body = JSON.parse(raw);
  const source = response.headers.get("x-oneview-data-source");
  assert(response.status === expectedStatus, `${name}: HTTP ${response.status}; esperado ${expectedStatus}`);
  assert(body.error === expectedCode, `${name}: código de erro inesperado`);
  assert(body.data_source === source, `${name}: fonte divergente`);
  assert(response.headers.get("cache-control") === noCache, `${name}: Cache-Control inválido`);
  assert(typeof body.checked_at === "string" && !Number.isNaN(Date.parse(body.checked_at)), `${name}: checked_at inválido`);
  if (expectedSource !== "any") assert(source === expectedSource, `${name}: fonte ${source}; esperada ${expectedSource}`);
}

try {
  const checks = [];
  for (const [name, path] of [
    ["health", "/api/oneview/health"],
    ["dashboard-summary", "/api/oneview/dashboard-summary"],
    ["data-sources", "/api/oneview/data-sources"],
    ["sync-logs", "/api/oneview/sync-logs"],
    ["operations-health", "/api/oneview/operations/health"],
    ["runtime-health", "/api/oneview/runtime-health"],
    ["links", "/api/oneview/links?page=1&page_size=50"],
    ["attention-required", "/api/oneview/attention-required?limit=10"],
  ]) checks.push(await checkRoute(name, path));

  const pageOne = await checkRoute("alerts-page-1", "/api/oneview/alerts?page=1&page_size=3&status=active");
  const pageTwo = await checkRoute("alerts-page-2", "/api/oneview/alerts?page=2&page_size=3&status=active");
  const cappedPage = await checkRoute("alerts-page-size-cap", "/api/oneview/alerts?page=1&page_size=5000&status=active");
  checks.push(pageOne, pageTwo, cappedPage);
  assert(pageOne.body.items.length <= 3 && pageTwo.body.items.length <= 3, "alerts: page_size não respeitado");
  assert(cappedPage.body.pagination?.page_size === 100 && cappedPage.body.items.length <= 100, "alerts: limite máximo 100 não respeitado");
  assert(pageOne.body.pagination?.page === 1 && pageTwo.body.pagination?.page === 2, "alerts: paginação inválida");
  assert(pageOne.body.items.every((item) => !pageTwo.body.items.some((other) => other.id === item.id)), "alerts: páginas repetidas");

  const firstAlertId = pageOne.body.items[0]?.id;
  if (firstAlertId) {
    checks.push(await checkRoute("alert-detail", `/api/oneview/alerts/${encodeURIComponent(firstAlertId)}`));
    checks.push(await checkRoute("alert-history", `/api/oneview/alerts/${encodeURIComponent(firstAlertId)}/history`));
  }

  await checkExpectedError("alerts-invalid-query", "/api/oneview/alerts?status=closed", 400, "invalid_query");
  await checkExpectedError("alert-not-found", "/api/oneview/alerts/00000000-0000-0000-0000-000000000000", 404, "not_found");

  for (const path of [
    "/api/oneview/health",
    "/api/oneview/alerts",
    "/api/oneview/operations/health",
    "/api/oneview/attention-required",
  ]) {
    const post = await fetch(`${baseUrl}${path}`, { method: "POST", cache: "no-store", headers: authHeaders });
    assert(post.status === 405, `POST ${path}: HTTP ${post.status}; esperado 405`);
  }

  const sources = [...new Set(checks.map(({ result }) => result.source))];
  console.info(JSON.stringify({
    event: "oneview_local_check_complete",
    status: "ok",
    expected_source: expectedSource,
    data_sources: sources,
    frontend_badge: sources.length === 1 && sources[0] === "database" ? "Banco em tempo real" : "Cópia atualizada",
    pagination_distinct: true,
    page_size_cap: 100,
    dynamic_routes_checked: Boolean(firstAlertId),
    validation_status: 400,
    not_found_status: 404,
    write_methods_status: 405,
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: "oneview_local_check_complete",
    status: "failed",
    code: String(error?.code || "LOCAL_CHECK_FAILED").slice(0, 80),
    message: String(error?.message || "Falha no teste local").replace(/https?:\/\/\S+/g, "[URL_LOCAL]").slice(0, 240),
  }));
  process.exitCode = 1;
}
