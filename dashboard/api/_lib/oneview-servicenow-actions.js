/**
 * OV-P0-280A — authenticated request contract only.
 *
 * This module writes a sanitized request to integration_outbox. It deliberately
 * has no ServiceNow client, credential, cookie or network dependency: a Worker
 * will be the only future executor.
 */
import { createHash, randomUUID } from "node:crypto";

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";

export const SERVICENOW_INCIDENT_ACTIONS = Object.freeze([
  "servicenow.assume_self",
  "servicenow.assign_group",
  "servicenow.work_note",
  "servicenow.hold",
]);

const SYS_ID_PATTERN = /^[a-f0-9]{32}$/i;
const INCIDENT_NUMBER_PATTERN = /^INC\d{1,32}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const OUTBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,79}$/i;
const MAX_WORK_NOTE_LENGTH = 2_000;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function requestBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try {
    const parsed = JSON.parse(String(req.body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requestSysId(req) {
  const raw = Array.isArray(req.query?.sysId) ? req.query.sysId[0] : req.query?.sysId;
  return text(raw).toLowerCase();
}

function requestOutboxId(req) {
  const raw = Array.isArray(req.query?.outbox_id) ? req.query.outbox_id[0] : req.query?.outbox_id;
  return OUTBOX_ID_PATTERN.test(text(raw)) ? text(raw) : "";
}

function hashKey({ actorId, incidentSysId, action, idempotencyKey }) {
  return `sn-action:${createHash("sha256")
    .update(`${actorId}\n${incidentSysId}\n${action}\n${idempotencyKey}`)
    .digest("hex")}`;
}

function publicStatus(status) {
  if (status === "success" || status === "succeeded") return "succeeded";
  if (status === "processing") return "processing";
  if (status === "failed") return "failed";
  return "pending";
}

function timestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function actionResponse(row, idempotent = false) {
  return {
    action_id: row.id,
    action: row.action_type,
    status: publicStatus(row.status),
    requested_at: timestamp(row.created_at),
    processed_at: timestamp(row.processed_at),
    error_code: row.status === "failed" && /^[a-z0-9_:-]{1,80}$/i.test(String(row.last_error || ""))
      ? String(row.last_error)
      : null,
    idempotent,
  };
}

function configOptions(config) {
  return {
    enabled: config.requestEnabled && config.allowAllAuthenticatedActions,
    actions: SERVICENOW_INCIDENT_ACTIONS,
    assignable_groups: config.assignableGroups,
    hold_reasons: config.holdReasons,
  };
}

function sanitizeActionPayload(action, rawPayload, config) {
  const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload : {};
  if (action === "servicenow.assume_self") return { value: {}, error: null };

  if (action === "servicenow.assign_group") {
    const targetGroup = text(payload.target_group);
    if (!targetGroup || !config.assignableGroups.includes(targetGroup)) return { value: null, error: "invalid_target_group" };
    return { value: { target_group: targetGroup }, error: null };
  }

  if (action === "servicenow.work_note") {
    const workNote = text(payload.work_note);
    // Reject markup rather than modifying it: the authorized, persisted text is exact after trim.
    if (!workNote || workNote.length > MAX_WORK_NOTE_LENGTH || /[<>]/.test(workNote)) return { value: null, error: "invalid_work_note" };
    return { value: { work_note: workNote }, error: null };
  }

  if (action === "servicenow.hold") {
    const holdReason = text(payload.hold_reason);
    if (!holdReason || !config.holdReasons.includes(holdReason)) return { value: null, error: "invalid_hold_reason" };
    return { value: { hold_reason: holdReason, state: "3" }, error: null };
  }

  return { value: null, error: "invalid_action" };
}

export function getServiceNowActionsConfig(env = process.env) {
  return Object.freeze({
    allowAllAuthenticatedActions: booleanValue(env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS),
    requestEnabled: booleanValue(env.ONEVIEW_SERVICENOW_ACTIONS_ENABLED),
    // Values are environment-audited logical choices; no group/vendor is embedded in code.
    assignableGroups: csv(env.ONEVIEW_SERVICENOW_ASSIGNABLE_GROUPS),
    holdReasons: csv(env.ONEVIEW_SERVICENOW_HOLD_REASONS),
  });
}

function publicDatabaseError(error) {
  return error?.code === "actions_database_not_configured"
    ? "actions_database_not_configured"
    : "database_unavailable";
}

export function createServiceNowIncidentActionsHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getServiceNowActionsConfig,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function serviceNowIncidentActionsHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!["POST", "GET"].includes(req.method)) return methodNotAllowed(res, ["POST", "GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;
    const actorId = text(auth.id).slice(0, 120);
    if (!actorId) return sendJson(res, 401, { error: "authentication_required" });
    const config = configProvider();

    if (req.method === "GET" && !requestOutboxId(req)) return sendJson(res, 200, configOptions(config));
    if (!config.allowAllAuthenticatedActions) return sendJson(res, 403, { error: "authenticated_actions_disabled" });
    if (!config.requestEnabled) return sendJson(res, 403, { error: "servicenow_actions_disabled" });

    const incidentSysId = requestSysId(req);
    if (!SYS_ID_PATTERN.test(incidentSysId)) return sendJson(res, 400, { error: "invalid_incident_sys_id" });

    if (req.method === "GET") {
      const outboxId = requestOutboxId(req);
      try {
        const row = await transaction(async (client) => {
          const result = await client.query(
            `select id, action_type, status, created_at, processed_at, last_error
               from integration_outbox
              where id = $1 and aggregate_type = 'incident' and aggregate_id = $2 and created_by = $3
                and action_type = any($4::text[])
              limit 1`,
            [outboxId, incidentSysId, actorId, SERVICENOW_INCIDENT_ACTIONS],
          );
          return result.rows[0] || null;
        });
        return row ? sendJson(res, 200, actionResponse(row)) : sendJson(res, 404, { error: "action_not_found" });
      } catch (error) {
        return sendJson(res, 503, { error: publicDatabaseError(error) });
      }
    }

    const body = requestBody(req);
    const action = text(body.action);
    const incidentNumber = text(body.incident_number).toUpperCase();
    const suppliedKey = text(body.idempotencyKey);
    if (!SERVICENOW_INCIDENT_ACTIONS.includes(action)) return sendJson(res, 400, { error: "invalid_action" });
    if (!INCIDENT_NUMBER_PATTERN.test(incidentNumber)) return sendJson(res, 400, { error: "invalid_incident_number" });
    if (!IDEMPOTENCY_KEY_PATTERN.test(suppliedKey)) return sendJson(res, 400, { error: "invalid_idempotency_key" });
    const sanitized = sanitizeActionPayload(action, body.payload, config);
    if (sanitized.error) return sendJson(res, 400, { error: sanitized.error });

    const idempotencyKey = hashKey({ actorId, incidentSysId, action, idempotencyKey: suppliedKey });
    const actorName = text(auth.name || auth.email || "Usuário SSO").slice(0, 120);
    const actorEmail = text(auth.email).toLowerCase().slice(0, 254);
    const requestedAt = now();
    try {
      const result = await transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
        const incidentResult = await client.query(
          "select sys_id, number from servicenow_incidents where lower(sys_id::text) = $1 limit 1 for share",
          [incidentSysId],
        );
        const incident = incidentResult.rows[0];
        if (!incident) return { error: "incident_not_found", status: 404 };
        if (text(incident.number).toUpperCase() !== incidentNumber) return { error: "incident_number_mismatch", status: 409 };

        const existingResult = await client.query(
          `select id, action_type, status, created_at, processed_at, last_error
             from integration_outbox
            where idempotency_key = $1 and aggregate_type = 'incident' and aggregate_id = $2 and created_by = $3
            limit 1`,
          [idempotencyKey, incidentSysId, actorId],
        );
        if (existingResult.rows[0]) return { row: existingResult.rows[0], idempotent: true };

        const outboxId = idFactory();
        const auditId = idFactory();
        const payload = {
          integration: "servicenow",
          entity_type: "incident",
          entity_id: incidentSysId,
          incident_sys_id: incidentSysId,
          incident_number: incidentNumber,
          requested_by_user_id: actorId,
          requested_by_email: actorEmail,
          requested_at: requestedAt.toISOString(),
          action,
          action_payload: sanitized.value,
          idempotency_key: idempotencyKey,
        };
        const inserted = await client.query(
          `insert into integration_outbox (
             id, aggregate_type, aggregate_id, action_type, status, priority, payload,
             attempts, max_attempts, available_at, next_attempt_at, idempotency_key,
             correlation_id, request_id, created_by, created_at, updated_at
           ) values ($1, 'incident', $2, $3, 'pending', 100, $4::jsonb, 0, 3, $5, $5, $6, $7, $7, $8, $5, $5)
           returning id, action_type, status, created_at, processed_at, last_error`,
          [outboxId, incidentSysId, action, JSON.stringify(payload), requestedAt, idempotencyKey,
            `ov-p0-280a:${outboxId}`, actorId],
        );
        await client.query(
          `insert into audit_logs (
             id, actor_name, actor_type, actor_id, action, action_source, entity_type, entity_id,
             correlation_id, request_id, after_data, metadata, created_at
           ) values ($1,$2,'sso_user',$3,$4,'vercel_api','incident',$5,$6,$6,$7,$8,$9)`,
          [auditId, actorName, actorId, action, incidentSysId, `ov-p0-280a:${outboxId}`,
            JSON.stringify({ status: "pending" }),
            JSON.stringify({ incident_number: incidentNumber, outbox_id: outboxId, work_note: action === "servicenow.work_note" ? { length: sanitized.value.work_note.length, sha256: createHash("sha256").update(sanitized.value.work_note).digest("hex") } : undefined }),
            requestedAt],
        );
        return { row: inserted.rows[0], idempotent: false };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      const response = actionResponse(result.row, result.idempotent);
      logger({ event: "oneview_servicenow_action_request", route: "/api/oneview/incidents/:sysId/actions", action, status: response.status, idempotent: result.idempotent, duration_ms: Date.now() - startedAt });
      return sendJson(res, result.idempotent ? 200 : 202, response);
    } catch (error) {
      const code = publicDatabaseError(error);
      logger({ event: "oneview_servicenow_action_request", route: "/api/oneview/incidents/:sysId/actions", action, status: "failed", code, duration_ms: Date.now() - startedAt });
      return sendJson(res, 503, { error: code });
    }
  };
}

export default createServiceNowIncidentActionsHandler();
