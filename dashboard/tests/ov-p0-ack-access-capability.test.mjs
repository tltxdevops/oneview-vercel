import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourceAckCapability } from "../api/_lib/oneview-source-acknowledge.js";
import { createSourceAckAccessHandler } from "../api/_lib/oneview-source-ack-access.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const config = { enabled: true, allowedDatasources: new Set(["teletex-http"]) };

test("Teletex-http suporta ACK e começa unknown; Zurich permanece fechado", () => {
  assert.deepEqual(sourceAckCapability({ datasourceName: "teletex-http", syncEnabled: true, config }), {
    source_ack_supported: true,
    actor_ack_access: "unknown",
    source_ack_available: true,
    source_ack_unavailable_reason: null,
  });
  const zurich = sourceAckCapability({ datasourceName: "zurich", syncEnabled: true, config });
  assert.equal(zurich.source_ack_supported, false);
  assert.equal(zurich.actor_ack_access, false);
  assert.equal(zurich.source_ack_available, false);
});

test("probe é BFF-only, drawer-only, sem fallback/token/event.acknowledge", async () => {
  const [probe, route, ui, api] = await Promise.all([
    read("api/_lib/oneview-source-ack-access.js"),
    read("api/oneview/alerts/[id]/source-ack-access.js"),
    read("src/components/oneview/AlertSourceAckAction.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);
  assert.match(probe, /requireOneViewAuth/);
  assert.match(probe, /source_host_id/);
  assert.match(probe, /CACHE_TTL_SECONDS = 60/);
  assert.match(probe, /payload ->> 'source_event_id' = \$5/);
  assert.match(probe, /zabbix_event_access_probe/);
  assert.match(route, /oneview-source-ack-access/);
  assert.match(ui, /probeEnabled/);
  assert.match(ui, /source_ack_supported === true/);
  assert.match(ui, /status_source === "active"/);
  assert.match(ui, /!currentAlert\.resolved_at/);
  assert.match(ui, /!currentAlert\.acknowledged_source/);
  assert.match(ui, /!liveStateUnavailable/);
  assert.match(ui, /actorAckAccess === true/);
  assert.match(api, /source-ack-access/);
  assert.match(api, /signal\?: AbortSignal/);
  assert.match(ui, /source_ack_access_unavailable/);
  assert.match(ui, /Não foi possível validar o acesso no Zabbix\./);
  assert.match(ui, /Tentar novamente/);
  assert.match(ui, /setActorAckAccess\(false\);\s*setActorAckReason\("source_ack_access_unavailable"\)/);
  assert.match(ui, /SOURCE_ACK_ACCESS_MAX_POLLS/);
  assert.match(ui, /O alerta já foi resolvido na origem\./);
  assert.match(ui, /O alerta já foi reconhecido na origem\./);
  assert.doesNotMatch(probe, /event\.acknowledge|ZABBIX_TOKEN|api_jsonrpc|service account/i);
});

test("probe exige POST e operador autenticado antes do banco", async () => {
  const response = () => ({
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = value ? JSON.parse(value) : null; },
  });
  let transactions = 0;
  const transaction = async () => { transactions += 1; throw new Error("database must not run"); };
  const handler = createSourceAckAccessHandler({
    authorize: async (_req, res) => { res.status(401).end(JSON.stringify({ error: "authentication_required" })); return null; },
    transaction,
    configProvider: () => config,
  });
  const getResponse = response();
  await handler({ method: "GET", query: { id: "alert-1" } }, getResponse);
  assert.equal(getResponse.statusCode, 405);
  const unauthenticatedResponse = response();
  await handler({ method: "POST", query: { id: "alert-1" } }, unauthenticatedResponse);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(transactions, 0);
});

test("BFF enqueues only delegated probes; resolved or acknowledged alerts do not enqueue", async () => {
  const operator = { id: "guilherme", preferred_username: "guilherme@teletex.com.br" };
  const rows = [];
  const response = () => ({
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  });
  const run = async (alert) => {
    const transaction = async (work) => work({ query: async (sql, values = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("select a.id")) return { rows: alert ? [alert] : [] };
      if (normalized.startsWith("select status, result_payload")) return { rows: [] };
      if (normalized.startsWith("insert into integration_outbox")) {
        rows.push({ action_type: values[3], payload: JSON.parse(values[4]) });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    }});
    const handler = createSourceAckAccessHandler({
      authorize: async () => operator,
      transaction,
      configProvider: () => config,
      idFactory: () => "probe-1",
      now: () => new Date("2026-10-13T12:00:00.000Z"),
    });
    const res = response();
    await handler({ method: "POST", query: { id: "alert-1" } }, res);
    return res;
  };
  const active = {
    id: "alert-1", data_source_id: "ds-1", source_event_id: "419733038", source_host_id: "39533",
    status_source: "active", resolved_at: null, acknowledged_source: false, datasource_name: "teletex-http", sync_enabled: true,
  };
  const pending = await run(active);
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.body.actor_ack_access, "unknown");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    action_type: "zabbix_event_access_probe",
    payload: {
      alert_id: "alert-1", data_source_id: "ds-1", source_event_id: "419733038", source_host_id: "39533",
      actor_id: "guilherme", actor_username: "guilherme@teletex.com.br",
    },
  });
  const resolved = await run({ ...active, status_source: "resolved", resolved_at: "2026-10-13T11:00:00.000Z" });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.actor_ack_access, false);
  assert.equal(resolved.body.reason, "source_event_resolved");
  const acknowledged = await run({ ...active, acknowledged_source: true });
  assert.equal(acknowledged.statusCode, 200);
  assert.equal(acknowledged.body.actor_ack_access, false);
  assert.equal(acknowledged.body.reason, "source_already_acknowledged");
  assert.equal(rows.length, 1);
});

