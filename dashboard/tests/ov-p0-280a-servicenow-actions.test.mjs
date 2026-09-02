import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServiceNowIncidentActionsHandler, getServiceNowActionsConfig } from "../api/_lib/oneview-servicenow-actions.js";
import routeHandler from "../api/oneview/incidents/[sysId]/actions.js";

const SYS_ID = "a".repeat(32);
const NUMBER = "INC0012345";
const operator = { id: "entra-operator-1", name: "Operador NOC", email: "operator@teletex.com.br" };

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : null; },
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    query: { sysId: SYS_ID },
    body: { action: "servicenow.assume_self", incident_number: NUMBER, payload: {}, idempotencyKey: "action-click-0001" },
    headers: {},
    ...overrides,
  };
}

function enabledConfig() {
  return {
    allowAllAuthenticatedActions: true,
    requestEnabled: true,
    assignableGroups: ["noc-primary"],
    holdReasons: ["vendor_wait_audited_value"],
  };
}

function fakeDatabase({ incident = { sys_id: SYS_ID, number: NUMBER } } = {}) {
  const state = { outboxes: [], audits: [], queries: [] };
  const client = {
    async query(sql, values = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      state.queries.push({ normalized, values });
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.startsWith("select sys_id, number from servicenow_incidents")) return { rows: incident ? [incident] : [] };
      if (normalized.startsWith("select id, action_type, status, created_at") && normalized.includes("idempotency_key")) {
        return { rows: state.outboxes.filter((row) => row.idempotency_key === values[0]) };
      }
      if (normalized.startsWith("select id, action_type, status, created_at") && normalized.includes("where id = $1")) {
        return { rows: state.outboxes.filter((row) => row.id === values[0] && row.aggregate_id === values[1] && row.created_by === values[2]) };
      }
      if (normalized.startsWith("insert into integration_outbox")) {
        const row = { id: values[0], aggregate_id: values[1], action_type: values[2], status: "pending", payload: JSON.parse(values[3]), created_at: values[4], processed_at: null, last_error: null, idempotency_key: values[5], created_by: values[7] };
        state.outboxes.push(row);
        return { rows: [row] };
      }
      if (normalized.startsWith("insert into audit_logs")) {
        state.audits.push({ values });
        return { rows: [] };
      }
      throw new Error(`unexpected_query:${normalized.slice(0, 90)}`);
    },
  };
  return { state, transaction: async (work) => work(client) };
}

function handler(database, extra = {}) {
  let sequence = 0;
  return createServiceNowIncidentActionsHandler({
    authorize: async () => operator,
    transaction: database.transaction,
    configProvider: enabledConfig,
    idFactory: () => `outbox-${++sequence}-0000`,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    logger: () => undefined,
    ...extra,
  });
}

test("OV-P0-280A: 401/403 falham antes de consultar ou inserir", async () => {
  const database = fakeDatabase();
  const unauthenticated = createServiceNowIncidentActionsHandler({ authorize: async (_req, res) => { res.status(401).end(JSON.stringify({ error: "authentication_required" })); return null; }, transaction: database.transaction, configProvider: enabledConfig });
  const noPermission = createServiceNowIncidentActionsHandler({ authorize: async (_req, res) => { res.status(403).end(JSON.stringify({ error: "operator_required" })); return null; }, transaction: database.transaction, configProvider: enabledConfig });
  const first = response(); const second = response();
  await unauthenticated(request(), first); await noPermission(request(), second);
  assert.equal(first.statusCode, 401); assert.equal(second.statusCode, 403); assert.equal(database.state.queries.length, 0);
});

test("OV-P0-280A: valida read-model, associação sys_id/INC e ações P0", async () => {
  const missing = fakeDatabase({ incident: null });
  const missingResponse = response();
  await handler(missing)(request(), missingResponse);
  assert.equal(missingResponse.statusCode, 404); assert.equal(missingResponse.body.error, "incident_not_found");

  const mismatch = fakeDatabase({ incident: { sys_id: SYS_ID, number: "INC0099999" } });
  const mismatchResponse = response();
  await handler(mismatch)(request(), mismatchResponse);
  assert.equal(mismatchResponse.statusCode, 409); assert.equal(mismatchResponse.body.error, "incident_number_mismatch");

  for (const [action, payload] of [
    ["servicenow.assume_self", {}],
    ["servicenow.assign_group", { target_group: "noc-primary" }],
    ["servicenow.work_note", { work_note: "Nota operacional autorizada" }],
    ["servicenow.hold", { hold_reason: "vendor_wait_audited_value" }],
  ]) {
    const database = fakeDatabase(); const res = response();
    await handler(database)(request({ body: { action, incident_number: NUMBER, payload, idempotencyKey: `action-click-${action.slice(11).replace("_", "-")}-001` } }), res);
    assert.equal(res.statusCode, 202); assert.equal(res.body.status, "pending");
    assert.equal(database.state.outboxes.length, 1); assert.equal(database.state.outboxes[0].payload.integration, "servicenow");
    assert.equal(database.state.outboxes[0].payload.action, action);
    assert.equal(database.state.audits.length, 1);
  }
});

