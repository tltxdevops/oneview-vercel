import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOperatorReminderTheoPayload,
  finalizeOperatorReminderDispatch,
  OPERATOR_REMINDER_AGGREGATE_TYPE,
  processDueOperatorReminders,
  THEO_OPERATOR_REMINDER_ACTION_TYPE,
} from "../api/_lib/oneview-operator-reminder-execution.js";
import { createTheoDispatchHandler } from "../api/_lib/oneview-theo-dispatch.js";

const NOW = new Date("2026-09-10T15:00:00.000Z");
const REMINDER_ID = "11111111-1111-4111-8111-111111111111";
const OUTBOX_ID = "22222222-2222-4222-8222-222222222222";

function reminder(overrides = {}) {
  return {
    id: REMINDER_ID,
    circuit_key: "ds-1:havan-host:meraki:143-marilia:wan1",
    data_source_id: "ds-1",
    source_host_id: "havan-host",
    scheduled_for: "2026-09-10T14:59:00.000Z",
    status: "scheduled",
    created_by_name: "Ana Analista",
    initial_alert_id: "old-alert",
    initial_incident_number: "INC000OLD",
    ...overrides,
  };
}

function activeLink(overrides = {}) {
  return {
    circuit_key: "ds-1:havan-host:meraki:143-marilia:wan1",
    data_source_id: "ds-1",
    source_host_id: "havan-host",
    customer_name: "Havan",
    host_name: "Marília",
    service_name: "wan1",
    uplink_key: "wan1",
    active_alerts: 1,
    active_since_at: "2026-09-10T12:00:00.000Z",
    current_alert: { id: "current-alert", severity: "high", started_at: "2026-09-10T12:00:00.000Z" },
    current_incident: { number: "INC0099999", state: "2", state_display: "Em espera" },
    ...overrides,
  };
}

function memoryStore(initial = [reminder()]) {
  const rows = initial.map((item) => ({ ...item }));
  const outbox = [];
  const queries = [];
  let claimed = false;
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/from operator_reminders/i.test(sql) && /for update skip locked/i.test(sql)) {
        if (claimed) return { rows: [] };
        const due = rows.filter((item) => item.status === "scheduled" && Date.parse(item.scheduled_for) <= NOW.getTime()).slice(0, values[0]);
        if (due.length) claimed = true;
        return { rows: due };
      }
      if (/set status = 'skipped'/i.test(sql)) {
        const item = rows.find((row) => row.id === values[0] && row.status === "scheduled");
        if (!item) return { rows: [] };
        item.status = "skipped"; item.skipped_at = values[1]; item.skip_reason = values[2]; item.updated_at = values[1];
        return { rows: [item] };
      }
      if (/insert into integration_outbox/i.test(sql)) {
        const key = values[8];
        if (outbox.some((item) => item.idempotency_key === key)) return { rows: [] };
        const item = { id: values[0], aggregate_type: values[1], aggregate_id: values[2], data_source_id: values[3], alert_id: values[4], action_type: values[5], payload: JSON.parse(values[6]), idempotency_key: key, status: "pending" };
        outbox.push(item);
        return { rows: [{ id: item.id }] };
      }
      if (/select id from integration_outbox/i.test(sql)) {
        const item = outbox.find((row) => row.idempotency_key === values[0]);
        return { rows: item ? [{ id: item.id }] : [] };
      }
      if (/set status = 'processing'/i.test(sql)) {
        const item = rows.find((row) => row.id === values[0] && row.status === "scheduled");
        if (!item) return { rows: [] };
        item.status = "processing"; item.updated_at = values[1]; item.last_error = null;
        return { rows: [item] };
      }
      if (/set status = 'sent'/i.test(sql)) {
        const item = rows.find((row) => row.id === values[0] && row.status === "processing");
        if (!item) return { rows: [] };
        item.status = "sent"; item.sent_at = values[1]; item.updated_at = values[1]; item.last_error = null;
        return { rows: [item] };
      }
      if (/set status = 'failed'/i.test(sql)) {
        const item = rows.find((row) => row.id === values[0] && row.status === "processing");
        if (!item) return { rows: [] };
        item.status = "failed"; item.updated_at = values[1]; item.last_error = values[2];
        return { rows: [item] };
      }
      if (/insert into audit_logs/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { rows, outbox, queries, transaction: async (work) => work(client), client };
}

