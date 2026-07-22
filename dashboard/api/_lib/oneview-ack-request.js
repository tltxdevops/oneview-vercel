import { createHash, randomUUID } from "node:crypto";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";
import { invalidateOneViewSummaryCache } from "./oneview-runtime-cache.js";

const MAX_COMMENT_LENGTH = 500;
const ALERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const IDEMPOTENCY_HEADER_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function csv(value) {
  return new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
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

function safeComment(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_COMMENT_LENGTH) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function requestId(req) {
  const candidate = headerValue(req, "x-request-id");
  return /^[a-z0-9._:-]{1,80}$/i.test(candidate) ? candidate : randomUUID();
}

function correlationId(req, fallback) {
  const candidate = headerValue(req, "x-correlation-id");
  return /^[a-z0-9._:-]{1,80}$/i.test(candidate) ? candidate : fallback;
}

function idempotencyKey(req, alertId, actorId, comment) {
  const supplied = headerValue(req, "idempotency-key");
  if (supplied && !IDEMPOTENCY_HEADER_PATTERN.test(supplied)) return null;
  const material = supplied || `${alertId}\n${actorId}\n${comment}`;
  return `ack-request:${createHash("sha256").update(`${alertId}\n${actorId}\n${material}`).digest("hex")}`;
}

function sendJson(res, status, payload) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res) {
  res.setHeader("Allow", "POST");
  return sendJson(res, 405, { error: "method_not_allowed" });
}

function publicDatabaseError(error) {
  if (error?.code === "actions_database_not_configured") return "actions_database_not_configured";
  return "database_unavailable";
}

export function getAckRequestConfig(env = process.env) {
  return Object.freeze({
    allowAllAuthenticatedActions: booleanValue(env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS, false),
    requestEnabled: booleanValue(env.ONEVIEW_ACK_REQUEST_ENABLED, false),
    executionEnabled: booleanValue(env.ONEVIEW_ACK_EXECUTION_ENABLED, false),
    allowedDatasources: csv(env.ONEVIEW_ACK_ALLOWED_DATASOURCES),
  });
}

export function createAckRequestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getAckRequestConfig,
  idFactory = randomUUID,
  now = () => new Date(),
  invalidateSummary = invalidateOneViewSummaryCache,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function ackRequestHandler(req, res) {
    const startedAt = Date.now();
    if (req.method !== "POST") return methodNotAllowed(res);

    const auth = await authorize(req, res);
    if (!auth) return;

    const config = configProvider();
    if (!config.allowAllAuthenticatedActions) {
      return sendJson(res, 403, { error: "authenticated_actions_disabled" });
    }
    if (!config.requestEnabled) return sendJson(res, 403, { error: "ack_request_disabled" });
    if (config.executionEnabled) return sendJson(res, 503, { error: "ack_execution_not_supported" });

    const alertId = Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id;
    if (!ALERT_ID_PATTERN.test(String(alertId || ""))) return sendJson(res, 400, { error: "invalid_alert_id" });

    const body = bodyValue(req);
    const comment = safeComment(body.comment);
    if (comment === null || !comment) return sendJson(res, 400, { error: "invalid_comment" });

    const actorId = String(auth.id || "").slice(0, 120);
    const actorName = String(auth.name || auth.email || "Usuário SSO").slice(0, 120);
    if (!actorId) return sendJson(res, 401, { error: "authentication_required" });

    const key = idempotencyKey(req, alertId, actorId, comment);
    if (!key) return sendJson(res, 400, { error: "invalid_idempotency_key" });

    const currentRequestId = requestId(req);
    const currentCorrelationId = correlationId(req, currentRequestId);

    try {
      const result = await transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);

        const alertResult = await client.query(
          `select a.id, a.data_source_id, a.source_event_id, a.acknowledged_source,
                  d.name as datasource_name
             from alerts a
             join data_sources d on d.id = a.data_source_id
            where a.id = $1
            limit 1`,
          [alertId],
        );
        const alert = alertResult.rows[0];
        if (!alert) return { error: "not_found", status: 404 };

        const datasource = String(alert.datasource_name || "").trim().toLowerCase();
        if (!config.allowedDatasources.has(datasource)) return { error: "datasource_not_allowed", status: 403 };

        const existing = await client.query(
          `select id
             from alert_acknowledgements
            where idempotency_key = $1 and acknowledgement_type in ('internal','internal_acknowledgement')
            limit 1`,
          [key],
        );
        if (existing.rows[0]) {
          return { acknowledgementId: existing.rows[0].id, idempotent: true };
        }
        const priorInternalRecognition = await client.query(
          `select id
             from alert_acknowledgements
            where alert_id = $1
              and acknowledgement_type in ('internal','internal_acknowledgement')
              and status in ('recorded','pending','processing')
            order by requested_at desc, id desc
            limit 1`,
          [alert.id],
        );
        if (priorInternalRecognition.rows[0]) {
          return { error: "alert_already_recognized", status: 409 };
        }

        const acknowledgementId = idFactory();
        const auditId = idFactory();
        const createdAt = now();

        await client.query(
          `insert into alert_acknowledgements (
             id, alert_id, data_source_id, acknowledgement_type, status,
             source_event_id, message, operator_name, correlation_id, request_id,
             actor_type, actor_id, idempotency_key, attempts, requested_at, created_at, updated_at
           ) values ($1,$2,$3,'internal','recorded',$4,$5,$6,$7,$8,'sso_user',$9,$10,0,$11,$11,$11)`,
          [acknowledgementId, alert.id, alert.data_source_id, alert.source_event_id, comment,
            actorName, currentCorrelationId, currentRequestId, actorId, key, createdAt],
        );

        await client.query(
          `insert into audit_logs (
             id, actor_name, actor_type, actor_id, action, action_source, entity_type, entity_id,
             data_source_id, alert_id, correlation_id, request_id, after_data, metadata, created_at
           ) values ($1,$2,'sso_user',$3,'alert_internal_acknowledged','vercel_api','alert',$4,$5,$4,$6,$7,$8,$9,$10)`,
          [auditId, actorName, actorId, alert.id, alert.data_source_id, currentCorrelationId, currentRequestId,
            JSON.stringify({ status: "recorded" }),
            JSON.stringify({ acknowledgement_id: acknowledgementId, acknowledgement_type: "internal", actor_email: String(auth.email || "").slice(0, 254), execution_enabled: false }),
            createdAt],
        );

        return { acknowledgementId, idempotent: false };
      });

      if (result.error) return sendJson(res, result.status, { error: result.error });
      invalidateSummary();
      logger({
        event: "oneview_ack_request",
        route: "/api/oneview/alerts/:id/ack-request",
        status: "recorded",
        idempotent: result.idempotent,
        duration_ms: Date.now() - startedAt,
      });
      return sendJson(res, 202, {
        request_id: result.acknowledgementId,
        status: "recorded",
        idempotent: result.idempotent,
        execution_enabled: false,
        actor_name: actorName,
        message: "Reconhecimento interno registrado no OneView. Nenhuma ação foi enviada ao Zabbix.",
      });
    } catch (error) {
      logger({
        event: "oneview_ack_request",
        route: "/api/oneview/alerts/:id/ack-request",
        status: "failed",
        code: publicDatabaseError(error),
        duration_ms: Date.now() - startedAt,
      });
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export default createAckRequestHandler();
