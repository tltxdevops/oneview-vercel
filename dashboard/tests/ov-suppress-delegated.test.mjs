import assert from "node:assert/strict";
import test from "node:test";

import {
  createSuppressAccessHandler,
  createSuppressHandler,
  createSuppressStatusHandler,
  createUnsuppressHandler,
  nextActionAfterTimeout,
  suppressUiState,
} from "../api/_lib/oneview-suppress-request.js";

const operator = { id: "operator-1", name: "Operador NOC", preferred_username: "operador.noc@teletex.com.br" };

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(value) { this.body = value ? JSON.parse(value) : null; },
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    query: { id: "alert-1" },
    headers: { "idempotency-key": "suppress-12345678" },
    body: {
      source_event_id: "438250534",
      reason: "Manutenção programada",
      duration_seconds: 7200,
      indefinite_confirmed: false,
    },
    ...overrides,
  };
}

function enabledConfig() {
  return {
    enabled: true,
    allowedDatasources: new Set(["teletex-http"]),
    allowedOperators: new Set(["operador.noc@teletex.com.br"]),
  };
}

function fakeDatabase({ alert = {}, schema = false, history = [] } = {}) {
  const state = {
    alert: {
      id: "alert-1",
      data_source_id: "ds-1",
      source_event_id: "438250534",
      status_source: "active",
      resolved_at: null,
      suppression_origin: null,
      suppression_confirmation: null,
      suppress_until: null,
      suppression_user_id: null,
      datasource_name: "teletex-http",
      sync_enabled: true,
      ...alert,
    },
    outboxes: [],
    history,
  };
  const transaction = async (work) => {
    const client = {
      query: async (statement, values = []) => {
        const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
        if (sql.includes("oneview_suppress_alert")) return { rows: state.alert ? [state.alert] : [] };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("oneview_suppress_existing")) {
          return { rows: state.outboxes.filter((row) => row.idempotency_key === values[0]).slice(0, 1) };
        }
        if (sql.includes("oneview_suppress_insert")) {
          if (schema) {
            const error = new Error("check");
            error.code = "23514";
            throw error;
          }
          state.outboxes.push({
            id: values[0],
            action_type: values[3],
            status: "pending",
            payload: JSON.parse(values[4]),
            idempotency_key: values[6],
            result_payload: null,
          });
          return { rows: [] };
        }
        if (sql.includes("oneview_suppress_probe_cache")) return { rows: [] };
        if (sql.includes("oneview_suppress_probe_insert")) {
          assert.equal(values[3], "zabbix_event_suppress_probe");
          assert.equal(sql.includes("zabbix_event_access_probe"), false);
          state.outboxes.push({ id: values[0], action_type: values[3], payload: JSON.parse(values[4]) });
          return { rows: [] };
        }
        if (sql.includes("oneview_suppress_status")) return { rows: state.outboxes.filter((row) => row.payload?.actor_id === values[2]).slice(-1) };
        if (sql.includes("oneview_suppress_periods")) return { rows: state.history };
        throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
      },
    };
    return work(client);
  };
  return { state, transaction };
}

function handler(database, config = enabledConfig) {
  let n = 0;
  const configProvider = typeof config === "function" ? config : () => config;
  return createSuppressHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider,
    idFactory: () => `id-${++n}`,
    now: () => new Date("2026-10-15T18:00:00Z"),
    logger: () => undefined,
  });
}

test("accepts a delegated suppress request without reporting origin success", async () => {
  const database = fakeDatabase();
  const res = response();
  await handler(database)(request(), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.origin_confirmed, false);
  assert.equal(res.body.ui_state, "awaiting");
  assert.equal(database.state.outboxes[0].action_type, "zabbix_event_suppress");
  assert.equal(database.state.outboxes[0].payload.duration_seconds, 7200);
  assert.equal(database.state.outboxes[0].payload.suppress_until, undefined);
  assert.equal(suppressUiState({ phase: "settled", accepted: true, outboxStatus: "pending", confirmed: false }), "awaiting");
});

