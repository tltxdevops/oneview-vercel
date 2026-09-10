import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAckRequestHandler, getAckRequestConfig } from "../api/_lib/oneview-ack-request.js";
import { getOneViewActionsDbConfig } from "../api/_lib/oneview-actions-db.js";
import { createSessionToken } from "../api/_lib/session.js";

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; },
  };
}

function requestMock(overrides = {}) {
  return {
    method: "POST",
    query: { id: "alert-123" },
    headers: { "idempotency-key": "ack-click-123456" },
    body: { comment: "Validado pelo NOC" },
    ...overrides,
  };
}

function enabledConfig(allowed = ["teletex-http"]) {
  return {
    requestEnabled: true,
    executionEnabled: false,
    allowedDatasources: new Set(allowed),
  };
}

function fakeDatabase({ datasource = "teletex-http", acknowledged = false } = {}) {
  const state = {
    acknowledgements: 0,
    outboxes: 0,
    audits: 0,
    existingAcknowledgementId: null,
    queryCount: 0,
    writes: [],
  };
  const client = {
    async query(text, values = []) {
      state.queryCount += 1;
      const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("select a.id") && sql.includes("from alerts a")) {
        return { rows: [{
          id: "alert-123",
          data_source_id: "ds-123",
          source_event_id: "event-123",
          datasource_name: datasource,
          acknowledged_source: acknowledged,
        }] };
      }
      if (sql.startsWith("select id") && sql.includes("from alert_acknowledgements")) {
        return { rows: state.existingAcknowledgementId ? [{ id: state.existingAcknowledgementId }] : [] };
      }
      if (sql.startsWith("insert into alert_acknowledgements")) {
        state.acknowledgements += 1;
        state.writes.push({ table: "alert_acknowledgements", values });
        state.existingAcknowledgementId = values[0];
        return { rows: [] };
      }
      if (sql.startsWith("insert into audit_logs")) {
        state.audits += 1;
        state.writes.push({ table: "audit_logs", values });
        return { rows: [] };
      }
      throw new Error(`unexpected_test_query:${sql.slice(0, 40)}`);
    },
  };
  return {
    state,
    transaction: async (work) => work(client),
  };
}

const operator = { id: "sso-user-123", name: "Operador NOC", email: "operador@example.invalid" };

test("ACK request: sem sessao retorna 401 antes do banco", async () => {
  let transactionCalled = false;
  const handler = createAckRequestHandler({
    authorize: async (_req, res) => { res.status(401).end(JSON.stringify({ error: "authentication_required" })); return null; },
    transaction: async () => { transactionCalled = true; },
    configProvider: () => enabledConfig(),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(transactionCalled, false);
});

test("ACK request: usuario sem permissao retorna 403 antes do banco", async () => {
  let transactionCalled = false;
  const handler = createAckRequestHandler({
    authorize: async (_req, res) => { res.status(403).end(JSON.stringify({ error: "insufficient_role" })); return null; },
    transaction: async () => { transactionCalled = true; },
    configProvider: () => enabledConfig(),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(transactionCalled, false);
});

test("ACK request: sessão corporativa usa flag geral sem lista individual", async () => {
  const names = [
    "APP_SESSION_SECRET",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const database = fakeDatabase();
  try {
    process.env.APP_SESSION_SECRET = "ack-session-test-secret";
    const session = createSessionToken({
      oid: "entra-object-test",
      id: "entra-object-test",
      tid: "test-tenant",
      sub: "test-subject",
      name: "Pessoa Autenticada",
      email: "pessoa.autenticada@teletex.com.br",
      roles: ["OneView.Operator"],
    });
    const handler = createAckRequestHandler({
      transaction: database.transaction,
      configProvider: () => enabledConfig(),
      logger: () => undefined,
    });
    const res = responseMock();
    await handler(requestMock({
      headers: {
        cookie: `oneview_session=${encodeURIComponent(session.token)}`,
        "idempotency-key": "authenticated-action-123",
      },
    }), res);
    assert.equal(res.statusCode, 202);
    assert.equal(database.state.acknowledgements, 1);
    const audit = database.state.writes.find((write) => write.table === "audit_logs");
    assert.equal(audit.values[1], "Pessoa Autenticada");
    assert.equal(audit.values[2], "entra-object-test");
    assert.equal(JSON.parse(audit.values[8]).actor_email, "pessoa.autenticada@teletex.com.br");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("ACK request: flag de apresentação desabilita antes do banco", async () => {
  let transactionCalled = false;
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: async () => { transactionCalled = true; },
    configProvider: () => ({
      requestEnabled: false,
      executionEnabled: false,
      allowedDatasources: new Set(["teletex-http"]),
    }),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "ack_request_disabled");
  assert.equal(transactionCalled, false);
});

test("ACK request: datasource nao permitido retorna 403 sem inserts", async () => {
  const database = fakeDatabase({ datasource: "zurich" });
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "datasource_not_allowed");
  assert.equal(database.state.acknowledgements, 0);
  assert.equal(database.state.outboxes, 0);
  assert.equal(database.state.audits, 0);
});

test("ACK request: válido registra reconhecimento interno sem outbox e retorna 202", async () => {
  const database = fakeDatabase();
  const logs = [];
  let sequence = 0;
  let summaryInvalidations = 0;
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
    idFactory: () => `generated-${++sequence}`,
    invalidateSummary: () => { summaryInvalidations += 1; },
    logger: (entry) => logs.push(entry),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "recorded");
  assert.equal(res.body.execution_enabled, false);
  assert.equal(res.body.idempotent, false);
  assert.equal(database.state.acknowledgements, 1);
  assert.equal(database.state.outboxes, 0);
  assert.equal(database.state.audits, 1);
  assert.equal(summaryInvalidations, 1);
  assert.equal(database.state.writes.some((write) => write.table === "alerts"), false);
  const acknowledgementWrite = database.state.writes.find((write) => write.table === "alert_acknowledgements");
  const auditWrite = database.state.writes.find((write) => write.table === "audit_logs");
  assert.equal(acknowledgementWrite.values[5], operator.name);
  assert.equal(acknowledgementWrite.values[8], operator.id);
  assert.equal(auditWrite.values[1], operator.name);
  assert.equal(auditWrite.values[2], operator.id);
  assert.equal(JSON.parse(auditWrite.values[8]).actor_email, operator.email);
  assert.deepEqual(logs[0], {
    event: "oneview_ack_request",
    route: "/api/oneview/alerts/:id/ack-request",
    status: "recorded",
    idempotent: false,
    duration_ms: logs[0].duration_ms,
  });
});

test("ACK na origem não impede o reconhecimento interno no OneView", async () => {
  const database = fakeDatabase({ acknowledged: true });
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
    logger: () => undefined,
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "recorded");
  assert.equal(database.state.acknowledgements, 1);
});

test("ACK request: repeticao usa idempotencia e nao duplica", async () => {
  const database = fakeDatabase();
  let sequence = 0;
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
    idFactory: () => `generated-${++sequence}`,
    logger: () => undefined,
  });
  const first = responseMock();
  const second = responseMock();
  await handler(requestMock(), first);
  await handler(requestMock(), second);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.request_id, first.body.request_id);
  assert.equal(database.state.acknowledgements, 1);
  assert.equal(database.state.outboxes, 0);
  assert.equal(database.state.audits, 1);
});

test("ACK request: comentário obrigatório, excedente e método GET são recusados", async () => {
  const database = fakeDatabase();
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
  });
  const invalidComment = responseMock();
  await handler(requestMock({ body: { comment: "x".repeat(501) } }), invalidComment);
  assert.equal(invalidComment.statusCode, 400);
  assert.equal(invalidComment.body.error, "invalid_comment");

  const missingComment = responseMock();
  await handler(requestMock({ body: { comment: "   " } }), missingComment);
  assert.equal(missingComment.statusCode, 400);
  assert.equal(missingComment.body.error, "invalid_comment");

  const getResponse = responseMock();
  await handler(requestMock({ method: "GET" }), getResponse);
  assert.equal(getResponse.statusCode, 405);
  assert.equal(getResponse.headers.allow, "POST");
});

