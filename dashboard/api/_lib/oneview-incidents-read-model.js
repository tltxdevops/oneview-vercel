/**
 * SN-P0-39 — leitura de incidentes exclusivamente do read model PostgreSQL.
 * Nunca seleciona raw_payload e nunca faz HTTP para ServiceNow.
 */
import { getOneViewDbPool } from "./oneview-db.js";

const OPERATIONAL_STATES = ["1", "2", "3"];

function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function displayBag(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function display(row, key) {
  const values = displayBag(row.display_values);
  return text(values[`${key}_display`]) || text(values[key]) || text(row[`${key}_display`]) || text(row[key]);
}

function mapIncident(row, { baseUrl = process.env.SERVICENOW_BASE_URL } = {}) {
  const sysId = text(row.sys_id);
  let servicenowUrl = null;
  try {
    if (baseUrl && sysId) {
      const url = new URL("/incident.do", `${String(baseUrl).replace(/\/+$/, "")}/`);
      url.searchParams.set("sys_id", sysId);
      servicenowUrl = url.toString();
    }
  } catch {
    // URL opcional; não interfere na leitura do read model.
  }
  return {
    sys_id: sysId,
    number: text(row.number),
    state: text(row.state),
    state_display: display(row, "state"),
    priority: text(row.priority),
    priority_display: display(row, "priority"),
    assigned_to: text(row.assigned_to),
    assigned_to_display: display(row, "assigned_to"),
    assignment_group: text(row.assignment_group),
    assignment_group_display: display(row, "assignment_group"),
    caller_id: text(row.caller_id),
    caller_id_display: display(row, "caller_id"),
    company: text(row.company),
    company_display: display(row, "company"),
    contact_type: text(row.contact_type),
    contact_type_display: display(row, "contact_type"),
    short_description: text(row.short_description),
    description: text(row.description),
    opened_at: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    sys_updated_on: row.sys_updated_on ? new Date(row.sys_updated_on).toISOString() : null,
    zabbix_event_id: text(row.zabbix_event_id),
    correlation_id: text(row.correlation_id),
    u_hostname_zabbix: text(row.u_hostname_zabbix),
    u_ip_zabbix: text(row.u_ip_zabbix),
    servicenow_url: servicenowUrl,
  };
}

function addParam(values, value) {
  values.push(value);
  return `$${values.length}`;
}

function buildWhere(filters, values, { includeState = true, includeUnassigned = true } = {}) {
  const clauses = ["coalesce(contact_type::text, '') = 'monitoring'"];
  if (filters.caller_id) clauses.push(`caller_id::text = ${addParam(values, filters.caller_id)}`);
  if (filters.assigned_to) clauses.push(`assigned_to::text = ${addParam(values, filters.assigned_to)}`);
  if (filters.assignment_group) clauses.push(`assignment_group::text = ${addParam(values, filters.assignment_group)}`);
  if (filters.number) clauses.push(`upper(number::text) = ${addParam(values, filters.number.toUpperCase())}`);
  if (filters.sys_id) clauses.push(`lower(sys_id::text) = ${addParam(values, filters.sys_id.toLowerCase())}`);
  if (filters.priority) clauses.push(`priority::text = ${addParam(values, filters.priority)}`);
  if (filters.company) {
    const term = `%${filters.company}%`;
    const param = addParam(values, term);
    clauses.push(`(company::text ilike ${param} or coalesce(display_values::text, '') ilike ${param})`);
  }
  if (filters.opened_from) clauses.push(`opened_at >= ${addParam(values, `${filters.opened_from}T00:00:00.000Z`)}`);
  if (filters.opened_to) clauses.push(`opened_at < (${addParam(values, `${filters.opened_to}T00:00:00.000Z`)}::timestamptz + interval '1 day')`);
  if (includeState && filters.state) clauses.push(`state::text = any(${addParam(values, String(filters.state).split(","))}::text[])`);
  if (includeUnassigned && filters.unassigned) clauses.push("coalesce(btrim(assigned_to::text), '') = ''");
  if (filters.search) {
    const param = addParam(values, `%${filters.search}%`);
    clauses.push(`(number::text ilike ${param} or coalesce(short_description, '') ilike ${param} or coalesce(description, '') ilike ${param} or coalesce(display_values::text, '') ilike ${param})`);
  }
  return clauses.join(" and ");
}

function mapFacet(rows) {
  return rows.map((row) => ({
    value: text(row.value) || "",
    label: text(row.label) || text(row.value) || "",
    display_value: text(row.label) || text(row.value) || "",
    count: Number(row.count) || 0,
  })).filter((row) => row.value);
}

async function fetchFacets(pool, filters) {
  const values = [];
  const where = buildWhere({ ...filters, caller_id: null, assigned_to: null }, values, {
    includeState: false,
    includeUnassigned: false,
  });
  const specs = [
    ["callers", "caller_id", "caller_id"],
    ["assignees", "assigned_to", "assigned_to"],
    ["companies", "company", "company"],
    ["states", "state", "state"],
    ["priorities", "priority", "priority"],
  ];
  const all = await Promise.all(specs.map(async ([name, field, displayField]) => {
    const result = await pool.query(`
      select ${field}::text as value,
             coalesce(display_values->>'${displayField}_display', display_values->>'${displayField}', ${field}::text) as label,
             count(*)::int as count
        from servicenow_incidents
       where ${where} and coalesce(btrim(${field}::text), '') <> ''
       group by ${field}::text, coalesce(display_values->>'${displayField}_display', display_values->>'${displayField}', ${field}::text)
       order by count(*) desc, label asc
       limit 100`, values);
    return [name, mapFacet(result.rows)];
  }));
  return Object.fromEntries(all);
}

async function fetchCounts(pool, filters) {
  const values = [];
  const where = buildWhere({ ...filters, state: null, unassigned: false }, values, {
    includeState: false,
    includeUnassigned: false,
  });
  const result = await pool.query(`
    select count(*)::int as total,
      count(*) filter (where state::text = '1')::int as open,
      count(*) filter (where state::text = '2')::int as in_progress,
      count(*) filter (where state::text = '6')::int as resolved,
      count(*) filter (where state::text = '7')::int as closed,
      count(*) filter (where coalesce(btrim(assigned_to::text), '') = '' and state::text = any($${values.length + 1}::text[]))::int as unassigned
    from servicenow_incidents where ${where}`, [...values, OPERATIONAL_STATES]);
  return result.rows[0] || { total: 0, open: 0, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 };
}

export async function fetchReadModelIncidentsPage(filters, { pool = getOneViewDbPool(), baseUrl } = {}) {
  const values = [];
  const where = buildWhere(filters, values);
  const exactLookup = Boolean(filters.number || filters.sys_id);
  const offset = exactLookup ? 0 : (filters.page - 1) * filters.page_size;
  const [pageResult, countResult, counts, facets, syncResult] = await Promise.all([
    pool.query(`
      select sys_id, number, state, priority, assigned_to, assignment_group, caller_id, company,
             contact_type, short_description, description, opened_at, sys_updated_on,
             correlation_id, u_hostname_zabbix, u_ip_zabbix, display_values
        from servicenow_incidents
       where ${where}
       order by sys_updated_on desc nulls last, sys_id asc
       limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, filters.page_size, offset]),
    pool.query(`select count(*)::int as total from servicenow_incidents where ${where}`, values),
    fetchCounts(pool, filters),
    fetchFacets(pool, filters),
    pool.query("select last_success_at, watermark_sys_updated_on from servicenow_sync_state where sync_key = 'incident' limit 1"),
  ]);
  const totalItems = Number(countResult.rows?.[0]?.total || 0);
  const totalPages = totalItems ? Math.ceil(totalItems / filters.page_size) : 0;
  const effectivePage = exactLookup ? 1 : filters.page;
  return {
    items: pageResult.rows.map((row) => mapIncident(row, { baseUrl })),
    pagination: {
      page: effectivePage,
      page_size: filters.page_size,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: effectivePage < totalPages,
      has_previous: effectivePage > 1 && totalPages > 0,
    },
    filters,
    counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value) || 0])),
    facets,
    data_source: "postgresql",
    checked_at: new Date().toISOString(),
    freshness: {
      last_success_at: syncResult.rows?.[0]?.last_success_at?.toISOString?.() || syncResult.rows?.[0]?.last_success_at || null,
      watermark_sys_updated_on: syncResult.rows?.[0]?.watermark_sys_updated_on?.toISOString?.() || syncResult.rows?.[0]?.watermark_sys_updated_on || null,
    },
  };
}

async function findBy(pool, where, values, { baseUrl } = {}) {
  const result = await pool.query(`
    select sys_id, number, state, priority, assigned_to, assignment_group, caller_id, company,
           contact_type, short_description, description, opened_at, sys_updated_on,
           correlation_id, u_hostname_zabbix, u_ip_zabbix, display_values
      from servicenow_incidents where ${where}
     order by sys_updated_on desc nulls last, sys_id asc limit 50`, values);
  return result.rows.map((row) => mapIncident(row, { baseUrl }));
}

export async function findReadModelRelatedIncidents({
  incidentSysIds = [], tagIncidentNumbers = [], incidentNumbers = [], sourceEventId = null,
} = {}, { pool = getOneViewDbPool(), baseUrl } = {}) {
  const sysIds = [...new Set(incidentSysIds.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const tagNumbers = [...new Set(tagIncidentNumbers.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))];
  const historyNumbers = [...new Set(incidentNumbers.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))];
  const searches = [
    ["zabbix_servicenow_sys_id", "lower(sys_id::text) = any($1::text[])", [sysIds]],
    ["zabbix_servicenow_number", "upper(number::text) = any($1::text[])", [tagNumbers]],
    ["zabbix_inc_reference", "upper(number::text) = any($1::text[])", [historyNumbers]],
    ["zabbix_event_id", "correlation_id::text = $1", [String(sourceEventId || "").trim()]],
  ];
  for (const [relationSource, where, values] of searches) {
    if (!values[0] || (Array.isArray(values[0]) && !values[0].length)) continue;
    const incidents = await findBy(pool, where, values, { baseUrl });
    if (incidents.length) return { matched: true, relation_source: relationSource, incidents };
  }
  return { matched: false, relation_source: "none", incidents: [] };
}
