/**
 * SN-P0-01 / SN-P0-17 — cliente read-only ServiceNow (Table API).
 * Somente GET. Basic Auth apenas no backend. Nunca loga senha/token.
 * Timeout explícito; retry limitado apenas em GET transitório.
 */

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_RETRY_MAX = 2;
export const MAX_RETRY_MAX = 3;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRY_BASE_DELAY_MS = 120;

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  /password["'\s:=]+[^\s"',}\\]+/gi,
  /SERVICENOW_PASSWORD=[^\s]+/gi,
  /SERVICENOW_USERNAME=[^\s]+/gi,
  /Authorization["'\s:=]+[^\s"',}\\]+/gi,
];

export class ServiceNowClientError extends Error {
  constructor(code, { status = null, details = null } = {}) {
    super(code);
    this.name = "ServiceNowClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clean(value) {
  return String(value || "").trim();
}

function asPositiveInt(value, fallback, { min = 1, max = MAX_PAGE_LIMIT } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function timeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1000), 60000);
}

function retryMax(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRY_MAX;
  return Math.min(Math.max(parsed, 0), MAX_RETRY_MAX);
}

export function sanitizeServiceNowError(error) {
  let message = String(
    error?.details || error?.code || error?.message || error || "servicenow_request_failed",
  );
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, "[redacted]");
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function errorCodeFromStatus(status) {
  const code = Number(status);
  if (code === 401) return "servicenow_authentication_failed";
  if (code === 403) return "servicenow_access_forbidden";
  if (code === 404) return "servicenow_not_found";
  if (code === 429) return "servicenow_rate_limited";
  if (Number.isFinite(code) && code >= 500) return "servicenow_unavailable";
  return "servicenow_request_failed";
}

/**
 * Status HTTP do BFF a partir do erro SN (não confunde com auth OneView).
 * 401/403/429/5xx ficam distintos via code público + status gateway.
 */
export function mapServiceNowErrorToHttpStatus(error) {
  if (error?.code === "invalid_query") return 400;
  if (error?.code === "servicenow_incidents_disabled") return 403;
  if (error instanceof ServiceNowClientError || error?.name === "ServiceNowClientError") {
    if (error.code === "servicenow_not_configured") return 503;
    if (error.code === "servicenow_caller_not_configured") return 503;
    if (error.code === "servicenow_timeout") return 504;
    if (error.code === "servicenow_authentication_failed") return 502;
    if (error.code === "servicenow_access_forbidden") return 502;
    if (error.code === "servicenow_rate_limited") return 429;
    if (error.code === "servicenow_method_not_allowed") return 405;
    if (error.status === 401) return 502;
    if (error.status === 403) return 502;
    if (error.status === 429) return 429;
    if (Number.isFinite(error.status) && error.status >= 500) return 502;
    return 502;
  }
  return 502;
}

/** Código público estável para UI/logs (sem detalhes internos). */
export function mapServiceNowErrorToPublicCode(error) {
  if (error?.code === "invalid_query") return "invalid_query";
  if (error?.code === "servicenow_incidents_disabled") return "servicenow_incidents_disabled";
  if (error instanceof ServiceNowClientError || error?.name === "ServiceNowClientError") {
    if (error.code === "servicenow_not_configured") return "servicenow_not_configured";
    if (error.code === "servicenow_caller_not_configured") return "servicenow_caller_not_configured";
    if (error.code === "servicenow_timeout") return "servicenow_timeout";
    if (error.code === "servicenow_authentication_failed") return "servicenow_authentication_failed";
    if (error.code === "servicenow_access_forbidden") return "servicenow_access_forbidden";
    if (error.code === "servicenow_rate_limited") return "servicenow_rate_limited";
    if (error.code === "servicenow_method_not_allowed") return "method_not_allowed";
    return "servicenow_unavailable";
  }
  return "servicenow_unavailable";
}

export function isRetryableServiceNowError(error) {
  if (!(error instanceof ServiceNowClientError) && error?.name !== "ServiceNowClientError") {
    return true;
  }
  if (error.code === "servicenow_timeout") return true;
  if (error.code === "servicenow_rate_limited") return true;
  if (error.code === "servicenow_unavailable") return true;
  if (Number.isFinite(error.status) && error.status >= 500) return true;
  if (error.status === 429) return true;
  return false;
}

/** SN-P0-33 — sys_id ServiceNow (32 hex). Sem fallback para IDs de outro ambiente. */
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;

export function normalizeServiceNowSysId(value) {
  const id = clean(value);
  // SN sys_id é case-insensitive; normaliza para minúsculas (dedupe OV-P0-108).
  return SAFE_SYS_ID.test(id) ? id.toLowerCase() : "";
}

