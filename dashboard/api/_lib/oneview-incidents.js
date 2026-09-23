/**
 * SN-P0-39 — GET /api/oneview/incidents via read model PostgreSQL.
 * Sem HTTP ServiceNow no caminho de leitura. Sem POST/PATCH/DELETE.
 * Encoded query montada só no backend com filtros allowlisted (nunca sysparm_query cru).
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  getServiceNowConfig,
  mapAggregateGroupCounts,
  mapServiceNowErrorToHttpStatus,
  mapServiceNowErrorToPublicCode,
  parseAggregateStatsCount,
  sanitizeServiceNowError,
  serviceNowGet,
  serviceNowStats,
  ServiceNowClientError,
} from "./servicenow-client.js";
import {
  extractServiceNowDisplay,
  normalizeServiceNowIncident,
  SERVICENOW_INCIDENT_FIELDS_CSV,
} from "./servicenow-normalize.js";
import { fetchReadModelIncidentsPage } from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MONITORING_CONTACT_TYPE = "monitoring";
const SAFE_FILTER = /^[a-zA-Z0-9._:@/\- ]{1,120}$/;
const SAFE_STATE = /^[0-9,]{1,40}$/;
const SAFE_PRIORITY = /^[1-5]$/;
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const MAX_ASSIGNED_TO_IDS = 20;

/**
 * SN-P0-12 — definições explícitas de KPI por state ServiceNow.
 * Não inferir por short_description. On Hold (3) e Cancelado (8) ficam fora da faixa.
 *
 * Abertos      = state=1  (Novo)
 * Em andamento = state=2  (Em andamento)
 * Resolvidos   = state=6  (Resolvido) — NÃO inclui Encerrado
 * Encerrados   = state=7  (Encerrado)
 */
export const INCIDENT_STATE_KPI = Object.freeze({
  open: Object.freeze({ state: "1", label: "Abertos", display: "Novo" }),
  in_progress: Object.freeze({ state: "2", label: "Em andamento", display: "Em andamento" }),
  resolved: Object.freeze({ state: "6", label: "Resolvidos", display: "Resolvido(a)" }),
  closed: Object.freeze({ state: "7", label: "Encerrados", display: "Encerrado(a)" }),
});
const SAFE_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_SEARCH = /^[a-zA-Z0-9._:@/\- ]{1,80}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** SN-P0-28 — busca que é número INC exato (case-insensitive). */
export const INCIDENT_EXACT_NUMBER_SEARCH_RE = /^INC\d+$/i;

/** SN-P0-15 — únicos query params aceitos do frontend. */
export const INCIDENT_ALLOWED_QUERY_KEYS = Object.freeze([
  "page",
  "page_size",
  "caller_id",
  "assigned_to",
  "contact_type",
  "manual",
  "number",
  "sys_id",
  "state",
  "priority",
  "company",
  "client",
  "cliente",
  "opened_from",
  "opened_to",
  "updated_from",
  "updated_to",
  "include_related_alert",
  "include_counts",
  "include_global_counts",
  "include_facets",
  "unassigned",
  "has_assignee",
  "include_unassigned",
  "assignment_group",
  "search",
  "q",
  "limit",
]);

/** Query params extras só para GET /oneview/incidents/search-suggest. */
export const INCIDENT_SUGGEST_QUERY_KEYS = Object.freeze(["q", "limit"]);

const ALLOWED_QUERY_KEY_SET = new Set(INCIDENT_ALLOWED_QUERY_KEYS);

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function oneQueryJoined(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).join(",");
  }
  return value;
}

export function parseAssignedToFilter(value) {
  if (value === undefined || value === null) return null;
  const tokens = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length > MAX_ASSIGNED_TO_IDS) throw invalidQuery("invalid_assigned_to");
  if (tokens.length === 1) {
    const single = tokens[0];
    if (SAFE_SYS_ID.test(single)) return single.toLowerCase();
    if (!SAFE_FILTER.test(single)) throw invalidQuery("invalid_assigned_to");
    return single;
  }
  const ids = [];
  for (const token of tokens) {
    if (!SAFE_SYS_ID.test(token)) throw invalidQuery("invalid_assigned_to");
    ids.push(token.toLowerCase());
  }
  return [...new Set(ids)].join(",");
}

