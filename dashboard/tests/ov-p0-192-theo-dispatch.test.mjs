import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTheoPayload,
  buildTheoAlertPayload,
  buildOneViewAlertDeepLink,
  claimEligibleTheoOutbox,
  createTheoCanaryOutbox,
  createTheoSmokeOutbox,
  createTheoDispatchHandler,
  recordTheoDispatcherHeartbeat,
  THEO_ACTION_TYPE,
  THEO_AUTO_ACTION_TYPE,
  THEO_DISPATCHER_WORKER_NAME,
  theoCanaryDedupeKey,
  THEO_SMOKE_DEDUPE_KEY,
  theoSmokePayload,
} from "../api/_lib/oneview-theo-dispatch.js";
import { createOneViewHandler } from "../api/_lib/oneview-response.js";

const SECRET = "theo-dispatch-test-secret";
const OUTBOX_ID = "0a3be1e9-42de-4a50-b5aa-9ec886971920";
const CANARY_ALERT_ID = "52bfe971-712e-4731-a135-e3d0001ad51c";

function req(query = {}) {
  return {
    method: "POST",
    query,
    headers: { authorization: `Bearer ${SECRET}` },
  };
}

function res() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function config(overrides = {}) {
  return {
    url: "https://dex.teletex.com.br/n8n/webhook/theo-oneview-alert",
    token: "server-only-theo-token",
    cronSecret: SECRET,
    automationEnabled: false,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function claimed() {
  return {
    id: OUTBOX_ID,
    attempts: 1,
    max_attempts: 3,
    idempotency_key: THEO_SMOKE_DEDUPE_KEY,
    payload: { ...theoSmokePayload(), data_hora: "2026-08-24T21:00:00.000Z" },
  };
}

function canaryAlert(severity = "disaster") {
  return {
    id: CANARY_ALERT_ID,
    customer_name: "Sanepar",
    host_name: "DEO-Cast-Router",
    host_ip: "192.0.2.10",
    problem_name: "Roteador indisponível",
    trigger_description: "Perda de conectividade",
    operational_data: "Investigar conectividade do equipamento.",
    severity,
    status_source: "active",
    resolved_at: null,
    first_seen_at: "2026-08-25T17:00:00.000Z",
    event_tags: [{ tag: "__zbx_servicenow_number", value: "INC0074751" }],
    trigger_tags: [],
    host_tags: [],
  };
}

function producedClaim() {
  return {
    id: OUTBOX_ID,
    action_type: THEO_AUTO_ACTION_TYPE,
    attempts: 1,
    max_attempts: 3,
    idempotency_key: "theo:alert:source-a:338976923",
    payload: {
      alert_id: CANARY_ALERT_ID,
      data_source_id: "source-a",
      source_event_id: "338976923",
    },
  };
}

function dispatcher(overrides = {}) {
  return createTheoDispatchHandler({
    configProvider: () => config(),
    transaction: async (work) => work({}),
    createSmoke: async () => ({ id: OUTBOX_ID, status: "pending" }),
    claim: async () => claimed(),
    finish: async () => ({ id: OUTBOX_ID, status: "success" }),
    heartbeat: async () => undefined,
    fetchFn: async () => ({ status: 204, headers: { get: () => null } }),
    idFactory: () => "test-lock-id",
    now: () => new Date("2026-08-24T21:00:00.000Z"),
    logger: () => undefined,
    ...overrides,
  });
}

test("OV-P0-192 atomic claim transitions pending or failed to processing", async () => {
  const calls = [];
  const row = await claimEligibleTheoOutbox({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [claimed()] };
    },
  }, { outboxId: OUTBOX_ID, allowAutomation: false, lockedBy: "vercel-theo:test" });

  assert.equal(row.id, OUTBOX_ID);
  assert.match(calls[0].sql, /status = 'processing'/);
  assert.match(calls[0].sql, /for update skip locked/i);
  assert.match(calls[0].sql, /attempts = o\.attempts \+ 1/);
  assert.equal(calls[0].values[3], THEO_SMOKE_DEDUPE_KEY);
});

