import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSourceAcknowledgeHandler, getSourceAcknowledgeConfig } from "../api/_lib/oneview-source-acknowledge.js";

const operator = { id: "operator-1", name: "Operador NOC", preferred_username: "operador.noc@teletex.com.br" };

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
        working.outboxes.push({ id: values[0], action_type: values[4], acknowledgement_id: values[1], payload: JSON.parse(values[5]) });
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

function concurrentDatabase() {
  const state = {
    alert: {
      id: "alert-1", data_source_id: "ds-1", source_event_id: "event-1", status_source: "active",
      resolved_at: null, acknowledged_source: false, datasource_name: "teletex-http", sync_enabled: true,
    },
    acknowledgements: [],
    outboxes: [],
  };
  let lockTail = Promise.resolve();
  const transaction = async (work) => {
    let releaseLock;
    const client = { query: async (statement, values = []) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.includes("pg_advisory_xact_lock")) {
        const previous = lockTail;
        lockTail = new Promise((resolve) => { releaseLock = resolve; });
        await previous;
        return { rows: [] };
      }
      if (sql.startsWith("select a.id") && sql.includes("from alerts a")) return { rows: [state.alert] };
      if (sql.startsWith("select id, status from alert_acknowledgements")) {
        return { rows: state.acknowledgements.filter((row) => row.idempotency_key === values[0]).slice(0, 1) };
      }
      if (sql.startsWith("select id from alert_acknowledgements")) {
        return { rows: state.acknowledgements.filter((row) => row.alert_id === values[0] && ["pending", "processing"].includes(row.status)).slice(0, 1) };
      }
      if (sql.startsWith("insert into alert_acknowledgements")) {
        state.acknowledgements.push({ id: values[0], alert_id: values[1], status: "pending", idempotency_key: values[9] });
        return { rows: [] };
      }
      if (sql.startsWith("insert into integration_outbox")) {
        state.outboxes.push({ id: values[0], action_type: values[4], acknowledgement_id: values[1], payload: JSON.parse(values[5]) });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    }};
    try {
      return await work(client);
    } finally {
      releaseLock?.();
    }
  };
  return { state, transaction };
}

function handler(database, authorized = operator) {
  let n = 0;
  return createSourceAcknowledgeHandler({ authorize: async () => authorized, transaction: database.transaction, configProvider: enabledConfig, idFactory: () => `id-${++n}`, logger: () => undefined });
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
  assert.equal(database.state.outboxes[0].payload.actor_id, operator.id);
  assert.equal(database.state.outboxes[0].payload.actor_name, operator.name);
  assert.equal(database.state.outboxes[0].payload.actor_oid, operator.id);
  assert.equal(database.state.outboxes[0].payload.actor_upn, operator.preferred_username);
  assert.equal(database.state.outboxes[0].payload.actor_username, operator.preferred_username);
});

