/** Circuit-level links read model: canonical inventory plus operator-tagged alerts. */
import { getId, methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewDbPool } from "./oneview-db.js";
import { extractServiceNowRefsFromAlertTags } from "./oneview-inc-correlation.js";
import { mapReadModelIncident } from "./oneview-incidents-read-model.js";
import { discoverOperatorCircuits } from "./oneview-operator-circuits.js";
import { attachOperationalRecurrence, OPERATIONAL_RECENT_DETAIL_LIMIT, OPERATIONAL_RECENT_PREVIEW_LIMIT } from "./oneview-operational-recurrence.js";
import { buildOperationalSubject } from "./oneview-operational-subject.js";
import { mergeRankedSuggestions, matchRank } from "./oneview-search-suggest-rank.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE = /^[\p{L}\p{N}._:@/| -]{1,240}$/u;
const SEVERITIES = new Set(["information", "warning", "average", "high", "critical", "disaster", "not_classified"]);
const QUEUE_TABS = new Set(["open", "normalized", "all", "without_incident", "with_incident", "resolved"]);
const RESOLVED_WINDOWS = new Set(["today", "24h", "7d"]);
const QUEUE_SORTS = new Set(["recent", "oldest", "duration", "severity"]);
const OPEN_INCIDENT_STATES = new Set(["1", "2", "3"]);
const RESOLVED_INCIDENT_STATES = new Set(["6"]);
const CLOSED_INCIDENT_STATES = new Set(["7"]);
const CANCELLED_INCIDENT_STATES = new Set(["8"]);
const INCIDENT_FILTERS = new Set(["all", "yes", "no", "open", "without_open", "resolved", "closed", "cancelled"]);
const INCIDENT_STATES = new Set(["1", "2", "3", "6", "7", "8"]);
const OPERATIONAL_SITUATIONS = new Set(["failure_without_incident", "failure_with_open_incident", "failure_with_closed_incident", "normalized_with_open_incident", "normalized_without_open_incident"]);
const ACTIVITY_PERIODS = new Set(["all", "1h", "4h", "24h", "7d"]);
const activeSql = "a.resolved_at is null and lower(coalesce(a.status_source, 'active')) = 'active' and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')";
const safeJsonArray = (expression) => `case when jsonb_typeof(coalesce(${expression}, '[]'::jsonb)) = 'array' then ${expression} else '[]'::jsonb end`;
const templateTagsSql = `case
  when jsonb_typeof(a.payload_normalized->'template_tags') = 'array' then a.payload_normalized->'template_tags'
  when jsonb_typeof(a.payload_raw->'trigger'->'template_tags') = 'array' then a.payload_raw->'trigger'->'template_tags'
  when jsonb_typeof(a.payload_raw->'trigger'->'tags') = 'array' then a.payload_raw->'trigger'->'tags'
  else '[]'::jsonb end`;
function operatorTagExistsSql({ includeTemplateTags = true } = {}) {
  const bags = [
    `select jsonb_array_elements(${safeJsonArray("a.event_tags")}) as tag`,
    `select jsonb_array_elements(${safeJsonArray("a.trigger_tags")})`,
    `select jsonb_array_elements(${safeJsonArray("a.host_tags")})`,
  ];
  if (includeTemplateTags) bags.push(`select jsonb_array_elements(${templateTagsSql})`);
  return `exists (
  select 1 from (
    ${bags.join("\n    union all ")}
  ) operator_tags
  where lower(btrim(coalesce(operator_tags.tag->>'tag', operator_tags.tag->>'name', ''))) = 'escalation'
    and lower(btrim(coalesce(operator_tags.tag->>'value', ''))) = 'operator'
)`;
}

/** Full eligibility (includes payload-derived template_tags). Kept for detail/compat. */
export const EXACT_OPERATOR_TAG_SQL = operatorTagExistsSql({ includeTemplateTags: true });

/**
 * List-path operator filter avoids payload_raw/payload_normalized. On current prod data,
 * escalation=operator lives in event/trigger/host tags for inventory-relevant alerts.
 */
const LIST_OPERATOR_TAG_SQL = operatorTagExistsSql({ includeTemplateTags: false });

/** Keep older alerts that still carry explicit ServiceNow refs (open INC / divergence B). */
const SERVICENOW_TAG_EXISTS_SQL = `(
  coalesce(a.event_tags::text, '') ilike '%__zbx_servicenow_sys_id%'
  or coalesce(a.event_tags::text, '') ilike '%__zbx_servicenow_number%'
  or coalesce(a.trigger_tags::text, '') ilike '%__zbx_servicenow_sys_id%'
  or coalesce(a.trigger_tags::text, '') ilike '%__zbx_servicenow_number%'
)`;

/** Operational queue needs active + resolved_window(7d); SN residuals are queried separately. */

