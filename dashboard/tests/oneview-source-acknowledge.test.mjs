import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSourceAcknowledgeHandler, getSourceAcknowledgeConfig } from "../api/_lib/oneview-source-acknowledge.js";

const operator = { id: "operator-1", name: "Operador NOC" };

function response() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value ? JSON.parse(value) : null; } };
}

function request(overrides = {}) {
  return { method: "POST", query: { id: "alert-1" }, headers: { "idempotency-key": "source-ack-123456" }, body: { source_event_id: "event-1", comment: "NOC validou" }, ...overrides };
}

function enabledConfig() {
  return { enabled: true, allowedDatasources: new Set(["teletex-http"]) };
}

function fakeDatabase({ alert = {}, failAt = null } = {}) {
  const state = {
    alert: alert === null ? null : { id: "alert-1", data_source_id: "ds-1", source_event_id: "event-1", status_source: "active", resolved_at: null, acknowledged_source: false, datasource_name: "teletex-http", sync_enabled: true, ...alert },
    acknowledgements: [], outboxes: [],
  };
  const transaction = async (work) => {
    const working = structuredClone(state);
    const client = { query: async (statement, values = []) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("select a.id") && sql.includes("from alerts a")) return { rows: working.alert ? [working.alert] : [] };
      if (sql.startsWith("select id, status from alert_acknowledgements")) {
        return { rows: working.acknowledgements.filter((row) => row.idempotency_key === values[0]).slice(0, 1) };
      }
      if (sql.startsWith("select id from alert_acknowledgements")) {
        return { rows: working.acknowledgements.filter((row) => row.alert_id === values[0] && ["pending", "processing"].includes(row.status)).slice(0, 1) };
      }
      if (sql.startsWith("insert into alert_acknowledgements")) {
        working.acknowledgements.push({ id: values[0], alert_id: values[1], status: "pending", idempotency_key: values[9] });
        if (failAt === "ack") throw new Error("forced_ack_failure");
        return { rows: [] };
      }
      if (sql.startsWith("insert into integration_outbox")) {
        if (failAt === "outbox") throw new Error("forced_outbox_failure");
        working.outboxes.push({ id: values[0], action_type: values[4], acknowledgement_id: values[1] });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    }};
    const result = await work(client);
    Object.assign(state, working);
    return result;
  };
  return { state, transaction };
}

function handler(database) {
  let n = 0;
  return createSourceAcknowledgeHandler({ authorize: async () => operator, transaction: database.transaction, configProvider: enabledConfig, idFactory: () => `id-${++n}`, logger: () => undefined });
}

test("source ACK: inexistente, resolvido e event id ausente são bloqueados", async () => {
  for (const alert of [null, { status_source: "resolved", resolved_at: "2026-01-01T00:00:00Z" }, { source_event_id: null }]) {
    const database = fakeDatabase({ alert: alert === null ? null : alert });
    const res = response();
    await handler(database)(request(), res);
    assert.ok([404, 409].includes(res.statusCode));
    assert.equal(database.state.acknowledgements.length, 0);
    assert.equal(database.state.outboxes.length, 0);
  }
});

test("source ACK: já confirmado retorna estado sem criar pedido", async () => {
  const database = fakeDatabase({ alert: { acknowledged_source: true } });
  const res = response();
  await handler(database)(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "confirmed");
  assert.equal(database.state.acknowledgements.length, 0);
});

test("source ACK: válido cria pending + outbox, sem alterar ACK da origem", async () => {
  const database = fakeDatabase();
  const res = response();
  await handler(database)(request(), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.acknowledged_source, false);
  assert.equal(database.state.alert.acknowledged_source, false);
  assert.equal(database.state.acknowledgements.length, 1);
  assert.equal(database.state.acknowledgements[0].status, "pending");
  assert.equal(database.state.outboxes.length, 1);
  assert.equal(database.state.outboxes[0].action_type, "zabbix_event_acknowledge");
});

test("source ACK: repetição/idempotência e dois operadores não duplicam outbox", async () => {
  const database = fakeDatabase();
  const first = response();
  const second = response();
  await handler(database)(request(), first);
  await handler(database)(request({ headers: { "idempotency-key": "source-ack-other-123" } }), second);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(second.body.idempotent, true);
  assert.equal(database.state.acknowledgements.length, 1);
  assert.equal(database.state.outboxes.length, 1);
});

test("source ACK: rollback não deixa ACK sem outbox nem outbox sem ACK", async () => {
  for (const failAt of ["ack", "outbox"]) {
    const database = fakeDatabase({ failAt });
    const res = response();
    await handler(database)(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(database.state.acknowledgements.length, 0);
    assert.equal(database.state.outboxes.length, 0);
  }
});

test("source ACK: flag fail-closed e produtor não chama Zabbix", () => {
  assert.equal(getSourceAcknowledgeConfig({}).enabled, false);
  const source = fs.readFileSync(fileURLToPath(new URL("../api/_lib/oneview-source-acknowledge.js", import.meta.url)), "utf8");
  assert.match(source, /integration_outbox/);
  assert.doesNotMatch(source, /event\.acknowledge|api_jsonrpc|\bfetch\s*\(|\baxios\b/i);
});
