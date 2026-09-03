/** OV-P0-278C — canonical connectivity links; inventory is the only link universe. */
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewDbPool } from "./oneview-db.js";
import { extractServiceNowRefsFromAlertTags } from "./oneview-inc-correlation.js";
import { mapReadModelIncident } from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE = /^[\p{L}\p{N}._:@/| -]{1,240}$/u;
const SEVERITIES = new Set(["information", "warning", "average", "high", "critical", "disaster", "not_classified"]);
const activeSql = "a.resolved_at is null and lower(coalesce(a.status_source, 'active')) = 'active' and lower(coalesce(a.status_internal, '')) not in ('resolved', 'normalized')";

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
    page: pageInt(oneQuery(req, "page"), 1, 10_000), page_size: pageInt(oneQuery(req, "page_size"), 50, 100),
  };
  for (const value of Object.values(filters)) if (typeof value === "string" && !SAFE.test(value)) throw invalidQuery();
  if (filters.severity && !SEVERITIES.has(filters.severity.toLowerCase())) throw invalidQuery();
  if (filters.state && !new Set(["critical", "alert", "attention", "normal"]).has(filters.state.toLowerCase())) throw invalidQuery();
  if (filters.ack && !new Set(["all", "pending", "none"]).has(filters.ack.toLowerCase())) throw invalidQuery();
  if (filters.incident && !new Set(["all", "yes", "no"]).has(filters.incident.toLowerCase())) throw invalidQuery();
  if (filters.carrier && !new Set(["all", "unknown"]).has(filters.carrier.toLowerCase())) throw invalidQuery();
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
function correlate(alerts, incidents) {
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
function filtered(rows, filters) {
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
    if (filters.carrier === "unknown" && row.carrier_name) return false;
    if (filters.search) { const needle = filters.search.toLowerCase(); if (![row.service_name, row.customer_name, row.source_host_id].some((value) => String(value || "").toLowerCase().includes(needle))) return false; }
    return true;
  });
}
export async function fetchCanonicalLinks({ pool = getOneViewDbPool() } = {}) {
  const result = await pool.query(`select l.id::text, l.data_source_id::text, l.source_host_id::text, l.customer_key, l.customer_name, l.service_name, l.classification, l.classification_source, l.classification_confidence, l.carrier_name, l.carrier_source, l.source_metadata, l.updated_at, d.name as datasource, coalesce(count(a.id) filter (where ${activeSql}),0)::int as active_alerts, coalesce(count(a.id) filter (where ${activeSql} and coalesce(a.acknowledged_source,false)=false),0)::int as unack_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,'')) in ('high','critical')),0)::int as high_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,''))='disaster'),0)::int as disaster_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,''))='average'),0)::int as average_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,''))='warning'),0)::int as warning_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,''))='information'),0)::int as information_alerts, coalesce(count(a.id) filter (where ${activeSql} and lower(coalesce(a.severity,''))='not_classified'),0)::int as not_classified_alerts from zabbix_link_inventory l join data_sources d on d.id::text=l.data_source_id::text left join alerts a on a.data_source_id::text=l.data_source_id::text and a.source_host_id::text=l.source_host_id::text group by l.id, d.name order by l.customer_name, l.service_name`);
  const rows = (result.rows || []).map((row) => ({ ...row, state: stateFromAlerts(row), max_severity: maxSeverity(row), incident_count: 0, incidents: [] }));
  const alertsResult = await pool.query(`select a.id::text, a.data_source_id::text, a.source_host_id::text, a.source_event_id::text, a.source_problem_id::text, a.event_tags, a.trigger_tags, a.host_tags, coalesce(a.problem_name,a.trigger_description) as problem_name, a.severity, (${activeSql}) as is_active from alerts a join zabbix_link_inventory l on l.data_source_id::text=a.data_source_id::text and l.source_host_id::text=a.source_host_id::text`);
  const incidents = await fetchLinkIncidents(alertsResult.rows || [], { pool }); const matches = correlate(alertsResult.rows || [], incidents); const byHost = new Map();
  const alertsByHost = new Map();
  for (const alert of alertsResult.rows || []) { const key=`${alert.data_source_id}:${alert.source_host_id}`; const current=byHost.get(key) || new Map(); for (const incident of matches.get(alert.id) || []) current.set(incident.sys_id || incident.number, incident); byHost.set(key,current); if (alert.is_active) { const alertItems=alertsByHost.get(key)||[]; alertItems.push({id:alert.id,problem_name:alert.problem_name,severity:alert.severity}); alertsByHost.set(key,alertItems); } }
  for (const row of rows) { const key=`${row.data_source_id}:${row.source_host_id}`; row.incidents=[...(byHost.get(key)?.values() || [])]; row.incident_count=row.incidents.length; row.alerts=alertsByHost.get(key)||[]; }
  return rows;
}
export function buildLinksPayload(rows, filters, now = Date.now()) {
  const all = rows; const scoped = filtered(all, filters); const start=(filters.page-1)*filters.page_size;
  const facets = (field) => [...new Map(all.map((row) => [String(row[field] || ""), row[field]]).filter(([value]) => value)).entries()].map(([value,label])=>({value,label})).sort((a,b)=>String(a.label).localeCompare(String(b.label),"pt-BR"));
  return { items: scoped.slice(start,start+filters.page_size), pagination:{page:filters.page,page_size:filters.page_size,total_items:scoped.length,total_pages:Math.ceil(scoped.length/filters.page_size),has_next:start+filters.page_size<scoped.length,has_previous:filters.page>1}, totals:{links:all.length,active_alert_links:all.filter(x=>x.active_alerts>0).length,incident_links:all.filter(x=>x.incident_count>0).length,known_carriers:all.filter(x=>x.carrier_name).length}, facets:{customers:facets("customer_name"),datasources:facets("datasource"),classifications:facets("classification")}, filters, data_source:"database", fallback_code:null, checked_at:new Date(now).toISOString() };
}
export function createLinksHandler({ authorize=(req,res)=>requireOneViewAuth(req,res,"viewer"), list=fetchCanonicalLinks, now=()=>Date.now() }={}) { return async (req,res) => { res.setHeader("Cache-Control",NO_CACHE); res.setHeader("X-Content-Type-Options","nosniff"); if(req.method!=="GET") return methodNotAllowed(res,["GET"]); if(!await authorize(req,res)) return; try { const filters=parseLinkFilters(req); const payload=buildLinksPayload(await list(),filters,now()); res.setHeader("X-OneView-Data-Source","database"); return sendJson(res,200,payload); } catch (error) { return sendJson(res,error?.code==="invalid_query"?400:503,{error:error?.code==="invalid_query"?"invalid_query":"database_unavailable",data_source:"database"}); } }; }
export default createLinksHandler();