test("source ACK: actor_username/UPN é obrigatório antes de criar outbox", async () => {
  const database = fakeDatabase();
  const res = response();
  await handler(database, { id: "operator-1", name: "Operador NOC" })(request(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "authentication_required");
  assert.equal(database.state.acknowledgements.length, 0);
  assert.equal(database.state.outboxes.length, 0);
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

test("source ACK: teletex-http com sync cria outbox; outras origens e sync desligado não", async () => {
  const config = getSourceAcknowledgeConfig({ ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "true" });
  assert.equal(config.allowedDatasources.has("teletex-http"), true);
  for (const datasource of ["zurich", "rhp", "castrolanda", "fraport-for", "maps"]) {
    assert.equal(config.allowedDatasources.has(datasource), false);
  }
  const accept = fakeDatabase();
  const accepted = response();
  await createSourceAcknowledgeHandler({
    authorize: async () => operator,
    transaction: accept.transaction,
    configProvider: () => config,
    idFactory: () => "id-accept",
    logger: () => undefined,
  })(request(), accepted);
  assert.equal(accepted.statusCode, 202);
  assert.equal(accept.state.outboxes.length, 1);
  assert.equal(accept.state.outboxes[0].action_type, "zabbix_event_acknowledge");

  for (const datasourceName of ["zurich", "rhp", "castrolanda", "fraport-for", "maps"]) {
    const database = fakeDatabase({ alert: { datasource_name: datasourceName } });
    const res = response();
    await createSourceAcknowledgeHandler({
      authorize: async () => operator,
      transaction: database.transaction,
      configProvider: () => config,
      idFactory: () => "id-deny",
      logger: () => undefined,
    })(request(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "datasource_not_allowed");
    assert.equal(database.state.outboxes.length, 0);
  }

  const unsynced = fakeDatabase({ alert: { sync_enabled: false } });
  const denied = response();
  await createSourceAcknowledgeHandler({
    authorize: async () => operator,
    transaction: unsynced.transaction,
    configProvider: () => config,
    idFactory: () => "id-sync",
    logger: () => undefined,
  })(request(), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, "datasource_not_allowed");
  assert.equal(unsynced.state.outboxes.length, 0);
});

test("source ACK: cada fonte canônica exige allowlist explícita", () => {
  const names = ["teletex-http", "rhp", "maps", "fraport-for", "fraport-poa", "castrolanda", "zurich"];
  const config = getSourceAcknowledgeConfig({
    ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "true",
    ONEVIEW_SOURCE_ACK_ALLOWED_DATASOURCES: names.join(","),
  });
  assert.deepEqual([...config.allowedDatasources].sort(), [...names].sort());
  const unknown = getSourceAcknowledgeConfig({
    ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "true",
    ONEVIEW_SOURCE_ACK_ALLOWED_DATASOURCES: "teletex-http,unknown-source",
  });
  assert.equal(unknown.allowedDatasources.has("unknown-source"), false);
});

test("source ACK: datasource homologada preserva identidade composta mesmo com eventid repetido", async () => {
  const database = fakeDatabase({ alert: { data_source_id: "ds-rhp", datasource_name: "rhp" } });
  const res = response();
  await createSourceAcknowledgeHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => ({ enabled: true, allowedDatasources: new Set(["teletex-http", "rhp"]) }),
    idFactory: () => "rhp-id",
    logger: () => undefined,
  })(request(), res);
  assert.equal(res.statusCode, 202);
  assert.equal(database.state.outboxes.length, 1);
  assert.equal(database.state.outboxes[0].payload.data_source_id, "ds-rhp");
  assert.equal(database.state.outboxes[0].payload.source_event_id, "event-1");
  assert.equal(database.state.outboxes[0].payload.actor_oid, operator.id);
});

test("source ACK: feature desligada responde source_acknowledge_disabled e não cria outbox", async () => {
  const database = fakeDatabase();
  const res = response();
  await createSourceAcknowledgeHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: () => getSourceAcknowledgeConfig({ ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "false" }),
    idFactory: () => "id-off",
    logger: () => undefined,
  })(request(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "source_acknowledge_disabled");
  assert.equal(database.state.outboxes.length, 0);
});

test("source ACK: flag fail-closed e produtor não chama Zabbix", () => {
  assert.equal(getSourceAcknowledgeConfig({}).enabled, false);
  assert.equal(getSourceAcknowledgeConfig({ ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "false", ONEVIEW_SOURCE_ACK_ALLOWED_DATASOURCES: "teletex-http,zurich" }).enabled, false);
  const source = fs.readFileSync(fileURLToPath(new URL("../api/_lib/oneview-source-acknowledge.js", import.meta.url)), "utf8");
  assert.match(source, /integration_outbox/);
  assert.doesNotMatch(source, /event\.acknowledge|api_jsonrpc|\bfetch\s*\(|\baxios\b/i);
});

test("source ACK: advisory lock protege pedidos concorrentes sem UPDATE em alerts", async () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../api/_lib/oneview-source-acknowledge.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bfor\s+update\b/i);
  assert.ok(source.indexOf("pg_advisory_xact_lock") < source.lastIndexOf("where a.id = $1"));

  const database = concurrentDatabase();
  const acknowledge = handler(database);
  const first = response();
  const second = response();
  await Promise.all([
    acknowledge(request(), first),
    acknowledge(request({ headers: { "idempotency-key": "source-ack-other-123" } }), second),
  ]);
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(second.body.idempotent, true);
  assert.equal(database.state.acknowledgements.length, 1);
  assert.equal(database.state.outboxes.length, 1);
  assert.equal(database.state.outboxes[0].action_type, "zabbix_event_acknowledge");
});
