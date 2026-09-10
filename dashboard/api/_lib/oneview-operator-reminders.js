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
    cancelled_at: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
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
    link: { service_name: link.service_name || null, carrier_name: link.carrier_name || null, link_type: link.link_type || null },
    alert: alert ? { id: alert.id || null, problem_name: alert.problem_name || null, severity: alert.severity || null } : null,
    incident: incident ? { sys_id: incident.sys_id || null, number: incident.number || null, state: incident.state || null } : null,
  };
}
const SELECT_COLUMNS = `id, circuit_key, data_source_id, source_host_id, scheduled_for, status, created_by, created_by_name,
  initial_alert_id, initial_incident_sys_id, initial_incident_number, context_snapshot, created_at, updated_at, cancelled_at`;

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
    const reply = (status, payload, extra = {}) => {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/links/:id/reminders",
        method,
        status,
        error_code: typeof payload?.error === "string" ? payload.error : null,
        cause: extra.cause || null,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return sendJson(res, status, payload);
    };
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
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
      const scheduledFor = futureTimestamp(body.scheduled_for, now());
      if (req.method === "POST") {
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
      if (req.method === "PATCH" && !scheduledFor) return reply(400, { error: "invalid_scheduled_for" });
      const result = await transaction(async (client) => {
        const existingResult = await client.query(
          `select ${SELECT_COLUMNS} from operator_reminders where id = $1 and circuit_key = $2 and data_source_id = $3 and source_host_id = $4 and created_by = $5 and status = 'scheduled' for update`,
          [id, requested.id, requested.dataSourceId, requested.sourceHostId, user.id],
        );
        const existing = existingResult.rows[0];
        if (!existing) return null;
        const changed = req.method === "PATCH"
          ? await client.query(`update operator_reminders set scheduled_for = $1, updated_at = $2 where id = $3 returning ${SELECT_COLUMNS}`, [scheduledFor, now(), id])
          : await client.query(`update operator_reminders set status = 'cancelled', cancelled_at = $1, updated_at = $1 where id = $2 returning ${SELECT_COLUMNS}`, [now(), id]);
        const row = changed.rows[0];
        await insertAuditLog(client, {
          actorName: user.name, actorId: user.id, actorType: "sso_user", action: req.method === "PATCH" ? "REMINDER_UPDATED" : "REMINDER_CANCELLED",
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