test("feature flag and operator allowlist fail closed", async () => {
  const disabled = fakeDatabase();
  const res = response();
  await handler(disabled, { ...enabledConfig(), enabled: false })(request(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "suppress_disabled");
  assert.equal(disabled.state.outboxes.length, 0);

  const outsider = fakeDatabase();
  const denied = response();
  await handler(outsider, { ...enabledConfig(), allowedOperators: new Set(["outra.pessoa"]) })(request(), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error, "operator_not_allowed");
});

test("maps stays read only and a missing or resolved event is not written", async () => {
  const maps = fakeDatabase({ alert: { datasource_name: "maps" } });
  const mapsResponse = response();
  await handler(maps, { ...enabledConfig(), allowedDatasources: new Set(["maps", "teletex-http"]) })(request(), mapsResponse);
  assert.equal(mapsResponse.statusCode, 409);
  assert.equal(mapsResponse.body.error, "suppress_read_only");

  const missing = fakeDatabase({ alert: { source_event_id: null } });
  const missingResponse = response();
  await handler(missing)(request({ body: { ...request().body, source_event_id: "" } }), missingResponse);
  assert.equal(missingResponse.statusCode, 409);
  assert.equal(missingResponse.body.error, "source_event_id_missing");

  const resolved = fakeDatabase({ alert: { status_source: "resolved", resolved_at: "2026-10-15T17:00:00Z" } });
  const resolvedResponse = response();
  await handler(resolved)(request(), resolvedResponse);
  assert.equal(resolvedResponse.statusCode, 409);
  assert.equal(resolvedResponse.body.error, "source_event_resolved");
});

test("requires a reason and an explicit indefinite confirmation", async () => {
  const database = fakeDatabase();
  const empty = response();
  await handler(database)(request({ body: { ...request().body, reason: " " } }), empty);
  assert.equal(empty.statusCode, 400);
  const indefinite = response();
  await handler(database)(request({ body: { ...request().body, duration_seconds: 0, indefinite_confirmed: false } }), indefinite);
  assert.equal(indefinite.statusCode, 400);
  assert.equal(database.state.outboxes.length, 0);
});

test("repeats the same confirmation and does not post a second action after an ambiguous result", async () => {
  const database = fakeDatabase();
  const first = response();
  const second = response();
  await handler(database)(request(), first);
  await handler(database)(request(), second);
  assert.equal(database.state.outboxes.length, 1);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.origin_confirmed, false);
  assert.equal(nextActionAfterTimeout(), "reconcile");
  assert.equal(suppressUiState({ phase: "settled", accepted: true, outboxStatus: "success", confirmed: false, timedOut: true }), "inconclusive");
});

test("schema check rejection does not become success", async () => {
  const database = fakeDatabase({ schema: true });
  const res = response();
  await handler(database)(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "schema_constraint_rejected");
});

test("probe is separate from acknowledgement access", async () => {
  const database = fakeDatabase();
  let n = 0;
  const probe = createSuppressAccessHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: enabledConfig,
    idFactory: () => `probe-${++n}`,
    now: () => new Date("2026-10-15T18:00:00Z"),
  });
  const res = response();
  await probe(request({ body: {} }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.ui_state, "checking");
  assert.equal(database.state.outboxes[0].action_type, "zabbix_event_suppress_probe");
});

test("unsuppress refuses maintenance and another user's period", async () => {
  const maintenance = fakeDatabase({ alert: { suppression_origin: "maintenance", suppression_confirmation: "confirmed", suppress_until: "100", suppression_user_id: "9" } });
  const maintenanceResponse = response();
  const unsuppress = createUnsuppressHandler({
    authorize: async () => operator,
    transaction: maintenance.transaction,
    configProvider: enabledConfig,
    idFactory: () => "unsuppress-1",
    now: () => new Date("2026-10-15T18:00:00Z"),
    logger: () => undefined,
  });
  await unsuppress(request({
    headers: { "idempotency-key": "unsuppress-12345678" },
    body: { source_event_id: "438250534", expected_suppress_until: 100, expected_userid: "9" },
  }), maintenanceResponse);
  assert.equal(maintenanceResponse.statusCode, 409);
  assert.equal(maintenanceResponse.body.error, "third_party_maintenance");
  assert.equal(maintenance.state.outboxes.length, 0);

  const other = fakeDatabase({ alert: { suppression_origin: "manual", suppression_confirmation: "confirmed", suppress_until: "100", suppression_user_id: "8" } });
  const otherResponse = response();
  await createUnsuppressHandler({
    authorize: async () => operator,
    transaction: other.transaction,
    configProvider: enabledConfig,
    idFactory: () => "unsuppress-2",
    now: () => new Date("2026-10-15T18:00:00Z"),
    logger: () => undefined,
  })(request({
    headers: { "idempotency-key": "unsuppress-22345678" },
    body: { source_event_id: "438250534", expected_suppress_until: 100, expected_userid: "9" },
  }), otherResponse);
  assert.equal(otherResponse.body.error, "suppressed_by_other");
});

test("status reports proved periods and does not treat acceptance as suppression", async () => {
  const database = fakeDatabase({
    history: [
      { id: "h1", action_type: "oneview_suppression_period", metadata: { idempotency_key: "a", origin: "oneview" }, created_at: "2026-10-15T12:00:00Z" },
      { id: "h2", action_type: "oneview_suppression_period", metadata: { idempotency_key: "b", origin: "oneview" }, created_at: "2026-10-15T15:00:00Z" },
    ],
  });
  database.state.outboxes.push({
    id: "out-1",
    status: "pending",
    action_type: "zabbix_event_suppress",
    payload: { actor_id: operator.id },
    result_payload: null,
  });
  const status = createSuppressStatusHandler({
    authorize: async () => operator,
    transaction: database.transaction,
  });
  const res = response();
  await status({ method: "GET", query: { id: "alert-1" }, headers: {} }, res);
  assert.equal(res.body.period_count, 2);
  assert.equal(res.body.origin_confirmed, false);
  assert.equal(res.body.ui_state, "awaiting");
  assert.equal(res.body.unsuppress.enabled, false);
});
