/**
 * SN-P0-36F2 — PROD API final smoke (GET-only).
 *
 *   node scripts/sn-prod-smoke.mjs
 *
 * Lê só SERVICENOW_PROD_* de dashboard/.env.local.
 * Não imprime password nem Authorization. Sem POST/PATCH/DELETE.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalEnv } from "./_lib/local-env.mjs";

const EXPECTED_HOST = "teletexprod.service-now.com";
const EXPECTED_USER = "teletex_Integration";
const CALLER_SYS_ID = "aa62f29f47477610082e3d02e26d4358";
const SYS_QUERY = [
  `caller_id=${CALLER_SYS_ID}`,
  "opened_at>=2026-08-01 00:00:00",
  "opened_at<=2026-08-12 23:59:59",
].join("^");
const FIELDS = [
  "sys_id",
  "number",
  "opened_at",
  "sys_updated_on",
  "state",
  "priority",
].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env.local");

function envGet(entries, key) {
  return entries.find((entry) => entry.key === key)?.value ?? "";
}

function hostnameOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

function isPlaceholderPassword(raw) {
  const value = String(raw || "").trim();
  if (!value) return true;
  const upper = value.toUpperCase();
  return upper === "SEU_SECRET_PROD" || upper.includes("SEU_SECRET");
}

function scalar(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") {
    return raw.display_value || raw.value || raw.sys_id || null;
  }
  return String(raw);
}

function rowOf(item) {
  return {
    number: scalar(item.number),
    sys_id: scalar(item.sys_id),
    opened_at: scalar(item.opened_at),
    sys_updated_on: scalar(item.sys_updated_on),
    state: scalar(item.state),
    priority: scalar(item.priority),
  };
}

function verdict(auth, query, lookup) {
  const ready = auth === "OK" && query === "OK" && lookup === "OK";
  return {
    PROD_AUTH: auth,
    CALLER_QUERY: query,
    EXACT_LOOKUP: lookup,
    READY_FOR_WORKER: ready ? "YES" : "NO",
  };
}

function printVerdict(result) {
  console.log("");
  console.log(`PROD_AUTH = ${result.PROD_AUTH}`);
  console.log(`CALLER_QUERY = ${result.CALLER_QUERY}`);
  console.log(`EXACT_LOOKUP = ${result.EXACT_LOOKUP}`);
  console.log(`READY_FOR_WORKER = ${result.READY_FOR_WORKER}`);
}

async function snGet(baseUrl, username, password, search) {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("api/now/table/incident", root);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${token}`,
    },
    signal: AbortSignal.timeout(40000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    status: response.status,
    totalHeader: response.headers.get("x-total-count"),
    result: Array.isArray(json?.result) ? json.result : [],
  };
}

const inspection = inspectLocalEnv(envPath);
if (!inspection.exists) {
  console.log("env: .env.local not found on disk");
  printVerdict(verdict("FAILED", "FAILED", "FAILED"));
  process.exit(0);
}

const entries = inspection.entries || [];
const baseUrl = envGet(entries, "SERVICENOW_PROD_BASE_URL").trim();
const username = envGet(entries, "SERVICENOW_PROD_USERNAME").trim();
const password = envGet(entries, "SERVICENOW_PROD_PASSWORD");
const host = hostnameOf(baseUrl);
const usernameOk = username === EXPECTED_USER;
const passwordOk = Boolean(password) && !isPlaceholderPassword(password);

console.log("SN-P0-36F2 PROD smoke");
console.log(`env_loaded_from_disk: ${envPath}`);
console.log(`PROD_BASE_URL present: ${Boolean(baseUrl)}`);
console.log(`PROD_USERNAME present: ${Boolean(username)}`);
console.log(`PROD_PASSWORD present: ${Boolean(password)}`);
console.log(`hostname: ${host || "(invalid)"}`);
console.log(`username: ${usernameOk ? EXPECTED_USER : "(rejected: not teletex_Integration)"}`);

if (!baseUrl || host !== EXPECTED_HOST || !usernameOk || !passwordOk) {
  if (host && host !== EXPECTED_HOST) console.log("abort: BASE_URL is not teletexprod.service-now.com");
  if (!usernameOk) console.log("abort: USERNAME is missing or not exactly teletex_Integration");
  if (!passwordOk) console.log("abort: PASSWORD missing or placeholder");
  printVerdict(verdict("FAILED", "FAILED", "FAILED"));
  process.exit(0);
}

let queryRes;
try {
  queryRes = await snGet(baseUrl, username, password, {
    sysparm_query: SYS_QUERY,
    sysparm_limit: "5",
    sysparm_fields: FIELDS,
    sysparm_display_value: "all",
  });
} catch (err) {
  console.log(`HTTP status: (network ${err?.name === "TimeoutError" ? "timeout" : "error"})`);
  printVerdict(verdict("FAILED", "FAILED", "FAILED"));
  process.exit(0);
}

console.log(`HTTP status: ${queryRes.status}`);
if (queryRes.totalHeader != null) console.log(`total: ${queryRes.totalHeader}`);

if (queryRes.status === 401 || queryRes.status === 403 || queryRes.status !== 200) {
  console.log("quantidade: 0");
  printVerdict(verdict("FAILED", "FAILED", "FAILED"));
  process.exit(0);
}

const rows = queryRes.result.map(rowOf);
console.log(`quantidade: ${rows.length}`);
for (const row of rows) {
  console.log(
    [
      `number=${row.number}`,
      `sys_id=${row.sys_id}`,
      `opened_at=${row.opened_at}`,
      `sys_updated_on=${row.sys_updated_on}`,
      `state=${row.state}`,
      `priority=${row.priority}`,
    ].join(" | "),
  );
}

if (rows.length === 0) {
  printVerdict(verdict("OK", "FAILED", "FAILED"));
  process.exit(0);
}

const first = rows[0];
if (!first.number || !first.sys_id) {
  console.log("exact lookup: skipped (missing number/sys_id on first row)");
  printVerdict(verdict("OK", "OK", "FAILED"));
  process.exit(0);
}

let lookupRes;
try {
  lookupRes = await snGet(baseUrl, username, password, {
    sysparm_query: `number=${first.number}`,
    sysparm_limit: "5",
    sysparm_fields: "sys_id,number",
  });
} catch (err) {
  console.log(`exact lookup: network ${err?.name === "TimeoutError" ? "timeout" : "error"}`);
  printVerdict(verdict("OK", "OK", "FAILED"));
  process.exit(0);
}

const found = lookupRes.result.map(rowOf);
const match = found.length === 1 && found[0].sys_id === first.sys_id && found[0].number === first.number;
console.log(`exact lookup HTTP status: ${lookupRes.status}`);
console.log(`exact lookup number=${first.number} result_count=${found.length} same_sys_id=${match}`);

printVerdict(verdict("OK", "OK", match && lookupRes.status === 200 ? "OK" : "FAILED"));
