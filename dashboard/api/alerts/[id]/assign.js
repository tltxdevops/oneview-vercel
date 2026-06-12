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
    const operatorName = operatorFrom(req, body);
    const ids = requestIds(req);
    const actorId = actorIdFrom(req);

    const assignment = await transaction(async (client) => {
      const alert = await getAlert(client, id);
      if (!alert) return null;

      const assignmentId = newId();
      const createdAt = now();
      const result = await client.query(
        `
          insert into alert_assignments (
            id, alert_id, operator_name, status, source,
            correlation_id, request_id, actor_type, actor_id, assigned_at, created_at, updated_at
          )
          values ($1,$2,$3,'assigned','vercel_api',$4,$5,'user',$6,$7,$7,$7)
          returning id, alert_id, operator_name, status, source, assigned_at, released_at, created_at, updated_at
        `,
        [assignmentId, id, operatorName, ids.correlationId, ids.requestId, actorId, createdAt],
      );

      const previousStatus = alert.status_internal;
      const newStatus = previousStatus === "hidden" || previousStatus === "normalized" ? previousStatus : "in_progress";
      if (newStatus !== previousStatus) {
        await client.query(
          "update alerts set status_internal = $1, updated_at = $2 where id = $3",
          [newStatus, createdAt, id],
        );
      }
      await insertAlertHistory(client, {
        alertId: id,
        actionType: "assigned",
        previousStatus,
        newStatus,
        message: body.message || null,
        operatorName,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        actorId,
        actorName: operatorName,
        beforeData: { status_internal: previousStatus },
        afterData: { status_internal: newStatus, assignment_id: assignmentId },
      });
      await insertAuditLog(client, {
        actorName: operatorName,
        actorId,
        action: "alert_assigned",
        entityType: "alert",
        entityId: id,
        dataSourceId: alert.data_source_id,
        alertId: id,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        metadata: { assignment_id: assignmentId },
        req,
      });
      return result.rows[0];
    });

    if (!assignment) return sendJson(res, 404, { error: "alert_not_found" });
    return sendJson(res, 201, assignment);
  } catch (error) {
    return handleError(res, error);
  }
}
