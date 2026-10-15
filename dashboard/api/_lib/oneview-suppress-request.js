/** Delegated suppression producer. Acceptance is not origin confirmation. */
import { createHash, randomUUID } from "node:crypto";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { classifyActionsFailure, withOneViewActionsTransaction } from "./oneview-actions-db.js";

const ALERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const EVENT_ID_PATTERN = /^\d{1,20}$/;
const IDEMPOTENCY_HEADER_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const DURATIONS = new Set([1800, 7200, 28800, 0]);
const SUPPRESS_ACTION = "zabbix_event_suppress";
const UNSUPPRESS_ACTION = "zabbix_event_unsuppress";
const PROBE_ACTION = "zabbix_event_suppress_probe";
const READ_ONLY = new Set(["maps"]);

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

function publicDatabaseError(error) {
  if (error?.code === "23514") return "schema_constraint_rejected";
  return classifyActionsFailure(error);
}

export function getSuppressConfig() {
  return {
    enabled: booleanValue(process.env.ONEVIEW_SUPPRESS_REQUEST_ENABLED, false),
    allowedDatasources: csv(process.env.ONEVIEW_SUPPRESS_ALLOWED_DATASOURCES),
    allowedOperators: csv(process.env.ONEVIEW_SUPPRESS_ALLOWED_OPERATORS),
  };
}

export function suppressUiState({ phase, accepted = false, outboxStatus = null, confirmed = false, timedOut = false } = {}) {
  if (phase === "checking") return "checking";
  if (phase === "requesting") return "requesting";
  if (timedOut && confirmed !== true) return "inconclusive";
  if (outboxStatus === "failed" || outboxStatus === "cancelled") return "refused";
  if (outboxStatus === "success" && confirmed === true) return "suppressed";
  if (outboxStatus === "success") return "inconclusive";
  if (accepted || outboxStatus === "pending" || outboxStatus === "processing") return "awaiting";
  return "requesting";
}

export function nextActionAfterTimeout() {
  return "reconcile";
}

function actorOf(auth) {
  const actorId = String(auth?.id || "").trim().slice(0, 120);
  const actorName = String(auth?.name || auth?.email || "").trim().slice(0, 120);
  const actorUsername = String(auth?.preferred_username || auth?.email || "").trim().slice(0, 255);
  return { actorId, actorName, actorUsername };
}

function confirmationKey(header, material) {
  if (!IDEMPOTENCY_HEADER_PATTERN.test(header)) return null;
  return `suppress:${createHash("sha256").update(`${header}\n${material}`).digest("hex")}`;
}

function capability(alert, config, actorUsername) {
  const name = String(alert.datasource_name || "").trim().toLowerCase();
  if (!config.enabled) return "suppress_disabled";
  if (READ_ONLY.has(name)) return "suppress_read_only";
  if (!config.allowedDatasources.has(name)) return "datasource_not_allowed";
  if (!config.allowedOperators.has(actorUsername.toLowerCase())) return "operator_not_allowed";
  if (!alert.sync_enabled) return "datasource_not_allowed";
  return null;
}

function replay(row) {
  const payload = row.result_payload && typeof row.result_payload === "object" ? row.result_payload : {};
  const confirmed = row.status === "success" && payload.confirmed === true;
  return {
    status: confirmed ? "confirmed" : "accepted",
    ui_state: suppressUiState({ phase: "settled", accepted: true, outboxStatus: row.status, confirmed }),
    origin_confirmed: confirmed,
    outbox_id: row.id,
    idempotent: true,
    reason: payload.reason || null,
  };
}

const ALERT_SQL = `/* oneview_suppress_alert */
  select a.id, a.data_source_id, a.source_event_id, a.status_source, a.resolved_at,
         a.payload_normalized->>'suppression_origin' as suppression_origin,
         a.payload_normalized->>'suppression_confirmation' as suppression_confirmation,
         a.payload_normalized->>'suppress_until' as suppress_until,
         a.payload_normalized->>'suppression_user_id' as suppression_user_id,
         d.name as datasource_name, d.sync_enabled
    from alerts a
    join data_sources d on d.id = a.data_source_id
   where a.id = $1
   limit 1`;

async function loadAlert(client, alertId) {
  const found = await client.query(ALERT_SQL, [alertId]);
  return found.rows[0] || null;
}

