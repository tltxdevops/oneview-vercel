/** Circuit-level links read model: canonical inventory plus operator-tagged alerts. */
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewDbPool } from "./oneview-db.js";
import { extractServiceNowRefsFromAlertTags } from "./oneview-inc-correlation.js";
import { mapReadModelIncident } from "./oneview-incidents-read-model.js";
import { discoverOperatorCircuits, hasExactOperatorEscalation } from "./oneview-operator-circuits.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE = /^[\p{L}\p{N}._:@/| -]{1,240}$/u;
const SEVERITIES = new Set(["information", "warning", "average", "high", "critical", "disaster", "not_classified"]);
const QUEUE_TABS = new Set(["open", "without_incident", "with_incident", "resolved", "all"]);
const RESOLVED_WINDOWS = new Set(["today", "24h", "7d"]);
const QUEUE_SORTS = new Set(["recent", "oldest", "duration", "severity"]);
const OPEN_INCIDENT_STATES = new Set(["1", "2", "3"]);
const RESOLVED_INCIDENT_STATES = new Set(["6"]);
const CLOSED_INCIDENT_STATES = new Set(["7", "8"]);
const activeSql = "a.resolved_at is null and lower(coalesce(a.status_source, 'active')) = 'active' and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')";
const safeJsonArray = (expression) => `case when jsonb_typeof(coalesce(${expression}, '[]'::jsonb)) = 'array' then ${expression} else '[]'::jsonb end`;
const templateTagsSql = `case
  when jsonb_typeof(a.payload_normalized->'template_tags') = 'array' then a.payload_normalized->'template_tags'
  when jsonb_typeof(a.payload_raw->'trigger'->'template_tags') = 'array' then a.payload_raw->'trigger'->'template_tags'
  when jsonb_typeof(a.payload_raw->'trigger'->'tags') = 'array' then a.payload_raw->'trigger'->'tags'
  else '[]'::jsonb end`;
export const EXACT_OPERATOR_TAG_SQL = `exists (
  select 1 from (
    select jsonb_array_elements(${safeJsonArray("a.event_tags")}) as tag
    union all select jsonb_array_elements(${safeJsonArray("a.trigger_tags")})
    union all select jsonb_array_elements(${safeJsonArray("a.host_tags")})
    union all select jsonb_array_elements(${templateTagsSql})
  ) operator_tags
  where lower(btrim(coalesce(operator_tags.tag->>'tag', operator_tags.tag->>'name', ''))) = 'escalation'
    and lower(btrim(coalesce(operator_tags.tag->>'value', ''))) = 'operator'
)`;

function text(value) { const result = String(value || "").trim(); return result || null; }
function oneQuery(req, key) { const value = req?.query?.[key]; return Array.isArray(value) ? value[0] : value; }
function invalidQuery() { const error = new Error("invalid_query"); error.code = "invalid_query"; return error; }
function pageInt(value, fallback, max) { const result = Number.parseInt(String(value || ""), 10); return Number.isFinite(result) ? Math.min(Math.max(result, 1), max) : fallback; }

