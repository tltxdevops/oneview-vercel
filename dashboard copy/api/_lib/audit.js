import { newId, now } from "./ids.js";

export function requestIds(req) {
  const requestId =
    req?.headers?.["x-request-id"] ||
    req?.headers?.["x-vercel-id"] ||
    newId();
  return {
    requestId,
    correlationId: req?.headers?.["x-correlation-id"] || requestId,
  };
}

export function actorIdFrom(req) {
  return req?.oneviewAuth?.id || req?.headers?.["x-user-id"] || req?.headers?.["x-vercel-user-id"] || null;
}

export async function insertAuditLog(client, {
  actorName,
  actorType = "user",
  actorId = null,
  action,
  actionSource = "vercel_api",
  entityType,
  entityId,
  dataSourceId = null,
  alertId = null,
  correlationId = null,
  requestId = null,
  beforeData = null,
  afterData = null,
  metadata = null,
  req = null,
}) {
  const ids = requestIds(req);
  await client.query(
    `
      insert into audit_logs (
        id, actor_name, actor_type, actor_id, action, action_source, entity_type, entity_id,
        data_source_id, alert_id, correlation_id, request_id, before_data, after_data,
        metadata, ip_address, user_agent, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `,
    [
      newId(),
      actorName || "oneview",
      actorType,
      actorId ?? actorIdFrom(req),
      action,
      actionSource,
      entityType,
      entityId,
      dataSourceId,
      alertId,
      correlationId || ids.correlationId,
      requestId || ids.requestId,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      metadata ? JSON.stringify(metadata) : null,
      req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || null,
      req?.headers?.["user-agent"] || null,
      now(),
    ],
  );
}

export async function insertAlertHistory(client, {
  alertId,
  actionType,
  previousStatus = null,
  newStatus = null,
  message = null,
  operatorName = null,
  source = "vercel_api",
  correlationId = null,
  requestId = null,
  actorType = "user",
  actorId = null,
  actorName = null,
  actionSource = source,
  entityType = "alert",
  entityId = alertId,
  beforeData = null,
  afterData = null,
  metadata = null,
}) {
  await client.query(
    `
      insert into alert_history (
        id, alert_id, action_type, previous_status, new_status,
        message, operator_name, source, correlation_id, request_id,
        actor_type, actor_id, actor_name, action_source, entity_type, entity_id,
        before_data, after_data, metadata, created_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `,
    [
      newId(),
      alertId,
      actionType,
      previousStatus,
      newStatus,
      message,
      operatorName,
      source,
      correlationId,
      requestId,
      actorType,
      actorId,
      actorName || operatorName,
      actionSource,
      entityType,
      entityId,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      metadata ? JSON.stringify(metadata) : null,
      now(),
    ],
  );
}