function validateAlert(alert, suppliedEventId) {
  if (!alert) return { error: "not_found", status: 404 };
  if (alert.status_source !== "active" || alert.resolved_at) return { error: "source_event_resolved", status: 409 };
  if (!EVENT_ID_PATTERN.test(String(alert.source_event_id || ""))) return { error: "source_event_id_missing", status: 409 };
  if (suppliedEventId && suppliedEventId !== String(alert.source_event_id)) return { error: "source_event_id_mismatch", status: 409 };
  return null;
}

async function insertOutbox(client, { idFactory, now, alert, actionType, key, actor, payload }) {
  const existing = await client.query(
    `/* oneview_suppress_existing */ select id, status, result_payload, payload from integration_outbox where idempotency_key = $1 limit 1`,
    [key],
  );
  if (existing.rows[0]) {
    const rawPayload = existing.rows[0].payload || {};
    const stored = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    if (stored.reason !== payload.reason || stored.duration_seconds !== payload.duration_seconds || stored.action_type !== actionType) {
      return { error: "idempotency_conflict", status: 409 };
    }
    return { replay: existing.rows[0] };
  }
  const outboxId = idFactory();
  const timestamp = now();
  await client.query(
    `/* oneview_suppress_insert */ insert into integration_outbox (
       id, aggregate_type, aggregate_id, data_source_id, alert_id, action_type, status,
       priority, payload, attempts, max_attempts, available_at, next_attempt_at,
       idempotency_key, created_by, created_at, updated_at
     ) values ($1,'alert',$2,$3,$2,$4,'pending',100,$5::jsonb,0,5,$6,$6,$7,$8,$6,$6)`,
    [outboxId, alert.id, alert.data_source_id, actionType, JSON.stringify({ ...payload, action_type: actionType }), timestamp, key, actor.actorId],
  );
  return { outboxId };
}

function accepted(outboxId) {
  return {
    status: "accepted",
    ui_state: "awaiting",
    origin_confirmed: false,
    outbox_id: outboxId,
    idempotent: false,
  };
}