export function parseLinkFilters(req) {
  const filters = {
    customer: text(oneQuery(req, "customer")), datasource: text(oneQuery(req, "datasource")),
    classification: text(oneQuery(req, "classification")), state: text(oneQuery(req, "state")),
    ack: text(oneQuery(req, "ack")), severity: text(oneQuery(req, "severity")),
    incident: text(oneQuery(req, "incident")), carrier: text(oneQuery(req, "carrier")), search: text(oneQuery(req, "search")),
    tab: text(oneQuery(req, "tab")) || "all", resolved_window: text(oneQuery(req, "resolved_window")) || "today",
    divergence: text(oneQuery(req, "divergence")), sort: text(oneQuery(req, "sort")) || "recent",
    page: pageInt(oneQuery(req, "page"), 1, 10_000), page_size: pageInt(oneQuery(req, "page_size"), 50, 100),
  };
  for (const value of Object.values(filters)) if (typeof value === "string" && !SAFE.test(value)) throw invalidQuery();
  if (filters.severity && !SEVERITIES.has(filters.severity.toLowerCase())) throw invalidQuery();
  if (filters.state && !new Set(["critical", "alert", "attention", "normal"]).has(filters.state.toLowerCase())) throw invalidQuery();
  if (filters.ack && !new Set(["all", "pending", "none"]).has(filters.ack.toLowerCase())) throw invalidQuery();
  if (filters.incident && !new Set(["all", "yes", "no", "open", "without_open"]).has(filters.incident.toLowerCase())) throw invalidQuery();
  if (filters.carrier && !new Set(["all", "unknown"]).has(filters.carrier.toLowerCase())) throw invalidQuery();
  if (!QUEUE_TABS.has(filters.tab.toLowerCase()) || !RESOLVED_WINDOWS.has(filters.resolved_window.toLowerCase()) || !QUEUE_SORTS.has(filters.sort.toLowerCase())) throw invalidQuery();
  if (filters.divergence && !new Set(["a", "b", "any"]).has(filters.divergence.toLowerCase())) throw invalidQuery();
  return filters;
}

function stateFromAlerts(row) {
  if (Number(row.disaster_alerts) > 0) return "critical";
  if (Number(row.high_alerts) > 0 || Number(row.average_alerts) > 0) return "alert";
  if (Number(row.warning_alerts) > 0) return "attention";
  return "normal";
}
function maxSeverity(row) {
  for (const key of ["disaster", "high", "critical", "average", "warning", "information", "not_classified"]) {
    if (Number(row[`${key}_alerts`]) > 0) return key;
  }
  return null;
}
function refsForAlerts(alerts) {
  const sysIds = new Set(), numbers = new Set(), eventIds = new Set();
  for (const alert of alerts) {
    const refs = extractServiceNowRefsFromAlertTags(alert);
    for (const value of refs.sysIds || []) sysIds.add(String(value).toLowerCase());
    for (const value of refs.numbers || []) numbers.add(String(value).toUpperCase());
    for (const value of [alert.source_event_id, alert.source_problem_id]) if (text(value)) eventIds.add(String(value));
  }
  return { sysIds: [...sysIds], numbers: [...numbers], eventIds: [...eventIds] };
}
export async function fetchLinkIncidents(alerts, { pool = getOneViewDbPool() } = {}) {
  const refs = refsForAlerts(alerts);
  if (!refs.sysIds.length && !refs.numbers.length && !refs.eventIds.length) return [];
  const result = await pool.query({ text: `select sys_id, number, state, priority, assigned_to, assignment_group, display_values, correlation_id from servicenow_incidents where ($1::text[] <> '{}' and lower(sys_id::text)=any($1::text[])) or ($2::text[] <> '{}' and upper(number::text)=any($2::text[])) or ($3::text[] <> '{}' and correlation_id::text=any($3::text[]))`, values: [refs.sysIds, refs.numbers, refs.eventIds] });
  return (result.rows || []).map(mapReadModelIncident);
}
export function correlateLinkIncidents(alerts, incidents) {
  const bySys = new Map(), byNumber = new Map(), byEvent = new Map();
  for (const incident of incidents) { if (incident.sys_id) bySys.set(String(incident.sys_id).toLowerCase(), incident); if (incident.number) byNumber.set(String(incident.number).toUpperCase(), incident); if (incident.correlation_id) byEvent.set(String(incident.correlation_id), incident); }
  const found = new Map();
  for (const alert of alerts) {
    const refs = extractServiceNowRefsFromAlertTags(alert); const matches = [];
    for (const id of refs.sysIds || []) if (bySys.has(String(id).toLowerCase())) matches.push(bySys.get(String(id).toLowerCase()));
    for (const number of refs.numbers || []) if (byNumber.has(String(number).toUpperCase())) matches.push(byNumber.get(String(number).toUpperCase()));
    for (const id of [alert.source_event_id, alert.source_problem_id]) if (byEvent.has(String(id))) matches.push(byEvent.get(String(id)));
    found.set(alert.id, [...new Map(matches.filter(Boolean).map((item) => [item.sys_id || item.number, item])).values()]);
  }
  return found;
}