test("OV-P0-192 completes a claimed smoke outbox after Theo 2xx", async () => {
  const finished = [];
  const sent = [];
  const handler = dispatcher({
    finish: async (_client, result) => { finished.push(result); return { id: OUTBOX_ID, status: "success" }; },
    fetchFn: async (url, options) => {
      sent.push({ url, options });
      return { status: 204, headers: { get: () => null } };
    },
  });
  const response = res();
  await handler(req({ smoke: "1" }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.status, "success");
  assert.equal(response.body.http_status, 204);
  assert.equal(sent[0].options.headers["Content-Type"], "application/json");
  assert.equal(sent[0].options.headers["X-Theo-Token"], "server-only-theo-token");
  assert.deepEqual(finished[0], {
    actionType: THEO_ACTION_TYPE,
    outboxId: OUTBOX_ID,
    lockedBy: "vercel-theo:test-lock-id",
    success: true,
    retryable: false,
    httpStatus: 204,
    errorCode: null,
    retryAfterSeconds: 0,
  });
});

test("OV-P0-214 automatic claim is limited to pending or failed producer rows", async () => {
  const calls = [];
  await claimEligibleTheoOutbox({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  }, {
    actionType: THEO_AUTO_ACTION_TYPE,
    allowAutomation: true,
    lockedBy: "vercel-theo:test",
  });

  assert.equal(calls[0].values[0], THEO_AUTO_ACTION_TYPE);
  assert.match(calls[0].sql, /o\.status in \('pending', 'failed'\)/i);
  assert.match(calls[0].sql, /o\.action_type = \$1/i);
  assert.doesNotMatch(calls[0].sql, /theo_webex_notification/);
});

test("OV-P0-214 automatic dispatcher cannot claim legacy smoke, canary, or Theo rows", async () => {
  let claimOptions;
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    claim: async (_client, options) => { claimOptions = options; return null; },
  });
  const response = res();
  await handler(req(), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { claimed: false, status: "not_eligible" });
  assert.equal(claimOptions.actionType, THEO_AUTO_ACTION_TYPE);
  assert.equal(claimOptions.allowAutomation, true);
  assert.equal(claimOptions.allowedDedupeKey, null);
});

test("OV-P0-214 enriches a producer row into Theo payload with OneView and ServiceNow links", async () => {
  let sent;
  let finished;
  const alert = {
    ...canaryAlert(),
    event_tags: [
      { tag: "__zbx_servicenow_number", value: "INC0074751" },
      { tag: "__zbx_servicenow_sys_id", value: "fdb2c6e797fe0710e580f137f053afe3" },
    ],
  };
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    claim: async () => producedClaim(),
    findProducedAlert: async (reference) => {
      assert.deepEqual(reference, { alertId: CANARY_ALERT_ID, dataSourceId: "source-a", sourceEventId: "338976923" });
      return alert;
    },
    finish: async (_client, result) => { finished = result; return { id: OUTBOX_ID, status: "success" }; },
    fetchFn: async (_url, options) => { sent = JSON.parse(options.body); return { status: 200, headers: { get: () => null } }; },
  });
  const response = res();
  await handler(req(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(finished.actionType, THEO_AUTO_ACTION_TYPE);
  assert.equal(sent.link, `https://oneview.teletexdev.com.br/alertas?alert=${CANARY_ALERT_ID}`);
  assert.equal(sent.oneview_link, sent.link);
  assert.equal(sent.servicenow_link, "https://teletexprod.service-now.com/incident.do?sys_id=fdb2c6e797fe0710e580f137f053afe3");
  assert.equal(sent.chamado, "INC0074751");
});

test("OV-P0-214 producer payload without an explicit Incident has only the OneView link", async () => {
  let sent;
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    claim: async () => producedClaim(),
    findProducedAlert: async () => ({ ...canaryAlert(), event_tags: [], trigger_tags: [], host_tags: [] }),
    fetchFn: async (_url, options) => { sent = JSON.parse(options.body); return { status: 200, headers: { get: () => null } }; },
  });
  const response = res();
  await handler(req(), response);

  assert.equal(response.statusCode, 200);
  assert.equal(sent.link, `https://oneview.teletexdev.com.br/alertas?alert=${CANARY_ALERT_ID}`);
  assert.equal(Object.hasOwn(sent, "servicenow_link"), false);
});

test("OV-P0-214 concurrent automatic dispatches claim and send a producer row once", async () => {
  let claimedOnce = false;
  let sends = 0;
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    claim: async () => {
      if (claimedOnce) return null;
      claimedOnce = true;
      return producedClaim();
    },
    findProducedAlert: async () => canaryAlert(),
    fetchFn: async () => { sends += 1; return { status: 200, headers: { get: () => null } }; },
  });
  const left = res();
  const right = res();
  await Promise.all([handler(req(), left), handler(req(), right)]);

  assert.equal(sends, 1);
  assert.deepEqual([left.body.status, right.body.status].sort(), ["not_eligible", "success"]);
});