function processor(store, resolveLink, overrides = {}) {
  return processDueOperatorReminders({
    transaction: store.transaction,
    resolveLink,
    idFactory: () => OUTBOX_ID,
    now: () => NOW,
    configProvider: () => ({ batchSize: 5 }),
    logger: () => undefined,
    ...overrides,
  });
}

function response() {
  return { statusCode: null, body: null, setHeader() { return this; }, status(code) { this.statusCode = code; return this; }, end(value) { this.body = JSON.parse(value); } };
}

function dispatch(store, { httpStatus, claimedReminder = reminder({ status: "processing" }) } = {}) {
  let claimedOnce = false;
  const finishCalls = [];
  return {
    finishCalls,
    handler: createTheoDispatchHandler({
      configProvider: () => ({ url: "https://theo.example.test/webhook", token: "test-token", cronSecret: "cron-secret", automationEnabled: true, timeoutMs: 500, batchSize: 1 }),
      transaction: store.transaction,
      processDueReminders: async () => ({ due_found: 0, skipped: 0, enqueued: 0, already_processing: 0, failed: 0 }),
      claim: async () => {
        if (claimedOnce) return null;
        claimedOnce = true;
        return {
          id: OUTBOX_ID, aggregate_type: OPERATOR_REMINDER_AGGREGATE_TYPE, aggregate_id: claimedReminder.id,
          action_type: THEO_OPERATOR_REMINDER_ACTION_TYPE, attempts: 1, max_attempts: 3,
          payload: buildOperatorReminderTheoPayload(claimedReminder, activeLink(), NOW), idempotency_key: `operator-reminder:${claimedReminder.id}`,
        };
      },
      finish: async (_client, options) => { finishCalls.push(options); return { id: OUTBOX_ID, aggregate_type: OPERATOR_REMINDER_AGGREGATE_TYPE, aggregate_id: claimedReminder.id, status: options.success ? "success" : "failed" }; },
      heartbeat: async () => undefined,
      fetchFn: async () => ({ status: httpStatus, headers: { get: () => null } }),
      now: () => NOW,
      idFactory: () => "lock-id",
      logger: () => undefined,
    }),
  };
}

test("OV-P0-298 due active reminder with INC enqueues exactly one Theo outbox then becomes sent", async () => {
  const store = memoryStore();
  const calls = [];
  const summary = await processor(store, async (identity) => { calls.push(identity); return activeLink(); });
  assert.deepEqual(summary, { due_found: 1, skipped: 0, enqueued: 1, already_processing: 0, failed: 0 });
  assert.deepEqual(calls[0], { id: "ds-1:havan-host:meraki:143-marilia:wan1", dataSourceId: "ds-1", sourceHostId: "havan-host" });
  assert.equal(store.rows[0].status, "processing");
  assert.equal(store.outbox.length, 1);
  assert.deepEqual([store.outbox[0].aggregate_type, store.outbox[0].aggregate_id, store.outbox[0].action_type, store.outbox[0].idempotency_key], [OPERATOR_REMINDER_AGGREGATE_TYPE, REMINDER_ID, THEO_OPERATOR_REMINDER_ACTION_TYPE, `operator-reminder:${REMINDER_ID}`]);
  assert.match(store.outbox[0].payload.acao, /INC0099999/);
  assert.doesNotMatch(JSON.stringify(store.outbox[0].payload), /old-alert|INC000OLD/i);
  assert.match(store.queries[0].sql, /for update skip locked/i);

  const sent = await finalizeOperatorReminderDispatch(store.client, { aggregateType: OPERATOR_REMINDER_AGGREGATE_TYPE, aggregateId: REMINDER_ID, actionType: THEO_OPERATOR_REMINDER_ACTION_TYPE, success: true, now: NOW });
  assert.equal(sent.status, "sent");
  assert.equal(store.rows[0].status, "sent");
});

test("OV-P0-298 current data wins: active reminder without INC builds a valid no-INC message", async () => {
  const store = memoryStore();
  await processor(store, async () => activeLink({ current_incident: null }));
  const payload = store.outbox[0].payload;
  assert.equal(payload.titulo, "🔔 Link continua em falha sem chamado");
  assert.equal(payload.chamado, undefined);
  assert.match(payload.acao, /Nenhum chamado aberto correlacionado/);
  assert.match(payload.acao, /Criado por: Ana Analista/);
  assert.doesNotMatch(JSON.stringify(payload), /created_by|oid|sys_id/i);
});