function asPageInt(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function cleanOptional(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function invalidQuery(code = "invalid_query") {
  const error = new Error(code);
  error.code = "invalid_query";
  return error;
}

export function isServiceNowIncidentsEnabled(env = process.env) {
  return booleanFlag(env.SERVICENOW_INCIDENTS_ENABLED, false);
}

function assertSafeFilter(value, code) {
  if (value == null) return null;
  if (!SAFE_FILTER.test(value)) throw invalidQuery(code);
  return value;
}

function assertSafeDate(value, code) {
  if (value == null) return null;
  if (!SAFE_DATE.test(value)) throw invalidQuery(code);
  return value;
}

function escapeLike(value) {
  return String(value).replace(/([%^@!=<>\\])/g, "\\$1");
}

/**
 * SN-P0-15 — rejeita sysparm_query / sysparm_* crus e chaves fora do allowlist.
 */
export function assertAllowlistedIncidentQuery(req) {
  const query = req?.query;
  if (query == null || typeof query !== "object") return;

  for (const key of Object.keys(query)) {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "sysparm_query" || normalized.startsWith("sysparm_")) {
      throw invalidQuery("raw_sysparm_not_allowed");
    }
    if (!ALLOWED_QUERY_KEY_SET.has(normalized) && !ALLOWED_QUERY_KEY_SET.has(key)) {
      throw invalidQuery("unknown_query_param");
    }
  }
}

/**
 * Parseia filtros allowlisted. contact_type é opcional e sempre explícito.
 */
export function parseIncidentFilters(req) {
  assertAllowlistedIncidentQuery(req);

  const page = asPageInt(oneQuery(req, "page"), DEFAULT_PAGE, { min: 1, max: 10_000 });
  const pageSize = asPageInt(oneQuery(req, "page_size"), DEFAULT_PAGE_SIZE, {
    min: 1,
    max: MAX_PAGE_SIZE,
  });

  // OV-P0-265: omitir o filtro mantém o universo integral do read-model.
  // "__blank" é a opção explícita para registros sem canal informado.
  const contactType = assertSafeFilter(cleanOptional(oneQuery(req, "contact_type")), "invalid_contact_type");

  const callerId = assertSafeFilter(cleanOptional(oneQuery(req, "caller_id")), "invalid_caller_id");
  const assignedTo = parseAssignedToFilter(oneQueryJoined(req, "assigned_to"));
  const stateRaw = cleanOptional(oneQuery(req, "state"));
  const state = stateRaw
    ? (SAFE_STATE.test(stateRaw) ? stateRaw : (() => { throw invalidQuery("invalid_state"); })())
    : null;

  const priorityRaw = cleanOptional(oneQuery(req, "priority"));
  const priority = priorityRaw
    ? (SAFE_PRIORITY.test(priorityRaw) ? priorityRaw : (() => { throw invalidQuery("invalid_priority"); })())
    : null;

  const company = assertSafeFilter(
    cleanOptional(oneQuery(req, "company") ?? oneQuery(req, "client") ?? oneQuery(req, "cliente")),
    "invalid_company",
  );
  const openedFrom = assertSafeDate(cleanOptional(oneQuery(req, "opened_from")), "invalid_opened_from");
  const openedTo = assertSafeDate(cleanOptional(oneQuery(req, "opened_to")), "invalid_opened_to");
  const updatedFrom = assertSafeDate(cleanOptional(oneQuery(req, "updated_from")), "invalid_updated_from");
  const updatedTo = assertSafeDate(cleanOptional(oneQuery(req, "updated_to")), "invalid_updated_to");
  const unassigned = booleanFlag(oneQuery(req, "unassigned"), false);
  const hasAssignee = booleanFlag(oneQuery(req, "has_assignee"), false);
  const includeUnassigned = booleanFlag(oneQuery(req, "include_unassigned"), false);
  const includeRelatedAlert = booleanFlag(oneQuery(req, "include_related_alert"), false);
  const includeCounts = booleanFlag(oneQuery(req, "include_counts"), true);
  const includeGlobalCounts = booleanFlag(oneQuery(req, "include_global_counts"), true);
  const includeFacets = booleanFlag(oneQuery(req, "include_facets"), true);
  const manual = booleanFlag(oneQuery(req, "manual"), false);

  let numberRaw = cleanOptional(oneQuery(req, "number"));
  const sysIdRaw = cleanOptional(oneQuery(req, "sys_id"));
  let searchRaw = cleanOptional(oneQuery(req, "search"));

  // SN-P0-28: busca ^INC\d+$ → number exato (não LIKE textual).
  if (!numberRaw && searchRaw && INCIDENT_EXACT_NUMBER_SEARCH_RE.test(searchRaw)) {
    numberRaw = searchRaw.toUpperCase();
    searchRaw = null;
  }

  const number = numberRaw
    ? (SAFE_NUMBER.test(numberRaw) ? numberRaw : (() => { throw invalidQuery("invalid_number"); })())
    : null;
  const sysId = sysIdRaw
    ? (SAFE_SYS_ID.test(sysIdRaw) ? sysIdRaw.toLowerCase() : (() => { throw invalidQuery("invalid_sys_id"); })())
    : null;
  const assignmentGroup = assertSafeFilter(
    cleanOptional(oneQuery(req, "assignment_group")),
    "invalid_assignment_group",
  );

  const search = searchRaw
    ? (SAFE_SEARCH.test(searchRaw) ? searchRaw : (() => { throw invalidQuery("invalid_search"); })())
    : null;

  return {
    page,
    page_size: pageSize,
    caller_id: callerId,
    assigned_to: unassigned ? null : assignedTo,
    contact_type: contactType,
    number,
    sys_id: sysId,
    // OV-P0-317: aba Manuais é estritamente operacional; não permite estado
    // resolvido/encerrado mesmo se a URL for alterada manualmente.
    state: manual ? "1,2,3" : state,
    priority,
    company,
    opened_from: openedFrom,
    opened_to: openedTo,
    updated_from: updatedFrom,
    updated_to: updatedTo,
    unassigned,
    has_assignee: unassigned ? false : hasAssignee,
    include_unassigned: unassigned ? false : includeUnassigned,
    include_related_alert: includeRelatedAlert,
    include_counts: includeCounts,
    include_global_counts: includeGlobalCounts,
    include_facets: includeFacets,
    manual,
    assignment_group: assignmentGroup,
    search,
  };
}

function buildAndParts(filters, { stateOverride = undefined, unassignedOverride = undefined } = {}) {
  const andParts = [];

  // OV-P0-265: canal só restringe a consulta quando informado pelo usuário.
  if (filters.contact_type === "__blank") andParts.push("contact_typeISEMPTY");
  else if (filters.contact_type) andParts.push(`contact_type=${filters.contact_type}`);
  // caller_id, assigned_to e number são filtros opcionais — só entram se enviados pelo frontend.
  if (filters.caller_id) andParts.push(`caller_id=${filters.caller_id}`);
  if (filters.assigned_to) {
    const ids = String(filters.assigned_to).split(",").map((item) => item.trim()).filter(Boolean);
    const assigneePart = ids.length > 1 ? `assigned_toIN${ids.join(",")}` : `assigned_to=${ids[0]}`;
    if (filters.include_unassigned) {
      andParts.push(assigneePart);
      andParts.push("ORassigned_toISEMPTY");
    } else {
      andParts.push(assigneePart);
    }
  } else if (filters.has_assignee) {
    andParts.push("assigned_toISNOTEMPTY");
  }
  if (filters.number) andParts.push(`number=${filters.number}`);
  if (filters.priority) andParts.push(`priority=${filters.priority}`);
  if (filters.company) andParts.push(`company.nameLIKE${escapeLike(filters.company)}`);
  if (filters.opened_from) andParts.push(`opened_at>=${filters.opened_from}`);
  if (filters.opened_to) andParts.push(`opened_at<=${filters.opened_to} 23:59:59`);

  const state = stateOverride === undefined ? filters.state : stateOverride;
  if (state) {
    if (String(state).includes(",")) andParts.push(`stateIN${state}`);
    else andParts.push(`state=${state}`);
  }

  const unassigned = unassignedOverride === undefined ? filters.unassigned : unassignedOverride;
  if (unassigned) andParts.push("assigned_toISEMPTY");

  return andParts;
}

/**
 * Monta encoded query ServiceNow a partir dos filtros allowlisted (SN-P0-15/25).
 * Sem canal ou caller_id implícito. Search usa ^NQ para numberLIKE OR short_descriptionLIKE.
 */
export function buildIncidentSysparmQuery(filters, options = {}) {
  const andParts = buildAndParts(filters, options);
  const base = andParts.join("^");
  let query = base;

  if (filters.search && !options.skipSearch) {
    const term = escapeLike(filters.search);
    const byNumber = base ? `${base}^numberLIKE${term}` : `numberLIKE${term}`;
    const byDescription = base ? `${base}^short_descriptionLIKE${term}` : `short_descriptionLIKE${term}`;
    query = `${byNumber}^NQ${byDescription}`;
  }

  if (options.skipOrder) return query || "";

  return query
    ? `${query}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`
    : "ORDERBYDESCsys_updated_on^ORDERBYsys_id";
}

function buildServiceNowIncidentUrl(baseUrl, sysId) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const id = String(sysId || "").trim();
  if (!base || !id) return null;
  try {
    const url = new URL("/incident.do", `${base}/`);
    url.searchParams.set("sys_id", id);
    return url.toString();
  } catch {
    return null;
  }
}

