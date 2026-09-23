/**
 * OV-P0-262A — ServiceNow possible-duplicate incident READ model.
 * Mirrors Snow Notifier normalizeDesc / findDuplicates. READ ONLY.
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewDbPool } from "./oneview-db.js";
import {
  findReadModelRelatedAlerts,
  mapReadModelIncident,
} from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

export const DUPLICATE_CLASSIFICATION = "POSSIBLE_DUPLICATE";

/** Extension open universe: state NOT IN resolved(6), closed(7), cancelled(8). */
export const OPEN_INCIDENT_STATES_EXCLUDED = Object.freeze(["6", "7", "8"]);

const SAFE_FILTER = /^[a-zA-Z0-9._:@/\- ]{1,120}$/;
const SAFE_STATE = /^[0-9,]{1,40}$/;
const SAFE_PRIORITY = /^[1-5]$/;
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;

const DUPLICATE_INCIDENT_SELECT = `
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
  coalesce(raw_payload->'contract'->>'value', nullif(raw_payload->>'contract', '')) as contract,
  exists (
    select 1 from servicenow_incidents duplicate
     where duplicate.number::text = servicenow_incidents.number::text
       and duplicate.sys_id::text <> servicenow_incidents.sys_id::text
  ) as identity_conflict
`;

function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function oneQuery(req, key) {
  const value = req?.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function toMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createdAtMs(incident) {
  return toMs(incident?.sys_created_on || incident?.opened_at || incident?.openedAt);
}

function updatedAtMs(incident) {
  return toMs(incident?.sys_updated_on || incident?.updatedAt || incident?.opened_at);
}

/**
 * Exact Snow Notifier equivalent (popup.js normalizeDesc):
 * 1) strip leading emoji / misc symbols
 * 2) remove [PROBLEM]|[RESOLVED]|[OK] anywhere (case-insensitive)
 * 3) trim
 * 4) lowercase
 */
export function normalizeDuplicateDescription(shortDescription) {
  return String(shortDescription ?? "")
    .replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27FF}]+/gu, "")
    .replace(/\[(PROBLEM|RESOLVED|OK)\]/gi, "")
    .trim()
    .toLowerCase();
}

function toDuplicateIncidentCard(mapped, { createdAt = null } = {}) {
  const related = mapped?.relatedAlert || null;
  return {
    sysId: mapped?.sysId || mapped?.sys_id || null,
    number: mapped?.number || null,
    shortDescription: mapped?.shortDescription || mapped?.short_description || null,
    customer: mapped?.customer || mapped?.company_display || mapped?.company || null,
    state: mapped?.state_display || mapped?.state || null,
    stateCode: mapped?.state || null,
    priority: mapped?.priority_display || mapped?.priority || null,
    priorityCode: mapped?.priority || null,
    assignedTo: mapped?.assignedTo || mapped?.assigned_to_display || null,
    assignedToId: mapped?.assignedToId || mapped?.assigned_to || null,
    assignmentGroup:
      mapped?.assignmentGroup || mapped?.assignment_group_display || mapped?.assignment_group || null,
    createdAt: createdAt || mapped?.openedAt || mapped?.opened_at || null,
    updatedAt: mapped?.updatedAt || mapped?.sys_updated_on || null,
    relatedAlert: related
      ? {
          alertId: related.alertId || null,
          severity: related.severity || null,
          host: related.host || null,
          link: related.link || null,
          problem: related.problem || null,
          status: related.status || null,
        }
      : null,
    servicenowUrl: mapped?.servicenow_url || null,
    identityConflict: Boolean(mapped?.identity_conflict),
  };
}

/**
 * Pure grouping — extension findDuplicates semantics.
 * primary = newest by sys_created_on (fallback opened_at).
 */
