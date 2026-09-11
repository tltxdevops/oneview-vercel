import { randomUUID } from "node:crypto";

import { insertAuditLog } from "./audit.js";
import { getId, methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { classifyActionsFailure, withOneViewActionsQuery, withOneViewActionsTransaction } from "./oneview-actions-db.js";
import { fetchCanonicalLinkDetail } from "./oneview-links.js";

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,239}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ["scheduled", "processing"];

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function queryValue(req, key) { const value = req?.query?.[key]; return text(Array.isArray(value) ? value[0] : value); }
function requestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try { const parsed = JSON.parse(String(req.body)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function publicDatabaseError(error) { return error?.code === "actions_database_not_configured" ? "actions_database_not_configured" : "database_unavailable"; }
function rowValue(value) { if (!value || typeof value !== "string") return value || null; try { return JSON.parse(value); } catch { return null; } }
function reminderRecord(row) {
  return {
    id: row.id, circuit_key: row.circuit_key, data_source_id: row.data_source_id, source_host_id: row.source_host_id || null,
    scheduled_for: new Date(row.scheduled_for).toISOString(), status: row.status,
    created_by: row.created_by, created_by_name: row.created_by_name,
    initial_alert_id: row.initial_alert_id || null, initial_incident_sys_id: row.initial_incident_sys_id || null,
    initial_incident_number: row.initial_incident_number || null, context_snapshot: rowValue(row.context_snapshot) || {},
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    cancelled_at: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    skipped_at: row.skipped_at ? new Date(row.skipped_at).toISOString() : null,
    skip_reason: row.skip_reason || null,
    last_error: row.last_error || null,
    activity_at: row.activity_at ? new Date(row.activity_at).toISOString() : null,
  };
}
function identity(req) {
  const id = text(getId(req, "id")); const dataSourceId = queryValue(req, "data_source_id"); const sourceHostId = queryValue(req, "source_host_id");
  return id && dataSourceId && sourceHostId && [id, dataSourceId, sourceHostId].every((value) => SAFE_ID.test(value)) ? { id, dataSourceId, sourceHostId } : null;
}
function futureTimestamp(value, now) {
  const raw = text(value);
  if (!raw || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null;
}
function reminderId(req, body) { const value = text(body.reminder_id || queryValue(req, "reminder_id")); return UUID.test(value) ? value : ""; }
function actor(auth) { return { id: text(auth?.id).slice(0, 120), name: text(auth?.name || auth?.email || "UsuÃ¡rio SSO").slice(0, 120) }; }
function currentCircuit(link, requested) {
  const circuitKey = text(link?.circuit_key || link?.technical?.circuit_key);
  if (!link || circuitKey !== requested.id || text(link.data_source_id) !== requested.dataSourceId || text(link.source_host_id) !== requested.sourceHostId) return null;
  if (!(Number(link.active_alerts) > 0 || link.has_active_alert === true)) return null;
  return link;
}
function snapshot(link) {
  const alert = link.current_alert || null; const incident = link.current_incident || null;
  return {
    circuit: { circuit_key: link.circuit_key, data_source_id: link.data_source_id, source_host_id: link.source_host_id, host_name: link.host_name || null },
    customer: { key: link.customer_key || null, name: link.customer_name || null },
    link: { service_name: link.service_name || null, carrier_name: link.carrier_name || null, link_type: link.link_type || null, member_key: link.member_key || null, uplink_key: link.uplink_key || null },
    alert: alert ? { id: alert.id || null, problem_name: alert.problem_name || null, severity: alert.severity || null } : null,
    incident: incident ? { sys_id: incident.sys_id || null, number: incident.number || null, state: incident.state || null } : null,
  };
}
const SELECT_COLUMNS = `id, circuit_key, data_source_id, source_host_id, scheduled_for, status, created_by, created_by_name,
  initial_alert_id, initial_incident_sys_id, initial_incident_number, context_snapshot, created_at, updated_at,
  sent_at, cancelled_at, skipped_at, skip_reason, last_error`;

export function createOperatorReminderHandler({
  authorize = (req, res, role) => requireOneViewAuth(req, res, role),
  query = withOneViewActionsQuery,
  transaction = withOneViewActionsTransaction,
  resolveLink = fetchCanonicalLinkDetail,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function operatorReminderHandler(req, res) {
    const startedAt = Date.now();
    const method = String(req.method || "UNKNOWN").toUpperCase();
    let operation = method === "GET" ? "list" : "create";
    const reply = (status, payload, extra = {}) => {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/links/:id/reminders",
        method,
        operation,
        status,
        error_code: typeof payload?.error === "string" ? payload.error : null,
        cause: extra.cause || null,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return sendJson(res, status, payload);
    };
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
    const requested = identity(req);
    if (!requested) return reply(400, { error: "invalid_query" });
    const auth = await authorize(req, res, req.method === "GET" ? "viewer" : "operator");
    if (!auth) {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/links/:id/reminders",
        method,
        status: res.statusCode || 401,
        error_code: res.statusCode === 403 ? "authorization_denied" : "authentication_required",
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return;
    }
    const user = actor(auth);
    if (!user.id) return reply(401, { error: "authentication_required" });

    try {
      if (req.method === "GET") {
        const result = await query(async (client) => client.query(
          `select ${SELECT_COLUMNS} from operator_reminders where circuit_key = $1 and data_source_id = $2 and source_host_id = $3 and status = any($4::text[]) order by scheduled_for asc`,
          [requested.id, requested.dataSourceId, requested.sourceHostId, ACTIVE_STATUSES],
        ));
        return reply(200, { items: result.rows.map(reminderRecord) });
      }

      const body = requestBody(req);
      operation = text(body.action).toLowerCase() || "create";
      if (!["create", "update", "cancel"].includes(operation)) return reply(400, { error: "invalid_reminder_action" });
      const scheduledFor = futureTimestamp(body.scheduled_for, now());
      if (operation === "create") {
        if (!scheduledFor) return reply(400, { error: "invalid_scheduled_for" });
        const link = currentCircuit(await resolveLink(requested), requested);
        if (!link) return reply(409, { error: "circuit_not_active" });
        const context = snapshot(link); const id = idFactory(); const createdAt = now();
        const result = await transaction(async (client) => {
          const inserted = await client.query(
            `insert into operator_reminders (
              id, circuit_key, data_source_id, source_host_id, scheduled_for, status, created_by, created_by_name,
              initial_alert_id, initial_incident_sys_id, initial_incident_number, context_snapshot, created_at, updated_at
            ) values ($1,$2,$3,$4,$5,'scheduled',$6,$7,$8,$9,$10,$11::jsonb,$12,$12) returning ${SELECT_COLUMNS}`,
            [id, requested.id, requested.dataSourceId, requested.sourceHostId, scheduledFor, user.id, user.name,
              context.alert?.id || null, context.incident?.sys_id || null, context.incident?.number || null, JSON.stringify(context), createdAt],
          );
          const row = inserted.rows[0];
          await insertAuditLog(client, { actorName: user.name, actorId: user.id, actorType: "sso_user", action: "REMINDER_CREATED", entityType: "operator_reminder", entityId: id, dataSourceId: requested.dataSourceId, alertId: context.alert?.id || null, afterData: { status: "scheduled", scheduled_for: scheduledFor.toISOString() }, metadata: { circuit_key: requested.id, source_host_id: requested.sourceHostId }, req });
          return row;
        });
        return reply(201, { item: reminderRecord(result) });
      }

      const id = reminderId(req, body);
      if (!id) return reply(400, { error: "invalid_reminder_id" });
      if (operation === "update" && !scheduledFor) return reply(400, { error: "invalid_scheduled_for" });
      const result = await transaction(async (client) => {
        const existingResult = await client.query(
          `select ${SELECT_COLUMNS} from operator_reminders where id = $1 and circuit_key = $2 and data_source_id = $3 and source_host_id = $4 and created_by = $5 and status = 'scheduled' for update`,
          [id, requested.id, requested.dataSourceId, requested.sourceHostId, user.id],
        );
        const existing = existingResult.rows[0];
        if (!existing) return null;
        const changed = operation === "update"
          ? await client.query(`update operator_reminders set scheduled_for = $1, updated_at = $2 where id = $3 returning ${SELECT_COLUMNS}`, [scheduledFor, now(), id])
          : await client.query(`update operator_reminders set status = 'cancelled', cancelled_at = $1, updated_at = $1 where id = $2 returning ${SELECT_COLUMNS}`, [now(), id]);
        const row = changed.rows[0];
        await insertAuditLog(client, {
          actorName: user.name, actorId: user.id, actorType: "sso_user", action: operation === "update" ? "REMINDER_UPDATED" : "REMINDER_CANCELLED",
          entityType: "operator_reminder", entityId: id, dataSourceId: requested.dataSourceId,
          alertId: existing.initial_alert_id || null, beforeData: { status: existing.status, scheduled_for: new Date(existing.scheduled_for).toISOString() },
          afterData: { status: row.status, scheduled_for: new Date(row.scheduled_for).toISOString() }, metadata: { circuit_key: requested.id, source_host_id: requested.sourceHostId }, req,
        });
        return row;
      });
      return result ? reply(200, { item: reminderRecord(result) }) : reply(404, { error: "reminder_not_found" });
    } catch (error) {
      if (error?.code === "23505") return reply(409, { error: "active_reminder_exists" });
      return reply(503, { error: publicDatabaseError(error) }, { cause: classifyActionsFailure(error) });
    }
  };
}

export default createOperatorReminderHandler();

const REMINDER_STATUSES = ["scheduled", "processing", "sent", "cancelled", "skipped", "failed"];
const FEED_LIMIT = 50;
const FEED_LIMIT_MAX = 100;
const FEED_SCOPES = ["all", "mine"];
const FEED_SORTS = ["recent", "oldest"];
const FEED_SEVERITIES = ["not_classified", "information", "warning", "average", "high", "critical", "disaster"];
const ACTIVITY_AT_SQL = `case
  when r.status = 'sent' then r.sent_at
  when r.status = 'skipped' then r.skipped_at
  when r.status = 'cancelled' then r.cancelled_at
  when r.status = 'failed' then r.updated_at
  else r.scheduled_for
end`;

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}
function optionalTimestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? parsed.toISOString() : undefined;
}
function optionalFilterText(value, maximum = 160) {
  const raw = text(value);
  return raw && raw.length <= maximum ? raw : raw ? undefined : null;
}
function reminderStatuses(value) {
  const raw = text(value);
  if (!raw) return ACTIVE_STATUSES;
  const values = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!values.length || values.some((item) => !REMINDER_STATUSES.includes(item))) return null;
  return values;
}
function reminderFeedRequest(req) {
  const scope = (queryValue(req, "scope") || "all").toLowerCase();
  const statuses = reminderStatuses(queryValue(req, "status"));
  const from = optionalTimestamp(queryValue(req, "from"));
  const to = optionalTimestamp(queryValue(req, "to"));
  const client = optionalFilterText(queryValue(req, "client"), 120);
  const severity = (queryValue(req, "severity") || "").toLowerCase();
  const hasIncidentRaw = (queryValue(req, "has_incident") || "").toLowerCase();
  const search = optionalFilterText(queryValue(req, "search"));
  const sort = (queryValue(req, "sort") || "").toLowerCase();
  if (!FEED_SCOPES.includes(scope) || !statuses || from === undefined || to === undefined || client === undefined || search === undefined
    || (severity && !FEED_SEVERITIES.includes(severity)) || (hasIncidentRaw && !["true", "false"].includes(hasIncidentRaw))
    || (sort && !FEED_SORTS.includes(sort))) return null;
  if (from && to && from > to) return null;
  return {
    scope, statuses, from, to, client, severity: severity || null,
    hasIncident: hasIncidentRaw ? hasIncidentRaw === "true" : null,
    search, sort: sort || null,
    limit: Math.max(1, positiveInteger(queryValue(req, "limit"), FEED_LIMIT, FEED_LIMIT_MAX)),
    offset: positiveInteger(queryValue(req, "offset"), 0, 10_000),
  };
}
function feedWhere(filters, actorId, { includeStatus = true } = {}) {
  const clauses = [];
  const values = [];
  const bind = (value) => { values.push(value); return `$${values.length}`; };
  if (includeStatus) clauses.push(`r.status = any(${bind(filters.statuses)}::text[])`);
  if (filters.scope === "mine") clauses.push(`r.created_by = ${bind(actorId)}`);
  if (filters.from) clauses.push(`${ACTIVITY_AT_SQL} >= ${bind(filters.from)}::timestamptz`);
  if (filters.to) clauses.push(`${ACTIVITY_AT_SQL} <= ${bind(filters.to)}::timestamptz`);
  if (filters.client) clauses.push(`coalesce(r.context_snapshot -> 'customer' ->> 'name', r.context_snapshot -> 'customer' ->> 'key', '') ilike ${bind(`%${filters.client}%`)}`);
  if (filters.severity) clauses.push(`lower(coalesce(r.context_snapshot -> 'alert' ->> 'severity', '')) = ${bind(filters.severity)}`);
  if (filters.hasIncident !== null) {
    const hasIncident = `coalesce(nullif(r.initial_incident_number, ''), nullif(r.context_snapshot -> 'incident' ->> 'number', '')) is not null`;
    clauses.push(filters.hasIncident ? hasIncident : `not (${hasIncident})`);
  }
  if (filters.search) clauses.push(`concat_ws(' ', coalesce(r.context_snapshot -> 'customer' ->> 'name', ''), coalesce(r.context_snapshot -> 'circuit' ->> 'host_name', ''), r.circuit_key, coalesce(r.initial_incident_number, ''), coalesce(r.context_snapshot -> 'incident' ->> 'number', '')) ilike ${bind(`%${filters.search}%`)}`);
  return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", values };
}
function feedOrder(filters) {
  if (filters.sort === "recent") return "activity_at desc nulls last, r.id desc";
  if (filters.sort === "oldest") return "activity_at asc nulls last, r.id asc";
  if (filters.statuses.every((status) => ACTIVE_STATUSES.includes(status))) return "r.scheduled_for asc, r.id asc";
  if (filters.statuses.length === 1 && filters.statuses[0] === "sent") return "r.sent_at desc nulls last, r.id desc";
  if (filters.statuses.length === 1 && filters.statuses[0] === "skipped") return "r.skipped_at desc nulls last, r.id desc";
  if (filters.statuses.length === 1 && filters.statuses[0] === "cancelled") return "r.cancelled_at desc nulls last, r.id desc";
  if (filters.statuses.length === 1 && filters.statuses[0] === "failed") return "r.updated_at desc nulls last, r.id desc";
  return "activity_at desc nulls last, r.id desc";
}

/** The feed is cross-circuit, so created_by (Entra oid) never leaves the BFF; ownership travels as a boolean. */
function feedRecord(row, actorId) {
  const record = reminderRecord(row);
  delete record.created_by;
  // Historical diagnostics remain server-side. The operational feed uses a safe status label only.
  delete record.last_error;
  return { ...record, mine: row.created_by === actorId };
}

export function createOperatorReminderFeedHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  query = withOneViewActionsQuery,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function operatorReminderFeedHandler(req, res) {
    const startedAt = Date.now();
    const method = String(req.method || "UNKNOWN").toUpperCase();
    const reply = (status, payload, extra = {}) => {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/reminders",
        method,
        operation: "feed",
        status,
        error_code: typeof payload?.error === "string" ? payload.error : null,
        cause: extra.cause || null,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return sendJson(res, status, payload);
    };
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);
    const filters = reminderFeedRequest(req);
    if (!filters) return reply(400, { error: "invalid_query" });
    const auth = await authorize(req, res);
    if (!auth) {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/reminders",
        method,
        operation: "feed",
        status: res.statusCode || 401,
        error_code: res.statusCode === 403 ? "authorization_denied" : "authentication_required",
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return;
    }
    const user = actor(auth);
    if (!user.id) return reply(401, { error: "authentication_required" });

    try {
      const result = await query(async (client) => {
        const page = feedWhere(filters, user.id);
        const base = feedWhere(filters, user.id, { includeStatus: false });
        const countResult = await client.query(
          `select r.status, count(*)::int as count, count(*) filter (where r.created_by = $${base.values.length + 1})::int as mine_count,
                  count(*) filter (where r.status = 'sent' and r.sent_at >= now() - interval '4 hours')::int as recent_sent_count
             from operator_reminders r ${base.where} group by r.status`,
          [...base.values, user.id],
        );
        const facetResult = await client.query(
          `select coalesce(nullif(r.context_snapshot -> 'customer' ->> 'name', ''), nullif(r.context_snapshot -> 'customer' ->> 'key', '')) as value, count(*)::int as count
             from operator_reminders r ${base.where}
            group by value
            having coalesce(nullif(r.context_snapshot -> 'customer' ->> 'name', ''), nullif(r.context_snapshot -> 'customer' ->> 'key', '')) is not null
            order by count desc, value asc limit 50`,
          base.values,
        );
        const pageResult = await client.query(
          `select ${SELECT_COLUMNS}, ${ACTIVITY_AT_SQL} as activity_at, count(*) over()::int as total_items
             from operator_reminders r ${page.where}
            order by ${feedOrder(filters)} limit $${page.values.length + 1} offset $${page.values.length + 2}`,
          [...page.values, filters.limit, filters.offset],
        );
        return { countRows: countResult.rows, facetRows: facetResult.rows, pageRows: pageResult.rows };
      });
      const byStatus = Object.fromEntries(REMINDER_STATUSES.map((status) => [status, 0]));
      let mine = 0;
      let recentSentCount = 0;
      for (const row of result.countRows) {
        if (REMINDER_STATUSES.includes(row.status)) byStatus[row.status] = Number(row.count) || 0;
        mine += Number(row.mine_count) || 0;
        recentSentCount += Number(row.recent_sent_count) || 0;
      }
      const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
      const items = result.pageRows.map((row) => feedRecord(row, user.id));
      const totalItems = Number(result.pageRows[0]?.total_items) || 0;
      return reply(200, {
        items,
        counts: { all: total, mine, ...byStatus },
        recent_sent_count: recentSentCount,
        facets: { clients: result.facetRows.map((row) => ({ value: row.value, label: row.value, count: Number(row.count) || 0 })) },
        pagination: { limit: filters.limit, offset: filters.offset, total_items: totalItems, has_next: filters.offset + items.length < totalItems },
        filters: { ...filters, from: filters.from, to: filters.to },
        data_source: "postgresql",
        checked_at: now().toISOString(),
      });
    } catch (error) {
      return reply(503, { error: publicDatabaseError(error) }, { cause: classifyActionsFailure(error) });
    }
  };
}

export const operatorReminderFeed = createOperatorReminderFeedHandler();