export const RELATED_INCIDENTS_MAX = 50;

/**
 * SN-P0-33 — caller Zabbix para correlação alerta→INC.
 * Lê só de config/env; sem fallback silencioso para sys_id DEV.
 */
export function resolveZabbixMonitoringCallerId(configOrEnv = getServiceNowConfig()) {
  if (configOrEnv && typeof configOrEnv === "object" && "zabbixMonitoringCallerId" in configOrEnv) {
    return String(configOrEnv.zabbixMonitoringCallerId || "").trim();
  }
  return String(getServiceNowConfig(configOrEnv).zabbixMonitoringCallerId || "").trim();
}

/** SN-P0-33 — seeds opcionais de facet (CSV env); vazio = só Aggregate/API. */
export function resolveCallerFilterSeeds(configOrEnv = getServiceNowConfig()) {
  if (configOrEnv && typeof configOrEnv === "object" && Array.isArray(configOrEnv.callerFilterSeeds)) {
    return configOrEnv.callerFilterSeeds;
  }
  return getServiceNowConfig(configOrEnv).callerFilterSeeds || [];
}

export function enrichIncident(raw, config = getServiceNowConfig()) {
  const base = normalizeServiceNowIncident(raw);
  return {
    ...base,
    caller_id_display: extractServiceNowDisplay(raw?.caller_id),
    contact_type_display: extractServiceNowDisplay(raw?.contact_type),
    assignment_group_display: extractServiceNowDisplay(raw?.assignment_group),
    assigned_to_display: extractServiceNowDisplay(raw?.assigned_to),
    company_display: extractServiceNowDisplay(raw?.company),
    state_display: extractServiceNowDisplay(raw?.state),
    priority_display: extractServiceNowDisplay(raw?.priority),
    servicenow_url: buildServiceNowIncidentUrl(config.baseUrl, base.sys_id),
  };
}