test("OV-P0-298 normalized and missing circuits are skipped without outbox", async () => {
  const resolved = memoryStore();
  await processor(resolved, async () => activeLink({ active_alerts: 0, has_active_alert: false, current_incident: null }));
  assert.deepEqual([resolved.rows[0].status, resolved.rows[0].skip_reason, resolved.outbox.length], ["skipped", "alert_resolved", 0]);

  const missing = memoryStore();
  await processor(missing, async () => null);
  assert.deepEqual([missing.rows[0].status, missing.rows[0].skip_reason, missing.outbox.length], ["skipped", "circuit_not_found", 0]);
});

test("OV-P0-298 ServiceNow degradation or missing current alert remains scheduled for safe retry", async () => {
  const degraded = memoryStore();
  const degradedSummary = await processor(degraded, async () => activeLink({ integration_status: { servicenow: "degraded" } }));
  assert.deepEqual([degradedSummary.failed, degraded.rows[0].status, degraded.outbox.length], [1, "scheduled", 0]);

  const incomplete = memoryStore();
  const incompleteSummary = await processor(incomplete, async () => activeLink({ current_alert: null }));
  assert.deepEqual([incompleteSummary.failed, incomplete.rows[0].status, incomplete.outbox.length], [1, "scheduled", 0]);
});

test("OV-P0-298 future and cancelled reminders are ignored", async () => {
  const future = memoryStore([reminder({ scheduled_for: "2026-09-10T15:01:00.000Z" })]);
  const cancelled = memoryStore([reminder({ status: "cancelled" })]);
  assert.equal((await processor(future, async () => activeLink())).due_found, 0);
  assert.equal((await processor(cancelled, async () => activeLink())).due_found, 0);
  assert.equal(future.outbox.length + cancelled.outbox.length, 0);
});

test("OV-P0-298 concurrent/repeated cron processing creates one outbox only", async () => {
  const store = memoryStore();
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const first = processor(store, async () => { await waiting; return activeLink(); });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await processor(store, async () => activeLink());
  release();
  const firstSummary = await first;
  const repeated = await processor(store, async () => activeLink());
  assert.equal(firstSummary.enqueued, 1);
  assert.equal(second.due_found, 0);
  assert.equal(repeated.due_found, 0);
  assert.equal(store.outbox.length, 1);
});

test("OV-P0-298 retryable Theo failure keeps reminder processing; terminal failure marks failed", async () => {
  const retryStore = memoryStore([reminder({ status: "processing" })]);
  const retry = dispatch(retryStore, { httpStatus: 500 });
  const retryResponse = response();
  await retry.handler({ method: "POST", headers: { authorization: "Bearer cron-secret" }, query: {} }, retryResponse);
  assert.equal(retryResponse.statusCode, 202);
  assert.equal(retry.finishCalls[0].retryable, true);
  assert.equal(retryStore.rows[0].status, "processing");

  const failedStore = memoryStore([reminder({ status: "processing" })]);
  const terminal = dispatch(failedStore, { httpStatus: 400 });
  await terminal.handler({ method: "POST", headers: { authorization: "Bearer cron-secret" }, query: {} }, response());
  assert.equal(terminal.finishCalls[0].retryable, false);
  assert.equal(failedStore.rows[0].status, "failed");
  assert.equal(failedStore.rows[0].last_error, "http_400");
});

test("OV-P0-298 successful retry dispatch marks operator reminder sent", async () => {
  const store = memoryStore([reminder({ status: "processing" })]);
  const retrySuccess = dispatch(store, { httpStatus: 204 });
  const res = response();
  await retrySuccess.handler({ method: "POST", headers: { authorization: "Bearer cron-secret" }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(store.rows[0].status, "sent");
});

test("OV-P0-298 existing Theo cron processes due reminders before its outbox claim", async () => {
  const order = [];
  const handler = createTheoDispatchHandler({
    configProvider: () => ({ url: "https://theo.example.test/webhook", token: "test-token", cronSecret: "cron-secret", automationEnabled: true, timeoutMs: 500, batchSize: 1 }),
    transaction: async (work) => work({}),
    processDueReminders: async () => { order.push("reminders"); return { due_found: 0, skipped: 0, enqueued: 0, already_processing: 0, failed: 0 }; },
    claim: async () => { order.push("outbox"); return null; },
    heartbeat: async () => undefined,
    logger: () => undefined,
  });
  const res = response();
  await handler({ method: "POST", headers: { authorization: "Bearer cron-secret" }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(order, ["reminders", "outbox"]);
});
