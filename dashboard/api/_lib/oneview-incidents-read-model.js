/**
 * SN-P0-39 — leitura de incidentes exclusivamente do read model PostgreSQL.
 * Nunca seleciona raw_payload e nunca faz HTTP para ServiceNow.
 */
import { getOneViewDbPool } from "./oneview-db.js";
import { SERVICENOW_PROD_BASE_URL } from "./oneview-inc-correlation.js";
import { parseColonHostProblemLine, parseZabbixFieldsFromDescription } from "./servicenow-normalize.js";
import { MAPS_SERVICENOW_COMPANY_WHERE_SQL } from "./oneview-servicenow-customer-bridge.js";
import {
  expandServiceNowCompanyFilterToken,
  matchServiceNowOperationalBridge,
  resolveServiceNowIncidentCustomerLabel,
} from "./oneview-servicenow-customer-bridge.js";
import { mergeRankedSuggestions } from "./oneview-search-suggest-rank.js";

const OPERATIONAL_STATES = ["1", "2", "3"];
const TERMINAL_INCIDENT_STATES = new Set(["6", "7", "8", "resolved", "closed", "cancelled", "canceled"]);
// Manual = caller_id diferente do emissor técnico Zabbix; NULL também é manual.
// Não usa contact_type, alerta ou correlação como critério.
export const ZABBIX_MONITORING_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
export const TENABLE_INTEGRATION_CALLER_ID = "150f6c0887cf8b10d5fd84c30cbb354c";
export const EXCLUDED_ASSIGNMENT_GROUP_IDS = Object.freeze([
  "fa5a17eb47fa47106b618ca2036d43b0", // N2 - Sustentação - Redes/Triagem
  "9f0a34be47622610082e3d02e26d43ab", // N1 - Infraestrutura
  "fa7a932f47fa47106b618ca2036d43b1", // N1 - Sustentação - Infra
]);

export const EXCLUDED_ASSIGNMENT_GROUP_NAMES = Object.freeze([
  "n3 - soc csirt",
  "salesforce",
  "n1 - sustentação - infra",
  "sustentação protheus - teletex",
  "n3 - engenharia - infraestrutura microsoft",
]);

// assignment_group é normalmente sys_id; o nome operacional vem do display_values.
export const ASSIGNMENT_GROUP_LABEL_SQL = `coalesce(
  nullif(btrim(display_values->>'assignment_group_display'), ''),
  nullif(btrim(display_values->>'assignment_group'), ''),
  nullif(btrim(assignment_group::text), ''),
  ''
)`;

const INCIDENT_SORTS = Object.freeze({
  updated: "sys_updated_on",
  opened: "opened_at",
  number: "lower(coalesce(number::text, ''))",
  client: "lower(coalesce(nullif(display_values->>'company_display', ''), nullif(display_values->>'company', ''), company::text, ''))",
  description: "lower(coalesce(short_description, ''))",
  state: "coalesce(state::text, '')",
  priority: "coalesce(priority::text, '')",
  group: `lower(${ASSIGNMENT_GROUP_LABEL_SQL})`,
  assignee: "lower(coalesce(nullif(display_values->>'assigned_to_display', ''), nullif(display_values->>'assigned_to', ''), assigned_to::text, ''))",
});

export function incidentOrderSql(filters = {}) {
  const sort = Object.hasOwn(INCIDENT_SORTS, filters.sort) ? filters.sort : "updated";
  const direction = filters.order === "asc" ? "asc" : "desc";
  const nulls = sort === "updated" || sort === "opened" ? " nulls last" : "";
  return `${INCIDENT_SORTS[sort]} ${direction}${nulls}, sys_id asc`;
}

export function assignmentGroupExclusionSql(idParam, nameParam) {
  return `(assignment_group is null or (
    lower(btrim(assignment_group::text)) <> all(${idParam}::text[])
    and lower(${ASSIGNMENT_GROUP_LABEL_SQL}) <> all(${nameParam}::text[])
    and lower(${ASSIGNMENT_GROUP_LABEL_SQL}) not like '%infraestrutura%'
  ))`;
}

function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

/** Parses an instant to epoch milliseconds. All temporal comparisons stay UTC. */
export function utcEpochMilliseconds(value) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isTerminalServiceNowIncident(incident) {
  const rawState = text(incident?.state)?.toLowerCase();
  const displayState = text(incident?.state_display)?.toLowerCase();
  return TERMINAL_INCIDENT_STATES.has(rawState) || TERMINAL_INCIDENT_STATES.has(displayState);
}

/**
 * A terminal incident is current only when its recorded opening belongs to this
 * episode and its terminal timestamp is later. Re-open is never inferred from
 * a generic update timestamp; no explicit re-open evidence means fail closed.
 */