/**
 * SN-P0-16 / SN-P0-33 — encoded query alerta → incidentes.
 * contact_type=monitoring + caller (env) + description LIKE eventid=
 * (sem host fallback; sem default DEV).
 */
export function buildRelatedIncidentsSysparmQuery(sourceEventId, { callerId } = {}) {
  const resolvedCaller = String(callerId || "").trim();
  if (!resolvedCaller) {
    throw new ServiceNowClientError("servicenow_caller_not_configured");
  }
  const eventId = escapeLike(String(sourceEventId || "").trim());
  return (
    `contact_type=${MONITORING_CONTACT_TYPE}`
    + `^caller_id=${resolvedCaller}`
    + `^descriptionLIKEeventid=${eventId}`
    + "^ORDERBYDESCsys_updated_on^ORDERBYsys_id"
  );
}

/**
 * SN-P0-16 / SN-P0-33 — GET ServiceNow + pós-filtro parser.zabbix_event_id === source_event_id.
 * Aceita múltiplos incidentes. Sem fallback por host.
 * Falha fechada com servicenow_caller_not_configured se o caller env estiver ausente
 * (não quebra /chamados nem lookup por número INC).
 */
export async function fetchIncidentsBySourceEventId(sourceEventId, {
  config = getServiceNowConfig(),
  fetchImpl,
  getPage = serviceNowGet,
  maxRecords = RELATED_INCIDENTS_MAX,
} = {}) {
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const callerId = resolveZabbixMonitoringCallerId(config);
  if (!callerId) {
    throw new ServiceNowClientError("servicenow_caller_not_configured");
  }

  const eventId = String(sourceEventId || "").trim();
  const pageResult = await getPage("incident", {
    config,
    fetchImpl,
    sysparm_query: buildRelatedIncidentsSysparmQuery(eventId, { callerId }),
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: Math.min(Math.max(Number(maxRecords) || RELATED_INCIDENTS_MAX, 1), RELATED_INCIDENTS_MAX),
    sysparm_offset: 0,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });

  const candidates = Array.isArray(pageResult.records) ? pageResult.records : [];
  const incidents = [];
  for (const raw of candidates) {
    const item = enrichIncident(raw, config);
    if (String(item.zabbix_event_id || "") === eventId) {
      incidents.push(item);
    }
  }

  return {
    source_event_id: eventId,
    matched: incidents.length > 0,
    incidents,
    candidates_returned: candidates.length,
    data_source: "servicenow",
    checked_at: new Date().toISOString(),
  };
}