function text(value) { const result = String(value || "").trim(); return result || null; }
function elapsedMs(startedAt) { return Math.max(0, Date.now() - startedAt); }
function logLinksTiming(payload) { console.info(JSON.stringify({ event: "oneview_links_timing", ...payload })); }
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
    divergence: text(oneQuery(req, "divergence")), recurrence: text(oneQuery(req, "recurrence")),
    incident_state: text(oneQuery(req, "incident_state")), operational_situation: text(oneQuery(req, "operational_situation")),
    activity_period: text(oneQuery(req, "activity_period")), sort: text(oneQuery(req, "sort")) || "recent",
    page: pageInt(oneQuery(req, "page"), 1, 10_000), page_size: pageInt(oneQuery(req, "page_size"), 50, 100),
  };
  for (const value of Object.values(filters)) if (typeof value === "string" && !SAFE.test(value)) throw invalidQuery();
  if (filters.severity && !SEVERITIES.has(filters.severity.toLowerCase())) throw invalidQuery();
  if (filters.state && !new Set(["critical", "alert", "attention", "normal"]).has(filters.state.toLowerCase())) throw invalidQuery();
  if (filters.ack && !new Set(["all", "pending", "none"]).has(filters.ack.toLowerCase())) throw invalidQuery();
  if (filters.incident && !INCIDENT_FILTERS.has(filters.incident.toLowerCase())) throw invalidQuery();
  if (filters.carrier && !new Set(["all", "unknown"]).has(filters.carrier.toLowerCase())) throw invalidQuery();
  if (!QUEUE_TABS.has(filters.tab.toLowerCase()) || !RESOLVED_WINDOWS.has(filters.resolved_window.toLowerCase()) || !QUEUE_SORTS.has(filters.sort.toLowerCase())) throw invalidQuery();
  if (filters.divergence && !new Set(["a", "b", "any"]).has(filters.divergence.toLowerCase())) throw invalidQuery();
  if (filters.recurrence && !new Set(["all", "recurrent"]).has(filters.recurrence.toLowerCase())) throw invalidQuery();
  if (filters.incident_state && !INCIDENT_STATES.has(filters.incident_state)) throw invalidQuery();
  if (filters.operational_situation && !OPERATIONAL_SITUATIONS.has(filters.operational_situation.toLowerCase())) throw invalidQuery();
  if (filters.activity_period && !ACTIVITY_PERIODS.has(filters.activity_period.toLowerCase())) throw invalidQuery();
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
  const result = await pool.query({ text: `select sys_id, number, state, priority, assigned_to, assignment_group, short_description, opened_at, resolved_at, closed_at, sys_updated_on, display_values, correlation_id from servicenow_incidents where ($1::text[] <> '{}' and lower(sys_id::text)=any($1::text[])) or ($2::text[] <> '{}' and upper(number::text)=any($2::text[])) or ($3::text[] <> '{}' and correlation_id::text=any($3::text[]))`, values: [refs.sysIds, refs.numbers, refs.eventIds] });
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

function valueTimestamp(value) { return timestamp(value) || 0; }
function alertSortValue(alert) { return valueTimestamp(alert.last_seen_at || alert.updated_at || alert.first_seen_at); }
function incidentSortValue(incident) { return valueTimestamp(incident?.updatedAt || incident?.sys_updated_on || incident?.resolvedAt || incident?.closedAt || incident?.openedAt); }
function severityValue(value) { const rank = ["disaster", "critical", "high", "average", "warning", "information", "not_classified"].indexOf(String(value || "")); return rank < 0 ? 99 : rank; }
function alertRecord(alert) {
  if (!alert) return null;
  return { id: String(alert.id), data_source_id: text(alert.data_source_id), source_host_id: text(alert.source_host_id), source_trigger_id: text(alert.source_trigger_id), problem_name: text(alert.problem_name), trigger_description: text(alert.trigger_description), severity: text(alert.severity), started_at: text(alert.first_seen_at), last_seen_at: text(alert.last_seen_at || alert.updated_at) };
}
function incidentRecord(incident) {
  if (!incident) return null;
  return { sys_id: incident.sys_id || null, number: incident.number || null, state: incident.state || null, state_display: incident.state_display || null, opened_at: incident.openedAt || incident.opened_at || null, updated_at: incident.updatedAt || incident.sys_updated_on || null, assignment_group: incident.assignment_group || null, assignment_group_display: incident.assignment_group_display || null, assigned_to: incident.assigned_to || null, assigned_to_display: incident.assigned_to_display || null, short_description: incident.short_description || incident.shortDescription || null, servicenow_url: incident.servicenow_url || null };
}

/** ServiceNow state classification for operational queueing. */
export function classifyLinkIncidentState(incident) {
  const state = String(incident?.state || "").trim();
  if (OPEN_INCIDENT_STATES.has(state)) return "open";
  if (RESOLVED_INCIDENT_STATES.has(state)) return "resolved";
  if (CANCELLED_INCIDENT_STATES.has(state)) return "cancelled";
  if (CLOSED_INCIDENT_STATES.has(state)) return "closed";
  return "unknown";
}

function servicenowState(row) {
  if (row.incident_correlation_status === "degraded") return "degraded";
  if (!row.incident_count) return "none";
  if (Number(row.open_incident_count || 0) > 0) return "open";
  return classifyLinkIncidentState(row.latest_incident || row.current_incident);
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
    current_alert: alertRecord([...active].sort((a, b) => severityValue(a.severity) - severityValue(b.severity) || alertSortValue(b) - alertSortValue(a) || String(a.id).localeCompare(String(b.id)))[0]),
    latest_alert: alertRecord([...unique].sort((a, b) => alertSortValue(b) - alertSortValue(a) || String(a.id).localeCompare(String(b.id)))[0]),
    alerts: active.map(alertRecord),
  };
}

function pendingClassificationLabel(value) {
  return /pendente de classifica/i.test(String(value || ""));
}

