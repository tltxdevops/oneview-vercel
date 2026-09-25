import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { classifyActionsFailure, withOneViewActionsQuery } from "./oneview-actions-db.js";
import { fetchOperationalSubjectDetail } from "./oneview-links.js";
import { parseOperationalSubject } from "./oneview-operational-subject.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value) { return String(Array.isArray(value) ? value[0] : value || "").trim(); }
function value(value) {
  if (!value || typeof value !== "string") return value || {};
  try { return JSON.parse(value); } catch { return {}; }
}
function identity(req) {
  return parseOperationalSubject({
    subject_type: text(req?.query?.subject_type), subject_key: text(req?.query?.subject_key),
    circuit_key: text(req?.query?.circuit), data_source_id: text(req?.query?.ds),
    source_host_id: text(req?.query?.host), source_trigger_id: text(req?.query?.trigger),
  });
}
function sameSubject(left, right) {
  return left && right && left.subject_type === right.subject_type && left.subject_key === right.subject_key
    && left.data_source_id === right.data_source_id && left.source_host_id === right.source_host_id
    && left.source_trigger_id === right.source_trigger_id && left.circuit_key === right.circuit_key;
}
function actorId(auth) { return text(auth?.id).slice(0, 120); }
function publicDatabaseError(error) { return error?.code === "actions_database_not_configured" ? "actions_database_not_configured" : "database_unavailable"; }

/** Resolve only the persisted, owned reminder subject; never fall back to another host/link. */
export function createOperatorReminderDeepLinkHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  query = withOneViewActionsQuery,
  resolveSubject = fetchOperationalSubjectDetail,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function operatorReminderDeepLinkHandler(req, res) {
    const startedAt = Date.now();
    const reply = (status, payload, cause = null) => {
      logger({ event: "oneview_reminder_request", route: "/api/oneview/reminders/resolve-link", method: String(req.method || "GET").toUpperCase(), operation: "resolve_link", status, error_code: payload?.error || null, cause, duration_ms: Math.max(0, Date.now() - startedAt) });
      return sendJson(res, status, payload);
    };
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (String(req.method || "GET").toUpperCase() !== "GET") return methodNotAllowed(res, ["GET"]);
    const reminderId = text(req?.query?.reminder_id);
    const requested = identity(req);
    if (!UUID.test(reminderId) || !requested) return reply(400, { error: "invalid_query" });
    const auth = await authorize(req, res);
    if (!auth) return;
    const actor = actorId(auth);
    if (!actor) return reply(401, { error: "authentication_required" });
    try {
      const row = await query(async (client) => (await client.query(
        "select id, subject_type, subject_key, circuit_key, data_source_id, source_host_id, source_trigger_id, context_snapshot from operator_reminders where id=$1 and created_by=$2 limit 1",
        [reminderId, actor],
      )).rows?.[0] || null);
      const persisted = parseOperationalSubject(row || {});
      if (!row || !sameSubject(requested, persisted)) return reply(404, { error: "reminder_not_found" });
      const link = await resolveSubject({
        subjectType: persisted.subject_type, circuitKey: persisted.circuit_key, dataSourceId: persisted.data_source_id,
        sourceHostId: persisted.source_host_id, sourceTriggerId: persisted.source_trigger_id,
      });
      return reply(200, {
        status: link ? "available" : "unavailable",
        link: link || null,
        reminder: {
          id: row.id, link: { circuit_key: persisted.circuit_key, data_source_id: persisted.data_source_id, source_host_id: persisted.source_host_id, subject_type: persisted.subject_type, subject_key: persisted.subject_key, source_trigger_id: persisted.source_trigger_id },
          context_snapshot: value(row.context_snapshot),
        },
      });
    } catch (error) {
      return reply(503, { error: publicDatabaseError(error) }, classifyActionsFailure(error));
    }
  };
}

export default createOperatorReminderDeepLinkHandler();