test("erro de banco retorna 503 terminal e log sanitizado", async () => {
  const logs = [];
  const handler = createSourceAckAccessHandler({
    authorize: async () => ({ id: "guilherme", preferred_username: "guilherme@teletex.com.br" }),
    transaction: async () => {
      const error = new Error("password=secret host=private.internal");
      error.code = "42703";
      throw error;
    },
    configProvider: () => config,
    logger: (entry) => logs.push(entry),
  });
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  };
  await handler({ method: "POST", query: { id: "alert-1" } }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "source_ack_access_unavailable" });
  assert.deepEqual(logs, [{
    event: "source_ack_access_error",
    stage: "transaction_start",
    alert_id: "alert-1",
    actor: "guilherme@teletex.com.br",
    error_code: "42703",
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /secret|private\.internal/);
});

test("503 registra o estágio exato sem vazar detalhes", async () => {
  const active = {
    id: "alert-1", data_source_id: "ds-1", source_event_id: "419733038", source_host_id: "39533",
    status_source: "active", resolved_at: null, acknowledged_source: false,
    datasource_name: "teletex-http", sync_enabled: true,
  };
  const response = () => ({
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  });
  const failure = (code = "XX000") => Object.assign(new Error("token=never-log"), { code });
  const cases = [
    {
      expected: "config",
      configProvider: () => { throw failure("actions_database_not_configured"); },
      transaction: async () => { throw new Error("must not run"); },
    },
    {
      expected: "load_alert",
      transaction: async (work) => work({ query: async () => { throw failure("42703"); } }),
    },
    {
      expected: "lookup_cache",
      transaction: async (work) => work({ query: async (sql) => {
        if (/select a\.id/i.test(sql)) return { rows: [active] };
        throw failure("42501");
      }}),
    },
    {
      expected: "insert_outbox",
      transaction: async (work) => work({ query: async (sql) => {
        if (/select a\.id/i.test(sql)) return { rows: [active] };
        if (/select status, result_payload/i.test(sql)) return { rows: [] };
        throw failure("23502");
      }}),
    },
    {
      expected: "transaction_commit",
      transaction: async (work) => {
        await work({ query: async (sql) => {
          if (/select a\.id/i.test(sql)) return { rows: [active] };
          if (/select status, result_payload/i.test(sql)) return { rows: [] };
          if (/insert into integration_outbox/i.test(sql)) return { rows: [], rowCount: 1 };
          throw new Error("unexpected query");
        }});
        throw failure("40001");
      },
    },
  ];
  for (const scenario of cases) {
    const logs = [];
    const handler = createSourceAckAccessHandler({
      authorize: async () => ({ id: "guilherme", preferred_username: "guilherme@teletex.com.br" }),
      transaction: scenario.transaction,
      configProvider: scenario.configProvider || (() => config),
      logger: (entry) => logs.push(entry),
      idFactory: () => "probe-1",
      now: () => new Date("2026-10-13T12:00:00.000Z"),
    });
    const res = response();
    await handler({ method: "POST", query: { id: "alert-1" } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(logs[0].stage, scenario.expected);
    assert.doesNotMatch(JSON.stringify(logs), /never-log/);
  }
});

test("cache positivo do evento A nunca autoriza evento B do mesmo host", async () => {
  const operator = { id: "guilherme", preferred_username: "guilherme@teletex.com.br" };
  const alert = {
    id: "alert-b", data_source_id: "ds-1", source_event_id: "event-B", source_host_id: "39533",
    status_source: "active", resolved_at: null, acknowledged_source: false,
    datasource_name: "teletex-http", sync_enabled: true,
  };
  // Numeric source IDs are required by the endpoint; use distinct numeric events.
  alert.source_event_id = "434144284";
  const cacheByEvent = new Map([["434144283", {
    status: "success", result_payload: { actor_ack_access: true, reason: null },
  }]]);
  const inserted = [];
  const transaction = async (work) => work({ query: async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select a.id")) return { rows: [alert] };
    if (normalized.startsWith("select status, result_payload")) {
      assert.equal(values[4], "434144284");
      return { rows: cacheByEvent.has(values[4]) ? [cacheByEvent.get(values[4])] : [] };
    }
    if (normalized.startsWith("insert into integration_outbox")) {
      inserted.push(JSON.parse(values[4]));
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${normalized}`);
  }});
  const handler = createSourceAckAccessHandler({
    authorize: async () => operator,
    transaction,
    configProvider: () => config,
    idFactory: () => "probe-b",
    now: () => new Date("2026-10-13T12:00:00.000Z"),
  });
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = JSON.parse(value); },
  };
  await handler({ method: "POST", query: { id: "alert-b" } }, res);
  assert.equal(res.body.actor_ack_access, "unknown");
  assert.equal(res.body.pending, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].source_event_id, "434144284");
});