test("OV-P0-214 a successful producer row is never sent again", async () => {
  let claims = 0;
  let sends = 0;
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    claim: async () => (++claims === 1 ? producedClaim() : null),
    findProducedAlert: async () => canaryAlert(),
    fetchFn: async () => { sends += 1; return { status: 200, headers: { get: () => null } }; },
  });
  const first = res();
  const second = res();
  await handler(req(), first);
  await handler(req(), second);

  assert.equal(first.body.status, "success");
  assert.deepEqual(second.body, { claimed: false, status: "not_eligible" });
  assert.equal(sends, 1);
});

test("OV-P0-192 creates the fixed smoke payload with the required dedupe key", async () => {
  const queries = [];
  const created = await createTheoSmokeOutbox({
    query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [{ id: OUTBOX_ID, status: "pending", idempotency_key: THEO_SMOKE_DEDUPE_KEY }] };
    },
  }, { idFactory: () => OUTBOX_ID, now: new Date("2026-08-24T21:00:00.000Z") });

  assert.equal(created.status, "pending");
  assert.equal(queries[0].values[4], THEO_SMOKE_DEDUPE_KEY);
  assert.deepEqual(JSON.parse(queries[0].values[2]), {
    ...theoSmokePayload(), data_hora: "2026-08-24T21:00:00.000Z",
  });
  assert.match(queries[0].sql, /on conflict \(idempotency_key\)/i);
});

test("OV-P0-206 valid Disaster canary uses the real alert payload builder", async () => {
  const alert = canaryAlert();
  let created;
  let claimOptions;
  let sent;
  const handler = dispatcher({
    findCanary: async (id) => id === CANARY_ALERT_ID ? alert : null,
    createCanary: async (_client, options) => {
      created = options;
      return { id: OUTBOX_ID, status: "pending" };
    },
    claim: async (_client, options) => {
      claimOptions = options;
      return { ...claimed(), idempotency_key: theoCanaryDedupeKey(CANARY_ALERT_ID), payload: buildTheoAlertPayload(alert) };
    },
    fetchFn: async (url, options) => {
      sent = { url, options };
      return { status: 204, headers: { get: () => null } };
    },
  });
  const response = res();
  await handler(req({ canary_alert_id: CANARY_ALERT_ID }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.canary_alert_id, CANARY_ALERT_ID);
  assert.equal(created.alert, alert);
  assert.equal(claimOptions.allowedDedupeKey, theoCanaryDedupeKey(CANARY_ALERT_ID));
  assert.equal(JSON.parse(sent.options.body).cliente, "Sanepar");
  assert.equal(JSON.parse(sent.options.body).equipamento, "DEO-Cast-Router");
  assert.equal(JSON.parse(sent.options.body).severidade, "disaster");
  assert.equal(JSON.parse(sent.options.body).chamado, "INC0074751");
  assert.equal(JSON.parse(sent.options.body).link, `https://oneview.teletexdev.com.br/alertas?alert=${CANARY_ALERT_ID}`);
});

test("OV-P0-206 valid High canary is allowed while Average and missing alerts are blocked", async () => {
  for (const severity of ["high"]) {
    let sent = 0;
    const handler = dispatcher({
      findCanary: async () => canaryAlert(severity),
      createCanary: async () => ({ id: OUTBOX_ID, status: "pending" }),
      fetchFn: async () => { sent += 1; return { status: 200, headers: { get: () => null } }; },
    });
    const response = res();
    await handler(req({ canary_alert_id: CANARY_ALERT_ID }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(sent, 1);
  }

  for (const found of [null, canaryAlert("average")]) {
    let claimedAny = false;
    const handler = dispatcher({
      findCanary: async () => found,
      claim: async () => { claimedAny = true; return claimed(); },
    });
    const response = res();
    await handler(req({ canary_alert_id: CANARY_ALERT_ID }), response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.body.error, "canary_alert_not_eligible");
    assert.equal(claimedAny, false);
  }
});

test("OV-P0-206 canary is rejected when global automation is enabled", async () => {
  let lookedUp = false;
  const handler = dispatcher({
    configProvider: () => config({ automationEnabled: true }),
    findCanary: async () => { lookedUp = true; return canaryAlert(); },
  });
  const response = res();
  await handler(req({ canary_alert_id: CANARY_ALERT_ID }), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "canary_requires_automation_disabled");
  assert.equal(lookedUp, false);
});

test("OV-P0-206 canary idempotency prevents a second external send", async () => {
  let sends = 0;
  let claims = 0;
  const alert = canaryAlert();
  const handler = dispatcher({
    findCanary: async () => alert,
    createCanary: async () => ({ id: OUTBOX_ID, status: claims ? "success" : "pending" }),
    claim: async () => (++claims === 1 ? { ...claimed(), payload: buildTheoAlertPayload(alert) } : null),
    fetchFn: async () => { sends += 1; return { status: 200, headers: { get: () => null } }; },
  });
  const first = res();
  const second = res();
  await handler(req({ canary_alert_id: CANARY_ALERT_ID }), first);
  await handler(req({ canary_alert_id: CANARY_ALERT_ID }), second);
  assert.equal(first.body.status, "success");
  assert.deepEqual(second.body, { claimed: false, status: "not_eligible" });
  assert.equal(sends, 1);
});

test("OV-P0-206 canary outbox preserves the exact idempotency key and incident", async () => {
  const calls = [];
  const alert = canaryAlert();
  const created = await createTheoCanaryOutbox({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [{ id: OUTBOX_ID, status: "pending", idempotency_key: theoCanaryDedupeKey(CANARY_ALERT_ID) }] };
    },
  }, { alert, alertId: CANARY_ALERT_ID, idFactory: () => OUTBOX_ID, now: new Date("2026-08-25T17:00:00.000Z") });
  assert.equal(created.idempotency_key, theoCanaryDedupeKey(CANARY_ALERT_ID));
  assert.equal(calls[0].values[5], `theo:canary:alert:${CANARY_ALERT_ID}`);
  assert.equal(JSON.parse(calls[0].values[3]).chamado, "INC0074751");
  assert.match(calls[0].sql, /on conflict \(idempotency_key\)/i);
});

test("OV-P0-209 emits direct OneView and production ServiceNow links from alert tags", () => {
  const payload = buildTheoAlertPayload({
    ...canaryAlert(),
    event_tags: [
      { tag: "__zbx_servicenow_number", value: "INC0074751" },
      { tag: "__zbx_servicenow_sys_id", value: "fdb2c6e797fe0710e580f137f053afe3" },
    ],
  });
  assert.equal(payload.link, `https://oneview.teletexdev.com.br/alertas?alert=${CANARY_ALERT_ID}`);
  assert.equal(payload.oneview_link, payload.link);
  assert.equal(payload.servicenow_link, "https://teletexprod.service-now.com/incident.do?sys_id=fdb2c6e797fe0710e580f137f053afe3");
  assert.equal(payload.chamado, "INC0074751");
  assert.equal(buildOneViewAlertDeepLink("invalid"), null);
  assert.equal(Object.hasOwn(buildTheoAlertPayload({ ...canaryAlert(), event_tags: [] }), "servicenow_link"), false);
});

test("OV-P0-192 timeout is a retryable failure", async () => {
  const finished = [];
  const handler = dispatcher({
    fetchFn: async () => { const error = new Error("request timed out"); error.name = "AbortError"; throw error; },
    finish: async (_client, result) => { finished.push(result); return { id: OUTBOX_ID, status: "failed" }; },
  });
  const response = res();
  await handler(req({ smoke: "1" }), response);

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.status, "failed");
  assert.equal(response.body.retryable, true);
  assert.equal(finished[0].errorCode, "timeout");
  assert.equal(finished[0].retryable, true);
  assert.equal(finished[0].retryAfterSeconds, 30);
});

