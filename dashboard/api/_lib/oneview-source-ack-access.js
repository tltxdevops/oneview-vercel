import { createHash, randomUUID } from "node:crypto";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { classifyActionsFailure, withOneViewActionsTransaction } from "./oneview-actions-db.js";
import { getSourceAcknowledgeConfig, sourceAckCapability } from "./oneview-source-acknowledge.js";

const PROBE_ACTION_TYPE = "zabbix_event_access_probe";
const ALERT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const CACHE_TTL_SECONDS = 60;

function probeKey(dataSourceId, actorOid, actorUpn, sourceHostId, sourceEventId, bucket) {
  const material = `${dataSourceId}\n${actorOid}\n${actorUpn}\n${sourceHostId}\n${sourceEventId}\n${bucket}`;
  return `source-ack-probe:${createHash("sha256").update(material).digest("hex")}`;
}

function accessResponse(row) {
  const payload = row?.result_payload && typeof row.result_payload === "object" ? row.result_payload : {};
  if (row?.status === "success" && typeof payload.actor_ack_access === "boolean") {
    return { actor_ack_access: payload.actor_ack_access, reason: payload.reason || null, pending: false };
  }
  return { actor_ack_access: "unknown", reason: null, pending: true };
}

function safeErrorCode(error) {
  const code = String(error?.code || "").trim();
  return /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : classifyActionsFailure(error);
}

export function createSourceAckAccessHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "operator"),
  transaction = withOneViewActionsTransaction,
  configProvider = getSourceAcknowledgeConfig,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.error(JSON.stringify(entry)),
} = {}) {
  return async function sourceAckAccessHandler(req, res) {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res);
    if (!auth) return;
    const alertId = String(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id || "").trim();
    const actorId = String(auth.id || "").trim().slice(0, 120);
    const actorOid = String(auth.oid || auth.id || "").trim().toLowerCase().slice(0, 120);
    const actorUpn = String(auth.preferred_username || auth.email || "").trim().toLowerCase().slice(0, 255);
    if (!ALERT_ID_PATTERN.test(alertId)) return sendJson(res, 400, { error: "invalid_alert_id" });
    if (!actorId || !actorOid || !actorUpn) return sendJson(res, 401, { error: "authentication_required" });
    let stage = "config";
    let responseStatus = 200;
    try {
      const config = configProvider();
      stage = "transaction_start";
      const result = await transaction(async (client) => {
        stage = "load_alert";
        const alertResult = await client.query(
          `select a.id, a.data_source_id, a.source_event_id, a.source_host_id, a.status_source, a.resolved_at,
                  a.acknowledged_source, d.name as datasource_name, d.sync_enabled
             from alerts a join data_sources d on d.id = a.data_source_id where a.id = $1 limit 1`,
          [alertId],
        );
        const alert = alertResult.rows[0];
        if (!alert) return { error: "not_found", status: 404 };
        stage = "validate_alert";
        const capability = sourceAckCapability({ datasourceName: alert.datasource_name, syncEnabled: alert.sync_enabled, config });
        if (!capability.source_ack_supported || !capability.source_ack_available) return { ...capability, pending: false };
        if (alert.acknowledged_source) return { ...capability, actor_ack_access: false, reason: "source_already_acknowledged", pending: false };
        if (alert.status_source !== "active" || alert.resolved_at) return { ...capability, actor_ack_access: false, reason: "source_event_resolved", pending: false };
        const hostId = String(alert.source_host_id || "").trim();
        const eventId = String(alert.source_event_id || "").trim();
        if (!hostId || !/^\d+$/.test(eventId)) return { ...capability, actor_ack_access: false, reason: "source_event_not_found", pending: false };
        stage = "lookup_cache";
        const cached = await client.query(
          `select status, result_payload from integration_outbox
            where action_type = $1 and payload ->> 'data_source_id' = $2
              and payload ->> 'actor_oid' = $3 and payload ->> 'actor_upn' = $4
              and payload ->> 'source_host_id' = $5 and payload ->> 'source_event_id' = $6
              and created_at >= now() - make_interval(secs => $7::int)
            order by created_at desc, id desc limit 1`,
          [PROBE_ACTION_TYPE, String(alert.data_source_id), actorOid, actorUpn, hostId, eventId, CACHE_TTL_SECONDS],
        );
        if (cached.rows[0]) return { ...capability, ...accessResponse(cached.rows[0]) };
        const timestamp = now();
        const bucket = Math.floor(timestamp.getTime() / (CACHE_TTL_SECONDS * 1000));
        const outboxId = idFactory();
        stage = "insert_outbox";
        await client.query(
          `insert into integration_outbox (
             id, aggregate_type, aggregate_id, data_source_id, alert_id, action_type, status, priority, payload,
             attempts, max_attempts, available_at, next_attempt_at, idempotency_key, created_by, created_at, updated_at
           ) values ($1,'alert',$2,$3,$2,$4,'pending',90,$5::jsonb,0,1,$6,$6,$7,$8,$6,$6)
           on conflict (idempotency_key) do nothing`,
          [outboxId, alert.id, alert.data_source_id, PROBE_ACTION_TYPE, JSON.stringify({
            alert_id: alert.id, data_source_id: alert.data_source_id, source_event_id: eventId, source_host_id: hostId,
            actor_id: actorId, actor_oid: actorOid, actor_upn: actorUpn, actor_username: actorUpn,
          }), timestamp, probeKey(alert.data_source_id, actorOid, actorUpn, hostId, eventId, bucket), actorId],
        );
        stage = "transaction_commit";
        responseStatus = 202;
        return { ...capability, actor_ack_access: "unknown", reason: null, pending: true };
      });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      return sendJson(res, responseStatus, result);
    } catch (error) {
      try {
        logger({
          event: "source_ack_access_error",
          stage,
          alert_id: alertId,
          error_code: safeErrorCode(error),
        });
      } catch {
        // Logging failure must not alter the fail-closed response.
      }
      return sendJson(res, 503, { error: "source_ack_access_unavailable" });
    }
  };
}

export default createSourceAckAccessHandler();