function alertDisplayName(alerts, hostName) {
  const summary = alertSummary(alerts);
  const current = summary.current_alert || summary.latest_alert;
  return text(current?.problem_name || current?.trigger_description || hostName) || "Link sem identificação";
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
  const buckets = { open: [], resolved: [], closed: [], cancelled: [], unknown: [] };
  for (const incident of incidents) buckets[classifyLinkIncidentState(incident)].push(incident);
  const orderedOpen = [...buckets.open].sort((a, b) => incidentSortValue(b) - incidentSortValue(a) || valueTimestamp(b.openedAt || b.opened_at) - valueTimestamp(a.openedAt || a.opened_at) || String(a.sys_id || a.number).localeCompare(String(b.sys_id || b.number)));
  const orderedAll = [...incidents].sort((a, b) => incidentSortValue(b) - incidentSortValue(a) || String(a.sys_id || a.number).localeCompare(String(b.sys_id || b.number)));
  return {
    open_incident_count: buckets.open.length,
    resolved_incident_count: buckets.resolved.length,
    closed_incident_count: buckets.closed.length,
    cancelled_incident_count: buckets.cancelled.length,
    unknown_incident_count: buckets.unknown.length,
    open_incidents: buckets.open,
    current_incident: incidentRecord(orderedOpen[0]),
    latest_incident: incidentRecord(orderedAll[0]),
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

function circuitTriggerKey(row, triggerId = row?.source_trigger_id) {
  return `${hostKey(row)}:${String(triggerId || "")}`;
}

function indexAlertsByCircuitTrigger(alerts) {
  const index = new Map();
  for (const alert of uniqueAlerts(alerts)) {
    const key = circuitTriggerKey(alert);
    const current = index.get(key) || [];
    current.push(alert);
    index.set(key, current);
  }
  return index;
}

function indexedAlertsForCircuit(circuit, index) {
  const found = [];
  for (const triggerId of circuit.trigger_ids || []) {
    found.push(...(index.get(circuitTriggerKey(circuit, triggerId)) || []));
  }
  return uniqueAlerts(found);
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
    incident_correlation_status: "available",
    ...incidentSummary(incidents),
  };
}

function circuitLink(circuit, alerts, matches, alertIndex = null) {
  const related = alertIndex ? indexedAlertsForCircuit(circuit, alertIndex) : alertsForCircuit(circuit, alerts);
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
    service_name: pendingClassificationLabel(circuit.service_name)
      ? alertDisplayName(related, circuit.host_name)
      : (circuit.service_name || alertDisplayName(related, circuit.host_name)),
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
    incident_correlation_status: "available",
    ...incidentSummary(incidents),
  };
}

function alertsForOperationalMerge(row) {
  return uniqueAlerts([...(row.alerts || []), row.current_alert, row.latest_alert]);
}

function mergeLinkOperationalState(target, source) {
  const combinedAlertIds = [...new Set([...(target.alert_ids || []), ...(source.alert_ids || [])])].sort();
  const combinedTriggerIds = [...new Set([...(target.trigger_ids || []), ...(source.trigger_ids || [])])].map(String).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const combinedAlerts = uniqueAlerts([...alertsForOperationalMerge(target), ...alertsForOperationalMerge(source)]);
  const combinedIncidents = [...new Map([...(target.incidents || []), ...(source.incidents || [])].map((incident) => [incident.sys_id || incident.number, incident])).values()];
  if (combinedAlerts.length) Object.assign(target, alertSummary(combinedAlerts));
  target.alert_ids = combinedAlertIds;
  target.trigger_ids = combinedTriggerIds;
  target.incidents = combinedIncidents;
  target.incident_count = combinedIncidents.length;
  Object.assign(target, incidentSummary(combinedIncidents));
  return target;
}

function usableCircuitTriggerKeys(row) {
  return [...new Set((row.trigger_ids || []).map((triggerId) => String(triggerId || "").trim()).filter(Boolean).map((triggerId) => circuitTriggerKey(row, triggerId)))];
}

function indexCircuitOwners(rows, ownerByTrigger) {
  for (const row of rows) {
    for (const key of usableCircuitTriggerKeys(row)) {
      if (!ownerByTrigger.has(key)) ownerByTrigger.set(key, row);
    }
  }
}

function absorbOwnedRows(candidates, ownerByTrigger, kept) {
  for (const row of candidates) {
    const usableKeys = usableCircuitTriggerKeys(row);
    if (!usableKeys.length) {
      kept.push(row);
      continue;
    }
    const owners = [];
    const seen = new Set();
    let fullyOwned = true;
    for (const key of usableKeys) {
      const owner = ownerByTrigger.get(key);
      if (!owner) {
        fullyOwned = false;
        break;
      }
      if (!seen.has(owner.id)) {
        seen.add(owner.id);
        owners.push(owner);
      }
    }
    if (fullyOwned && owners.length === 1 && owners[0] !== row) {
      mergeLinkOperationalState(owners[0], row);
      continue;
    }
    kept.push(row);
  }
}

function collapseEquivalentOperationalRows(rows) {
  const resolvedCircuits = [];
  const pendingCircuits = [];
  const inventoryRows = [];
  for (const row of rows) {
    if (row.circuit_key && row.resolution_status === "resolved") resolvedCircuits.push(row);
    else if (row.circuit_key) pendingCircuits.push(row);
    else inventoryRows.push(row);
  }
  const ownerByTrigger = new Map();
  indexCircuitOwners(resolvedCircuits, ownerByTrigger);
  const kept = [...resolvedCircuits];
  absorbOwnedRows(pendingCircuits, ownerByTrigger, kept);
  indexCircuitOwners(kept, ownerByTrigger);
  absorbOwnedRows(inventoryRows, ownerByTrigger, kept);
  return kept;
}