export function buildPossibleDuplicateGroups(incidents) {
  const buckets = new Map();
  for (const incident of incidents || []) {
    const shortDescription = incident.short_description ?? incident.shortDescription ?? "";
    const duplicateKey = normalizeDuplicateDescription(shortDescription);
    if (!duplicateKey) continue;
    if (!buckets.has(duplicateKey)) buckets.set(duplicateKey, []);
    buckets.get(duplicateKey).push(incident);
  }

  const groups = [];
  for (const [duplicateKey, members] of buckets.entries()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      const createdDiff = createdAtMs(b) - createdAtMs(a);
      if (createdDiff !== 0) return createdDiff;
      return String(b.number || "").localeCompare(String(a.number || ""));
    });
    groups.push({
      duplicateKey,
      duplicateCount: sorted.length,
      classification: DUPLICATE_CLASSIFICATION,
      primaryIncident: sorted[0],
      relatedIncidents: sorted.slice(1),
      _groupUpdatedAtMs: Math.max(...sorted.map((item) => updatedAtMs(item))),
    });
  }

  groups.sort((a, b) => {
    const updatedDiff = (b._groupUpdatedAtMs || 0) - (a._groupUpdatedAtMs || 0);
    if (updatedDiff !== 0) return updatedDiff;
    return String(b.duplicateKey).localeCompare(String(a.duplicateKey));
  });

  return groups.map(({ _groupUpdatedAtMs, ...group }) => group);
}

