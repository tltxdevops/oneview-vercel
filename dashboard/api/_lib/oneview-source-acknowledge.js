/** Source ACK producer. Vercel writes only a transactional worker outbox. */
import { createHash, randomUUID } from "node:crypto";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";

const ALERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const EVENT_ID_PATTERN = /^[a-z0-9._:-]{1,80}$/i;
const IDEMPOTENCY_HEADER_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const MAX_COMMENT_LENGTH = 500;
const ACTION_TYPE = "zabbix_event_acknowledge";

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function csv(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function headerValue(req, key) {
  const value = req.headers?.[key] ?? req.headers?.[key.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function bodyValue(req) {
  if (!req.body) return {};
  if (typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try {
    const parsed = JSON.parse(String(req.body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanComment(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_COMMENT_LENGTH) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function requestId(req) {
  const candidate = headerValue(req, "x-request-id");
  return /^[a-z0-9._:-]{1,80}$/i.test(candidate) ? candidate : randomUUID();
}

function idempotencyKey(req, alertId, actorId, comment) {
  const supplied = headerValue(req, "idempotency-key");
  if (supplied && !IDEMPOTENCY_HEADER_PATTERN.test(supplied)) return null;
  const material = supplied || `${alertId}\n${actorId}\n${comment}`;
  return `source-ack:${createHash("sha256").update(`${alertId}\n${actorId}\n${material}`).digest("hex")}`;
}

export function getSourceAcknowledgeConfig(env = process.env) {
  return Object.freeze({
    enabled: booleanValue(env.ONEVIEW_SOURCE_ACK_REQUEST_ENABLED, false),
    allowedDatasources: csv(env.ONEVIEW_SOURCE_ACK_ALLOWED_DATASOURCES),
  });
}

function publicDatabaseError(error) {
  return error?.code === "actions_database_not_configured" ? "actions_database_not_configured" : "database_unavailable";
}

export function createSourceAcknowledgeHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getSourceAcknowledgeConfig,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function sourceAcknowledgeHandler(req, res) {
    const startedAt = Date.now();
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res);
    if (!auth) return;

    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const body = bodyValue(req);
    const suppliedEventId = String(body.source_event_id || "").trim();
    const comment = cleanComment(body.comment);
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    if (suppliedEventId && !EVENT_ID_PATTERN.test(suppliedEventId)) return sendJson(res, 400, { error: "invalid_source_event_id" });
    if (comment === null) return sendJson(res, 400, { error: "invalid_comment" });

    const actorId = String(auth.id || "").trim().slice(0, 120);
    const actorName = String(auth.name || auth.email || "Usuário SSO").trim().slice(0, 120);
    if (!actorId) return sendJson(res, 401, { error: "authentication_required" });
    const config = configProvider();
    if (!config.enabled) return sendJson(res, 403, { error: "source_acknowledge_disabled" });
    const key = idempotencyKey(req, alertId, actorId, comment);
    if (!key) return sendJson(res, 400, { error: "invalid_idempotency_key" });
    const currentRequestId = requestId(req);

    try {
      const result = await transaction(async (client) => {
        const initial = await client.query(
          `select a.id, a.data_source_id, a.source_event_id, a.status_source, a.resolved_at,
                  a.acknowledged_source, d.name as datasource_name, d.sync_enabled
             from alerts a join data_sources d on d.id = a.data_source_id
            where a.id = $1 limit 1`,
          [alertId],
        );
        const preview = initial.rows[0];
        if (!preview) return { error: "not_found", status: 404 };
        const lockKey = `source-ack:${preview.data_source_id}:${preview.source_event_id || "missing"}`;
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);

        const alertResult = await client.query(
          `select a.id, a.data_source_id, a.source_event_id, a.status_source, a.resolved_at,
                  a.acknowledged_source, d.name as datasource_name, d.sync_enabled
             from alerts a join data_sources d on d.id = a.data_source_id
            where a.id = $1 for update`,
          [alertId],
        );
        const alert = alertResult.rows[0];
        if (!alert) return { error: "not_found", status: 404 };
        if (alert.acknowledged_source) return { alreadyAcknowledged: true, alert };
        if (alert.status_source !== "active" || alert.resolved_at) return { error: "alert_not_active", status: 409 };
        if (!alert.source_event_id || !EVENT_ID_PATTERN.test(String(alert.source_event_id))) return { error: "source_event_id_missing", status: 409 };
        if (suppliedEventId && suppliedEventId !== String(alert.source_event_id)) return { error: "source_event_id_mismatch", status: 409 };
        const datasource = String(alert.datasource_name || "").trim().toLowerCase();
        if (!alert.sync_enabled || !config.allowedDatasources.has(datasource)) return { error: "datasource_not_allowed", status: 403 };

        const existing = await client.query(
          `select id, status from alert_acknowledgements
            where idempotency_key = $1 and acknowledgement_type = 'source'
            order by requested_at desc, id desc limit 1`,
          [key],
        );
        if (existing.rows[0]) return { acknowledgementId: existing.rows[0].id, idempotent: true };
        const inFlight = await client.query(
          `select id from alert_acknowledgements
            where alert_id = $1 and acknowledgement_type = 'source'
              and status in ('pending','processing')
            order by requested_at desc, id desc limit 1`,
          [alert.id],
        );
        if (inFlight.rows[0]) return { acknowledgementId: inFlight.rows[0].id, idempotent: true };

        const acknowledgementId = idFactory();
        const outboxId = idFactory();
        const requestedAt = now();
        const payload = {
          acknowledgement_id: acknowledgementId,
          alert_id: alert.id,
          data_source_id: alert.data_source_id,
          source_event_id: alert.source_event_id,
          actor_id: actorId,
          actor_name: actorName,
          comment,
        };
        await client.query(
          `insert into alert_acknowledgements (
             id, alert_id, data_source_id, acknowledgement_type, status, source_event_id,
             message, operator_name, request_id, actor_type, actor_id, idempotency_key,
             attempts, requested_at, created_at, updated_at
           ) values ($1,$2,$3,'source','pending',$4,$5,$6,$7,'sso_user',$8,$9,0,$10,$10,$10)`,
          [acknowledgementId, alert.id, alert.data_source_id, alert.source_event_id, comment,
            actorName, currentRequestId, actorId, key, requestedAt],
        );
        await client.query(
          `insert into integration_outbox (
             id, aggregate_type, aggregate_id, data_source_id, alert_id, action_type, status,
             priority, payload, attempts, max_attempts, available_at, next_attempt_at,
             idempotency_key, request_id, created_by, created_at, updated_at
           ) values ($1,'alert_acknowledgement',$2,$3,$4,$5,'pending',100,$6::jsonb,0,5,$7,$7,$8,$9,$10,$7,$7)`,
          [outboxId, acknowledgementId, alert.data_source_id, alert.id, ACTION_TYPE,
            JSON.stringify(payload), requestedAt, `outbox:${key}`, currentRequestId, actorName],
        );
        return { acknowledgementId, outboxId, idempotent: false };
      });

      if (result.error) return sendJson(res, result.status, { error: result.error });
      if (result.alreadyAcknowledged) {
        return sendJson(res, 200, {
          status: "confirmed",
          alert_id: alertId,
          source_event_id: result.alert.source_event_id,
          acknowledged_source: true,
        });
      }
      logger({ event: "oneview_source_ack_enqueued", route: "/api/oneview/alerts/:id/source-acknowledge", status: "pending", idempotent: result.idempotent, duration_ms: Date.now() - startedAt });
      return sendJson(res, 202, {
        status: "pending",
        request_id: result.acknowledgementId,
        outbox_id: result.outboxId || null,
        idempotent: result.idempotent,
        alert_id: alertId,
        acknowledged_source: false,
        message: "Reconhecimento enviado ao Zabbix...",
      });
    } catch (error) {
      logger({ event: "oneview_source_ack_enqueued", route: "/api/oneview/alerts/:id/source-acknowledge", status: "failed", code: publicDatabaseError(error), duration_ms: Date.now() - startedAt });
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export default createSourceAcknowledgeHandler();