test("OV-P0-192 treats non-retryable HTTP 4xx as terminal failure", async () => {
  const finished = [];
  const handler = dispatcher({
    fetchFn: async () => ({ status: 401, headers: { get: () => null } }),
    finish: async (_client, result) => { finished.push(result); return { id: OUTBOX_ID, status: "failed" }; },
  });
  const response = res();
  await handler(req({ smoke: "1" }), response);

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.retryable, false);
  assert.equal(finished[0].errorCode, "http_401");
  assert.equal(finished[0].retryable, false);
});

test("OV-P0-192 treats HTTP 429 as retryable", async () => {
  const finished = [];
  const handler = dispatcher({
    fetchFn: async () => ({ status: 429, headers: { get: () => "45" } }),
    finish: async (_client, result) => { finished.push(result); return { id: OUTBOX_ID, status: "failed" }; },
  });
  const response = res();
  await handler(req({ smoke: "1" }), response);

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.retryable, true);
  assert.equal(finished[0].retryAfterSeconds, 45);
});

test("OV-P0-192 normal automation stays disabled without a smoke request", async () => {
  let claimedAny = false;
  const handler = dispatcher({ claim: async () => { claimedAny = true; return claimed(); } });
  const response = res();
  await handler(req(), response);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "theo_automation_disabled");
  assert.equal(claimedAny, false);
});