function mapServiceNowStatus(error) {
  return mapServiceNowErrorToHttpStatus(error);
}

function publicErrorCode(error) {
  return mapServiceNowErrorToPublicCode(error);
}

function sendIncidentsJson(res, status, payload, { dataSource = null } = {}) {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (dataSource) res.setHeader("X-OneView-Data-Source", dataSource);
  return sendJson(res, status, payload);
}

async function countWithQuery(getPage, config, fetchImpl, sysparmQuery) {
  const pageResult = await getPage("incident", {
    config,
    fetchImpl,
    sysparm_query: sysparmQuery || "ORDERBYDESCsys_id",
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_offset: 0,
    sysparm_display_value: "false",
    sysparm_exclude_reference_link: "true",
  });
  if (Number.isFinite(pageResult.totalCount)) return pageResult.totalCount;
  return pageResult.count || 0;
}

/**
 * Query de KPI "sem responsável" (ativos), alinhada aos demais filtros — inclusive search/^NQ.
 * SN-P0-26: buildAndParts sozinho omitia search e inflava unassigned.
 */
function buildUnassignedCountQuery(filters) {
  const andParts = [
    ...buildAndParts({ ...filters, state: null, unassigned: true }),
    "stateNOT IN6,7",
  ];
  const base = andParts.join("^");
  if (!filters.search) return base;

  const term = escapeLike(filters.search);
  const byNumber = base ? `${base}^numberLIKE${term}` : `numberLIKE${term}`;
  const byDescription = base ? `${base}^short_descriptionLIKE${term}` : `short_descriptionLIKE${term}`;
  return `${byNumber}^NQ${byDescription}`;
}

/**
 * Contagens via Table API (X-Total-Count) — fallback se Aggregate API falhar/403.
 */
async function fetchIncidentCountsViaTable(filters, { config, fetchImpl, getPage }) {
  const baseFilters = {
    ...filters,
    state: null,
    unassigned: false,
  };

  const [total, open, inProgress, resolved, closed, unassigned] = await Promise.all([
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildIncidentSysparmQuery(baseFilters, { skipOrder: true }),
    ),
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildIncidentSysparmQuery({ ...baseFilters, state: INCIDENT_STATE_KPI.open.state }, { skipOrder: true }),
    ),
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildIncidentSysparmQuery({ ...baseFilters, state: INCIDENT_STATE_KPI.in_progress.state }, { skipOrder: true }),
    ),
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildIncidentSysparmQuery({ ...baseFilters, state: INCIDENT_STATE_KPI.resolved.state }, { skipOrder: true }),
    ),
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildIncidentSysparmQuery({ ...baseFilters, state: INCIDENT_STATE_KPI.closed.state }, { skipOrder: true }),
    ),
    countWithQuery(
      getPage,
      config,
      fetchImpl,
      buildUnassignedCountQuery(baseFilters),
    ),
  ]);

  return {
    total,
    open,
    in_progress: inProgress,
    resolved,
    closed,
    unassigned,
  };
}

/**
 * Contagens operacionais via Aggregate API (SN-P0-12B).
 * Fallback automático para Table API se Aggregate retornar 403/erro.
 */
