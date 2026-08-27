import { randomUUID, timingSafeEqual } from "node:crypto";

import { methodNotAllowed, sendJson } from "./http.js";
import {
  extractServiceNowIncidentNumbers,
  projectServiceNowReferenceFromAlertTags,
  SERVICENOW_PROD_BASE_URL,
} from "./oneview-inc-correlation.js";
import { findTheoCanaryAlert, findTheoProducedAlert } from "./oneview-db.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";

// Legacy type is reserved for explicit smoke/canary operations. Automatic
// dispatch may claim only rows created by the persisted Worker producer.
export const THEO_ACTION_TYPE = "theo_webex_notification";
export const THEO_AUTO_ACTION_TYPE = "theo_alert_notification_v1";
export const THEO_SMOKE_DEDUPE_KEY = "theo:smoke:ov-p0-192";
export const THEO_CANARY_DEDUPE_PREFIX = "theo:canary:alert:";
export const THEO_DISPATCHER_WORKER_NAME = "theo_dispatcher";
export const THEO_DISPATCHER_CREATED_BY = "vercel-theo-dispatcher";
const THEO_TIMEOUT_MS = 10_000;
const THEO_AUTO_BATCH_SIZE = 5;
const LOCK_TTL_SECONDS = 600;
const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200];
const SAFE_OUTBOX_ID = /^[a-z0-9][a-z0-9-]{7,79}$/i;
const SAFE_ALERT_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
const ONEVIEW_PRODUCTION_ORIGIN = "https://oneview.teletexdev.com.br";

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function text(value) {
  return String(value || "").trim();
}

