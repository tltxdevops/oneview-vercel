import { transaction } from "../../_lib/db.js";
import { actorIdFrom, insertAuditLog, requestIds } from "../../_lib/audit.js";
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

    const outbox = await transaction(async (client) => {
      const existing = await client.query("select id from data_sources where id = $1", [id]);
      if (!existing.rows[0]) return null;

      const outboxId = newId();
      const createdAt = now();
      const idempotencyKey = `request_sync:${outboxId}`;
      await client.query(
        `
          insert into integration_outbox (
            id, aggregate_type, aggregate_id, data_source_id, action_type,
            status, priority, payload, attempts, max_attempts, available_at,
            next_attempt_at, idempotency_key, correlation_id, request_id,
            created_by, created_at, updated_at
          )
          values ($1,'data_source',$2,$2,'request_sync','pending',40,$3,0,3,$4,$4,$5,$6,$7,$8,$4,$4)
        `,
        [
          outboxId,
          id,
          JSON.stringify({
            data_source_id: id,
            limit: body.limit || null,
            reason: body.reason || "manual_request",
          }),
          createdAt,
          idempotencyKey,
          ids.correlationId,
          ids.requestId,
          operatorName,
        ],
      );
      await insertAuditLog(client, {
        actorName: operatorName,
        actorId,
        action: "data_source_sync_requested",
        entityType: "data_source",
        entityId: id,
        dataSourceId: id,
        correlationId: ids.correlationId,
        requestId: ids.requestId,
        metadata: { outbox_id: outboxId },
        req,
      });
      return { outbox_id: outboxId, status: "pending" };
    });

    if (!outbox) return sendJson(res, 404, { error: "data_source_not_found" });
    return sendJson(res, 202, outbox);
  } catch (error) {
    return handleError(res, error);
  }
}
