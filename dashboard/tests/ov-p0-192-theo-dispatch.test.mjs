import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTheoPayload,
  claimEligibleTheoOutbox,
  createTheoSmokeOutbox,
  createTheoDispatchHandler,
  THEO_SMOKE_DEDUPE_KEY,
  theoSmokePayload,
} from "../api/_lib/oneview-theo-dispatch.js";

const SECRET = "theo-dispatch-test-secret";
const OUTBOX_ID = "0a3be1e9-42de-4a50-b5aa-9ec886971920";

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

function dispatcher(overrides = {}) {
  return createTheoDispatchHandler({
    configProvider: () => config(),
    transaction: async (work) => work({}),
    createSmoke: async () => ({ id: OUTBOX_ID, status: "pending" }),
    claim: async () => claimed(),
    finish: async () => ({ id: OUTBOX_ID, status: "success" }),
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
    outboxId: OUTBOX_ID,
    lockedBy: "vercel-theo:test-lock-id",
    success: true,
    retryable: false,
    httpStatus: 204,
    errorCode: null,
    retryAfterSeconds: 0,
  });
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
    "acompanhamento", "severidade", "chamado", "link",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-pass-through/);
});