export function isIncidentCurrentForAlertEpisode(incident, alertEpisodeStartedAt) {
  const episodeStartedAt = utcEpochMilliseconds(alertEpisodeStartedAt);
  const openedAt = utcEpochMilliseconds(incident?.opened_at ?? incident?.openedAt);
  if (!isTerminalServiceNowIncident(incident)) return true;
  if (episodeStartedAt == null) return false;
  const resolvedAt = utcEpochMilliseconds(incident?.resolved_at ?? incident?.resolvedAt);
  const closedAt = utcEpochMilliseconds(incident?.closed_at ?? incident?.closedAt);
  const terminalAt = Math.max(resolvedAt ?? Number.NEGATIVE_INFINITY, closedAt ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(terminalAt)) return false;
  if (openedAt == null || openedAt < episodeStartedAt) return false;
  if (terminalAt < openedAt) return false;
  return terminalAt >= episodeStartedAt;
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

function matchServiceNowOperationalBridgeFromRow(row) {
  return matchServiceNowOperationalBridge(display(row, "company") || row.company);
}

// `number` is normalized to uppercase at ingress. Equality keeps the existing
// number index usable and flags every duplicated local identity without trying
// to select a winner at the BFF layer.
function identityConflictSelect(alias = "servicenow_incidents") {
  return `exists (
    select 1
      from servicenow_incidents duplicate
     where duplicate.number::text = ${alias}.number::text
       and duplicate.sys_id::text <> ${alias}.sys_id::text
  ) as identity_conflict`;
}

const READ_MODEL_INCIDENT_SELECT = `
  sys_id, number, state, priority, assigned_to, assignment_group, caller_id, company,
  contact_type, short_description, description, opened_at, resolved_at, closed_at,
  sys_created_on, sys_updated_on, correlation_id, u_hostname_zabbix, u_ip_zabbix,
  display_values,
  coalesce(raw_payload->'impact'->>'value', nullif(raw_payload->>'impact', '')) as impact,
  coalesce(raw_payload->'impact'->>'display_value', nullif(raw_payload->>'impact_display', '')) as impact_display,
  coalesce(raw_payload->'urgency'->>'value', nullif(raw_payload->>'urgency', '')) as urgency,
  coalesce(raw_payload->'urgency'->>'display_value', nullif(raw_payload->>'urgency_display', '')) as urgency_display,
  coalesce(raw_payload->'category'->>'value', nullif(raw_payload->>'category', '')) as category,
  coalesce(raw_payload->'category'->>'display_value', nullif(raw_payload->>'category_display', '')) as category_display,
  coalesce(raw_payload->'subcategory'->>'value', nullif(raw_payload->>'subcategory', '')) as subcategory,
  coalesce(raw_payload->'subcategory'->>'display_value', nullif(raw_payload->>'subcategory_display', '')) as subcategory_display,
  coalesce(raw_payload->'close_code'->>'value', nullif(raw_payload->>'close_code', '')) as close_code,
  coalesce(raw_payload->'close_notes'->>'value', nullif(raw_payload->>'close_notes', '')) as close_notes,
  coalesce(raw_payload->'contract'->>'value', nullif(raw_payload->>'contract', '')) as contract
`;

function normalizeRelatedAlert(alert) {
  if (!alert?.id) return null;
  return {
    alertId: text(alert.id),
    severity: text(alert.severity),
    host: text(alert.host),
    datasource: text(alert.datasource),
    link: `/alertas?alert=${encodeURIComponent(String(alert.id))}`,
    relationSource: text(alert.relation_source),
    customer: text(alert.customer),
    problem: text(alert.problem),
    status: text(alert.status),
    sourceEventId: text(alert.source_event_id),
  };
}

export function mapReadModelIncident(row, { baseUrl = SERVICENOW_PROD_BASE_URL, relatedAlert = null } = {}) {
  const sysId = text(row.sys_id);
  const zabbixEventId = parseZabbixFieldsFromDescription(row.description).zabbix_event_id;
  const assignedTo = text(row.assigned_to);
  const assignmentGroup = text(row.assignment_group);
  const customer = text(row.company);
  const state = text(row.state);
  const priority = text(row.priority);
  const contactType = text(row.contact_type);
  let servicenowUrl = null;
  const identityConflict = Boolean(row.identity_conflict);
  try {
    if (baseUrl && sysId && !identityConflict) {
      const url = new URL("/incident.do", `${String(baseUrl).replace(/\/+$/, "")}/`);
      url.searchParams.set("sys_id", sysId);
      servicenowUrl = url.toString();
    }
  } catch {
    // URL opcional; não interfere na leitura do read model.
  }
  return {
    sys_id: sysId,
    id: sysId,
    sysId,
    number: text(row.number),
    state,
    state_display: display(row, "state"),
    priority,
    priority_display: display(row, "priority"),
    impact: text(row.impact),
    impact_display: display(row, "impact"),
    urgency: text(row.urgency),
    urgency_display: display(row, "urgency"),
    assigned_to: assignedTo,
    assigned_to_display: display(row, "assigned_to"),
    assignment_group: assignmentGroup,
    assignment_group_display: display(row, "assignment_group"),
    caller_id: text(row.caller_id),
    caller_id_display: display(row, "caller_id"),
    company: customer,
    company_display: display(row, "company"),
    contact_type: contactType,
    contact_type_display: display(row, "contact_type"),
    short_description: text(row.short_description),
    description: text(row.description),
    opened_at: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    sys_created_on: row.sys_created_on ? new Date(row.sys_created_on).toISOString() : null,
    sys_updated_on: row.sys_updated_on ? new Date(row.sys_updated_on).toISOString() : null,
    zabbix_event_id: text(zabbixEventId),
    correlation_id: text(row.correlation_id),
    u_hostname_zabbix: text(row.u_hostname_zabbix),
    u_ip_zabbix: text(row.u_ip_zabbix),
    category: text(row.category),
    category_display: display(row, "category"),
    subcategory: text(row.subcategory),
    subcategory_display: display(row, "subcategory"),
    close_code: text(row.close_code),
    close_notes: text(row.close_notes),
    contract: text(row.contract),
    // OV-P0-245 canonical BFF contract. Existing snake_case keys above stay
    // for current frontend compatibility; these aliases carry no inferred data.
    assignmentGroup: display(row, "assignment_group") || assignmentGroup,
    assignedTo: display(row, "assigned_to") || null,
    assignedToId: assignedTo,
    customer: resolveServiceNowIncidentCustomerLabel(customer, display(row, "company")),
    shortDescription: text(row.short_description),
    openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    updatedAt: row.sys_updated_on ? new Date(row.sys_updated_on).toISOString() : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    channel: display(row, "contact_type") || contactType,
    identity_conflict: identityConflict,
    relatedAlert: normalizeRelatedAlert(relatedAlert),
    servicenow_url: servicenowUrl,
  };
}

export async function fetchReadModelIncidentDetail(sysId, { pool = getOneViewDbPool() } = {}) {
  const normalized = text(sysId)?.toLowerCase();
  if (!normalized || !/^[a-z0-9._:-]{1,80}$/.test(normalized)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  const result = await pool.query({
    text: `select ${READ_MODEL_INCIDENT_SELECT}, ${identityConflictSelect()}
      from servicenow_incidents
      where lower(sys_id::text) = $1
      limit 1`,
    values: [normalized],
  });
  return result.rows?.[0] ? mapReadModelIncident(result.rows[0]) : null;
}

function addParam(values, value) {
  values.push(value);
  return `$${values.length}`;
}

function assignedToIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildWhere(filters, values, { includeState = true, includeUnassigned = true } = {}) {
  // Mantém WHERE sintaticamente válido quando nenhum filtro é explícito.
  const clauses = ["true"];
  clauses.push(`(caller_id is null or lower(btrim(caller_id::text)) <> ${addParam(values, TENABLE_INTEGRATION_CALLER_ID)})`);
  const excludedGroups = addParam(values, EXCLUDED_ASSIGNMENT_GROUP_IDS);
  const excludedGroupNames = addParam(values, EXCLUDED_ASSIGNMENT_GROUP_NAMES);
  clauses.push(assignmentGroupExclusionSql(excludedGroups, excludedGroupNames));
  if (filters.contact_type === "__blank") {
    clauses.push("coalesce(btrim(contact_type::text), '') = ''");
  } else if (filters.contact_type) {
    clauses.push(`lower(coalesce(contact_type::text, '')) = lower(${addParam(values, filters.contact_type)})`);
  }
  if (filters.manual) {
    clauses.push(`(caller_id is null or lower(btrim(caller_id::text)) <> ${addParam(values, ZABBIX_MONITORING_CALLER_ID)})`);
  } else if (filters.origin === "manual") {
    clauses.push(`(caller_id is null or lower(btrim(caller_id::text)) <> ${addParam(values, ZABBIX_MONITORING_CALLER_ID)})`);
  }
  if (!filters.manual && filters.origin === "automatic") {
    clauses.push(`lower(btrim(caller_id::text)) = ${addParam(values, ZABBIX_MONITORING_CALLER_ID)}`);
  }
  if (filters.caller_id) clauses.push(`caller_id::text = ${addParam(values, filters.caller_id)}`);
  const assigneeIds = assignedToIds(filters.assigned_to);
  const emptyAssignee = "coalesce(btrim(assigned_to::text), '') = ''";
  if (assigneeIds.length) {
    if (filters.include_unassigned) {
      const idList = addParam(values, assigneeIds.map((id) => id.toLowerCase()));
      clauses.push(`(lower(assigned_to::text) = any(${idList}::text[]) or ${emptyAssignee})`);
    } else if (assigneeIds.length === 1) {
      clauses.push(`assigned_to::text = ${addParam(values, assigneeIds[0])}`);
    } else {
      const idList = addParam(values, assigneeIds.map((id) => id.toLowerCase()));
      clauses.push(`lower(assigned_to::text) = any(${idList}::text[])`);
    }
  } else if (filters.has_assignee) {
    clauses.push("coalesce(btrim(assigned_to::text), '') <> ''");
  }
  if (filters.assignment_group) clauses.push(`assignment_group::text = ${addParam(values, filters.assignment_group)}`);
  if (filters.number) clauses.push(`upper(number::text) = ${addParam(values, filters.number.toUpperCase())}`);
  if (filters.sys_id) clauses.push(`lower(sys_id::text) = ${addParam(values, filters.sys_id.toLowerCase())}`);
  if (filters.priority) clauses.push(`priority::text = ${addParam(values, filters.priority)}`);
  if (filters.company) {
    const { terms } = expandServiceNowCompanyFilterToken(filters.company);
    const companyClauses = terms.map((term) => {
      const param = addParam(values, `%${term}%`);
      return `(company::text ilike ${param} or coalesce(display_values::text, '') ilike ${param})`;
    });
    if (companyClauses.length === 1) clauses.push(companyClauses[0]);
    else if (companyClauses.length > 1) clauses.push(`(${companyClauses.join(" or ")})`);
  }
  if (filters.opened_from) clauses.push(`opened_at >= ${addParam(values, `${filters.opened_from}T00:00:00.000Z`)}`);
  if (filters.opened_to) clauses.push(`opened_at < (${addParam(values, `${filters.opened_to}T00:00:00.000Z`)}::timestamptz + interval '1 day')`);
  if (filters.updated_from) clauses.push(`sys_updated_on >= ${addParam(values, `${filters.updated_from}T00:00:00.000Z`)}`);
  if (filters.updated_to) clauses.push(`sys_updated_on < (${addParam(values, `${filters.updated_to}T00:00:00.000Z`)}::timestamptz + interval '1 day')`);
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
  const where = buildWhere({
    ...filters,
    state: filters.manual ? OPERATIONAL_STATES.join(",") : null,
    caller_id: null,
    assigned_to: null,
    has_assignee: false,
    include_unassigned: false,
  }, values, {
    includeState: Boolean(filters.manual),
    includeUnassigned: false,
  });
  const specs = [
    ["callers", "caller_id", "caller_id"],
    ["assignees", "assigned_to", "assigned_to"],
    ["companies", "company", "company"],
    ["contact_types", "coalesce(nullif(btrim(contact_type::text), ''), '__blank')", "contact_type"],
    ["states", "state", "state"],
    ["priorities", "priority", "priority"],
    ["assignment_groups", "assignment_group", "assignment_group"],
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
  const where = buildWhere({
    ...filters,
    state: filters.manual ? OPERATIONAL_STATES.join(",") : null,
    unassigned: false,
  }, values, {
    includeState: Boolean(filters.manual),
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

async function fetchGlobalCounts(pool) {
  const values = [];
  const where = buildWhere({}, values, { includeState: false, includeUnassigned: false });
  const operationalStates = addParam(values, OPERATIONAL_STATES);
  const zabbixCaller = addParam(values, ZABBIX_MONITORING_CALLER_ID);
  const result = await pool.query(`
    select count(*)::int as total,
      count(*) filter (where state::text = '1')::int as open,
      count(*) filter (where state::text = '2')::int as in_progress,
      count(*) filter (where state::text = '6')::int as resolved,
      count(*) filter (where state::text = '7')::int as closed,
      count(*) filter (where coalesce(btrim(assigned_to::text), '') = '' and state::text = any(${operationalStates}::text[]))::int as unassigned,
      count(*) filter (
        where state::text = any(${operationalStates}::text[])
          and (caller_id is null or btrim(caller_id::text) = '' or lower(btrim(caller_id::text)) <> ${zabbixCaller})
      )::int as manual
    from servicenow_incidents where ${where}`, values);
  return result.rows[0] || {
    total: 0,
    open: 0,
    in_progress: 0,
    resolved: 0,
    closed: 0,
    unassigned: 0,
    manual: 0,
  };
}

const TAG_ARRAY_MATCH_SQL = (column, tagName, reference) => `
  exists (
    select 1
      from jsonb_array_elements(
        case when jsonb_typeof(coalesce(a.${column}, '[]'::jsonb)) = 'array'
          then a.${column} else '[]'::jsonb end
      ) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = '${tagName}'
       and lower(btrim(coalesce(tag->>'value', ''))) = lower(${reference})
  )
`;

function explicitTagMatchSql(tagName, reference) {
  return `(
    ${TAG_ARRAY_MATCH_SQL("event_tags", tagName, reference)}
    or ${TAG_ARRAY_MATCH_SQL("trigger_tags", tagName, reference)}
    or ${TAG_ARRAY_MATCH_SQL("host_tags", tagName, reference)}
    or exists (
      select 1
        from jsonb_array_elements(
          case when jsonb_typeof(a.payload_normalized->'tags') = 'array'
            then a.payload_normalized->'tags' else '[]'::jsonb end
        ) tag
       where lower(coalesce(tag->>'tag', tag->>'name', '')) = '${tagName}'
         and lower(btrim(coalesce(tag->>'value', ''))) = lower(${reference})
    )
    or lower(btrim(coalesce(a.payload_normalized->'tags'->>'${tagName}', ''))) = lower(${reference})
  )`;
}

/**
 * Resolves one page in one SQL query — not an alert lookup per incident.
 * Priority remains explicit sys_id, then INC number, then original Zabbix
 * event parsed from the persisted description, then host dedicado (MAPS).
 */
export async function findReadModelRelatedAlerts(rows, { pool = getOneViewDbPool() } = {}) {
  const references = (rows || []).map((row) => {
    const parsed = parseZabbixFieldsFromDescription(row.description);
    const colonHead = parseColonHostProblemLine(row.description);
    const bridge = matchServiceNowOperationalBridgeFromRow(row);
    return {
      sys_id: text(row.sys_id)?.toLowerCase() || null,
      number: text(row.number)?.toUpperCase() || null,
      zabbix_event_id: parsed.zabbix_event_id,
      zabbix_host: text(row.u_hostname_zabbix) || colonHead.host || parsed.zabbix_host,
      zabbix_problem: text(colonHead.problem)?.slice(0, 200) || null,
      bridge_datasource: bridge?.datasource || null,
    };
  }).filter((row) => row.sys_id);
  if (!references.length) return new Map();

  const result = await pool.query(`
    with incident_refs as (
      select lower(btrim(sys_id)) as sys_id,
             upper(btrim(number)) as number,
             nullif(btrim(zabbix_event_id), '') as zabbix_event_id,
             nullif(btrim(zabbix_host), '') as zabbix_host,
             nullif(btrim(bridge_datasource), '') as bridge_datasource,
             nullif(btrim(zabbix_problem), '') as zabbix_problem
        from jsonb_to_recordset($1::jsonb)
          as ref(sys_id text, number text, zabbix_event_id text, zabbix_host text, bridge_datasource text, zabbix_problem text)
    ), candidates as (
      select r.sys_id as incident_sys_id, 1 as precedence,
             a.id::text as id, d.name::text as datasource, a.severity,
             coalesce(a.host_visible_name, a.host_technical_name, a.host_name)::text as host,
             coalesce(a.customer_name, a.client_name)::text as customer,
             coalesce(a.problem_name, a.trigger_description)::text as problem,
             a.source_event_id::text as source_event_id,
             coalesce(a.status_source, case when a.resolved_at is null then 'active' else 'resolved' end)::text as status,
             a.last_seen_at, a.updated_at
        from incident_refs r
        join alerts a on r.sys_id is not null
        left join data_sources d on d.id = a.data_source_id
       where ${explicitTagMatchSql("__zbx_servicenow_sys_id", "r.sys_id")}
      union all
      select r.sys_id as incident_sys_id, 2 as precedence,
             a.id::text as id, d.name::text as datasource, a.severity,
             coalesce(a.host_visible_name, a.host_technical_name, a.host_name)::text as host,
             coalesce(a.customer_name, a.client_name)::text as customer,
             coalesce(a.problem_name, a.trigger_description)::text as problem,
             a.source_event_id::text as source_event_id,
             coalesce(a.status_source, case when a.resolved_at is null then 'active' else 'resolved' end)::text as status,
             a.last_seen_at, a.updated_at
        from incident_refs r
        join alerts a on r.number is not null
        left join data_sources d on d.id = a.data_source_id
       where ${explicitTagMatchSql("__zbx_servicenow_number", "r.number")}
      union all
      select r.sys_id as incident_sys_id, 3 as precedence,
             a.id::text as id, d.name::text as datasource, a.severity,
             coalesce(a.host_visible_name, a.host_technical_name, a.host_name)::text as host,
             coalesce(a.customer_name, a.client_name)::text as customer,
             coalesce(a.problem_name, a.trigger_description)::text as problem,
             a.source_event_id::text as source_event_id,
             coalesce(a.status_source, case when a.resolved_at is null then 'active' else 'resolved' end)::text as status,
             a.last_seen_at, a.updated_at
        from incident_refs r
        join alerts a on r.zabbix_event_id is not null
                   and (a.source_event_id::text = r.zabbix_event_id or a.source_problem_id::text = r.zabbix_event_id)
        left join data_sources d on d.id = a.data_source_id
      union all
      select r.sys_id as incident_sys_id, 4 as precedence,
             a.id::text as id, d.name::text as datasource, a.severity,
             coalesce(a.host_visible_name, a.host_technical_name, a.host_name)::text as host,
             coalesce(a.customer_name, a.client_name)::text as customer,
             coalesce(a.problem_name, a.trigger_description)::text as problem,
             a.source_event_id::text as source_event_id,
             coalesce(a.status_source, case when a.resolved_at is null then 'active' else 'resolved' end)::text as status,
             a.last_seen_at, a.updated_at
        from incident_refs r
        join data_sources d on r.bridge_datasource is not null
                         and lower(d.name) = lower(r.bridge_datasource)
        join alerts a on r.zabbix_host is not null
                     and (
                       lower(btrim(coalesce(a.host_technical_name, ''))) = lower(r.zabbix_host)
                       or lower(btrim(coalesce(a.host_name, ''))) = lower(r.zabbix_host)
                       or lower(btrim(coalesce(a.host_visible_name, ''))) = lower(r.zabbix_host)
                     )
                     and a.data_source_id = d.id
                     and (
                       r.zabbix_problem is null
                       or lower(coalesce(a.problem_name, a.trigger_description, '')) like '%' || lower(r.zabbix_problem) || '%'
                     )
    ), ranked as (
      select distinct on (incident_sys_id) *
        from candidates
       order by incident_sys_id, precedence, last_seen_at desc nulls last, updated_at desc nulls last, id desc
    )
    select * from ranked
  `, [JSON.stringify(references)]);

  return new Map(result.rows.map((row) => [
    String(row.incident_sys_id || "").toLowerCase(),
    {
      id: text(row.id),
      datasource: text(row.datasource),
      severity: text(row.severity),
      host: text(row.host),
      customer: text(row.datasource) === "maps" ? "MAPS" : text(row.customer),
      problem: text(row.problem),
      source_event_id: text(row.source_event_id),
      status: text(row.status),
      relation_source: ["sys_id", "number", "source_event", "operational_host"][Number(row.precedence) - 1] || null,
    },
  ]));
}

const INCIDENT_SUGGEST_INC_PREFIX_RE = /^INC\d*$/i;

function truncateLabel(value, max = 120) {
  const output = text(value);
  if (!output) return "";
  return output.length <= max ? output : `${output.slice(0, max - 1)}…`;
}

/**
 * Sugestões de busca na fila de chamados (read model PostgreSQL, read-only).
 * Respeita filtros da tela exceto search/number.
 */
export async function searchReadModelIncidentSuggestions(filters, {
  q,
  limit = 8,
  pool = getOneViewDbPool(),
} = {}) {
  const query = String(q || "").trim();
  if (query.length < 2) return { suggestions: [] };
  const cap = Math.min(Math.max(Number(limit) || 8, 1), 15);
  const scopeFilters = { ...filters, search: null, number: null, sys_id: null };
  const suggestions = [];

  if (INCIDENT_SUGGEST_INC_PREFIX_RE.test(query)) {
    const values = [];
    const where = buildWhere(scopeFilters, values);
    const prefixParam = addParam(values, `${query.toUpperCase()}%`);
    const result = await pool.query(`
      select number::text as number,
             coalesce(display_values->>'company_display', display_values->>'company', company::text) as company_label,
             coalesce(short_description, '') as short_description
        from servicenow_incidents
       where ${where}
         and upper(number::text) like ${prefixParam}
       order by sys_updated_on desc nulls last, number asc
       limit $${values.length + 1}`, [...values, cap]);
    for (const row of result.rows) {
      const number = text(row.number);
      if (!number) continue;
      suggestions.push({
        kind: "number",
        value: number,
        label: number,
        number,
        company: text(row.company_label),
      });
    }
    return { suggestions };
  }

  const values = [];
  const where = buildWhere(scopeFilters, values);
  const likeParam = addParam(values, `%${query}%`);
  const incidentLimit = Math.min(5, cap);
  const companyLimit = Math.min(6, cap);
  const descriptionLimit = Math.min(4, cap);
  const hostLimit = Math.min(5, cap);

  const [incidentRows, companyRows, descriptionRows, hostRows] = await Promise.all([
    pool.query(`
      select number::text as number,
             coalesce(display_values->>'company_display', display_values->>'company', company::text) as company_label,
             coalesce(short_description, '') as short_description
        from servicenow_incidents
       where ${where}
         and (number::text ilike ${likeParam} or coalesce(short_description, '') ilike ${likeParam})
       order by sys_updated_on desc nulls last, number asc
       limit $${values.length + 1}`, [...values, incidentLimit]),
    pool.query(`
      select distinct coalesce(display_values->>'company_display', display_values->>'company', company::text) as company_label
        from servicenow_incidents
       where ${where}
         and coalesce(display_values->>'company_display', display_values->>'company', company::text) ilike ${likeParam}
       order by company_label asc
       limit $${values.length + 1}`, [...values, companyLimit]),
    pool.query(`
      select distinct on (left(coalesce(short_description, ''), 120))
             number::text as number,
             coalesce(short_description, '') as short_description
        from servicenow_incidents
       where ${where}
         and coalesce(short_description, '') ilike ${likeParam}
       order by left(coalesce(short_description, ''), 120), sys_updated_on desc nulls last
       limit $${values.length + 1}`, [...values, descriptionLimit]),
    pool.query(`
      select distinct coalesce(u_hostname_zabbix::text, '') as host_label
        from servicenow_incidents
       where ${where}
         and coalesce(u_hostname_zabbix::text, '') ilike ${likeParam}
       order by host_label asc
       limit $${values.length + 1}`, [...values, hostLimit]),
  ]);

  const raw = [];
  for (const row of companyRows.rows) {
    const company = text(row.company_label);
    if (!company) continue;
    raw.push({ kind: "company", value: company, label: company, company, hint: "Filtrar por cliente" });
  }
  for (const row of hostRows.rows) {
    const host = text(row.host_label);
    if (!host) continue;
    raw.push({ kind: "host", value: host, label: host, hint: "Filtrar por host Zabbix" });
  }
  for (const row of incidentRows.rows) {
    const number = text(row.number);
    if (!number) continue;
    const company = text(row.company_label);
    raw.push({
      kind: "number",
      value: number,
      label: number,
      number,
      company,
      hint: company ? `Chamado · ${company}` : "Filtrar por número INC",
    });
  }
  for (const row of descriptionRows.rows) {
    const description = truncateLabel(row.short_description, 120);
    if (!description) continue;
    raw.push({
      kind: "description",
      value: description,
      label: description,
      number: text(row.number),
      hint: text(row.number) ? `Descrição · ${text(row.number)}` : "Filtrar por descrição",
    });
  }

  return { suggestions: mergeRankedSuggestions(raw, query, cap) };
}

export async function fetchReadModelIncidentsPage(filters, {
  pool = getOneViewDbPool(),
  relatedAlertResolver = findReadModelRelatedAlerts,
} = {}) {
  // Keep the invariant at the read-model boundary too. The public BFF already
  // normalizes this, but callers of this helper must never widen Manuais to a
  // historical state by passing a different `state` value.
  const effectiveFilters = filters?.manual
    ? { ...filters, state: OPERATIONAL_STATES.join(",") }
    : filters;
  const values = [];
  const where = buildWhere(effectiveFilters, values);
  const exactLookup = Boolean(effectiveFilters.number || effectiveFilters.sys_id);
  const offset = exactLookup ? 0 : (effectiveFilters.page - 1) * effectiveFilters.page_size;
  const orderSql = incidentOrderSql(effectiveFilters);
  const [pageResult, countResult, counts, globalCounts, facets, syncResult] = await Promise.all([
    pool.query(`
      select ${READ_MODEL_INCIDENT_SELECT}, ${identityConflictSelect()}
        from servicenow_incidents
       where ${where}
       order by ${orderSql}
       limit $${values.length + 1} offset $${values.length + 2}`,
    [...values, effectiveFilters.page_size, offset]),
    pool.query(`select count(*)::int as total from servicenow_incidents where ${where}`, values),
    effectiveFilters.include_counts === false ? Promise.resolve(null) : fetchCounts(pool, effectiveFilters),
    effectiveFilters.include_global_counts === false ? Promise.resolve(null) : fetchGlobalCounts(pool),
    effectiveFilters.include_facets === false ? Promise.resolve(null) : fetchFacets(pool, effectiveFilters),
    pool.query("select last_success_at, watermark_sys_updated_on from servicenow_sync_state where sync_key = 'incident' limit 1"),
  ]);
  // Tag correlation is intentionally a detail lookup: the current alerts
  // schema has no index for ServiceNow tag JSON. Running it for every recent
  // incident would turn the operational queue into a slow scan. Exact GETs
  // may opt in and still execute one bounded batch, never one query per row.
  const shouldResolveRelatedAlerts = Boolean(effectiveFilters.include_related_alert && exactLookup);
  const relatedAlerts = shouldResolveRelatedAlerts
    ? await relatedAlertResolver(pageResult.rows, { pool })
    : new Map();
  const totalItems = Number(countResult.rows?.[0]?.total || 0);
  const totalPages = totalItems ? Math.ceil(totalItems / effectiveFilters.page_size) : 0;
  const effectivePage = exactLookup ? 1 : effectiveFilters.page;
  return {
    items: pageResult.rows.map((row) => mapReadModelIncident(row, {
      relatedAlert: relatedAlerts.get(String(row.sys_id || "").toLowerCase()) || null,
    })),
    pagination: {
      page: effectivePage,
      page_size: effectiveFilters.page_size,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: effectivePage < totalPages,
      has_previous: effectivePage > 1 && totalPages > 0,
    },
    filters: effectiveFilters,
    ...(counts ? { counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value) || 0])) } : {}),
    ...(globalCounts ? { global_counts: Object.fromEntries(Object.entries(globalCounts).map(([key, value]) => [key, Number(value) || 0])) } : {}),
    ...(facets ? { facets } : {}),
    data_source: "postgresql",
    checked_at: new Date().toISOString(),
    freshness: {
      last_success_at: syncResult.rows?.[0]?.last_success_at?.toISOString?.() || syncResult.rows?.[0]?.last_success_at || null,
      watermark_sys_updated_on: syncResult.rows?.[0]?.watermark_sys_updated_on?.toISOString?.() || syncResult.rows?.[0]?.watermark_sys_updated_on || null,
    },
  };
}

async function findBy(pool, where, values, { alertEpisodeStartedAt = null } = {}) {
  const result = await pool.query(`
    select ${READ_MODEL_INCIDENT_SELECT}, ${identityConflictSelect()}
      from servicenow_incidents where ${where}
     order by sys_updated_on desc nulls last, sys_id asc limit 50`, values);
  return result.rows
    .filter((row) => isIncidentCurrentForAlertEpisode(row, alertEpisodeStartedAt))
    .map((row) => mapReadModelIncident(row));
}

async function findMapsIncidentsByOperationalAlert(
  { hostName, problemName, alertEpisodeStartedAt = null } = {},
  { pool = getOneViewDbPool() } = {},
) {
  const host = text(hostName);
  const problem = text(problemName)?.slice(0, 200) || null;
  // MAPS is host/description fallback: no episode start means no safe match.
  if (!host || utcEpochMilliseconds(alertEpisodeStartedAt) == null) return [];
  const result = await pool.query(
    `
    select ${READ_MODEL_INCIDENT_SELECT}, ${identityConflictSelect()}
      from servicenow_incidents
     where ${MAPS_SERVICENOW_COMPANY_WHERE_SQL}
       and (
         lower(btrim(coalesce(u_hostname_zabbix::text, ''))) = lower($1)
         or lower(coalesce(description, '')) like '%' || lower($1) || '%'
       )
       and (
         $2::text is null
         or lower(coalesce(description, '')) like '%' || lower($2::text) || '%'
       )
     order by sys_updated_on desc nulls last, sys_id asc
     limit 10
    `,
    [host, problem],
  );
  return (result.rows || [])
    .filter((row) => isIncidentCurrentForAlertEpisode(row, alertEpisodeStartedAt))
    .map((row) => mapReadModelIncident(row));
}

export async function findReadModelRelatedIncidents({
  incidentSysIds = [],
  tagIncidentNumbers = [],
  incidentNumbers = [],
  sourceEventId = null,
  alertEpisodeStartedAt = null,
  mapsDatasource = null,
  mapsHost = null,
  mapsProblemName = null,
} = {}, { pool = getOneViewDbPool() } = {}) {
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
    const incidents = await findBy(pool, where, values, { alertEpisodeStartedAt });
    if (incidents.length) return { matched: true, relation_source: relationSource, incidents };
  }
  if (String(mapsDatasource || "").trim().toLowerCase() === "maps") {
    const incidents = await findMapsIncidentsByOperationalAlert(
      { hostName: mapsHost, problemName: mapsProblemName, alertEpisodeStartedAt },
      { pool },
    );
    if (incidents.length) {
      return { matched: true, relation_source: "operational_host", incidents };
    }
  }
  return { matched: false, relation_source: "none", incidents: [] };
}