export function composeCircuitLevelLinks({ inventoryRows = [], alertRows = [], incidents = [], circuits: providedCircuits = null, incidentMatches = null } = {}) {
  const alerts = uniqueAlerts(alertRows);
  const matches = incidentMatches || correlateLinkIncidents(alerts, incidents);
  const circuits = providedCircuits || discoverOperatorCircuits(alerts);
  const alertIndex = indexAlertsByCircuitTrigger(alerts);
  const alertsByHost = new Map();
  for (const alert of alerts) {
    const key = hostKey(alert);
    const current = alertsByHost.get(key) || [];
    current.push(alert);
    alertsByHost.set(key, current);
  }
  const derived = circuits.map((circuit) => circuitLink(circuit, alerts, matches, alertIndex));
  const ownedTriggers = new Set();
  for (const row of derived) {
    for (const triggerId of row.trigger_ids || []) ownedTriggers.add(circuitTriggerKey(row, triggerId));
  }
  const circuitHosts = new Set(derived.map(hostKey));
  const legacy = [];
  for (const row of inventoryRows) {
    const hostAlerts = alertsByHost.get(hostKey(row)) || [];
    const uncovered = hostAlerts.filter((alert) => !ownedTriggers.has(circuitTriggerKey(alert)));
    if (uncovered.length === 0 && circuitHosts.has(hostKey(row))) continue;
    legacy.push(inventoryLink(row, uncovered.length ? uncovered : hostAlerts, matches));
  }
  return collapseEquivalentOperationalRows([...legacy, ...derived]).sort((a, b) => (
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
    if (filters.incident && filters.incident !== "all" && row.incident_correlation_status === "degraded") return false;
    if (filters.incident === "yes" && !row.incident_count) return false;
    if (filters.incident === "no" && row.incident_count) return false;
    if (filters.incident === "open" && !row.open_incident_count) return false;
    if (filters.incident === "without_open" && row.open_incident_count) return false;
    if (filters.incident === "resolved" && servicenowState(row) !== "resolved") return false;
    if (filters.incident === "closed" && servicenowState(row) !== "closed") return false;
    if (filters.incident === "cancelled" && servicenowState(row) !== "cancelled") return false;
    if (filters.incident_state && String((row.current_incident || row.latest_incident)?.state || "") !== filters.incident_state) return false;
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
  const incidentAvailable = row.incident_correlation_status !== "degraded";
  const incidents = row.incidents || [];
  const counts = row.open_incident_count !== undefined
    ? {
      open_incident_count: row.open_incident_count,
      resolved_incident_count: row.resolved_incident_count,
      closed_incident_count: row.closed_incident_count,
      cancelled_incident_count: row.cancelled_incident_count,
      unknown_incident_count: row.unknown_incident_count,
    }
    : incidentSummary(incidents);
  const active = Number(row.active_alerts || 0) > 0;
  const lastActivity = timestamp(row.latest_activity_at || row.resolved_at || row.updated_at);
  const resolvedRecent = !active && lastActivity !== null && lastActivity >= resolvedWindow;
  const incidentState = incidentAvailable ? servicenowState({ ...row, ...counts }) : "degraded";
  const terminalIncident = ["resolved", "closed", "cancelled"].includes(incidentState);
  const divergence_type = incidentAvailable && active && terminalIncident
    ? "a"
    : incidentAvailable && !active && counts.open_incident_count ? "b" : null;
  const next = {
    ...row,
    ...(incidentAvailable ? counts : { open_incident_count: null, resolved_incident_count: null, closed_incident_count: null, cancelled_incident_count: null, unknown_incident_count: null }),
    has_active_alert: active,
    monitoring_state: active ? "down" : "normalized",
    resolved_recent: resolvedRecent,
    divergence_type,
  };
  next.servicenow_state = incidentState;
  next.last_operational_activity_at = latestTimestamp([
    row.latest_alert_at, row.latest_activity_at, row.last_failure_at, row.last_recovery_at, row.updated_at,
    row.current_incident?.updated_at, row.current_incident?.opened_at,
    row.latest_incident?.updated_at, row.latest_incident?.resolved_at, row.latest_incident?.closed_at, row.latest_incident?.opened_at,
  ]);
  next.operational_situation = !incidentAvailable
    ? null
    : active
      ? !row.incident_count
        ? "failure_without_incident"
        : counts.open_incident_count > 0
          ? "failure_with_open_incident"
          : terminalIncident ? "failure_with_closed_incident" : null
      : counts.open_incident_count > 0
        ? "normalized_with_open_incident"
        : !row.incident_count || terminalIncident ? "normalized_without_open_incident" : null;
  return next;
}

function activityPeriodStart(period, now) {
  if (period === "1h") return now - (60 * 60 * 1000);
  if (period === "4h") return now - (4 * 60 * 60 * 1000);
  if (period === "24h") return now - (24 * 60 * 60 * 1000);
  if (period === "7d") return now - (7 * 24 * 60 * 60 * 1000);
  return null;
}

function filteredOperational(rows, filters, now) {
  return rows.filter((row) => {
    if (filters.recurrence === "recurrent" && !row.is_recurrent) return false;
    if (filters.divergence === "any" && !row.divergence_type) return false;
    if (filters.divergence && filters.divergence !== "any" && row.divergence_type !== filters.divergence) return false;
    if (filters.operational_situation && row.operational_situation !== filters.operational_situation) return false;
    const activityStart = activityPeriodStart(filters.activity_period, now);
    if (activityStart !== null && (timestamp(row.last_operational_activity_at) || 0) < activityStart) return false;
    if (filters.tab === "open") return row.has_active_alert;
    if (filters.tab === "normalized") return !row.has_active_alert;
    if (filters.tab === "without_incident") return row.has_active_alert && row.incident_correlation_status !== "degraded" && !row.open_incident_count;
    if (filters.tab === "with_incident") return row.has_active_alert && row.incident_correlation_status !== "degraded" && row.open_incident_count > 0;
    if (filters.tab === "resolved") return row.resolved_recent;
    return true;
  });
}

function severityRank(value) {
  return ["disaster", "critical", "high", "average", "warning", "information", "not_classified"].indexOf(String(value || ""));
}

function ordered(rows, filters) {
  return [...rows].sort((a, b) => {
    const activityA = timestamp(a.latest_alert_at || a.latest_activity_at || a.updated_at) || 0;
    const activityB = timestamp(b.latest_alert_at || b.latest_activity_at || b.updated_at) || 0;
    const startedA = timestamp(a.active_since_at) || Number.MAX_SAFE_INTEGER;
    const startedB = timestamp(b.active_since_at) || Number.MAX_SAFE_INTEGER;
    if (filters.sort === "oldest") return activityA - activityB || String(a.id).localeCompare(String(b.id));
    if (filters.sort === "duration") return startedA - startedB || activityB - activityA;
    if (filters.sort === "severity") return severityRank(a.max_severity) - severityRank(b.max_severity) || activityB - activityA;
    return activityB - activityA || String(a.id).localeCompare(String(b.id));
  });
}
const INVENTORY_SELECT = "select l.id::text, l.data_source_id::text, l.source_host_id::text, l.customer_key, l.customer_name, l.service_name, l.classification, l.classification_source, l.classification_confidence, l.carrier_name, l.carrier_source, l.source_metadata, l.updated_at, d.name as datasource from zabbix_link_inventory l join data_sources d on d.id=l.data_source_id";
/** Shared alert identity/tags for circuit discovery + SN correlation. No raw_payload blob. */
const ALERTS_CORE_PROJECTION = `a.id::text, a.data_source_id::text, a.source_host_id::text, a.source_trigger_id::text, a.source_event_id::text, a.source_problem_id::text, a.customer_name, a.customer_key, a.host_name, a.service_name, a.item_key, a.item_name, a.trigger_description, a.problem_name, a.event_tags, a.trigger_tags, a.host_tags, a.severity, a.status_source, a.status_internal, a.acknowledged_source, a.first_seen_at, a.resolved_at, a.last_seen_at, a.updated_at, d.name as datasource, (${activeSql}) as is_active`;
/** Detail keeps payload-derived template_tags for full escalation eligibility. */
const ALERTS_DETAIL_PROJECTION = `${ALERTS_CORE_PROJECTION}, ${templateTagsSql} as template_tags`;
/**
 * List skips payload_raw/payload_normalized. Template tags are rare for escalation=operator
 * once event/trigger/host bags are present; empty array preserves contract shape.
 */
const ALERTS_LIST_PROJECTION = `${ALERTS_CORE_PROJECTION}, '[]'::jsonb as template_tags`;
const ALERTS_FROM = "alerts a join data_sources d on d.id=a.data_source_id";
const ALERTS_LIST_SELECT = `select ${ALERTS_LIST_PROJECTION} from ${ALERTS_FROM}`;
const ALERTS_DETAIL_SELECT = `select ${ALERTS_DETAIL_PROJECTION} from ${ALERTS_FROM}`;

function markIncidentDegraded(rows) {
  for (const row of rows) {
    row.incident_correlation_status = "degraded";
    row.incident_count = null;
    row.open_incident_count = null;
    row.resolved_incident_count = null;
    row.closed_incident_count = null;
    row.cancelled_incident_count = null;
    row.unknown_incident_count = null;
    row.current_incident = null;
    row.latest_incident = null;
  }
}

async function fetchCanonicalLinkModel({ pool, dataSourceId = null, sourceHostId = null, includeIncidents = true } = {}) {
  const startedAt = Date.now(); const timings = {};
  const scoped = Boolean(dataSourceId && sourceHostId);
  const timedQuery = async (query) => {
    const queryStartedAt = Date.now();
    const result = await pool.query(query);
    return { result, elapsed_ms: elapsedMs(queryStartedAt) };
  };
  const listScopeSql = `(
    exists (select 1 from zabbix_link_inventory l where l.data_source_id=a.data_source_id and l.source_host_id=a.source_host_id)
    or ${LIST_OPERATOR_TAG_SQL}
  )`;
  const recentWindowSql = `((${activeSql})
    or a.resolved_at >= now() - interval '7 days'
    or coalesce(a.last_seen_at, a.updated_at, a.first_seen_at) >= now() - interval '7 days')`;
  const [inventoryQuery, recentAlertsQuery, residualAlertsQuery] = scoped
    ? await Promise.all([
      timedQuery({ text: `${INVENTORY_SELECT} where l.data_source_id=$1 and l.source_host_id=$2 order by l.customer_name, l.service_name`, values: [dataSourceId, sourceHostId] }),
      timedQuery({ text: `${ALERTS_DETAIL_SELECT} where a.data_source_id=$1 and a.source_host_id=$2`, values: [dataSourceId, sourceHostId] }),
      Promise.resolve({ result: { rows: [] }, elapsed_ms: 0 }),
    ])
    : await Promise.all([
      timedQuery(`${INVENTORY_SELECT} order by l.customer_name, l.service_name`),
      timedQuery(`${ALERTS_LIST_SELECT} where ${listScopeSql} and ${recentWindowSql}`),
      timedQuery(`${ALERTS_LIST_SELECT} where exists (
          select 1 from zabbix_link_inventory l
          where l.data_source_id=a.data_source_id and l.source_host_id=a.source_host_id
        ) and ${SERVICENOW_TAG_EXISTS_SQL} and not ${recentWindowSql}`),
    ]);
  const inventoryResult = inventoryQuery.result;
  const alerts = uniqueAlerts([
    ...(recentAlertsQuery.result.rows || []),
    ...(residualAlertsQuery.result.rows || []),
  ]);
  timings.inventory_query_ms = inventoryQuery.elapsed_ms;
  timings.alerts_query_ms = Math.max(recentAlertsQuery.elapsed_ms, residualAlertsQuery.elapsed_ms);
  timings.alerts_recent_query_ms = recentAlertsQuery.elapsed_ms;
  timings.alerts_residual_query_ms = residualAlertsQuery.elapsed_ms;
  let incidents = []; let servicenowStatus = "available";
  const serviceNowStartedAt = Date.now();
  if (includeIncidents) {
    try { incidents = await fetchLinkIncidents(alerts, { pool }); }
    catch { servicenowStatus = "degraded"; }
  }
  timings.servicenow_correlation_ms = elapsedMs(serviceNowStartedAt);
  const discoveryStartedAt = Date.now();
  const circuits = discoverOperatorCircuits(alerts);
  timings.circuit_discovery_ms = elapsedMs(discoveryStartedAt);
  const compositionStartedAt = Date.now();
  const incidentMatches = correlateLinkIncidents(alerts, incidents);
  const rows = composeCircuitLevelLinks({ inventoryRows: inventoryResult.rows || [], alertRows: alerts, incidents, circuits, incidentMatches });
  attachOperationalRecurrence(rows, alerts, new Date(), { recentLimit: scoped ? OPERATIONAL_RECENT_PREVIEW_LIMIT : 0, incidentMatches });
  timings.composition_ms = elapsedMs(compositionStartedAt);
  if (servicenowStatus === "degraded") markIncidentDegraded(rows);
  timings.total_ms = elapsedMs(startedAt);
  return { rows, alerts, circuits, inventory_rows_data: inventoryResult.rows || [], integration_status: { servicenow: servicenowStatus }, timings, inventory_rows: (inventoryResult.rows || []).length, alert_rows: alerts.length };
}

function queueLink(row) {
  return {
    id: row.id, circuit_key: row.circuit_key, resolution_status: row.resolution_status,
    data_source_id: row.data_source_id, datasource: row.datasource, source_host_id: row.source_host_id,
    host_name: row.host_name, customer_key: row.customer_key, customer_name: row.customer_name,
    service_name: row.service_name, classification: row.classification, classification_source: row.classification_source,
    classification_confidence: row.classification_confidence, site_key: row.site_key, site_name: row.site_name,
    link_type: row.link_type, carrier_name: row.carrier_name, carrier_source: row.carrier_source,
    carrier_reference: row.carrier_reference, strategy: row.strategy, confidence: row.confidence, updated_at: row.updated_at,
    active_alerts: row.active_alerts, unack_alerts: row.unack_alerts, high_alerts: row.high_alerts,
    disaster_alerts: row.disaster_alerts, average_alerts: row.average_alerts, warning_alerts: row.warning_alerts,
    state: row.state, max_severity: row.max_severity, active_since_at: row.active_since_at,
    latest_activity_at: row.latest_activity_at, resolved_at: row.resolved_at,
    alert_started_at: row.active_since_at, latest_alert_at: row.latest_alert?.last_seen_at || row.latest_activity_at,
    current_alert: row.current_alert, latest_alert: row.latest_alert,
    incident_count: row.incident_count, incident_correlation_status: row.incident_correlation_status,
    open_incident_count: row.open_incident_count, resolved_incident_count: row.resolved_incident_count,
    closed_incident_count: row.closed_incident_count, cancelled_incident_count: row.cancelled_incident_count, unknown_incident_count: row.unknown_incident_count,
    current_incident: row.current_incident, latest_incident: row.latest_incident,
    monitoring_state: row.monitoring_state, servicenow_state: row.servicenow_state, divergence_type: row.divergence_type,
    operational_subject: buildOperationalSubject(row),
    occurrences_24h: Number(row.occurrences_24h || 0),
    occurrences_7d: Number(row.occurrences_7d || 0),
    last_failure_at: row.last_failure_at || null,
    last_recovery_at: row.last_recovery_at || null,
    is_recurrent: Boolean(row.is_recurrent),
    total_recent_episodes: Number(row.total_recent_episodes || 0),
  };
}

export async function fetchCanonicalLinks({ pool = getOneViewDbPool() } = {}) {
  const model = await fetchCanonicalLinkModel({ pool });
  const rows = model.rows.map(queueLink);
  Object.defineProperties(rows, { integration_status: { value: model.integration_status, enumerable: false }, timings: { value: model.timings, enumerable: false } });
  logLinksTiming({ ...model.timings, inventory_rows: model.inventory_rows, alert_rows: model.alert_rows, result_rows: rows.length, servicenow: model.integration_status.servicenow });
  return rows;
}

export async function fetchCanonicalLinkDetail({ id, dataSourceId, sourceHostId, pool = getOneViewDbPool() } = {}) {
  const model = await fetchCanonicalLinkModel({ pool, dataSourceId, sourceHostId, includeIncidents: false });
  const candidate = model.rows.find((row) => String(row.id) === String(id));
  if (!candidate) return null;
  const circuit = model.circuits.find((item) => String(item.circuit_key) === String(id));
  const relatedAlerts = circuit ? alertsForCircuit(circuit, model.alerts) : model.alerts;
  let incidents = []; let servicenowStatus = "available";
  const serviceNowStartedAt = Date.now();
  try { incidents = await fetchLinkIncidents(relatedAlerts, { pool }); }
  catch { servicenowStatus = "degraded"; }
  model.timings.servicenow_correlation_ms = elapsedMs(serviceNowStartedAt);
  const detailCompositionStartedAt = Date.now();
  const incidentMatches = correlateLinkIncidents(model.alerts, incidents);
  const rows = composeCircuitLevelLinks({ inventoryRows: model.inventory_rows_data, alertRows: model.alerts, incidents, circuits: model.circuits, incidentMatches });
  attachOperationalRecurrence(rows, model.alerts, new Date(), { recentLimit: OPERATIONAL_RECENT_DETAIL_LIMIT, incidentMatches });
  model.timings.composition_ms = elapsedMs(detailCompositionStartedAt);
  if (servicenowStatus === "degraded") markIncidentDegraded(rows);
  model.integration_status = { servicenow: servicenowStatus };
  model.timings.total_ms = model.timings.inventory_query_ms + model.timings.alerts_query_ms + model.timings.circuit_discovery_ms + model.timings.composition_ms + model.timings.servicenow_correlation_ms;
  const row = rows.find((item) => String(item.id) === String(id));
  if (!row) return null;
  const incidentHistory = [...(row.incidents || [])].sort((a, b) => incidentSortValue(b) - incidentSortValue(a) || String(a.sys_id || a.number).localeCompare(String(b.sys_id || b.number))).slice(0, 20).map(incidentRecord);
  const detail = {
    ...queueLink(row),
    current_alert: row.current_alert, latest_alert: row.latest_alert, active_alerts_detail: row.alerts || [],
    current_incident: row.current_incident, latest_incident: row.latest_incident, incident_history: incidentHistory,
    recent_episodes: row.recent_episodes || [], total_recent_episodes: Number(row.total_recent_episodes || 0),
    technical: { circuit_key: row.circuit_key, resolution_status: row.resolution_status, source: row.datasource, host_name: row.host_name, source_host_id: row.source_host_id, trigger_ids: row.trigger_ids || [], member_key: row.member_key, uplink_key: row.uplink_key, healthcheck_key: row.healthcheck_key, endpoint_ip: row.endpoint_ip, confidence: row.confidence, strategy: row.strategy },
    integration_status: model.integration_status,
    checked_at: new Date().toISOString(),
  };
  logLinksTiming({ route: "/api/oneview/links/:id", detail_request_total_ms: model.timings.total_ms, inventory_rows: model.inventory_rows, alert_rows: model.alert_rows, servicenow: model.integration_status.servicenow, status: 200 });
  return detail;
}

/** Revalidate a stable alert subject; canonical circuit data remains presentation enrichment only. */
export async function fetchOperationalSubjectDetail({ subjectType, circuitKey, dataSourceId, sourceHostId, sourceTriggerId, pool = getOneViewDbPool() } = {}) {
  if (subjectType === "circuit") return fetchCanonicalLinkDetail({ id: circuitKey, dataSourceId, sourceHostId, pool });
  if (subjectType !== "alert_subject" || !dataSourceId || !sourceHostId || !sourceTriggerId) return null;

  const model = await fetchCanonicalLinkModel({ pool, dataSourceId, sourceHostId, includeIncidents: false });
  const relatedAlerts = uniqueAlerts(model.alerts).filter((alert) => (
    String(alert.data_source_id || "") === String(dataSourceId)
    && String(alert.source_host_id || "") === String(sourceHostId)
    && String(alert.source_trigger_id || "") === String(sourceTriggerId)
  ));
  const candidate = model.rows.find((row) => (row.trigger_ids || []).map(String).includes(String(sourceTriggerId)));
  if (!candidate || !relatedAlerts.length) return null;

  let incidents = []; let servicenowStatus = "available";
  const serviceNowStartedAt = Date.now();
  try { incidents = await fetchLinkIncidents(relatedAlerts, { pool }); }
  catch { servicenowStatus = "degraded"; }
  model.timings.servicenow_correlation_ms = elapsedMs(serviceNowStartedAt);
  const summary = alertSummary(relatedAlerts);
  const row = {
    ...candidate,
    ...summary,
    incidents,
    incident_count: incidents.length,
    incident_correlation_status: "available",
    ...incidentSummary(incidents),
  };
  const incidentMatches = correlateLinkIncidents(relatedAlerts, incidents);
  attachOperationalRecurrence([row], relatedAlerts, new Date(), { recentLimit: OPERATIONAL_RECENT_DETAIL_LIMIT, incidentMatches });
  if (servicenowStatus === "degraded") markIncidentDegraded([row]);
  const incidentHistory = [...incidents]
    .sort((a, b) => incidentSortValue(b) - incidentSortValue(a) || String(a.sys_id || a.number).localeCompare(String(b.sys_id || b.number)))
    .slice(0, 20)
    .map(incidentRecord);
  const detail = {
    ...queueLink(row),
    active_alerts_detail: row.alerts || [],
    incident_history: incidentHistory,
    recent_episodes: row.recent_episodes || [], total_recent_episodes: Number(row.total_recent_episodes || 0),
    technical: { circuit_key: row.circuit_key, resolution_status: row.resolution_status, source: row.datasource, host_name: row.host_name, source_host_id: row.source_host_id, trigger_ids: [String(sourceTriggerId)], member_key: row.member_key, uplink_key: row.uplink_key, healthcheck_key: row.healthcheck_key, endpoint_ip: row.endpoint_ip, confidence: row.confidence, strategy: row.strategy },
    integration_status: { servicenow: servicenowStatus },
    checked_at: new Date().toISOString(),
  };
  logLinksTiming({ route: "/api/oneview/operational-subject", detail_request_total_ms: model.timings.total_ms, inventory_rows: model.inventory_rows, alert_rows: model.alert_rows, servicenow: servicenowStatus, status: 200 });
  return detail;
}
export function buildLinksPayload(rows, filters, now = Date.now(), integrationStatus = { servicenow: "available" }) {
  const resolvedWindow = resolvedWindowStart(filters.resolved_window, now);
  const all = rows.map((row) => operationalRow(row, now, resolvedWindow));
  const base = filteredBase(all, filters);
  const scoped = ordered(filteredOperational(base, filters, now), filters); const start=(filters.page-1)*filters.page_size;
  const facets = (field) => [...new Map(all.map((row) => [String(row[field] || ""), row[field]]).filter(([value]) => value)).entries()].map(([value,label])=>({value,label})).sort((a,b)=>String(a.label).localeCompare(String(b.label),"pt-BR"));
  const operational = {
    open: base.filter((row) => row.has_active_alert).length,
    normalized: base.filter((row) => !row.has_active_alert).length,
    without_incident: base.filter((row) => row.has_active_alert && row.incident_correlation_status !== "degraded" && !row.incident_count).length,
    without_open_incident: base.filter((row) => row.has_active_alert && row.incident_correlation_status !== "degraded" && !row.open_incident_count).length,
    with_open_incident: base.filter((row) => row.incident_correlation_status !== "degraded" && row.open_incident_count > 0).length,
    recurrent: base.filter((row) => row.is_recurrent).length,
    divergences: base.filter((row) => row.divergence_type).length,
    divergence_a: base.filter((row) => row.divergence_type === "a").length,
    divergence_b: base.filter((row) => row.divergence_type === "b").length,
    resolved_today: base.filter((row) => !row.has_active_alert && (timestamp(row.latest_activity_at || row.resolved_at || row.updated_at) || 0) >= resolvedWindowStart("today", now)).length,
  };
  return { items: scoped.slice(start,start+filters.page_size), pagination:{page:filters.page,page_size:filters.page_size,total_items:scoped.length,total_pages:Math.ceil(scoped.length/filters.page_size),has_next:start+filters.page_size<scoped.length,has_previous:filters.page>1}, totals:{links:base.length,active_alert_links:base.filter(x=>x.active_alerts>0).length,incident_links:integrationStatus.servicenow === "degraded" ? null : base.filter(x=>x.incident_count>0).length,known_carriers:base.filter(x=>x.carrier_name).length,pending_classification:base.filter(x=>x.resolution_status!=="resolved").length,operational}, integration_status:integrationStatus, facets:{customers:facets("customer_name"),datasources:facets("datasource"),classifications:facets("classification")}, filters, data_source:"database", fallback_code:null, checked_at:new Date(now).toISOString() };
}
const LINKS_SUGGEST_CACHE_MS = 30_000;
const LINK_SEARCH_FIELDS = ["service_name", "customer_name", "source_host_id", "host_name", "site_name", "link_type", "carrier_name", "circuit_key"];
let linksSuggestCache = { rows: null, at: 0 };

export async function searchLinkSuggestions(req, { list = fetchCanonicalLinks, now = () => Date.now() } = {}) {
  const q = text(oneQuery(req, "q"));
  if (!q || q.length < 2 || !SAFE.test(q)) throw invalidQuery();
  const limit = pageInt(oneQuery(req, "limit"), 8, 15);
  const scopeQuery = { ...req.query, search: undefined, q: undefined, limit: undefined };
  const filters = parseLinkFilters({ query: scopeQuery });

  let rows = linksSuggestCache.rows;
  if (!rows || now() - linksSuggestCache.at > LINKS_SUGGEST_CACHE_MS) {
    const result = await list();
    rows = Array.isArray(result) ? result : result.rows;
    linksSuggestCache = { rows, at: now() };
  }

  const scoped = filteredBase(rows, { ...filters, search: null });
  const needle = q.toLowerCase();
  const raw = [];

  if (/^INC\d*$/i.test(q)) {
    for (const row of scoped) {
      const incidents = [...(row.incidents || []), row.current_incident, row.latest_incident].filter(Boolean);
      for (const incident of incidents) {
        const number = String(incident?.number || "").trim().toUpperCase();
        if (!number.startsWith(q.toUpperCase())) continue;
        raw.push({ kind: "number", value: number, label: number, hint: "Filtrar por chamado" });
      }
    }
    return { suggestions: mergeRankedSuggestions(raw, q, limit) };
  }

  for (const row of scoped) {
    if (matchRank(row.customer_name, q) <= 1) {
      const label = String(row.customer_name || "").trim();
      if (label) raw.push({ kind: "customer", value: label, label, hint: row.host_name ? `Cliente · host ${row.host_name}` : "Filtrar por cliente" });
    }
    if (matchRank(row.host_name, q) <= 1 || matchRank(row.source_host_id, q) <= 1) {
      const label = String(row.host_name || row.source_host_id || "").trim();
      if (label) raw.push({ kind: "host", value: label, label, hint: row.customer_name ? `Host · ${row.customer_name}` : "Filtrar por host" });
    }
    for (const field of ["service_name", "site_name", "circuit_key", "carrier_name"]) {
      const label = String(row[field] || "").trim();
      if (!label || !label.toLowerCase().includes(needle)) continue;
      raw.push({ kind: "link", value: label, label, hint: `Link · ${row.customer_name || "circuito"}` });
    }
  }
  return { suggestions: mergeRankedSuggestions(raw, q, limit) };
}

export function createLinksSearchSuggestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  suggest = searchLinkSuggestions,
} = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res))) return;
    try {
      const payload = await suggest(req);
      return sendJson(res, 200, { ...payload, data_source: "database", checked_at: new Date().toISOString() });
    } catch (error) {
      if (error?.code === "invalid_query") return sendJson(res, 400, { error: "invalid_query", data_source: "database" });
      return sendJson(res, 503, { error: "database_unavailable", data_source: "database" });
    }
  };
}

