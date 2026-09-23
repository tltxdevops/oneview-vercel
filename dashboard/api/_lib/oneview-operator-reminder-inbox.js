import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { classifyActionsFailure, withOneViewActionsQuery } from "./oneview-actions-db.js";
import {
  buildOperatorReminderInAppCopy,
  reminderLinkLocator,
  severityFromReminder,
} from "./oneview-operator-reminder-message.js";

function text(value) {
  return String(value ?? "").trim();
}

function queryValue(req, key) {
  const value = req?.query?.[key];
  return text(Array.isArray(value) ? value[0] : value);
}

function actor(auth) {
  return { id: text(auth?.id).slice(0, 120), name: text(auth?.name || auth?.email || "Usuário SSO").slice(0, 120) };
}

function parseSince(value) {
  const raw = text(value);
  if (!raw || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 50);
}

function rowValue(value) {
  if (!value || typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function inboxRowToEvents(row) {
  const reminder = {
    ...row,
    context_snapshot: rowValue(row.context_snapshot) || row.context_snapshot || {},
  };
  const events = [];
  if (row.status === "processing") {
    const occurred = row.updated_at ? new Date(row.updated_at).toISOString() : null;
    if (occurred) {
      const copy = buildOperatorReminderInAppCopy(reminder, "fired");
      events.push({
        id: row.id,
        phase: "fired",
        occurred_at: occurred,
        title: copy.title,
        body: copy.body,
        link: reminderLinkLocator(reminder),
        severity: severityFromReminder(reminder),
      });
    }
  }
  if (row.status === "sent") {
    const occurred = row.sent_at ? new Date(row.sent_at).toISOString() : null;
    if (occurred) {
      const copy = buildOperatorReminderInAppCopy(reminder, "delivered");
      events.push({
        id: row.id,
        phase: "delivered",
        occurred_at: occurred,
        title: copy.title,
        body: copy.body,
        link: reminderLinkLocator(reminder),
        severity: severityFromReminder(reminder),
      });
    }
  }
  return events;
}

function publicDatabaseError(error) {
  return error?.code === "actions_database_not_configured" ? "actions_database_not_configured" : "database_unavailable";
}

export function createOperatorReminderInboxHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  query = withOneViewActionsQuery,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function operatorReminderInboxHandler(req, res) {
    const startedAt = Date.now();
    const method = String(req.method || "UNKNOWN").toUpperCase();
    const reply = (status, payload, extra = {}) => {
      logger({
        event: "oneview_reminder_request",
        route: "/api/oneview/reminders/inbox",
        method,
        operation: "inbox",
        status,
        error_code: typeof payload?.error === "string" ? payload.error : null,
        cause: extra.cause || null,
        duration_ms: Math.max(0, Date.now() - startedAt),
        events: Array.isArray(payload?.items) ? payload.items.length : 0,
      });
      return sendJson(res, status, payload);
    };

    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (method !== "GET") return methodNotAllowed(res, ["GET"]);

    const since = parseSince(queryValue(req, "since"));
    if (!since) return reply(400, { error: "invalid_query" });
    const limit = parseLimit(queryValue(req, "limit"));

    const auth = await authorize(req, res);
    if (!auth) return;

    const user = actor(auth);
    if (!user.id) return reply(401, { error: "authentication_required" });

    try {
      const rows = await query(async (client) => {
        const result = await client.query(
          `
            select id, subject_type, subject_key, circuit_key, data_source_id, source_host_id, source_trigger_id,
                   status, context_snapshot, initial_incident_number, updated_at, sent_at
              from operator_reminders
             where created_by = $1
               and (
                 (status = 'processing' and updated_at > $2::timestamptz)
                 or (status = 'sent' and sent_at > $2::timestamptz)
               )
             order by coalesce(sent_at, updated_at) asc, id asc
             limit $3
          `,
          [user.id, since, limit],
        );
        return result.rows || [];
      });

      const items = rows.flatMap((row) => inboxRowToEvents(row));
      return reply(200, {
        items,
        data_source: "postgresql",
        checked_at: now().toISOString(),
      });
    } catch (error) {
      return reply(503, { error: publicDatabaseError(error) }, { cause: classifyActionsFailure(error) });
    }
  };
}

export default createOperatorReminderInboxHandler();