function hostKey(row) {
  return `${text(row?.data_source_id) || ""}:${text(row?.source_host_id) || ""}`;
}

function isActiveAlert(alert) {
  if (typeof alert?.is_active === "boolean") return alert.is_active;
  return !alert?.resolved_at
    && String(alert?.status_source || "active").toLowerCase() === "active"
    && !["resolved", "normalized"].includes(String(alert?.status_internal || "").toLowerCase());
}

function uniqueAlerts(alerts) {
  return [...new Map((alerts || []).filter(Boolean).map((alert) => [String(alert.id), alert])).values()];
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function oldestTimestamp(values) {
  const timestamps = values.map(timestamp).filter((value) => value !== null);
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null;
}

function latestTimestamp(values) {
  const timestamps = values.map(timestamp).filter((value) => value !== null);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

/** ServiceNow state classification for operational queueing. */
export function classifyLinkIncidentState(incident) {
  const state = String(incident?.state || "").trim();
  if (OPEN_INCIDENT_STATES.has(state)) return "open";
  if (RESOLVED_INCIDENT_STATES.has(state)) return "resolved";
  if (CLOSED_INCIDENT_STATES.has(state)) return "closed";
  return "unknown";
}

function alertSummary(alerts) {
  const unique = uniqueAlerts(alerts);
  const active = unique.filter(isActiveAlert);
  const count = (severity) => active.filter((alert) => String(alert.severity || "not_classified").toLowerCase() === severity).length;
  const summary = {
    active_alerts: active.length,
    unack_alerts: active.filter((alert) => !alert.acknowledged_source).length,
    high_alerts: count("high") + count("critical"),
    disaster_alerts: count("disaster"),
    average_alerts: count("average"),
    warning_alerts: count("warning"),
    information_alerts: count("information"),
    not_classified_alerts: count("not_classified"),
  };
  return {
    ...summary,
    state: stateFromAlerts(summary),
    max_severity: maxSeverity(summary),
    active_since_at: oldestTimestamp(active.map((alert) => alert.first_seen_at)),
    latest_activity_at: latestTimestamp(unique.map((alert) => alert.last_seen_at || alert.updated_at || alert.resolved_at)),
    resolved_at: latestTimestamp(unique.filter((alert) => !isActiveAlert(alert)).map((alert) => alert.resolved_at)),
    alerts: active.map((alert) => ({
      id: String(alert.id),
      problem_name: text(alert.problem_name),
      severity: text(alert.severity),
    })),
  };
}

function incidentsForAlerts(alerts, matches) {
  const found = new Map();
  for (const alert of uniqueAlerts(alerts)) {
    for (const incident of matches.get(alert.id) || []) {
      found.set(incident.sys_id || incident.number, incident);
    }
  }
  return [...found.values()];
}

function incidentSummary(incidents) {
  const buckets = { open: [], resolved: [], closed: [], unknown: [] };
  for (const incident of incidents) buckets[classifyLinkIncidentState(incident)].push(incident);
  return {
    open_incident_count: buckets.open.length,
    resolved_incident_count: buckets.resolved.length,
    closed_incident_count: buckets.closed.length,
    unknown_incident_count: buckets.unknown.length,
    open_incidents: buckets.open,
  };
}

function alertsForCircuit(circuit, alerts) {
  const triggerIds = new Set((circuit.trigger_ids || []).map(String));
  return uniqueAlerts(alerts).filter((alert) => {
    if (!triggerIds.has(String(alert.source_trigger_id || ""))) return false;
    return String(alert.data_source_id || "") === String(circuit.data_source_id || "")
      && String(alert.source_host_id || "") === String(circuit.source_host_id || "");
  });
}

function inventoryLink(row, alerts, matches) {
  const related = uniqueAlerts(alerts);
  const incidents = incidentsForAlerts(related, matches);
  const triggerIds = [...new Set(related.map((alert) => text(alert.source_trigger_id)).filter(Boolean))].sort();
  return {
    ...row,
    id: String(row.id),
    circuit_key: null,
    resolution_status: "resolved",
    host_name: text(row.host_name ?? row.source_metadata?.host_name),
    site_key: null,
    site_name: null,
    link_type: text(row.classification),
    member_key: null,
    healthcheck_key: null,
    uplink_key: null,
    endpoint_ip: null,
    strategy: "inventory_host",
    confidence: text(row.classification_confidence),
    carrier_reference: null,
    trigger_ids: triggerIds,
    alert_ids: related.map((alert) => String(alert.id)).sort(),
    ...alertSummary(related),
    incidents,
    incident_count: incidents.length,
    ...incidentSummary(incidents),
  };
}

function circuitLink(circuit, alerts, matches) {
  const related = alertsForCircuit(circuit, alerts);
  const incidents = incidentsForAlerts(related, matches);
  const unresolved = circuit.resolution_status !== "resolved";
  return {
    id: circuit.circuit_key,
    circuit_key: circuit.circuit_key,
    resolution_status: circuit.resolution_status,
    data_source_id: circuit.data_source_id || "",
    datasource: circuit.datasource || "",
    source_host_id: circuit.source_host_id || "",
    host_name: circuit.host_name,
    customer_key: circuit.customer_key || "unclassified",
    customer_name: circuit.customer_name || "Cliente não identificado",
    service_name: circuit.service_name || "Circuito pendente de classificação",
    classification: circuit.link_type || "pending_classification",
    classification_source: circuit.strategy,
    classification_confidence: circuit.confidence,
    carrier_name: circuit.carrier_name,
    carrier_source: circuit.carrier_name ? circuit.strategy : null,
    carrier_reference: circuit.carrier_reference,
    source_metadata: {
      circuit_evidence: circuit.evidence,
      evidence_conflicts: circuit.evidence_conflicts || [],
      candidate_keys: circuit.candidate_keys || [],
      unresolved_reason: circuit.unresolved_reason,
    },
    updated_at: circuit.updated_at,
    site_key: circuit.site_key,
    site_name: circuit.site_name,
    link_type: unresolved ? null : circuit.link_type,
    member_key: circuit.member_key,
    healthcheck_key: circuit.healthcheck_key,
    uplink_key: circuit.uplink_key,
    endpoint_ip: circuit.endpoint_ip,
    strategy: circuit.strategy,
    confidence: circuit.confidence,
    trigger_ids: circuit.trigger_ids,
    alert_ids: related.map((alert) => String(alert.id)).sort(),
    ...alertSummary(related),
    incidents,
    incident_count: incidents.length,
    ...incidentSummary(incidents),
  };
}

export function composeCircuitLevelLinks({ inventoryRows = [], alertRows = [], incidents = [] } = {}) {
  const alerts = uniqueAlerts(alertRows);
  const matches = correlateLinkIncidents(alerts, incidents);
  const circuits = discoverOperatorCircuits(alerts);
  const resolvedHosts = new Set(circuits
    .filter((circuit) => circuit.resolution_status === "resolved")
    .map(hostKey));
  const alertsByHost = new Map();
  for (const alert of alerts) {
    const key = hostKey(alert);
    const current = alertsByHost.get(key) || [];
    current.push(alert);
    alertsByHost.set(key, current);
  }
  const legacy = inventoryRows
    .filter((row) => !resolvedHosts.has(hostKey(row)))
    .map((row) => inventoryLink(row, alertsByHost.get(hostKey(row)) || [], matches));
  const derived = circuits.map((circuit) => circuitLink(circuit, alerts, matches));
  return [...legacy, ...derived].sort((a, b) => (
    String(a.customer_name || "").localeCompare(String(b.customer_name || ""), "pt-BR")
    || String(a.service_name || "").localeCompare(String(b.service_name || ""), "pt-BR")
    || String(a.id).localeCompare(String(b.id), "pt-BR")
  ));
}

function filteredBase(rows, filters) {
  return rows.filter((row) => {
    if (filters.customer && row.customer_key !== filters.customer && row.customer_name !== filters.customer) return false;
    if (filters.datasource && row.datasource !== filters.datasource) return false;
    if (filters.classification && row.classification !== filters.classification) return false;
    if (filters.state && row.state !== filters.state) return false;
    if (filters.ack === "pending" && !row.unack_alerts) return false;
    if (filters.ack === "none" && row.unack_alerts) return false;
    if (filters.severity && row.max_severity !== filters.severity) return false;
    if (filters.incident === "yes" && !row.incident_count) return false;
    if (filters.incident === "no" && row.incident_count) return false;
    if (filters.incident === "open" && !row.open_incident_count) return false;
    if (filters.incident === "without_open" && row.open_incident_count) return false;
    if (filters.carrier === "unknown" && row.carrier_name) return false;
    if (filters.search) { const needle = filters.search.toLowerCase(); if (![row.service_name, row.customer_name, row.source_host_id, row.host_name, row.site_name, row.link_type, row.carrier_name, row.circuit_key].some((value) => String(value || "").toLowerCase().includes(needle))) return false; }
    return true;
  });
}

function resolvedWindowStart(window, now) {
  if (window === "24h") return now - (24 * 60 * 60 * 1000);
  if (window === "7d") return now - (7 * 24 * 60 * 60 * 1000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const values = Object.fromEntries(date.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00-03:00`);
}

function operationalRow(row, now, resolvedWindow) {
  const incidents = row.incidents || [];
  const counts = incidentSummary(incidents);
  const active = Number(row.active_alerts || 0) > 0;
  const lastActivity = timestamp(row.latest_activity_at || row.resolved_at || row.updated_at);
  const resolvedRecent = !active && lastActivity !== null && lastActivity >= resolvedWindow;
  const divergence_type = active && row.incident_count > 0 && !counts.open_incident_count
    ? "a"
    : !active && counts.open_incident_count ? "b" : null;
  return {
    ...row,
    ...counts,
    has_active_alert: active,
    resolved_recent: resolvedRecent,
    divergence_type,
  };
}

function filteredOperational(rows, filters) {
  return rows.filter((row) => {
    if (filters.divergence === "any" && !row.divergence_type) return false;
    if (filters.divergence && filters.divergence !== "any" && row.divergence_type !== filters.divergence) return false;
    if (filters.tab === "open") return row.has_active_alert;
    if (filters.tab === "without_incident") return row.has_active_alert && !row.open_incident_count;
    if (filters.tab === "with_incident") return row.has_active_alert && row.open_incident_count > 0;
    if (filters.tab === "resolved") return row.resolved_recent;
    return true;
  });
}

function severityRank(value) {
  return ["disaster", "critical", "high", "average", "warning", "information", "not_classified"].indexOf(String(value || ""));
}

function ordered(rows, filters) {
  return [...rows].sort((a, b) => {
    const activityA = timestamp(a.latest_activity_at || a.updated_at) || 0;
    const activityB = timestamp(b.latest_activity_at || b.updated_at) || 0;
    const startedA = timestamp(a.active_since_at) || Number.MAX_SAFE_INTEGER;
    const startedB = timestamp(b.active_since_at) || Number.MAX_SAFE_INTEGER;
    if (filters.sort === "oldest") return activityA - activityB || String(a.id).localeCompare(String(b.id));
    if (filters.sort === "duration") return startedA - startedB || activityB - activityA;
    if (filters.sort === "severity") return severityRank(a.max_severity) - severityRank(b.max_severity) || activityB - activityA;
    return activityB - activityA || String(a.id).localeCompare(String(b.id));
  });
}
export async function fetchCanonicalLinks({ pool = getOneViewDbPool() } = {}) {
  const inventoryResult = await pool.query(`select l.id::text, l.data_source_id::text, l.source_host_id::text, l.customer_key, l.customer_name, l.service_name, l.classification, l.classification_source, l.classification_confidence, l.carrier_name, l.carrier_source, l.source_metadata, l.updated_at, d.name as datasource from zabbix_link_inventory l join data_sources d on d.id::text=l.data_source_id::text order by l.customer_name, l.service_name`);
  const alertsResult = await pool.query(`select a.id::text, a.data_source_id::text, a.source_host_id::text, a.source_trigger_id::text, a.source_event_id::text, a.source_problem_id::text, a.client_name, a.customer_name, a.customer_key, a.host_name, a.service_name, a.item_key, a.item_name, a.trigger_description, a.problem_name, a.event_tags, a.trigger_tags, a.host_tags, ${templateTagsSql} as template_tags, a.severity, a.status_source, a.status_internal, a.acknowledged_source, a.first_seen_at, a.resolved_at, a.last_seen_at, a.updated_at, d.name as datasource, (${activeSql}) as is_active from alerts a join data_sources d on d.id::text=a.data_source_id::text where exists (select 1 from zabbix_link_inventory l where l.data_source_id::text=a.data_source_id::text and l.source_host_id::text=a.source_host_id::text) or ${EXACT_OPERATOR_TAG_SQL}`);
  const alerts = alertsResult.rows || [];
  const incidents = await fetchLinkIncidents(alerts, { pool });
  return composeCircuitLevelLinks({ inventoryRows: inventoryResult.rows || [], alertRows: alerts, incidents });
}
export function buildLinksPayload(rows, filters, now = Date.now()) {
  const resolvedWindow = resolvedWindowStart(filters.resolved_window, now);
  const all = rows.map((row) => operationalRow(row, now, resolvedWindow));
  const base = filteredBase(all, filters);
  const scoped = ordered(filteredOperational(base, filters), filters); const start=(filters.page-1)*filters.page_size;
  const facets = (field) => [...new Map(all.map((row) => [String(row[field] || ""), row[field]]).filter(([value]) => value)).entries()].map(([value,label])=>({value,label})).sort((a,b)=>String(a.label).localeCompare(String(b.label),"pt-BR"));
  const operational = {
    open: base.filter((row) => row.has_active_alert).length,
    without_open_incident: base.filter((row) => row.has_active_alert && !row.open_incident_count).length,
    with_open_incident: base.filter((row) => row.has_active_alert && row.open_incident_count > 0).length,
    divergences: base.filter((row) => row.divergence_type).length,
    divergence_a: base.filter((row) => row.divergence_type === "a").length,
    divergence_b: base.filter((row) => row.divergence_type === "b").length,
    resolved_today: base.filter((row) => !row.has_active_alert && (timestamp(row.latest_activity_at || row.resolved_at || row.updated_at) || 0) >= resolvedWindowStart("today", now)).length,
  };
  return { items: scoped.slice(start,start+filters.page_size), pagination:{page:filters.page,page_size:filters.page_size,total_items:scoped.length,total_pages:Math.ceil(scoped.length/filters.page_size),has_next:start+filters.page_size<scoped.length,has_previous:filters.page>1}, totals:{links:base.length,active_alert_links:base.filter(x=>x.active_alerts>0).length,incident_links:base.filter(x=>x.incident_count>0).length,known_carriers:base.filter(x=>x.carrier_name).length,pending_classification:base.filter(x=>x.resolution_status!=="resolved").length,operational}, facets:{customers:facets("customer_name"),datasources:facets("datasource"),classifications:facets("classification")}, filters, data_source:"database", fallback_code:null, checked_at:new Date(now).toISOString() };
}
export function createLinksHandler({ authorize=(req,res)=>requireOneViewAuth(req,res,"viewer"), list=fetchCanonicalLinks, now=()=>Date.now() }={}) { return async (req,res) => { res.setHeader("Cache-Control",NO_CACHE); res.setHeader("X-Content-Type-Options","nosniff"); if(req.method!=="GET") return methodNotAllowed(res,["GET"]); if(!await authorize(req,res)) return; try { const filters=parseLinkFilters(req); const payload=buildLinksPayload(await list(),filters,now()); res.setHeader("X-OneView-Data-Source","database"); return sendJson(res,200,payload); } catch (error) { return sendJson(res,error?.code==="invalid_query"?400:503,{error:error?.code==="invalid_query"?"invalid_query":"database_unavailable",data_source:"database"}); } }; }
export default createLinksHandler();