export async function fetchIncidentCounts(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getPage = serviceNowGet,
  getStats = serviceNowStats,
} = {}) {
  const baseFilters = {
    ...filters,
    state: null,
    unassigned: false,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });
  const unassignedQuery = buildUnassignedCountQuery(baseFilters);

  try {
    const [totalResult, stateResult, unassignedResult] = await Promise.all([
      getStats("incident", {
        config,
        fetchImpl,
        sysparm_count: true,
        sysparm_query: baseQuery,
      }),
      getStats("incident", {
        config,
        fetchImpl,
        sysparm_count: true,
        sysparm_group_by: "state",
        sysparm_query: baseQuery,
      }),
      getStats("incident", {
        config,
        fetchImpl,
        sysparm_count: true,
        sysparm_query: unassignedQuery,
      }),
    ]);

    const byState = mapAggregateGroupCounts(stateResult.rows, "state");
    const total = parseAggregateStatsCount(totalResult.rows?.[0]);
    const unassigned = parseAggregateStatsCount(unassignedResult.rows?.[0]);

    if (total == null || unassigned == null) {
      throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
    }

    return {
      total,
      open: byState[INCIDENT_STATE_KPI.open.state] || 0,
      in_progress: byState[INCIDENT_STATE_KPI.in_progress.state] || 0,
      resolved: byState[INCIDENT_STATE_KPI.resolved.state] || 0,
      closed: byState[INCIDENT_STATE_KPI.closed.state] || 0,
      unassigned,
    };
  } catch (error) {
    // SN-P0-12B: se Aggregate API for negada/indisponível, mantém KPIs via Table API.
    return fetchIncidentCountsViaTable(filters, { config, fetchImpl, getPage });
  }
}

/**
 * SN-P0-25 / SN-P0-33 — facet de callers no universo monitoring.
 * Aggregate + displayHints; seeds só via env (sem IDs/labels DEV hardcoded).
 */
export function buildIncidentCallerFacets(groupCounts, {
  labels = {},
  seedIds = [],
  displayHints = {},
} = {}) {
  const map = new Map();

  for (const [value, count] of Object.entries(groupCounts || {})) {
    const id = String(value || "").trim();
    if (!id || id === "(null)") continue;
    map.set(id, {
      value: id,
      label: displayHints[id] || labels[id] || id,
      display_value: displayHints[id] || labels[id] || id,
      count: Number(count) || 0,
    });
  }

  for (const seedId of seedIds) {
    const id = String(seedId || "").trim();
    if (!id || map.has(id)) continue;
    map.set(id, {
      value: id,
      label: displayHints[id] || labels[id] || id,
      display_value: displayHints[id] || labels[id] || id,
      count: 0,
    });
  }

  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.label).localeCompare(String(b.label), "pt-BR");
  });
}

export async function fetchIncidentCallerFacets(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getStats = serviceNowStats,
  displayHints = {},
  seedIds = resolveCallerFilterSeeds(config),
} = {}) {
  const baseFilters = {
    ...filters,
    caller_id: null,
    assigned_to: null,
    state: null,
    unassigned: false,
    number: null,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });

  try {
    const statsResult = await getStats("incident", {
      config,
      fetchImpl,
      sysparm_count: true,
      sysparm_group_by: "caller_id",
      sysparm_query: baseQuery,
    });
    const groupCounts = mapAggregateGroupCounts(statsResult.rows, "caller_id");
    return buildIncidentCallerFacets(groupCounts, { displayHints, seedIds });
  } catch {
    return buildIncidentCallerFacets({}, { displayHints, seedIds });
  }
}

/**
 * SN-P0-28 — facet de analistas (assigned_to): value estável + display_value para UI.
 */
export function buildIncidentAssigneeFacets(groupCounts, {
  displayHints = {},
} = {}) {
  const map = new Map();

  for (const [value, count] of Object.entries(groupCounts || {})) {
    const id = String(value || "").trim();
    if (!id || id === "(null)") continue;
    const label = String(displayHints[id] || id).trim() || id;
    map.set(id, {
      value: id,
      label,
      display_value: label,
      count: Number(count) || 0,
    });
  }

  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.label).localeCompare(String(b.label), "pt-BR");
  });
}

export async function fetchIncidentAssigneeFacets(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getStats = serviceNowStats,
  displayHints = {},
} = {}) {
  const baseFilters = {
    ...filters,
    assigned_to: null,
    unassigned: false,
    state: null,
    number: null,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });

  try {
    const statsResult = await getStats("incident", {
      config,
      fetchImpl,
      sysparm_count: true,
      sysparm_group_by: "assigned_to",
      sysparm_query: baseQuery,
    });
    const groupCounts = mapAggregateGroupCounts(statsResult.rows, "assigned_to");
    return buildIncidentAssigneeFacets(groupCounts, { displayHints });
  } catch {
    return buildIncidentAssigneeFacets({}, { displayHints });
  }
}

