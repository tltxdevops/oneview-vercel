/**
 * OV-P0-247 — fila operacional de follow-up de operadoras.
 * Seleção somente por tag Zabbix persistida. Sem regex em título/host/cliente/descrição.
 * Analista = ServiceNow assigned_to do read-model. Sem SLA (estrutura nula).
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  extractServiceNowRefsFromAlertTags,
  SERVICENOW_PROD_BASE_URL,
  buildServiceNowIncidentDeepLink,
} from "./oneview-inc-correlation.js";
import { getOneViewDbPool, safeCustomerIdentity } from "./oneview-db.js";
import { getPrimaryDataSourceName } from "./oneview-scope.js";
import { mapReadModelIncident } from "./oneview-incidents-read-model.js";
import {
  OPERATOR_TAG_EXISTS_SQL,
  OPERATOR_TAG_KEYS,
  OPERATOR_TAG_KEY_ALIASES,
  OPERATOR_TAG_VALUES,
  OPERATOR_TAG_VALUE_TOKENS,
  alertHasOperatorTag,
  extractOperatorTags,
  isOperatorTagKey,
  isOperatorTagValue,
} from "./oneview-operator-tags.js";

export {
  OPERATOR_TAG_KEYS,
  OPERATOR_TAG_KEY_ALIASES,
  OPERATOR_TAG_VALUES,
  OPERATOR_TAG_VALUE_TOKENS,
  alertHasOperatorTag,
  extractOperatorTags,
  isOperatorTagKey,
  isOperatorTagValue,
};

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_ALERT_ROWS = 500;
const SAFE_TAB = /^(all|unassigned|following|recent)$/;
const SAFE_SEVERITY = /^(information|warning|average|high|disaster|critical|not_classified)$/;
const SAFE_STATE = /^[1-8]$/;
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const SAFE_FILTER = /^[\p{L}\p{N}._:@/| \-]{1,240}$/u;
const SAFE_ALERT_STATUS = /^(all|active|resolved)$/;

export const UNASSIGNED_ANALYST_LABEL = "Sem responsável";
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SLA_RULES_IMPLEMENTED = false;


function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function asPageInt(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function invalidQuery() {
  const error = new Error("invalid_query");
  error.code = "invalid_query";
  return error;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function operatorTagLabel(alertOrTags) {
  const tags = extractOperatorTags(alertOrTags);
  if (!tags.length) return null;
  const preferred = tags.find((item) => item.value) || tags[0];
  return preferred.value || preferred.tag || null;
}

export function formatUpdatedAgoLabel(iso, now = Date.now()) {
  const ts = Date.parse(String(iso || ""));
  if (!Number.isFinite(ts)) return null;
  const minutes = Math.max(0, Math.round((now - ts) / 60000));
  if (minutes < 1) return "Atualizado há menos de 1 min";
  if (minutes < 60) return `Atualizado há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder ? `Atualizado há ${hours} h ${remainder} min` : `Atualizado há ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "Atualizado há 1 d" : `Atualizado há ${days} d`;
}

export function analystFromIncident(incident) {
  const assignedTo = text(incident?.assigned_to);
  const display = text(incident?.assigned_to_display);
  return {
    assigned_to: assignedTo,
    assigned_to_display: display,
    analyst_label: assignedTo ? (display || assignedTo) : UNASSIGNED_ANALYST_LABEL,
    unassigned: !assignedTo,
  };
}

export function slaPlaceholder() {
  return {
    sla_status: null,
    next_followup_at: null,
  };
}

export function lastUpdatedAt({ alert, incident } = {}) {
  return isoDate(incident?.sys_updated_on)
    || isoDate(alert?.last_seen_at)
    || isoDate(alert?.updated_at)
    || null;
}

export function pickCorrelatedIncident(alert, indexes) {
  const refs = extractServiceNowRefsFromAlertTags(alert);
  for (const sysId of refs.sysIds || []) {
    const incident = indexes.bySysId.get(String(sysId).toLowerCase());
    if (incident) {
      return { incident, relation_source: "zabbix_servicenow_sys_id" };
    }
  }
  for (const number of refs.numbers || []) {
    const incident = indexes.byNumber.get(String(number).toUpperCase());
    if (incident) {
      return { incident, relation_source: "zabbix_servicenow_number" };
    }
  }
  const eventIds = [alert?.source_event_id, alert?.source_problem_id]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const eventId of eventIds) {
    const incident = indexes.byEventId.get(eventId);
    if (incident) {
      return { incident, relation_source: "zabbix_event_id" };
    }
  }
  return { incident: null, relation_source: "none" };
}

export function parseOperatorQueueFilters(req) {
  const tab = String(oneQuery(req, "tab") || "all").trim().toLowerCase();
  if (!SAFE_TAB.test(tab)) throw invalidQuery();

  const operatorTag = text(oneQuery(req, "operator_tag"));
  if (operatorTag && !SAFE_FILTER.test(operatorTag)) throw invalidQuery();

  const customer = text(oneQuery(req, "customer") ?? oneQuery(req, "client"));
  if (customer && !SAFE_FILTER.test(customer)) throw invalidQuery();

  const assignedTo = text(oneQuery(req, "assigned_to"));
  if (assignedTo && !SAFE_SYS_ID.test(assignedTo)) throw invalidQuery();

  const state = text(oneQuery(req, "state") ?? oneQuery(req, "status"));
  if (state && !SAFE_STATE.test(state)) throw invalidQuery();

  const severity = text(oneQuery(req, "severity"));
  if (severity && !SAFE_SEVERITY.test(severity.toLowerCase())) throw invalidQuery();

  const alertStatus = String(oneQuery(req, "alert_status") || "all").trim().toLowerCase();
  if (!SAFE_ALERT_STATUS.test(alertStatus)) throw invalidQuery();

  return {
    tab,
    operator_tag: operatorTag,
    customer,
    assigned_to: assignedTo ? assignedTo.toLowerCase() : null,
    state,
    severity: severity ? severity.toLowerCase() : null,
    alert_status: alertStatus,
    page: asPageInt(oneQuery(req, "page"), DEFAULT_PAGE, { min: 1, max: 10_000 }),
    page_size: asPageInt(oneQuery(req, "page_size"), DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE }),
  };
}

function matchesTab(row, tab, now) {
  if (tab === "unassigned") return row.unassigned;
  if (tab === "following") return !row.unassigned;
  if (tab === "recent") {
    const ts = Date.parse(String(row.last_updated_at || ""));
    return Number.isFinite(ts) && (now - ts) <= RECENT_WINDOW_MS;
  }
  return true;
}

function matchesFilters(row, filters) {
  if (filters.operator_tag && row.operator_tag !== filters.operator_tag) return false;
  if (filters.customer) {
    const needle = filters.customer.toLowerCase();
    const haystack = [row.customer_name, row.customer_key]
      .map((value) => String(value || "").toLowerCase());
    if (!haystack.includes(needle)) return false;
  }
  if (filters.assigned_to && row.assigned_to !== filters.assigned_to) return false;
  if (filters.state && row.incident_state !== filters.state) return false;
  if (filters.severity && row.severity !== filters.severity) return false;
  return true;
}

function hostLabel(alert) {
  return text(alert.host_visible_name) || text(alert.host_technical_name) || text(alert.host_name);
}

function customerFields(alert) {
  const identity = safeCustomerIdentity(alert);
  return {
    customer_name: identity.customerName || text(alert.customer_name) || text(alert.client_name),
    customer_key: identity.customerKey || text(alert.customer_key),
  };
}

export function mapOperatorQueueRow(alert, incident, relationSource, now = Date.now()) {
  const analyst = analystFromIncident(incident);
  const lastUpdated = lastUpdatedAt({ alert, incident });
  const sla = slaPlaceholder();
  const customer = customerFields(alert);
  const sysId = text(incident?.sys_id);
  return {
    alert_id: text(alert.id),
    customer_name: customer.customer_name,
    customer_key: customer.customer_key,
    operator_tag: operatorTagLabel(alert),
    problem_name: text(alert.problem_name),
    host_name: hostLabel(alert),
    severity: text(alert.severity),
    incident_number: text(incident?.number),
    incident_sys_id: sysId,
    incident_state: text(incident?.state),
    incident_state_display: text(incident?.state_display) || text(incident?.state),
    assigned_to: analyst.assigned_to,
    assigned_to_display: analyst.assigned_to_display,
    analyst_label: analyst.analyst_label,
    unassigned: analyst.unassigned,
    assignment_group: text(incident?.assignment_group),
    assignment_group_display: text(incident?.assignment_group_display) || text(incident?.assignment_group),
    last_updated_at: lastUpdated,
    updated_ago_label: formatUpdatedAgoLabel(lastUpdated, now),
    sla_status: sla.sla_status,
    next_followup_at: sla.next_followup_at,
    relation_source: relationSource || "none",
    oneview_link: text(alert.id) ? `/operadoras?alert=${encodeURIComponent(String(alert.id))}` : null,
    servicenow_url: sysId ? buildServiceNowIncidentDeepLink(SERVICENOW_PROD_BASE_URL, sysId) : null,
  };
}

export function buildIncidentIndexes(incidents = []) {
  const bySysId = new Map();
  const byNumber = new Map();
  const byEventId = new Map();
  for (const incident of incidents) {
    if (!incident) continue;
    const sysId = text(incident.sys_id)?.toLowerCase();
    const number = text(incident.number)?.toUpperCase();
    const eventId = text(incident.correlation_id) || text(incident.zabbix_event_id);
    if (sysId && !bySysId.has(sysId)) bySysId.set(sysId, incident);
    if (number && !byNumber.has(number)) byNumber.set(number, incident);
    if (eventId && !byEventId.has(eventId)) byEventId.set(eventId, incident);
  }
  return { bySysId, byNumber, byEventId };
}

function compareQueueRows(left, right) {
  const leftTs = Date.parse(String(left.last_updated_at || "")) || 0;
  const rightTs = Date.parse(String(right.last_updated_at || "")) || 0;
  if (rightTs !== leftTs) return rightTs - leftTs;
  return String(right.alert_id || "").localeCompare(String(left.alert_id || ""));
}

function uniqueFacet(values) {
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const value = text(item.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: text(item.label) || value });
  }
  return out.sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
}

export function buildOperatorQueuePayload(alerts, incidents, filters, now = Date.now()) {
  const indexes = buildIncidentIndexes(incidents);
  const rows = [];
  for (const alert of alerts || []) {
    if (!alertHasOperatorTag(alert)) continue;
    const matched = pickCorrelatedIncident(alert, indexes);
    rows.push(mapOperatorQueueRow(alert, matched.incident, matched.relation_source, now));
  }

  const counts = {
    all: rows.filter((row) => matchesTab(row, "all", now)).length,
    unassigned: rows.filter((row) => matchesTab(row, "unassigned", now)).length,
    following: rows.filter((row) => matchesTab(row, "following", now)).length,
    recent: rows.filter((row) => matchesTab(row, "recent", now)).length,
  };

  const filtered = rows
    .filter((row) => matchesTab(row, filters.tab, now))
    .filter((row) => matchesFilters(row, filters))
    .sort(compareQueueRows);

  const totalItems = filtered.length;
  const totalPages = totalItems ? Math.ceil(totalItems / filters.page_size) : 0;
  const page = Math.min(filters.page, Math.max(totalPages, 1));
  const start = (page - 1) * filters.page_size;

  return {
    items: filtered.slice(start, start + filters.page_size),
    pagination: {
      page,
      page_size: filters.page_size,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_previous: page > 1 && totalPages > 0,
    },
    filters,
    counts,
    facets: {
      operator_tags: uniqueFacet(rows.map((row) => ({ value: row.operator_tag, label: row.operator_tag }))),
      customers: uniqueFacet(rows.map((row) => ({ value: row.customer_name, label: row.customer_name }))),
      analysts: uniqueFacet(rows
        .filter((row) => row.assigned_to)
        .map((row) => ({ value: row.assigned_to, label: row.assigned_to_display || row.assigned_to }))),
      states: uniqueFacet(rows
        .filter((row) => row.incident_state)
        .map((row) => ({ value: row.incident_state, label: row.incident_state_display || row.incident_state }))),
      severities: uniqueFacet(rows.map((row) => ({ value: row.severity, label: row.severity }))),
    },
    sla_rules_implemented: SLA_RULES_IMPLEMENTED,
    sla_awaiting_business_rules: true,
    data_source: "postgresql",
    checked_at: new Date(now).toISOString(),
  };
}

export async function fetchOperatorTaggedAlerts({
  pool = getOneViewDbPool(),
  primaryDataSourceName = getPrimaryDataSourceName(),
  alertStatus = "all",
} = {}) {
  const result = await pool.query({
    text: `
      select
        a.id::text as id,
        a.source_event_id::text as source_event_id,
        a.source_problem_id::text as source_problem_id,
        a.client_name,
        a.customer_name,
        a.customer_key,
        a.customer_source,
        a.host_name,
        a.host_visible_name,
        a.host_technical_name,
        a.event_tags,
        a.trigger_tags,
        a.host_tags,
        coalesce(a.problem_name, a.trigger_description) as problem_name,
        a.severity,
        a.status_source,
        a.last_seen_at,
        a.updated_at,
        a.first_seen_at,
        a.resolved_at
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where d.name = $1
        and ${OPERATOR_TAG_EXISTS_SQL}
        and (
          $2 = 'all'
          or ($2 = 'active' and a.resolved_at is null and coalesce(a.status_source, 'active') = 'active')
          or ($2 = 'resolved' and (a.resolved_at is not null or coalesce(a.status_source, '') = 'resolved'))
        )
      order by a.last_seen_at desc nulls last, a.id desc
      limit $3
    `,
    values: [primaryDataSourceName, alertStatus, MAX_ALERT_ROWS],
  });
  return result.rows || [];
}

export async function fetchIncidentsForOperatorAlerts(alerts, { pool = getOneViewDbPool() } = {}) {
  const sysIds = [];
  const numbers = [];
  const eventIds = [];
  const seenSys = new Set();
  const seenNum = new Set();
  const seenEvent = new Set();

  for (const alert of alerts || []) {
    const refs = extractServiceNowRefsFromAlertTags(alert);
    for (const sysId of refs.sysIds || []) {
      const id = String(sysId).toLowerCase();
      if (seenSys.has(id)) continue;
      seenSys.add(id);
      sysIds.push(id);
    }
    for (const number of refs.numbers || []) {
      const value = String(number).toUpperCase();
      if (seenNum.has(value)) continue;
      seenNum.add(value);
      numbers.push(value);
    }
    for (const raw of [alert.source_event_id, alert.source_problem_id]) {
      const eventId = String(raw || "").trim();
      if (!eventId || seenEvent.has(eventId)) continue;
      seenEvent.add(eventId);
      eventIds.push(eventId);
    }
  }

  if (!sysIds.length && !numbers.length && !eventIds.length) return [];

  const result = await pool.query({
    text: `
      select
        sys_id, number, state, priority, assigned_to, assignment_group, caller_id, company,
        contact_type, short_description, description, opened_at, resolved_at, closed_at,
        sys_created_on, sys_updated_on, correlation_id, display_values
      from servicenow_incidents
      where ($1::text[] <> '{}' and lower(sys_id::text) = any($1::text[]))
         or ($2::text[] <> '{}' and upper(number::text) = any($2::text[]))
         or ($3::text[] <> '{}' and correlation_id::text = any($3::text[]))
    `,
    values: [sysIds, numbers, eventIds],
  });
  return (result.rows || []).map((row) => mapReadModelIncident(row));
}

function sendQueueJson(res, status, payload) {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-OneView-Data-Source", payload?.data_source || "postgresql");
  return sendJson(res, status, payload);
}

export function createOperatorQueueHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  listAlerts = fetchOperatorTaggedAlerts,
  listIncidents = fetchIncidentsForOperatorAlerts,
  now = () => Date.now(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function operatorQueueHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    let filters;
    try {
      filters = parseOperatorQueueFilters(req);
    } catch {
      return sendQueueJson(res, 400, { error: "invalid_query", data_source: "postgresql" });
    }

    try {
      const alerts = await listAlerts({ alertStatus: filters.alert_status });
      let incidents = [];
      try {
        incidents = await listIncidents(alerts);
      } catch (error) {
        logger({
          event: "oneview_operator_queue_incidents_unavailable",
          route: "/api/oneview/operator-queue",
          error: "database_unavailable",
          detail: String(error?.message || "database_unavailable").slice(0, 160),
        });
      }
      const payload = buildOperatorQueuePayload(alerts, incidents, filters, now());
      logger({
        event: "oneview_request",
        route: "/api/oneview/operator-queue",
        data_source: "postgresql",
        duration_ms: Math.max(Date.now() - startedAt, 0),
        rows: payload.items.length,
      });
      return sendQueueJson(res, 200, payload);
    } catch (error) {
      logger({
        event: "oneview_operator_queue_error",
        route: "/api/oneview/operator-queue",
        error: "database_unavailable",
        detail: String(error?.message || "database_unavailable").slice(0, 160),
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendQueueJson(res, 503, { error: "database_unavailable", data_source: "postgresql" });
    }
  };
}

export default createOperatorQueueHandler();