test("OV-P0-203 Theo route accepts only its CRON_SECRET and does not require an SSO session", async () => {
  let transactionCalls = 0;
  const handler = dispatcher({
    configProvider: () => config({ url: null }),
    transaction: async () => { transactionCalls += 1; },
  });

  const missing = res();
  await handler({ method: "POST", query: {}, headers: {} }, missing);
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(missing.body, { error: "authentication_required" });

  const wrong = res();
  await handler({ method: "POST", query: {}, headers: { authorization: "Bearer wrong-secret" } }, wrong);
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.body, { error: "authentication_required" });

  const validWithoutSso = res();
  await handler({ method: "POST", query: {}, headers: { authorization: `Bearer ${SECRET}` } }, validWithoutSso);
  assert.equal(validWithoutSso.statusCode, 503);
  assert.deepEqual(validWithoutSso.body, { error: "theo_dispatch_not_configured" });
  assert.equal(transactionCalls, 0);
});

test("OV-P0-203 Theo route rejects non-POST before auth and other OneView routes retain SSO", async () => {
  const theo = dispatcher();
  const getResponse = res();
  await theo({ method: "GET", query: {}, headers: {} }, getResponse);
  assert.equal(getResponse.statusCode, 405);
  assert.deepEqual(getResponse.body, { error: "method_not_allowed" });

  const oneView = createOneViewHandler("health");
  const oneViewResponse = res();
  await oneView({ method: "GET", query: {}, headers: {} }, oneViewResponse);
  assert.equal(oneViewResponse.statusCode, 401);
  assert.deepEqual(oneViewResponse.body, { error: "authentication_required" });
});

test("OV-P0-192 success is never sent again", async () => {
  let claims = 0;
  let sends = 0;
  const handler = dispatcher({
    claim: async () => (++claims === 1 ? claimed() : null),
    fetchFn: async () => { sends += 1; return { status: 200, headers: { get: () => null } }; },
  });
  const first = res();
  const second = res();
  await handler(req({ smoke: "1" }), first);
  await handler(req({ smoke: "1" }), second);

  assert.equal(first.body.status, "success");
  assert.deepEqual(second.body, { claimed: false, status: "not_eligible" });
  assert.equal(sends, 1);
});

test("OV-P0-192 concurrent dispatches cannot duplicate an external send", async () => {
  let claimedOnce = false;
  let sends = 0;
  const handler = dispatcher({
    claim: async () => {
      if (claimedOnce) return null;
      claimedOnce = true;
      return claimed();
    },
    fetchFn: async () => { sends += 1; return { status: 200, headers: { get: () => null } }; },
  });
  const left = res();
  const right = res();
  await Promise.all([handler(req({ smoke: "1" }), left), handler(req({ smoke: "1" }), right)]);

  assert.equal(sends, 1);
  assert.deepEqual([left.body.status, right.body.status].sort(), ["not_eligible", "success"]);
});

test("OV-P0-192 never exposes the token in a response or structured log", async () => {
  const logs = [];
  const handler = dispatcher({ logger: (entry) => logs.push(entry) });
  const response = res();
  await handler(req({ smoke: "1" }), response);

  const publicOutput = JSON.stringify({ response: response.body, logs });
  assert.doesNotMatch(publicOutput, /server-only-theo-token|x-theo-token/i);
});

test("OV-P0-192 payload follows the validated Theo contract", () => {
  const payload = buildTheoPayload({
    titulo: "Title", cliente: "Client", equipamento: "Host", ip: "10.0.0.1",
    data_hora: "2026-08-24T21:00:00.000Z", acao: "Action", proximos_passos: "Next",
    acompanhamento: "NOC", severidade: "High", chamado: "INC001", link: "https://oneview.teletexdev.com.br",
    token: "must-not-pass-through",
  });
  assert.deepEqual(Object.keys(payload), [
    "titulo", "cliente", "equipamento", "ip", "data_hora", "acao", "proximos_passos",
    "acompanhamento", "severidade", "chamado", "link", "oneview_link",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-pass-through/);
});

test("OV-P0-194 persists a server-side Theo dispatcher heartbeat", async () => {
  const calls = [];
  await recordTheoDispatcherHeartbeat({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  }, { success: true, hostname: "vercel-test", version: "c374d34" });

  assert.match(calls[0].sql, /insert into worker_heartbeats/i);
  assert.match(calls[0].sql, /on conflict \(worker_id\) do update/i);
  assert.equal(calls[0].values[0], THEO_DISPATCHER_WORKER_NAME);
  assert.equal(calls[0].values[3], null);
  assert.equal(calls[0].values[4], true);
});