export function createLinksHandler({ authorize=(req,res)=>requireOneViewAuth(req,res,"viewer"), list=fetchCanonicalLinks, now=()=>Date.now() }={}) { return async (req,res) => { const startedAt=Date.now(); let status=500; res.setHeader("Cache-Control",NO_CACHE); res.setHeader("X-Content-Type-Options","nosniff"); try { if(req.method!=="GET") { status=405; return methodNotAllowed(res,["GET"]); } if(!await authorize(req,res)) { status=res.statusCode||401; return; } const filters=parseLinkFilters(req); const result=await list(); const rows=Array.isArray(result)?result:result.rows; const integrationStatus=result?.integration_status||{servicenow:"available"}; const payload=buildLinksPayload(rows,filters,now(),integrationStatus); res.setHeader("X-OneView-Data-Source","database"); status=200; return sendJson(res,200,payload); } catch (error) { status=error?.code==="invalid_query"?400:503; return sendJson(res,status,{error:error?.code==="invalid_query"?"invalid_query":"database_unavailable",data_source:"database"}); } finally { logLinksTiming({ route:"/api/oneview/links", request_total_ms:elapsedMs(startedAt), status }); } }; }
export function createLinkDetailHandler({ authorize=(req,res)=>requireOneViewAuth(req,res,"viewer"), detail=fetchCanonicalLinkDetail }={}) { return async (req,res) => { const startedAt=Date.now(); let status=500; res.setHeader("Cache-Control",NO_CACHE); res.setHeader("X-Content-Type-Options","nosniff"); try { if(req.method!=="GET") { status=405; return methodNotAllowed(res,["GET"]); } if(!await authorize(req,res)) { status=res.statusCode||401; return; } const id=text(getId(req,"id")); const dataSourceId=text(oneQuery(req,"data_source_id")); const sourceHostId=text(oneQuery(req,"source_host_id")); if(!id||!dataSourceId||!sourceHostId||![id,dataSourceId,sourceHostId].every((value)=>SAFE.test(value))) { status=400; return sendJson(res,400,{error:"invalid_query",data_source:"database"}); } const payload=await detail({id,dataSourceId,sourceHostId}); if(!payload) { status=404; return sendJson(res,404,{error:"not_found",data_source:"database"}); } res.setHeader("X-OneView-Data-Source","database"); status=200; return sendJson(res,200,{...payload,data_source:"database",fallback_code:null}); } catch { status=503; return sendJson(res,503,{error:"database_unavailable",data_source:"database"}); } finally { logLinksTiming({route:"/api/oneview/links/:id",detail_request_total_ms:elapsedMs(startedAt),status}); } }; }
export default createLinksHandler();