/** SN-P0-30 — labels estáveis de state/priority para facets. */
export const INCIDENT_STATE_FACET_LABELS = Object.freeze({
  1: "Novo",
  2: "Em andamento",
  3: "Em espera",
  6: "Resolvido(a)",
  7: "Encerrado(a)",
  8: "Cancelado",
});

export const INCIDENT_PRIORITY_FACET_LABELS = Object.freeze({
  1: "1 - Crítica",
  2: "2 - Alta",
  3: "3 - Moderada",
  4: "4 - Baixa",
  5: "5 - Planejamento",
});

function buildNamedFacets(groupCounts, {
  displayHints = {},
  labels = {},
} = {}) {
  const map = new Map();
  for (const [value, count] of Object.entries(groupCounts || {})) {
    const id = String(value || "").trim();
    if (!id || id === "(null)") continue;
    const label = String(displayHints[id] || labels[id] || id).trim() || id;
    map.set(id, {
      value: id,
      label,
      display_value: label,
      count: Number(count) || 0,
    });
  }
  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.label).localeCompare(String(b.label), "pt-BR");
  });
}

/** SN-P0-30 — facet companies (value=sys_id, display_value=nome). */
export function buildIncidentCompanyFacets(groupCounts, options = {}) {
  return buildNamedFacets(groupCounts, options);
}

export async function fetchIncidentCompanyFacets(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getStats = serviceNowStats,
  displayHints = {},
} = {}) {
  const baseFilters = {
    ...filters,
    company: null,
    number: null,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });
  try {
    const statsResult = await getStats("incident", {
      config,
      fetchImpl,
      sysparm_count: true,
      sysparm_group_by: "company",
      sysparm_query: baseQuery,
    });
    const groupCounts = mapAggregateGroupCounts(statsResult.rows, "company");
    return buildIncidentCompanyFacets(groupCounts, { displayHints });
  } catch {
    return buildIncidentCompanyFacets({}, { displayHints });
  }
}

/** SN-P0-30 — facet states (value estável + display_value). */
export function buildIncidentStateFacets(groupCounts, {
  displayHints = {},
  labels = INCIDENT_STATE_FACET_LABELS,
} = {}) {
  return buildNamedFacets(groupCounts, { displayHints, labels });
}

export async function fetchIncidentStateFacets(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getStats = serviceNowStats,
  displayHints = {},
} = {}) {
  const baseFilters = {
    ...filters,
    state: null,
    number: null,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });
  try {
    const statsResult = await getStats("incident", {
      config,
      fetchImpl,
      sysparm_count: true,
      sysparm_group_by: "state",
      sysparm_query: baseQuery,
    });
    const groupCounts = mapAggregateGroupCounts(statsResult.rows, "state");
    return buildIncidentStateFacets(groupCounts, { displayHints });
  } catch {
    return buildIncidentStateFacets({}, { displayHints });
  }
}

/** SN-P0-30 — facet priorities (value estável + display_value). */
export function buildIncidentPriorityFacets(groupCounts, {
  displayHints = {},
  labels = INCIDENT_PRIORITY_FACET_LABELS,
} = {}) {
  return buildNamedFacets(groupCounts, { displayHints, labels });
}

export async function fetchIncidentPriorityFacets(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getStats = serviceNowStats,
  displayHints = {},
} = {}) {
  const baseFilters = {
    ...filters,
    priority: null,
    number: null,
  };
  const baseQuery = buildIncidentSysparmQuery(baseFilters, { skipOrder: true });
  try {
    const statsResult = await getStats("incident", {
      config,
      fetchImpl,
      sysparm_count: true,
      sysparm_group_by: "priority",
      sysparm_query: baseQuery,
    });
    const groupCounts = mapAggregateGroupCounts(statsResult.rows, "priority");
    return buildIncidentPriorityFacets(groupCounts, { displayHints });
  } catch {
    return buildIncidentPriorityFacets({}, { displayHints });
  }
}

/**
 * Busca uma página de incidentes no ServiceNow (somente GET).
 */
