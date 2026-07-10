import { transaction } from "../../_lib/db.js";
import { actorIdFrom, insertAlertHistory, insertAuditLog, requestIds } from "../../_lib/audit.js";
import { getAlert } from "../../_lib/alerts.js";
import { requireAuth } from "../../_lib/auth.js";
import { now } from "../../_lib/ids.js";
import { getId, handleError, methodNotAllowed, operatorFrom, parseBody, sendJson } from "../../_lib/http.js";

const ALLOWED_STATUS = new Set([
  "new",
  "viewed",
  "in_progress",
  "acknowledged",
  "observing",
  "normalized",
  "hidden",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireAuth(req, res, { role: "operator" }))) return;

  try {
    const id = getId(req);
    const body = parseBody(req);
    const status = String(body.status || "").trim();
    if (!ALLOWED_STATUS.has(status)) return sendJson(res, 400, { error: "invalid_status" });
    const operatorName = operatorFrom(req, body);
    const ids = requestIds(req);
    const actorId = actorIdFrom(req);

    const updated = await transaction(async (client) => {
      const alert = await getAlert(client, id);
      if (!alert) return null;

      const updatedAt = now();
      const previousStatus = alert.status_internal;
      const acknowledgedInternal = status === "acknowledged" ? true : alert.acknowledged_internal;
      const result = await client.query(
        `
          update alerts
          set status_internal = $1::text,
              acknowledged_internal = $2::boolean,
              acknowledged_internal_at = case when $1::text = 'acknowledged' and acknowledged_internal_at is null then $3 else acknowledged_internal_at end,
              normalized_at = case when $1::text = 'normalized' and normalized_at is null then $3 else normalized_at end,
              updated_at = $3
          where id = $4
          returning id, status_internal, acknowledged_internal, updated_at
        `,
        [status, acknowledgedInternal, updatedAt, id],
      );
      await insertAlertHistory(client, {
        alertId: id,
        actionType: "status_changed",
        previousStatus,
        newStatus: status,
        message: body.message || null,
        operatorName,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        actorId,
        actorName: operatorName,
        beforeData: { status_internal: previousStatus },
        afterData: { status_internal: status },
      });
      await insertAuditLog(client, {
        actorName: operatorName,
        actorId,
        action: "alert_status_changed",
        entityType: "alert",
        entityId: id,
        dataSourceId: alert.data_source_id,
        alertId: id,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        beforeData: { status_internal: previousStatus },
        afterData: { status_internal: status },
        metadata: { previous_status: previousStatus, new_status: status },
        req,
      });
      return result.rows[0];
    });

    if (!updated) return sendJson(res, 404, { error: "alert_not_found" });
    return sendJson(res, 200, updated);
  } catch (error) {
    return handleError(res, error);
  }
}