function invalidQuery(code = "invalid_query") {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function parseDuplicateFilters(req) {
  const company = text(oneQuery(req, "customer") || oneQuery(req, "company") || oneQuery(req, "client"));
  const assignedTo = text(oneQuery(req, "assigned_to"));
  const assignmentGroup = text(oneQuery(req, "assignment_group"));
  const priority = text(oneQuery(req, "priority"));
  const state = text(oneQuery(req, "state"));

  if (company && !SAFE_FILTER.test(company)) throw invalidQuery("invalid_customer");
  if (assignmentGroup && !(SAFE_SYS_ID.test(assignmentGroup) || SAFE_FILTER.test(assignmentGroup))) {
    throw invalidQuery("invalid_assignment_group");
  }
  if (priority && !SAFE_PRIORITY.test(priority)) throw invalidQuery("invalid_priority");
  if (state && !SAFE_STATE.test(state)) throw invalidQuery("invalid_state");

  let assignedToFilter = null;
  if (assignedTo) {
    const tokens = assignedTo.split(",").map((item) => item.trim()).filter(Boolean);
    if (!tokens.length) throw invalidQuery("invalid_assigned_to");
    for (const token of tokens) {
      if (!(SAFE_SYS_ID.test(token) || SAFE_FILTER.test(token))) throw invalidQuery("invalid_assigned_to");
    }
    assignedToFilter = tokens.map((token) => (SAFE_SYS_ID.test(token) ? token.toLowerCase() : token));
  }

  return {
    company,
    assigned_to: assignedToFilter,
    assignment_group: assignmentGroup,
    priority,
    state: state ? state.split(",").map((item) => item.trim()).filter(Boolean) : null,
  };
}

function buildOpenUniverseWhere(filters, values) {
  const clauses = [
    "coalesce(contact_type::text, '') = 'monitoring'",
    `state::text <> all($${values.length + 1}::text[])`,
  ];
  values.push([...OPEN_INCIDENT_STATES_EXCLUDED]);

  if (filters.state?.length) {
    values.push(filters.state);
    clauses.push(`state::text = any($${values.length}::text[])`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    clauses.push(`priority::text = $${values.length}`);
  }
  if (filters.assignment_group) {
    values.push(filters.assignment_group);
    clauses.push(`assignment_group::text = $${values.length}`);
  }
  if (filters.assigned_to?.length) {
    values.push(filters.assigned_to.map((id) => id.toLowerCase()));
    clauses.push(`lower(assigned_to::text) = any($${values.length}::text[])`);
  }
  if (filters.company) {
    values.push(`%${filters.company}%`);
    clauses.push(
      `(company::text ilike $${values.length} or coalesce(display_values::text, '') ilike $${values.length})`,
    );
  }
  return clauses.join(" and ");
}

export async function fetchPossibleDuplicateGroups({
  filters = {},
  pool = getOneViewDbPool(),
  relatedAlertResolver = findReadModelRelatedAlerts,
  includeRelatedAlerts = true,
} = {}) {
  const started = Date.now();
  const values = [];
  const where = buildOpenUniverseWhere(filters, values);
  const result = await pool.query(
    `
    select ${DUPLICATE_INCIDENT_SELECT}
      from servicenow_incidents
     where ${where}
     order by sys_created_on desc nulls last, number desc
    `,
    values,
  );

  const rows = result.rows || [];
  const enriched = rows.map((row) => {
    const mapped = mapReadModelIncident(row);
    return {
      ...mapped,
      sys_created_on: toIso(row.sys_created_on) || mapped.opened_at,
      short_description: mapped.short_description,
    };
  });

  const rawGroups = buildPossibleDuplicateGroups(enriched);
  const rowBySysId = new Map(rows.map((row) => [String(row.sys_id || "").toLowerCase(), row]));

  const primaryRows = rawGroups
    .map((group) => {
      const sysId = String(group.primaryIncident.sys_id || group.primaryIncident.sysId || "").toLowerCase();
      return rowBySysId.get(sysId) || null;
    })
    .filter(Boolean);

  const relatedAlerts = includeRelatedAlerts && primaryRows.length
    ? await relatedAlertResolver(primaryRows, { pool })
    : new Map();

  const groups = rawGroups.map((group) => {
    const primarySysId = String(
      group.primaryIncident.sys_id || group.primaryIncident.sysId || "",
    ).toLowerCase();
    const primaryRow = rowBySysId.get(primarySysId);
    const primary = toDuplicateIncidentCard(
      primaryRow
        ? mapReadModelIncident(primaryRow, {
            relatedAlert: relatedAlerts.get(primarySysId) || null,
          })
        : group.primaryIncident,
      { createdAt: group.primaryIncident.sys_created_on || group.primaryIncident.opened_at },
    );

    const relatedIncidents = group.relatedIncidents.map((item) => {
      const sysId = String(item.sys_id || item.sysId || "").toLowerCase();
      const row = rowBySysId.get(sysId);
      return toDuplicateIncidentCard(row ? mapReadModelIncident(row) : item, {
        createdAt: item.sys_created_on || item.opened_at,
      });
    });

    return {
      duplicateKey: group.duplicateKey,
      duplicateCount: group.duplicateCount,
      classification: DUPLICATE_CLASSIFICATION,
      shortDescription: primary.shortDescription,
      primaryIncident: primary,
      relatedIncidents,
    };
  });

  const incidentsInGroups = groups.reduce((sum, group) => sum + group.duplicateCount, 0);
  const largestGroup = groups.reduce((max, group) => Math.max(max, group.duplicateCount), 0);

  return {
    classification: DUPLICATE_CLASSIFICATION,
    open_universe: {
      contact_type: "monitoring",
      state_not_in: [...OPEN_INCIDENT_STATES_EXCLUDED],
    },
    groups,
    stats: {
      evaluated_incidents: enriched.length,
      duplicate_groups: groups.length,
      incidents_in_duplicate_groups: incidentsInGroups,
      largest_group: largestGroup,
      bff_ms: Math.max(Date.now() - started, 0),
    },
    data_source: "postgresql",
    checked_at: new Date().toISOString(),
    write_actions: {
      auto_close: false,
      parent_incident_mutation: false,
      servicenow_write: false,
    },
  };
}

export function createIncidentDuplicatesHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  fetchGroups = fetchPossibleDuplicateGroups,
} = {}) {
  return async function incidentDuplicatesHandler(req, res) {
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    let filters;
    try {
      filters = parseDuplicateFilters(req);
    } catch {
      return sendJson(res, 400, {
        error: "invalid_query",
        classification: DUPLICATE_CLASSIFICATION,
        data_source: "postgresql",
      });
    }

    try {
      const payload = await fetchGroups({ filters });
      return sendJson(res, 200, payload);
    } catch (error) {
      console.error("[oneview-incident-duplicates]", String(error?.message || error).slice(0, 200));
      return sendJson(res, 503, {
        error: "database_unavailable",
        classification: DUPLICATE_CLASSIFICATION,
        data_source: "postgresql",
      });
    }
  };
}

export default createIncidentDuplicatesHandler();