function queryValue(req, name) {
  const value = req?.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeUrl(value) {
  try {
    const parsed = new URL(text(value));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function authorization(req) {
  const value = req?.headers?.authorization ?? req?.headers?.Authorization ?? "";
  return Array.isArray(value) ? String(value[0] || "") : String(value);
}

function fixedEquals(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function payloadObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanPayloadField(value, fallback = "") {
  return text(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1200) || fallback;
}

const FAKE_CHAMADO_VALUES = new Set(["teste", "n/a", "n-a", "na", "unknown", "desconhecido"]);

/** Real ServiceNow INC only. Never TESTE, N/A, UNKNOWN, or an empty placeholder. */
export function normalizeTheoChamado(value) {
  const cleaned = cleanPayloadField(value);
  if (!cleaned || FAKE_CHAMADO_VALUES.has(cleaned.toLowerCase())) return null;
  return extractServiceNowIncidentNumbers(cleaned)[0] || null;
}

function publicErrorCode(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (error?.name === "AbortError" || /abort|timeout|timed out/.test(message)) return "timeout";
  return "network_error";
}

function retryDelaySeconds(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_SECONDS.length - 1, Number(attempts || 1) - 1));
  return RETRY_DELAYS_SECONDS[index];
}

function retryAfterSeconds(response, fallback) {
  const value = response?.headers?.get?.("retry-after");
  const seconds = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 7200 ? seconds : fallback;
}

export function getTheoDispatchConfig(env = process.env) {
  return Object.freeze({
    url: safeUrl(env.THEO_ONEVIEW_URL),
    token: text(env.THEO_ONEVIEW_TOKEN),
    cronSecret: text(env.CRON_SECRET),
    automationEnabled: bool(env.THEO_ONEVIEW_AUTOMATION_ENABLED, false),
    timeoutMs: Math.min(Math.max(Number(env.THEO_ONEVIEW_TIMEOUT_MS) || THEO_TIMEOUT_MS, 1000), 25_000),
    batchSize: Math.min(Math.max(Number(env.THEO_ONEVIEW_DISPATCH_BATCH_SIZE) || THEO_AUTO_BATCH_SIZE, 1), 10),
  });
}

export function theoSmokePayload() {
  return {
    titulo: "TESTE OneView - Theo via Vercel",
    cliente: "OneView",
    equipamento: "TESTE",
    ip: "N/A",
    data_hora: "",
    acao: "Validação do dispatcher server-side do OneView.",
    proximos_passos: "Nenhuma ação necessária.",
    acompanhamento: "Equipe NOC",
    severidade: "Teste",
    chamado: "TESTE",
    link: "https://oneview.teletexdev.com.br",
  };
}

export function theoCanaryDedupeKey(alertId) {
  return `${THEO_CANARY_DEDUPE_PREFIX}${text(alertId).toLowerCase()}`;
}

export function buildOneViewAlertDeepLink(alertId) {
  const id = text(alertId).toLowerCase();
  return SAFE_ALERT_ID.test(id) ? `${ONEVIEW_PRODUCTION_ORIGIN}/alertas?alert=${encodeURIComponent(id)}` : null;
}

/** Maps an eligible database alert to the same contract consumed by automation. */
export function buildTheoAlertPayload(alert, now = new Date()) {
  const source = payloadObject(alert);
  const incident = projectServiceNowReferenceFromAlertTags(source, {
    baseUrl: SERVICENOW_PROD_BASE_URL,
    allowLinkTagFallback: false,
  });
  const title = source.titulo || source.problem_name || source.trigger_description;
  const host = source.equipamento || source.host_visible_name || source.host_technical_name || source.host_name;
  const oneviewLink = buildOneViewAlertDeepLink(source.id) || ONEVIEW_PRODUCTION_ORIGIN;
  const chamado = normalizeTheoChamado(source.chamado || incident?.number);
  return {
    titulo: title,
    cliente: source.cliente || source.customer_name || source.client_name,
    equipamento: host,
    ip: source.ip || source.host_ip,
    data_hora: source.data_hora || source.first_seen_at || source.last_seen_at || now.toISOString(),
    acao: source.acao || source.operational_data || source.trigger_description || title,
    proximos_passos: source.proximos_passos || "Validar o alerta no OneView.",
    acompanhamento: source.acompanhamento || "Equipe NOC",
    severidade: source.severidade || source.severity,
    ...(chamado ? { chamado } : {}),
    link: oneviewLink,
    oneview_link: oneviewLink,
    ...(incident?.url ? { servicenow_link: incident.url } : {}),
  };
}

/** Builds only the validated Theo contract; no token or dispatcher metadata leaves the BFF. */
export function buildTheoPayload(payload, now = new Date()) {
  const source = payloadObject(payload);
  const smoke = theoSmokePayload();
  const link = cleanPayloadField(source.link, smoke.link);
  const oneviewLink = cleanPayloadField(source.oneview_link, link);
  const servicenowLink = cleanPayloadField(source.servicenow_link);
  const chamado = normalizeTheoChamado(source.chamado);
  return {
    titulo: cleanPayloadField(source.titulo, smoke.titulo),
    cliente: cleanPayloadField(source.cliente, smoke.cliente),
    equipamento: cleanPayloadField(source.equipamento, smoke.equipamento),
    ip: cleanPayloadField(source.ip, smoke.ip),
    data_hora: cleanPayloadField(source.data_hora, now.toISOString()),
    acao: cleanPayloadField(source.acao, smoke.acao),
    proximos_passos: cleanPayloadField(source.proximos_passos, smoke.proximos_passos),
    acompanhamento: cleanPayloadField(source.acompanhamento, smoke.acompanhamento),
    severidade: cleanPayloadField(source.severidade, smoke.severidade),
    ...(chamado ? { chamado } : {}),
    link,
    oneview_link: oneviewLink,
    ...(servicenowLink ? { servicenow_link: servicenowLink } : {}),
  };
}

export async function createTheoSmokeOutbox(client, { idFactory = randomUUID, now = new Date() } = {}) {
  const outboxId = idFactory();
  const payload = { ...theoSmokePayload(), data_hora: now.toISOString() };
  const result = await client.query(
    `
      insert into integration_outbox (
        id, aggregate_type, aggregate_id, action_type, status, priority, payload,
        attempts, max_attempts, available_at, next_attempt_at, idempotency_key,
        correlation_id, request_id, created_by, created_at, updated_at
      ) values ($1, 'oneview', $1, $2, 'pending', 100, $3::jsonb, 0, 3, $4, $4, $5, $6, $6, $7, $4, $4)
      on conflict (idempotency_key) do update set updated_at = integration_outbox.updated_at
      returning id, status, attempts, max_attempts, payload, idempotency_key
    `,
    [outboxId, THEO_ACTION_TYPE, JSON.stringify(payload), now, THEO_SMOKE_DEDUPE_KEY, `ov-p0-192:${outboxId}`, THEO_DISPATCHER_CREATED_BY],
  );
  return result.rows[0] || null;
}

export async function createTheoCanaryOutbox(client, {
  alert,
  alertId,
  idFactory = randomUUID,
  now = new Date(),
} = {}) {
  const normalizedAlertId = text(alertId || alert?.id).toLowerCase();
  const outboxId = idFactory();
  const payload = buildTheoAlertPayload(alert, now);
  const dedupeKey = theoCanaryDedupeKey(normalizedAlertId);
  const result = await client.query(
    `
      insert into integration_outbox (
        id, aggregate_type, aggregate_id, action_type, status, priority, payload,
        attempts, max_attempts, available_at, next_attempt_at, idempotency_key,
        correlation_id, request_id, created_by, created_at, updated_at
      ) values ($1, 'alert', $2, $3, 'pending', 100, $4::jsonb, 0, 3, $5, $5, $6, $7, $7, $8, $5, $5)
      on conflict (idempotency_key) do update set updated_at = integration_outbox.updated_at
      returning id, status, attempts, max_attempts, payload, idempotency_key
    `,
    [outboxId, normalizedAlertId, THEO_ACTION_TYPE, JSON.stringify(payload), now, dedupeKey, `ov-p0-206:${normalizedAlertId}`, THEO_DISPATCHER_CREATED_BY],
  );
  return result.rows[0] || null;
}

/** PostgreSQL claim is the cross-instance idempotency boundary. */
export async function claimEligibleTheoOutbox(client, {
  actionType = THEO_ACTION_TYPE,
  outboxId = null,
  allowAutomation = false,
  allowedDedupeKey = null,
  lockedBy,
  lockTtlSeconds = LOCK_TTL_SECONDS,
} = {}) {
  const result = await client.query(
    `
      with candidate as (
        select o.id
          from integration_outbox o
         where o.action_type = $1
           and ($2::text is null or o.id = $2)
           and o.status in ('pending', 'failed')
           and o.attempts < o.max_attempts
           and o.next_attempt_at <= now()
           and ($3::boolean or o.idempotency_key = $4 or ($5::text is not null and o.idempotency_key = $5))
         order by o.created_at asc, o.id asc
         limit 1
         for update skip locked
      )
      update integration_outbox o
         set status = 'processing',
             attempts = o.attempts + 1,
             locked_at = now(),
             locked_by = $6,
             lock_expires_at = now() + make_interval(secs => $7::int),
             updated_at = now()
        from candidate
       where o.id = candidate.id
      returning o.id, o.action_type, o.payload, o.attempts, o.max_attempts, o.idempotency_key
    `,
    [actionType, outboxId, allowAutomation, THEO_SMOKE_DEDUPE_KEY, allowedDedupeKey, lockedBy, lockTtlSeconds],
  );
  return result.rows[0] || null;
}

export async function finishTheoOutbox(client, {
  actionType = THEO_ACTION_TYPE,
  outboxId,
  lockedBy,
  success = false,
  retryable = false,
  httpStatus = null,
  errorCode = null,
  retryAfterSeconds: retryAfter = 0,
} = {}) {
  const result = await client.query(
    `
      update integration_outbox
         set status = case when $3::boolean then 'success' else 'failed' end,
             attempts = case when $3::boolean or $4::boolean then attempts else max_attempts end,
             processed_at = case when $3::boolean or not $4::boolean then now() else null end,
             next_attempt_at = case when $3::boolean or not $4::boolean then now() else now() + make_interval(secs => $7::int) end,
             result_payload = case when $3::boolean then jsonb_build_object('http_status', $5::int) else null end,
             last_error = case when $3::boolean then null else $6 end,
             locked_at = null,
             locked_by = null,
             lock_expires_at = null,
             updated_at = now()
       where id = $1
         and action_type = $2
         and status = 'processing'
         and locked_by = $8
      returning id, status, attempts, processed_at, next_attempt_at
    `,
    [outboxId, actionType, success, retryable, httpStatus, errorCode, retryAfter, lockedBy],
  );
  return result.rows[0] || null;
}

/** Persists the Vercel dispatcher heartbeat without making its health depend on memory. */
export async function recordTheoDispatcherHeartbeat(client, {
  success = false,
  errorCode = null,
  hostname = process.env.VERCEL_REGION || "vercel",
  version = process.env.VERCEL_GIT_COMMIT_SHA || "bff",
} = {}) {
  await client.query(
    `
      insert into worker_heartbeats (
        worker_id, status, hostname, version, last_seen_at, last_cycle_at,
        last_error, metadata, created_at, updated_at
      ) values (
        $1, 'running', $2, $3, now(), now(), $4,
        jsonb_build_object('worker_name', $1, 'last_success_at', case when $5::boolean then now() else null end),
        now(), now()
      )
      on conflict (worker_id) do update
         set status = 'running',
             hostname = excluded.hostname,
             version = excluded.version,
             last_seen_at = now(),
             last_cycle_at = now(),
             last_error = excluded.last_error,
             metadata = jsonb_build_object(
               'worker_name', $1,
               'last_success_at', case when $5::boolean then now() else worker_heartbeats.metadata->>'last_success_at' end
             ),
             updated_at = now()
    `,
    [THEO_DISPATCHER_WORKER_NAME, text(hostname).slice(0, 160) || "vercel", text(version).slice(0, 160) || "bff", text(errorCode).slice(0, 120) || null, success],
  );
}

function internalAuthorized(req, config) {
  if (!config.cronSecret) return false;
  return fixedEquals(authorization(req), `Bearer ${config.cronSecret}`);
}

function isSmokeRequest(req) {
  return String(queryValue(req, "smoke") || "").trim() === "1";
}

function requestedOutboxId(req) {
  const value = text(queryValue(req, "outbox_id"));
  return SAFE_OUTBOX_ID.test(value) ? value : null;
}

function requestedCanaryAlertId(req) {
  const raw = queryValue(req, "canary_alert_id");
  if (raw === undefined || raw === null || text(raw) === "") return { present: false, value: null, valid: true };
  const value = text(raw).toLowerCase();
  return { present: true, value, valid: /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/.test(value) };
}

function eligibleCanaryAlert(alert) {
  const severity = text(alert?.severity || alert?.severidade).toLowerCase();
  const status = text(alert?.status_source || alert?.status).toLowerCase();
  return Boolean(alert?.id)
    && !alert.resolved_at
    && status === "active"
    && (severity === "high" || severity === "disaster");
}

export function createTheoDispatchHandler({
  transaction = withOneViewActionsTransaction,
  configProvider = getTheoDispatchConfig,
  createSmoke = createTheoSmokeOutbox,
  findCanary = findTheoCanaryAlert,
  findProducedAlert = findTheoProducedAlert,
  createCanary = createTheoCanaryOutbox,
  claim = claimEligibleTheoOutbox,
  finish = finishTheoOutbox,
  heartbeat = recordTheoDispatcherHeartbeat,
  fetchFn = globalThis.fetch,
  idFactory = randomUUID,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function theoDispatchHandler(req, res) {
    const startedAt = Date.now();
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

    const config = configProvider();
    if (!internalAuthorized(req, config)) return sendJson(res, 401, { error: "authentication_required" });
    if (!config.url || !config.token) return sendJson(res, 503, { error: "theo_dispatch_not_configured" });

    const smoke = isSmokeRequest(req);
    const canary = requestedCanaryAlertId(req);
    if (canary.present && !canary.valid) return sendJson(res, 400, { error: "invalid_canary_alert_id" });
    if (smoke && canary.present) return sendJson(res, 400, { error: "ambiguous_dispatch_request" });
    if (canary.present && config.automationEnabled) return sendJson(res, 403, { error: "canary_requires_automation_disabled" });
    let targetId = requestedOutboxId(req);
    let allowedDedupeKey = null;
    let actionType = THEO_AUTO_ACTION_TYPE;
    if (smoke) {
      const smokeOutbox = await transaction((client) => createSmoke(client, { idFactory, now: now() }));
      targetId = smokeOutbox?.id || null;
      actionType = THEO_ACTION_TYPE;
    } else if (canary.present) {
      let alert;
      try {
        alert = await findCanary(canary.value);
      } catch {
        logger({ event: "theo_dispatch", status: "failed", code: "database_unavailable", duration_ms: Date.now() - startedAt });
        return sendJson(res, 503, { error: "database_unavailable" });
      }
      if (!eligibleCanaryAlert(alert)) return sendJson(res, 422, { error: "canary_alert_not_eligible" });
      let canaryOutbox;
      try {
        canaryOutbox = await transaction((client) => createCanary(client, {
          alert,
          alertId: canary.value,
          idFactory,
          now: now(),
        }));
      } catch {
        logger({ event: "theo_dispatch", status: "failed", code: "database_unavailable", duration_ms: Date.now() - startedAt });
        return sendJson(res, 503, { error: "database_unavailable" });
      }
      targetId = canaryOutbox?.id || null;
      allowedDedupeKey = theoCanaryDedupeKey(canary.value);
      actionType = THEO_ACTION_TYPE;
    } else if (!config.automationEnabled) {
      return sendJson(res, 403, { error: "theo_automation_disabled" });
    }

    const automaticBatch = actionType === THEO_AUTO_ACTION_TYPE && !targetId;
    const maxItems = automaticBatch ? config.batchSize : 1;
    const results = [];

    for (let item = 0; item < maxItems; item += 1) {
      const lockId = `vercel-theo:${idFactory()}`;
      let claimed;
      try {
        claimed = await transaction((client) => claim(client, {
          actionType,
          outboxId: targetId,
          allowAutomation: actionType === THEO_AUTO_ACTION_TYPE && config.automationEnabled,
          allowedDedupeKey,
          lockedBy: lockId,
        }));
      } catch {
        logger({ event: "theo_dispatch", status: "failed", code: "database_unavailable", duration_ms: Date.now() - startedAt });
        return sendJson(res, 503, { error: "database_unavailable" });
      }

      if (!claimed) break;
      const claimedActionType = text(claimed.action_type) || actionType;
      let payload;
      if (claimedActionType === THEO_AUTO_ACTION_TYPE) {
        const producerPayload = payloadObject(claimed.payload);
        let alert;
        let enrichmentFailure = null;
        try {
          alert = await findProducedAlert({
            alertId: producerPayload.alert_id,
            dataSourceId: producerPayload.data_source_id,
            sourceEventId: producerPayload.source_event_id,
          });
        } catch {
          enrichmentFailure = { code: "database_unavailable", retryable: true, retry_after_seconds: retryDelaySeconds(claimed.attempts) };
        }
        if (!alert && !enrichmentFailure) {
          enrichmentFailure = { code: "produced_alert_not_found", retryable: false, retry_after_seconds: 0 };
        }
        if (enrichmentFailure) {
          await transaction((client) => finish(client, {
            actionType: claimedActionType,
            outboxId: claimed.id,
            lockedBy: lockId,
            success: false,
            retryable: enrichmentFailure.retryable,
            httpStatus: null,
            errorCode: enrichmentFailure.code,
            retryAfterSeconds: enrichmentFailure.retry_after_seconds,
          }));
          try {
            await transaction((client) => heartbeat(client, { success: false, errorCode: enrichmentFailure.code }));
          } catch {
            logger({ event: "theo_dispatch_heartbeat", status: "failed", code: "database_unavailable" });
          }
          const latencyMs = Math.max(Date.now() - startedAt, 0);
          logger({ event: "theo_dispatch", outbox_id: claimed.id, status: "failed", code: enrichmentFailure.code, retryable: enrichmentFailure.retryable, latency_ms: latencyMs });
          results.push({
            outbox_id: claimed.id,
            status: "failed",
            http_status: null,
            retryable: enrichmentFailure.retryable,
            latency_ms: latencyMs,
          });
          continue;
        }
        payload = buildTheoPayload(buildTheoAlertPayload(alert, now()), now());
      } else {
        payload = buildTheoPayload(claimed.payload, now());
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      let response;
      let failure = null;
      try {
        response = await fetchFn(config.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Theo-Token": config.token },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        failure = { code: publicErrorCode(error), retryable: true, retry_after_seconds: retryDelaySeconds(claimed.attempts) };
      } finally {
        clearTimeout(timeout);
      }

      const httpStatus = Number(response?.status || 0) || null;
      if (!failure && !(httpStatus >= 200 && httpStatus < 300)) {
        const retryable = httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
        failure = {
          code: `http_${httpStatus || "error"}`,
          retryable,
          retry_after_seconds: retryable ? retryAfterSeconds(response, retryDelaySeconds(claimed.attempts)) : 0,
        };
      }

      const succeeded = !failure;
      await transaction((client) => finish(client, {
        actionType: claimedActionType,
        outboxId: claimed.id,
        lockedBy: lockId,
        success: succeeded,
        retryable: failure?.retryable || false,
        httpStatus,
        errorCode: failure?.code || null,
        retryAfterSeconds: failure?.retry_after_seconds || 0,
      }));
      // Finishing the outbox precedes telemetry: a heartbeat write failure must
      // never leave a delivered message eligible for another external send.
      try {
        await transaction((client) => heartbeat(client, {
          success: succeeded,
          errorCode: failure?.code || null,
        }));
      } catch {
        logger({ event: "theo_dispatch_heartbeat", status: "failed", code: "database_unavailable" });
      }

      const latencyMs = Math.max(Date.now() - startedAt, 0);
      logger({
        event: "theo_dispatch",
        outbox_id: claimed.id,
        status: succeeded ? "success" : "failed",
        http_status: httpStatus,
        code: failure?.code || null,
        retryable: failure?.retryable || false,
        latency_ms: latencyMs,
      });
      results.push({
        outbox_id: claimed.id,
        ...(canary.present ? { canary_alert_id: canary.value } : {}),
        status: succeeded ? "success" : "failed",
        http_status: httpStatus,
        retryable: failure?.retryable || false,
        latency_ms: latencyMs,
      });
    }

    if (!results.length) return sendJson(res, 200, { claimed: false, status: "not_eligible" });
    const failures = results.filter((result) => result.status === "failed");
    const last = results.at(-1);
    return sendJson(res, failures.length ? 202 : 200, {
      ...last,
      ...(automaticBatch ? { processed: results.length, succeeded: results.length - failures.length, failed: failures.length } : {}),
    });
  };
}

export default createTheoDispatchHandler();