export async function fetchIncidentsPage(filters, {
  config = getServiceNowConfig(),
  fetchImpl,
  getPage = serviceNowGet,
  getStats = serviceNowStats,
  includeCounts = true,
} = {}) {
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const offset = (filters.page - 1) * filters.page_size;
  const sysparmQuery = buildIncidentSysparmQuery(filters);

  const pageResult = await getPage("incident", {
    config,
    fetchImpl,
    sysparm_query: sysparmQuery,
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: filters.page_size,
    sysparm_offset: offset,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });

  const totalItems = Number.isFinite(pageResult.totalCount)
    ? pageResult.totalCount
    : pageResult.count;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / filters.page_size);

  const items = (pageResult.records || []).map((item) => enrichIncident(item, config));
  const callerHints = {};
  const assigneeHints = {};
  const companyHints = {};
  const stateHints = {};
  const priorityHints = {};
  for (const item of items) {
    if (item.caller_id && item.caller_id_display) {
      callerHints[item.caller_id] = item.caller_id_display;
    }
    if (item.assigned_to && item.assigned_to_display) {
      assigneeHints[item.assigned_to] = item.assigned_to_display;
    }
    if (item.company && item.company_display) {
      companyHints[item.company] = item.company_display;
    }
    if (item.state && item.state_display) {
      stateHints[item.state] = item.state_display;
    }
    if (item.priority && item.priority_display) {
      priorityHints[item.priority] = item.priority_display;
    }
  }

  const [counts, callers, assignees, companies, states, priorities] = await Promise.all([
    includeCounts
      ? fetchIncidentCounts(filters, { config, fetchImpl, getPage, getStats })
      : Promise.resolve(null),
    fetchIncidentCallerFacets(filters, { config, fetchImpl, getStats, displayHints: callerHints }),
    fetchIncidentAssigneeFacets(filters, { config, fetchImpl, getStats, displayHints: assigneeHints }),
    fetchIncidentCompanyFacets(filters, { config, fetchImpl, getStats, displayHints: companyHints }),
    fetchIncidentStateFacets(filters, { config, fetchImpl, getStats, displayHints: stateHints }),
    fetchIncidentPriorityFacets(filters, { config, fetchImpl, getStats, displayHints: priorityHints }),
  ]);

  return {
    items,
    pagination: {
      page: filters.page,
      page_size: filters.page_size,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: filters.page < totalPages,
      has_previous: filters.page > 1 && totalPages > 0,
    },
    filters: {
      caller_id: filters.caller_id,
      assigned_to: filters.assigned_to,
      contact_type: filters.contact_type,
      number: filters.number,
      state: filters.state,
      priority: filters.priority,
      company: filters.company,
      opened_from: filters.opened_from,
      opened_to: filters.opened_to,
      unassigned: filters.unassigned,
      search: filters.search,
    },
    counts,
    facets: {
      callers,
      assignees,
      companies,
      states,
      priorities,
    },
    data_source: "servicenow",
    checked_at: new Date().toISOString(),
  };
}

export function createIncidentsHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  readModelPage = fetchReadModelIncidentsPage,
  readModelOptions,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function incidentsHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    if (!featureFlagProvider()) {
      return sendIncidentsJson(
        res,
        403,
        { error: "servicenow_incidents_disabled", data_source: "postgresql" },
        { dataSource: "postgresql" },
      );
    }

    let filters;
    try {
      filters = parseIncidentFilters(req);
    } catch {
      return sendIncidentsJson(res, 400, { error: "invalid_query", data_source: "postgresql" }, { dataSource: "postgresql" });
    }

    try {
      const payload = await readModelPage(filters, readModelOptions);
      logger({
        event: "oneview_request",
        route: "/api/oneview/incidents",
        data_source: "postgresql",
        duration_ms: Math.max(Date.now() - startedAt, 0),
        rows: payload.items.length,
        page: payload.pagination.page,
        page_size: payload.pagination.page_size,
      });
      return sendIncidentsJson(res, 200, payload, { dataSource: "postgresql" });
    } catch (error) {
      const status = 503;
      const code = "database_unavailable";
      logger({
        event: "oneview_incidents_error",
        route: "/api/oneview/incidents",
        error: code,
        detail: String(error?.message || "database_unavailable").slice(0, 160),
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendIncidentsJson(res, status, { error: code, data_source: "postgresql" }, { dataSource: "postgresql" });
    }
  };
}

export default createIncidentsHandler();