test("OV-P0-280A: rejeita grupo livre, nota vazia/HTML e hold não homologado", async () => {
  for (const [action, payload, expected] of [
    ["servicenow.assign_group", { target_group: "f".repeat(32) }, "invalid_target_group"],
    ["servicenow.work_note", { work_note: "   " }, "invalid_work_note"],
    ["servicenow.work_note", { work_note: "<b>não</b>" }, "invalid_work_note"],
    ["servicenow.hold", { hold_reason: "Aguardando Fornecedor" }, "invalid_hold_reason"],
  ]) {
    const database = fakeDatabase(); const res = response();
    await handler(database)(request({ body: { action, incident_number: NUMBER, payload, idempotencyKey: `invalid-action-${Math.random().toString(16).slice(2, 12)}` } }), res);
    assert.equal(res.statusCode, 400); assert.equal(res.body.error, expected); assert.equal(database.state.outboxes.length, 0);
  }
});

test("OV-P0-280A: idempotência retorna registro existente e status não vaza stack", async () => {
  const database = fakeDatabase(); const actionHandler = handler(database);
  const first = response(); const second = response();
  const req = request({ body: { action: "servicenow.work_note", incident_number: NUMBER, payload: { work_note: "conteúdo sensível" }, idempotencyKey: "same-action-key-001" } });
  await actionHandler(req, first); await actionHandler(req, second);
  assert.equal(first.statusCode, 202); assert.equal(second.statusCode, 200); assert.equal(second.body.idempotent, true);
  assert.equal(database.state.outboxes.length, 1); assert.doesNotMatch(JSON.stringify(database.state.audits), /conteúdo sensível/);

  database.state.outboxes[0].status = "failed"; database.state.outboxes[0].last_error = "safe_worker_error";
  const status = response();
  await actionHandler(request({ method: "GET", query: { sysId: SYS_ID, outbox_id: first.body.action_id }, body: {} }), status);
  assert.equal(status.statusCode, 200); assert.equal(status.body.status, "failed"); assert.equal(status.body.error_code, "safe_worker_error");
});

test("OV-P0-280A: config is fail-closed and no Vercel-to-ServiceNow client exists", () => {
  const config = getServiceNowActionsConfig({ ONEVIEW_SERVICENOW_ACTIONS_ENABLED: "true", ONEVIEW_SERVICENOW_ASSIGNABLE_GROUPS: "noc-primary", ONEVIEW_SERVICENOW_HOLD_REASONS: "vendor_wait_audited_value" });
  assert.equal(config.requestEnabled, true); assert.deepEqual(config.assignableGroups, ["noc-primary"]);
  assert.equal(getServiceNowActionsConfig({}).requestEnabled, false);
  const source = fs.readFileSync(fileURLToPath(new URL("../api/_lib/oneview-servicenow-actions.js", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|axios|SERVICENOW_(?:USERNAME|PASSWORD)|Basic\s+/i);
});

test("OV-P0-280A: drawer uses only the authenticated OneView BFF and presents all P0 actions", () => {
  const page = fs.readFileSync(fileURLToPath(new URL("../src/pages/Chamados.tsx", import.meta.url)), "utf8");
  const api = fs.readFileSync(fileURLToPath(new URL("../src/lib/oneview-api.ts", import.meta.url)), "utf8");
  assert.match(page, /Assumir/);
  assert.match(page, /Atribuir grupo/);
  assert.match(page, /Adicionar nota/);
  assert.match(page, /Colocar em espera/);
  assert.match(page, /Solicitação enviada — aguardando Worker/);
  assert.match(api, /\/oneview\/incidents\/\$\{encodeURIComponent\(sysId\)\}\/actions/);
  assert.doesNotMatch(api, /service-now\.com|SERVICENOW_(?:USERNAME|PASSWORD)|Basic\s+/i);
});

test("OV-P0-280A: Vercel dynamic route resolves the action handler", () => {
  assert.equal(typeof routeHandler, "function");
});
