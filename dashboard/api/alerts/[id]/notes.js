import { transaction } from "../../_lib/db.js";
import { actorIdFrom, insertAlertHistory, insertAuditLog, requestIds } from "../../_lib/audit.js";
import { getAlert } from "../../_lib/alerts.js";
import { requireAuth } from "../../_lib/auth.js";
import { newId, now } from "../../_lib/ids.js";
import { getId, handleError, methodNotAllowed, operatorFrom, parseBody, sendJson } from "../../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireAuth(req, res, { role: "operator" }))) return;

  try {
    const id = getId(req);
    const body = parseBody(req);
    const message = String(body.message || "").trim();
    if (!message) return sendJson(res, 400, { error: "message_required" });
    const operatorName = operatorFrom(req, body);
    const ids = requestIds(req);
    const actorId = actorIdFrom(req);

    const note = await transaction(async (client) => {
      const alert = await getAlert(client, id);
      if (!alert) return null;

      const noteId = newId();
      const createdAt = now();
      const result = await client.query(
        `
          insert into alert_notes (
            id, alert_id, message, operator_name, source,
            correlation_id, request_id, actor_type, actor_id, created_at, updated_at
          )
          values ($1,$2,$3,$4,$5,$6,$7,'user',$8,$9,$9)
          returning id, alert_id, message, operator_name, source, created_at, updated_at
        `,
        [noteId, id, message, operatorName, "vercel_api", ids.correlationId, ids.requestId, actorId, createdAt],
      );
      await insertAlertHistory(client, {
        alertId: id,
        actionType: "note_added",
        message,
        operatorName,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        actorId,
        actorName: operatorName,
        metadata: { note_id: noteId },
      });
      await insertAuditLog(client, {
        actorName: operatorName,
        actorId,
        action: "alert_note_added",
        entityType: "alert",
        entityId: id,
        dataSourceId: alert.data_source_id,
        alertId: id,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        metadata: { note_id: noteId },
        req,
      });
      return result.rows[0];
    });

    if (!note) return sendJson(res, 404, { error: "alert_not_found" });
    return sendJson(res, 201, note);
  } catch (error) {
    return handleError(res, error);
  }
}