export function createSuppressHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getSuppressConfig,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.error(JSON.stringify(entry)),
} = {}) {
  return async function suppressHandler(req, res) {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res);
    if (!auth) return;
    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const body = bodyValue(req);
    const actor = actorOf(auth);
    const reason = String(body.reason || "").trim();
    const duration = Number(body.duration_seconds);
    const indefinite = body.indefinite_confirmed === true;
    const suppliedEventId = String(body.source_event_id || "").trim();
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    if (!actor.actorId || !actor.actorName || !actor.actorUsername) return sendJson(res, 401, { error: "authentication_required" });
    if (!DURATIONS.has(duration) || (duration === 0 && !indefinite)) return sendJson(res, 400, { error: "invalid_duration" });
    if (reason.length < 3 || reason.length > 500) return sendJson(res, 400, { error: "reason_required" });
    const header = headerValue(req, "idempotency-key").trim();
    const key = confirmationKey(header, `${alertId}\n${actor.actorId}\n${suppliedEventId}\n${reason}\n${duration}\n${indefinite}`);
    if (!key) return sendJson(res, 400, { error: "invalid_idempotency_key" });
    try {
      const result = await transaction(async (client) => {
        const alert = await loadAlert(client, alertId);
        const invalid = validateAlert(alert, suppliedEventId);
        if (invalid) return invalid;
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`suppress:${alert.data_source_id}:${alert.source_event_id}`]);
        const denied = capability(alert, configProvider(), actor.actorUsername);
        if (denied) return { error: denied, status: denied === "suppress_read_only" ? 409 : 403 };
        const saved = await insertOutbox(client, {
          idFactory, now, alert, actionType: SUPPRESS_ACTION, key, actor,
          payload: {
            alert_id: alert.id,
            data_source_id: alert.data_source_id,
            source_event_id: String(alert.source_event_id),
            datasource_name: alert.datasource_name,
            actor_id: actor.actorId,
            actor_name: actor.actorName,
            actor_username: actor.actorUsername,
            reason,
            duration_seconds: duration,
            indefinite_confirmed: duration === 0,
          },
        });
        if (saved.error) return saved;
        if (saved.replay) return { replay: saved.replay };
        return { outboxId: saved.outboxId };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      if (result.replay) {
        const body = replay(result.replay);
        return sendJson(res, body.origin_confirmed ? 200 : 202, body);
      }
      logger({ event: "oneview_suppress_enqueued", status: "accepted" });
      return sendJson(res, 202, accepted(result.outboxId));
    } catch (error) {
      logger({ event: "oneview_suppress_enqueued", status: "failed", code: publicDatabaseError(error) });
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export function createUnsuppressHandler(options = {}) {
  const {
    authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
    transaction = withOneViewActionsTransaction,
    configProvider = getSuppressConfig,
    idFactory = randomUUID,
    now = () => new Date(),
    logger = (entry) => console.error(JSON.stringify(entry)),
  } = options;
  return async function unsuppressHandler(req, res) {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res);
    if (!auth) return;
    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const body = bodyValue(req);
    const actor = actorOf(auth);
    const suppliedEventId = String(body.source_event_id || "").trim();
    const expectedUntil = Number(body.expected_suppress_until);
    const expectedUser = String(body.expected_userid || "").trim();
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    if (!actor.actorId || !actor.actorName || !actor.actorUsername) return sendJson(res, 401, { error: "authentication_required" });
    if (!Number.isInteger(expectedUntil) || expectedUntil < 0 || !/^\d+$/.test(expectedUser)) {
      return sendJson(res, 400, { error: "period_not_identified" });
    }
    const header = headerValue(req, "idempotency-key").trim();
    const key = confirmationKey(header, `unsuppress\n${alertId}\n${actor.actorId}\n${expectedUntil}\n${expectedUser}`);
    if (!key) return sendJson(res, 400, { error: "invalid_idempotency_key" });
    try {
      const result = await transaction(async (client) => {
        const alert = await loadAlert(client, alertId);
        const invalid = validateAlert(alert, suppliedEventId);
        if (invalid) return invalid;
        const denied = capability(alert, configProvider(), actor.actorUsername);
        if (denied) return { error: denied, status: denied === "suppress_read_only" ? 409 : 403 };
        if (alert.suppression_origin === "maintenance") return { error: "third_party_maintenance", status: 409 };
        if (alert.suppression_confirmation !== "confirmed") return { error: "suppression_unconfirmed", status: 409 };
        if (String(alert.suppression_user_id || "") !== expectedUser) return { error: "suppressed_by_other", status: 409 };
        if (String(alert.suppress_until || "") !== String(expectedUntil)) return { error: "period_not_identified", status: 409 };
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`unsuppress:${alert.data_source_id}:${alert.source_event_id}`]);
        const saved = await insertOutbox(client, {
          idFactory, now, alert, actionType: UNSUPPRESS_ACTION, key, actor,
          payload: {
            alert_id: alert.id,
            data_source_id: alert.data_source_id,
            source_event_id: String(alert.source_event_id),
            datasource_name: alert.datasource_name,
            actor_id: actor.actorId,
            actor_name: actor.actorName,
            actor_username: actor.actorUsername,
            reason: "unsuppress",
            duration_seconds: null,
            expected_suppress_until: expectedUntil,
            expected_userid: expectedUser,
          },
        });
        if (saved.error) return saved;
        if (saved.replay) return { replay: saved.replay };
        return { outboxId: saved.outboxId };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error, ui_state: "refused" });
      if (result.replay) return sendJson(res, 202, replay(result.replay));
      logger({ event: "oneview_unsuppress_enqueued", status: "accepted" });
      return sendJson(res, 202, accepted(result.outboxId));
    } catch (error) {
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export function createSuppressAccessHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getSuppressConfig,
  idFactory = randomUUID,
  now = () => new Date(),
} = {}) {
  return async function suppressAccessHandler(req, res) {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res);
    if (!auth) return;
    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const actor = actorOf(auth);
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    if (!actor.actorId || !actor.actorUsername) return sendJson(res, 401, { error: "authentication_required" });
    try {
      const result = await transaction(async (client) => {
        const alert = await loadAlert(client, alertId);
        if (!alert) return { error: "not_found", status: 404 };
        const denied = capability(alert, configProvider(), actor.actorUsername);
        if (denied) return { actor_suppress_access: false, reason: denied, pending: false, statusCode: 200 };
        const cached = await client.query(
          `/* oneview_suppress_probe_cache */ select status, result_payload from integration_outbox
            where action_type = $1 and payload ->> 'actor_id' = $2 and payload ->> 'source_event_id' = $3
              and created_at >= now() - interval '60 seconds'
            order by created_at desc limit 1`,
          [PROBE_ACTION, actor.actorId, String(alert.source_event_id || "")],
        );
        const cachedRow = cached.rows[0];
        const cachedPayload = cachedRow?.result_payload || {};
        if (cachedRow?.status === "success" && typeof cachedPayload.actor_suppress_access === "boolean") {
          return { actor_suppress_access: cachedPayload.actor_suppress_access, reason: cachedPayload.reason || null, pending: false, statusCode: 200 };
        }
        const timestamp = now();
        const bucket = Math.floor(timestamp.getTime() / 60000);
        const key = `suppress-probe:${createHash("sha256").update(`${alert.id}\n${actor.actorId}\n${bucket}`).digest("hex")}`;
        await client.query(
          `/* oneview_suppress_probe_insert */ insert into integration_outbox (
             id, aggregate_type, aggregate_id, data_source_id, alert_id, action_type, status, priority, payload,
             attempts, max_attempts, available_at, next_attempt_at, idempotency_key, created_by, created_at, updated_at
           ) values ($1,'alert',$2,$3,$2,$4,'pending',90,$5::jsonb,0,1,$6,$6,$7,$8,$6,$6)
           on conflict (idempotency_key) do nothing`,
          [idFactory(), alert.id, alert.data_source_id, PROBE_ACTION, JSON.stringify({
            alert_id: alert.id,
            data_source_id: alert.data_source_id,
            source_event_id: String(alert.source_event_id || ""),
            datasource_name: alert.datasource_name,
            actor_id: actor.actorId,
            actor_name: actor.actorName || actor.actorUsername,
            actor_username: actor.actorUsername,
          }), timestamp, key, actor.actorId],
        );
        return { actor_suppress_access: "unknown", reason: null, pending: true, ui_state: "checking", statusCode: 202 };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      const statusCode = result.statusCode || 200;
      return sendJson(res, statusCode, result);
    } catch (error) {
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export function createSuppressStatusHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
} = {}) {
  return async function suppressStatusHandler(req, res) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const auth = await authorize(req, res);
    if (!auth) return;
    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const actor = actorOf(auth);
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    try {
      const result = await transaction(async (client) => {
        const alert = await loadAlert(client, alertId);
        if (!alert) return { error: "not_found", status: 404 };
        const outboxId = String(req.query?.outbox_id || "").trim();
        const latest = await client.query(
          `/* oneview_suppress_status */ select id, status, result_payload, action_type from integration_outbox
            where alert_id = $1 and action_type = any($2) and payload ->> 'actor_id' = $3
              and ($4 = '' or id = $4)
            order by created_at desc limit 1`,
          [alertId, [SUPPRESS_ACTION, UNSUPPRESS_ACTION], actor.actorId, outboxId],
        );
        const periods = await client.query(
          `/* oneview_suppress_periods */ select id, action_type, metadata, created_at from alert_history
            where alert_id = $1 and action_type in ('oneview_suppression_period', 'external_suppression_observed')
            order by created_at asc`,
          [alertId],
        );
        const row = latest.rows[0];
        const payload = row?.result_payload || {};
        const confirmed = row?.status === "success" && payload.confirmed === true;
        const untilText = String(alert.suppress_until || "");
        const userText = String(alert.suppression_user_id || "");
        const identified = alert.suppression_origin === "manual"
          && alert.suppression_confirmation === "confirmed"
          && /^\d+$/.test(untilText)
          && /^\d+$/.test(userText);
        const unsuppressReason = alert.suppression_origin === "maintenance"
          ? "third_party_maintenance"
          : identified ? null : "suppression_not_identified";
        return {
          ui_state: row ? suppressUiState({ phase: "settled", accepted: true, outboxStatus: row.status, confirmed }) : "checking",
          origin_confirmed: confirmed,
          outbox_status: row?.status || null,
          reason: payload.reason || null,
          periods: periods.rows.map((item) => ({
            id: item.id,
            action_type: item.action_type,
            ...(item.metadata || {}),
          })),
          period_count: periods.rows.length,
          unsuppress: {
            enabled: identified,
            reason: unsuppressReason,
            expected_suppress_until: identified ? Number(untilText) : null,
            expected_userid: identified ? userText : null,
          },
        };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 503, { error: publicDatabaseError(error) });
    }
  };
}

export default createSuppressHandler();