test("ACK request: log não contém usuário ou segredo e resposta expõe somente nome nominal", async () => {
  const database = fakeDatabase();
  const logs = [];
  const secretComment = "segredo-super-sensivel";
  const handler = createAckRequestHandler({
    authorize: async () => ({ id: "secret-user-id", name: "Nome Secreto", email: "secret@example.invalid" }),
    transaction: database.transaction,
    configProvider: () => enabledConfig(),
    logger: (entry) => logs.push(entry),
  });
  const res = responseMock();
  await handler(requestMock({ body: { comment: secretComment } }), res);
  assert.doesNotMatch(JSON.stringify(logs), /segredo-super-sensivel|Nome Secreto|secret-user-id|secret@example/i);
  assert.equal(res.body.actor_name, "Nome Secreto");
  assert.doesNotMatch(JSON.stringify(res.body), /segredo-super-sensivel|secret-user-id|secret@example/i);
});

test("pool de actions usa role fixa e senha exclusiva", () => {
  const config = getOneViewActionsDbConfig({
    ONEVIEW_DB_HOST: "db.example.invalid",
    ONEVIEW_DB_NAME: "oneview",
    POSTGRES_ACTIONS_PASSWORD: "actions-secret",
    POSTGRES_READONLY_PASSWORD: "readonly-secret",
  });
  assert.equal(config.user, "oneview_actions");
  assert.equal(config.password, "actions-secret");
  assert.equal(config.poolMax, 1);
  assert.equal(getAckRequestConfig({
    ONEVIEW_ACK_REQUEST_ENABLED: "true",
    ONEVIEW_ACK_EXECUTION_ENABLED: "false",
    ONEVIEW_ACK_ALLOWED_DATASOURCES: "teletex-http",
  }).allowedDatasources.has("teletex-http"), true);
});

test("pool de actions aceita a senha oficial do projeto", () => {
  const config = getOneViewActionsDbConfig({
    ONEVIEW_DB_HOST: "db.example.invalid",
    ONEVIEW_DB_NAME: "oneview",
    ONEVIEW_ACTIONS_PASSWORD: "official-actions-secret",
  });
  assert.equal(config.password, "official-actions-secret");
});

test("ACK request: flag geral legado nÃ£o concede nem bloqueia operator", async () => {
  let transactionCalled = false;
  const handler = createAckRequestHandler({
    authorize: async () => operator,
    transaction: async () => { transactionCalled = true; },
    configProvider: () => enabledConfig(),
  });
  const res = responseMock();
  await handler(requestMock(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "database_unavailable");
  assert.equal(transactionCalled, true);
});

test("pool de actions sem senha exclusiva falha fechado", () => {
  assert.throws(
    () => getOneViewActionsDbConfig({ ONEVIEW_DB_HOST: "db.example.invalid", ONEVIEW_DB_NAME: "oneview" }),
    (error) => error?.code === "actions_database_not_configured",
  );
});

test("BFF de ACK nao possui chamada Zabbix", () => {
  const sourcePath = fileURLToPath(new URL("../api/_lib/oneview-ack-request.js", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /event\.acknowledge|api_jsonrpc|\bfetch\s*\(|\baxios\b/i);
  assert.doesNotMatch(source, /insert into integration_outbox/i);
  assert.doesNotMatch(source, /update\s+alerts\b/i);
});
