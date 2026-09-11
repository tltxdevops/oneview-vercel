import { randomUUID } from "node:crypto";

import { insertAuditLog } from "./audit.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";
import { fetchCanonicalLinkDetail } from "./oneview-links.js";

export const THEO_OPERATOR_REMINDER_ACTION_TYPE = "theo_operator_reminder_v1";
export const OPERATOR_REMINDER_AGGREGATE_TYPE = "operator_reminder";

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10;
const ONEVIEW_OPERADORAS_URL = "https://oneview.teletexdev.com.br/operadoras";

function text(value) { return String(value || "").trim(); }
function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}
function safe(value, fallback = "") { return text(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600) || fallback; }
function time(value) { const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? parsed : null; }
function active(link) { return Number(link?.active_alerts) > 0 || link?.has_active_alert === true; }
function errorCode(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (code.includes("timeout") || message.includes("timeout")) return "timeout";
  if (code.includes("permission") || message.includes("permission")) return "permission_denied";
  if (code.includes("connect") || message.includes("connect")) return "database_unavailable";
  return "circuit_revalidation_failed";
}
function durationLabel(startedAt, now) {
  const started = time(startedAt);
  if (started === null) return "tempo não informado";
  const minutes = Math.max(0, Math.floor((now.getTime() - started) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}min` : `${hours}h`;
}
function linkLabel(link) {
  const service = safe(link?.service_name || link?.link_name || link?.circuit_key, "Link de operadora");
  const detail = safe(link?.member_key || link?.uplink_key || link?.site_key);
  return detail && !service.toLowerCase().includes(detail.toLowerCase()) ? `${service} · ${detail}` : service;
}
function executionLog(logger, entry) {
  logger({
    event: "operator_reminder_execution",
    reminder_id: text(entry.reminder_id),
    phase: text(entry.phase),
    status_before: text(entry.status_before) || null,
    status_after: text(entry.status_after) || null,
    has_active_alert: Boolean(entry.has_active_alert),
    has_open_incident: Boolean(entry.has_open_incident),
    outbox_created: Boolean(entry.outbox_created),
    error_code: text(entry.error_code) || null,
    duration_ms: Math.max(0, Number(entry.duration_ms) || 0),
  });
}

export function getOperatorReminderExecutionConfig(env = process.env) {
  return Object.freeze({
    batchSize: integer(env.OPERATOR_REMINDER_DISPATCH_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
  });
}

/** Only current canonical circuit data is sent; creation snapshot is intentionally ignored. */
export function buildOperatorReminderTheoPayload(reminder, link, now = new Date()) {
  const alert = link?.current_alert || null;
  const incident = link?.current_incident || null;
  const hasIncident = Boolean(text(incident?.number));
  const startedAt = alert?.started_at || link?.active_since_at || link?.alert_started_at;
  const circuit = linkLabel(link);
  const createdByName = safe(reminder?.created_by_name, "Operador OneView");
  const incidentLine = hasIncident
    ? `INC: ${safe(incident.number)}${incident?.state_display ? ` · ${safe(incident.state_display)}` : ""}.`
    : "INC: Nenhum chamado aberto correlacionado.";
  return {
    titulo: hasIncident ? "🔔 Link de operadora ainda pendente" : "🔔 Link continua em falha sem chamado",
    cliente: safe(link?.customer_name || link?.customer_key, "Cliente não informado"),
    equipamento: safe(link?.host_name || link?.site_name, "Local não informado"),
    ip: "N/A",
    data_hora: now.toISOString(),
    acao: `Link: ${circuit}. Em falha há: ${durationLabel(startedAt, now)}. ${incidentLine} Criado por: ${createdByName}`,
    proximos_passos: "Verificar acompanhamento do circuito/chamado.",
    acompanhamento: "Equipe NOC",
    severidade: safe(alert?.severity || link?.max_severity, "not_classified"),
    ...(hasIncident ? { chamado: safe(incident.number) } : {}),
    link: ONEVIEW_OPERADORAS_URL,
    oneview_link: ONEVIEW_OPERADORAS_URL,
  };
}

export async function claimDueOperatorReminders(client, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const result = await client.query(
    `
      select id, circuit_key, data_source_id, source_host_id, scheduled_for, status,
             created_by_name, initial_alert_id, initial_incident_number
        from operator_reminders
       where status = 'scheduled'
         and scheduled_for <= now()
       order by scheduled_for asc, id asc
       limit $1
       for update skip locked
    `,
    [integer(batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)],
  );
  return result.rows || [];
}

async function markSkipped(client, reminder, reason, now, audit, req) {
  const result = await client.query(
    `update operator_reminders
        set status = 'skipped', skipped_at = $2, skip_reason = $3, updated_at = $2
      where id = $1 and status = 'scheduled'
      returning id, status, skipped_at, skip_reason`,
    [reminder.id, now, reason],
  );
  const row = result.rows[0] || null;
  if (row) {
    await audit(client, {
      actorName: "Theo Dispatcher", actorId: "theo_dispatcher", actorType: "system",
      action: "REMINDER_SKIPPED", entityType: "operator_reminder", entityId: reminder.id,
      dataSourceId: reminder.data_source_id, alertId: reminder.initial_alert_id || null,
      beforeData: { status: "scheduled" }, afterData: { status: "skipped", skip_reason: reason },
      metadata: { circuit_key: reminder.circuit_key, source_host_id: reminder.source_host_id || null }, req,
    });
  }
  return row;
}

async function enqueueReminder(client, reminder, link, { idFactory, now, audit, req }) {
  const outboxId = idFactory();
  const idempotencyKey = `operator-reminder:${reminder.id}`;
  const payload = buildOperatorReminderTheoPayload(reminder, link, now);
  const outbox = await client.query(
    `
      insert into integration_outbox (
        id, aggregate_type, aggregate_id, data_source_id, alert_id, action_type, status, priority, payload,
        attempts, max_attempts, available_at, next_attempt_at, idempotency_key, correlation_id, request_id,
        created_by, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,'pending',100,$7::jsonb,0,3,$8,$8,$9,$10,$10,$11,$8,$8)
      on conflict (idempotency_key) do nothing
      returning id
    `,
    [
      outboxId, OPERATOR_REMINDER_AGGREGATE_TYPE, reminder.id, reminder.data_source_id,
      link.current_alert?.id || null, THEO_OPERATOR_REMINDER_ACTION_TYPE, JSON.stringify(payload), now,
      idempotencyKey, `operator-reminder:${reminder.id}`, "vercel-operator-reminder-dispatcher",
    ],
  );
  const created = Boolean(outbox.rows[0]);
  if (!created) {
    const existing = await client.query(
      `select id from integration_outbox where idempotency_key = $1 and aggregate_type = $2 and aggregate_id = $3 and action_type = $4 limit 1`,
      [idempotencyKey, OPERATOR_REMINDER_AGGREGATE_TYPE, reminder.id, THEO_OPERATOR_REMINDER_ACTION_TYPE],
    );
    if (!existing.rows[0]) throw new Error("operator_reminder_outbox_conflict");
    const recovered = await client.query(
      `update operator_reminders set status = 'processing', updated_at = $2, last_error = null where id = $1 and status = 'scheduled' returning id, status`,
      [reminder.id, now],
    );
    return { created: false, outboxId: existing.rows[0].id, recovered: Boolean(recovered.rows[0]) };
  }
  const changed = await client.query(
    `update operator_reminders set status = 'processing', updated_at = $2, last_error = null where id = $1 and status = 'scheduled' returning id, status`,
    [reminder.id, now],
  );
  if (!changed.rows[0]) throw new Error("operator_reminder_claim_lost");
  await audit(client, {
    actorName: "Theo Dispatcher", actorId: "theo_dispatcher", actorType: "system",
    action: "REMINDER_ENQUEUED", entityType: "operator_reminder", entityId: reminder.id,
    dataSourceId: reminder.data_source_id, alertId: link.current_alert?.id || null,
    beforeData: { status: "scheduled" }, afterData: { status: "processing" },
    metadata: { circuit_key: reminder.circuit_key, outbox_id: outboxId }, req,
  });
  return { created: true, outboxId };
}

/**
 * Claims only due scheduled rows. Revalidation and the scheduled→processing/outbox
 * transition share one transaction, so no invocation can enqueue twice.
 */
export async function processDueOperatorReminders({
  transaction = withOneViewActionsTransaction,
  resolveLink = fetchCanonicalLinkDetail,
  audit = insertAuditLog,
  idFactory = randomUUID,
  now = () => new Date(),
  configProvider = getOperatorReminderExecutionConfig,
  logger = (entry) => console.info(JSON.stringify(entry)),
  req = null,
} = {}) {
  const summary = { due_found: 0, skipped: 0, enqueued: 0, already_processing: 0, failed: 0 };
  const config = configProvider();
  await transaction(async (client) => {
    const reminders = await claimDueOperatorReminders(client, { batchSize: config.batchSize });
    summary.due_found = reminders.length;
    for (const reminder of reminders) {
      const startedAt = Date.now();
      let link;
      try {
        link = await resolveLink({
          id: reminder.circuit_key,
          dataSourceId: reminder.data_source_id,
          sourceHostId: reminder.source_host_id,
        });
      } catch (error) {
        summary.failed += 1;
        executionLog(logger, { reminder_id: reminder.id, phase: "revalidate", status_before: "scheduled", status_after: "scheduled", error_code: errorCode(error), duration_ms: Date.now() - startedAt });
        continue;
      }
      if (!link) {
        const skipped = await markSkipped(client, reminder, "circuit_not_found", now(), audit, req);
        summary.skipped += skipped ? 1 : 0;
        executionLog(logger, { reminder_id: reminder.id, phase: "revalidate", status_before: "scheduled", status_after: skipped?.status, error_code: skipped ? null : "claim_lost", duration_ms: Date.now() - startedAt });
        continue;
      }
      const hasActiveAlert = active(link);
      if (!hasActiveAlert) {
        const skipped = await markSkipped(client, reminder, "alert_resolved", now(), audit, req);
        summary.skipped += skipped ? 1 : 0;
        executionLog(logger, { reminder_id: reminder.id, phase: "revalidate", status_before: "scheduled", status_after: skipped?.status, has_active_alert: false, has_open_incident: Boolean(link.current_incident?.number), error_code: skipped ? null : "claim_lost", duration_ms: Date.now() - startedAt });
        continue;
      }
      if (link.integration_status?.servicenow === "degraded" || !text(link.current_alert?.id)) {
        summary.failed += 1;
        executionLog(logger, {
          reminder_id: reminder.id, phase: "revalidate", status_before: "scheduled", status_after: "scheduled",
          has_active_alert: true, has_open_incident: Boolean(link.current_incident?.number),
          error_code: link.integration_status?.servicenow === "degraded" ? "servicenow_correlation_degraded" : "current_alert_not_found",
          duration_ms: Date.now() - startedAt,
        });
        continue;
      }
      try {
        const enqueued = await enqueueReminder(client, reminder, link, { idFactory, now: now(), audit, req });
        if (enqueued.created) summary.enqueued += 1;
        else summary.already_processing += 1;
        executionLog(logger, { reminder_id: reminder.id, phase: "enqueue", status_before: "scheduled", status_after: enqueued.created ? "processing" : "scheduled", has_active_alert: true, has_open_incident: Boolean(link.current_incident?.number), outbox_created: enqueued.created, error_code: enqueued.created ? null : "outbox_already_exists", duration_ms: Date.now() - startedAt });
      } catch (error) {
        summary.failed += 1;
        executionLog(logger, { reminder_id: reminder.id, phase: "enqueue", status_before: "scheduled", status_after: "scheduled", has_active_alert: true, has_open_incident: Boolean(link.current_incident?.number), error_code: errorCode(error), duration_ms: Date.now() - startedAt });
        throw error;
      }
    }
  });
  return summary;
}

/** Outbox owns retries. Reminder remains processing until a terminal outcome. */
export async function finalizeOperatorReminderDispatch(client, {
  aggregateType,
  aggregateId,
  actionType,
  success = false,
  retryable = false,
  error = null,
  now = new Date(),
  audit = insertAuditLog,
  req = null,
} = {}) {
  if (aggregateType !== OPERATOR_REMINDER_AGGREGATE_TYPE || actionType !== THEO_OPERATOR_REMINDER_ACTION_TYPE || !text(aggregateId) || (!success && retryable)) return null;
  const terminalStatus = success ? "sent" : "failed";
  const result = await client.query(
    success
      ? `update operator_reminders set status = 'sent', sent_at = $2, updated_at = $2, last_error = null where id = $1 and status = 'processing' returning id, status`
      : `update operator_reminders set status = 'failed', updated_at = $2, last_error = $3 where id = $1 and status = 'processing' returning id, status`,
    success ? [aggregateId, now] : [aggregateId, now, safe(error, "theo_dispatch_failed").slice(0, 180)],
  );
  const row = result.rows[0] || null;
  if (row) {
    await audit(client, {
      actorName: "Theo Dispatcher", actorId: "theo_dispatcher", actorType: "system",
      action: success ? "REMINDER_SENT" : "REMINDER_FAILED", entityType: "operator_reminder", entityId: aggregateId,
      beforeData: { status: "processing" }, afterData: { status: terminalStatus },
      metadata: success ? null : { error_code: safe(error, "theo_dispatch_failed").slice(0, 120) }, req,
    });
  }
  return row;
}