/** CSV opcional de seeds de facet (sys_ids). IDs inválidos são ignorados. */
export function parseServiceNowSysIdList(value) {
  const seen = new Set();
  const out = [];
  for (const part of String(value || "").split(",")) {
    const id = normalizeServiceNowSysId(part);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getServiceNowConfig(env = process.env) {
  const baseUrl = clean(env.SERVICENOW_BASE_URL).replace(/\/+$/, "");
  const username = clean(env.SERVICENOW_USERNAME);
  const password = String(env.SERVICENOW_PASSWORD || "");
  const configured = Boolean(baseUrl && username && password);

  return {
    configured,
    baseUrl: configured ? baseUrl : "",
    username: configured ? username : "",
    password: configured ? password : "",
    timeoutMs: timeoutMs(env.SERVICENOW_TIMEOUT_MS),
    retryMax: retryMax(env.SERVICENOW_RETRY_MAX),
    defaultLimit: asPositiveInt(env.SERVICENOW_PAGE_LIMIT, DEFAULT_PAGE_LIMIT),
    // SN-P0-33 — obrigatório só para correlação alerta→INC por eventid (sem default DEV).
    zabbixMonitoringCallerId: normalizeServiceNowSysId(env.SERVICENOW_ZABBIX_MONITORING_CALLER_ID),
    // Seeds opcionais de facet (ex.: NOC); /chamados não depende deles.
    callerFilterSeeds: parseServiceNowSysIdList(env.SERVICENOW_CALLER_FILTER_SEEDS),
  };
}

function assertGetOnly(method) {
  if (String(method || "GET").toUpperCase() !== "GET") {
    throw new ServiceNowClientError("servicenow_method_not_allowed", { status: 405 });
  }
}

function buildBasicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function buildTableUrl(baseUrl, table, params = {}) {
  const path = `/api/now/table/${encodeURIComponent(table)}`;
  const url = new URL(path, `${baseUrl}/`);
  const entries = {
    sysparm_query: params.sysparm_query,
    sysparm_fields: params.sysparm_fields,
    sysparm_limit: params.sysparm_limit,
    sysparm_offset: params.sysparm_offset,
    sysparm_display_value: params.sysparm_display_value,
    sysparm_exclude_reference_link: params.sysparm_exclude_reference_link,
  };

  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function buildStatsUrl(baseUrl, table, params = {}) {
  const path = `/api/now/stats/${encodeURIComponent(table)}`;
  const url = new URL(path, `${baseUrl}/`);
  const entries = {
    sysparm_query: params.sysparm_query,
    sysparm_count: params.sysparm_count,
    sysparm_group_by: params.sysparm_group_by,
  };

  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeStatsRows(result) {
  if (Array.isArray(result)) return result;
  if (result != null && typeof result === "object") return [result];
  return [];
}

export function parseAggregateStatsCount(row) {
  if (row == null || typeof row !== "object") return null;
  const candidates = [row?.stats?.count, row?.stats?.COUNT, row?.count, row?.COUNT];
  for (const value of candidates) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function parseAggregateGroupValue(row, field) {
  if (row == null || typeof row !== "object") return null;
  const fieldName = String(field || "");
  if (Array.isArray(row.groupby_fields)) {
    const hit = row.groupby_fields.find((item) => String(item?.field || "") === fieldName);
    if (hit != null && hit.value != null && String(hit.value).trim() !== "") {
      return String(hit.value).trim();
    }
  }
  const direct = row[fieldName];
  if (direct != null && typeof direct === "object") {
    const value = direct.value ?? direct.display_value;
    return value != null && String(value).trim() !== "" ? String(value).trim() : null;
  }
  if (direct != null && String(direct).trim() !== "") return String(direct).trim();
  return null;
}

export function mapAggregateGroupCounts(rows, field) {
  const out = Object.create(null);
  for (const row of rows || []) {
    const key = parseAggregateGroupValue(row, field);
    if (key == null) continue;
    const count = parseAggregateStatsCount(row);
    if (count == null) continue;
    out[key] = count;
  }
  return out;
}

function parseLinkNext(linkHeader) {
  const header = String(linkHeader || "");
  if (!header) return null;
  const match = header.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  return match?.[1] || null;
}

async function readJsonBody(response) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new ServiceNowClientError("servicenow_response_too_large", { status: 502 });
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ServiceNowClientError("servicenow_response_too_large", { status: 502 });
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET único com timeout explícito (AbortController) e retry limitado.
 * Retry: apenas GET; só 429 / 5xx / timeout / rede; nunca 401/403/404.
 */
async function serviceNowFetchOnce(url, { config, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: buildBasicAuthHeader(config.username, config.password),
      },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ServiceNowClientError(errorCodeFromStatus(response.status), {
        status: response.status,
      });
    }

    return response;
  } catch (error) {
    if (error instanceof ServiceNowClientError) throw error;
    if (error?.name === "AbortError") {
      throw new ServiceNowClientError("servicenow_timeout", { status: 504 });
    }
    throw new ServiceNowClientError("servicenow_unavailable", {
      status: 502,
      details: sanitizeServiceNowError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function serviceNowGetWithRetry(url, options = {}) {
  assertGetOnly(options.method || "GET");

  const config = options.config || getServiceNowConfig();
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const fetchImpl = options.fetchImpl || fetch;
  const maxRetries = Number.isFinite(options.retryMax)
    ? Math.min(Math.max(options.retryMax, 0), MAX_RETRY_MAX)
    : (config.retryMax ?? DEFAULT_RETRY_MAX);

  let attempt = 0;
  let lastError;

  while (attempt <= maxRetries) {
    try {
      return await serviceNowFetchOnce(url, { config, fetchImpl });
    } catch (error) {
      lastError = error;
      if (!isRetryableServiceNowError(error) || attempt >= maxRetries) throw error;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      attempt += 1;
    }
  }

  throw lastError;
}

/**
 * GET único à Table API.
 * @param {string} table
 * @param {object} options
 */
export async function serviceNowGet(table, options = {}) {
  assertGetOnly(options.method || "GET");

  const config = options.config || getServiceNowConfig();
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const tableName = clean(table);
  if (!tableName) {
    throw new ServiceNowClientError("servicenow_invalid_table");
  }

  const limit = asPositiveInt(options.sysparm_limit, config.defaultLimit);
  const offset = asPositiveInt(options.sysparm_offset, 0, { min: 0, max: 1_000_000 });
  const url = buildTableUrl(config.baseUrl, tableName, {
    sysparm_query: options.sysparm_query,
    sysparm_fields: options.sysparm_fields,
    sysparm_limit: limit,
    sysparm_offset: offset,
    sysparm_display_value: options.sysparm_display_value,
    sysparm_exclude_reference_link: options.sysparm_exclude_reference_link,
  });

  const response = await serviceNowGetWithRetry(url, {
    config,
    fetchImpl: options.fetchImpl,
    retryMax: options.retryMax,
    method: "GET",
  });

  const body = await readJsonBody(response);
  const records = Array.isArray(body?.result) ? body.result : [];
  const totalCountHeader = response.headers.get("x-total-count");
  const totalCount =
    totalCountHeader != null && totalCountHeader !== ""
      ? Number.parseInt(totalCountHeader, 10)
      : null;

  return {
    table: tableName,
    records,
    count: records.length,
    offset,
    limit,
    totalCount: Number.isFinite(totalCount) ? totalCount : null,
    nextLink: parseLinkNext(response.headers.get("link")),
  };
}

/**
 * GET Aggregate API (/api/now/stats/{table}). Somente leitura.
 */
export async function serviceNowStats(table, options = {}) {
  assertGetOnly(options.method || "GET");

  const config = options.config || getServiceNowConfig();
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const tableName = clean(table);
  if (!tableName) {
    throw new ServiceNowClientError("servicenow_invalid_table");
  }

  const url = buildStatsUrl(config.baseUrl, tableName, {
    sysparm_query: options.sysparm_query,
    sysparm_count: options.sysparm_count == null ? "true" : options.sysparm_count,
    sysparm_group_by: options.sysparm_group_by,
  });

  const response = await serviceNowGetWithRetry(url, {
    config,
    fetchImpl: options.fetchImpl,
    retryMax: options.retryMax,
    method: "GET",
  });

  const body = await readJsonBody(response);
  const rows = normalizeStatsRows(body?.result);

  return {
    table: tableName,
    rows,
    count: rows.length,
    total: rows.length === 1 && !options.sysparm_group_by
      ? parseAggregateStatsCount(rows[0])
      : null,
    groupBy: options.sysparm_group_by || null,
  };
}

/**
 * Paginação GET (sysparm_offset + sysparm_limit). Somente leitura.
 */
export async function serviceNowGetAll(table, options = {}) {
  const config = options.config || getServiceNowConfig();
  const pageLimit = asPositiveInt(options.sysparm_limit, config.defaultLimit);
  const maxRecords = asPositiveInt(
    options.maxRecords ?? options.max_records,
    1000,
    { min: 1, max: 50_000 },
  );
  const startOffset = asPositiveInt(options.sysparm_offset, 0, { min: 0, max: 1_000_000 });

  const all = [];
  const pages = [];
  let offset = startOffset;
  let page = 0;
  let reportedTotal = null;
  let truncated = false;

  while (all.length < maxRecords) {
    const remaining = maxRecords - all.length;
    const limit = Math.min(pageLimit, remaining);
    const pageResult = await serviceNowGet(table, {
      ...options,
      config,
      sysparm_limit: limit,
      sysparm_offset: offset,
    });

    page += 1;
    if (pageResult.totalCount != null) reportedTotal = pageResult.totalCount;

    pages.push({
      page,
      offset: pageResult.offset,
      limit: pageResult.limit,
      count: pageResult.count,
      totalCount: pageResult.totalCount,
    });

    all.push(...pageResult.records);

    if (pageResult.count === 0 || pageResult.count < limit) break;
    if (pageResult.totalCount != null && offset + pageResult.count >= pageResult.totalCount) break;

    offset += pageResult.count;
    if (all.length >= maxRecords) {
      truncated = true;
      break;
    }
  }

  return {
    table: clean(table),
    records: all,
    count: all.length,
    pages: pages.length,
    pageDetails: pages,
    totalCount: reportedTotal,
    truncated,
    offsetStart: startOffset,
    pageLimit,
    maxRecords,
  };
}
