import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOperatorReminderHandler } from "../api/_lib/oneview-operator-reminders.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const CIRCUIT = { id: "ds-1:havan-host:meraki:143-marilia:wan1", data_source_id: "ds-1", source_host_id: "havan-host" };
const REMINDER_ID = "11111111-1111-4111-8111-111111111111";
const actor = { id: "analyst-1", name: "Ana Analista", email: "ana@teletex.com" };
const activeLink = (overrides = {}) => ({ ...CIRCUIT, circuit_key: CIRCUIT.id, active_alerts: 1, customer_key: "havan", customer_name: "Havan", host_name: "HAVAN", service_name: "wan1", link_type: "uplink", carrier_name: "Vivo", current_alert: { id: "alert-1", problem_name: "Uplink down", severity: "high" }, current_incident: { sys_id: "incident-1", number: "INC001", state: "2" }, ...overrides });
const response = () => ({ statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } });
const request = (method, body = {}, query = CIRCUIT) => ({ method, body, query, headers: {}, socket: {} });

function row(overrides = {}) {
  return {
    id: REMINDER_ID, circuit_key: CIRCUIT.id, data_source_id: CIRCUIT.data_source_id, source_host_id: CIRCUIT.source_host_id,
    scheduled_for: "2026-09-04T15:00:00.000Z", status: "scheduled", created_by: actor.id, created_by_name: actor.name,
    initial_alert_id: "alert-1", initial_incident_sys_id: "incident-1", initial_incident_number: "INC001", context_snapshot: {},
    created_at: NOW, updated_at: NOW, cancelled_at: null, ...overrides,
  };
}

function database(initial = []) {
  const rows = [...initial]; const queries = [];
  const client = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (/insert into operator_reminders/i.test(sql)) {
      const inserted = row({ id: values[0], circuit_key: values[1], data_source_id: values[2], source_host_id: values[3], scheduled_for: values[4], created_by: values[5], created_by_name: values[6], initial_alert_id: values[7], initial_incident_sys_id: values[8], initial_incident_number: values[9], context_snapshot: JSON.parse(values[10]), created_at: values[11], updated_at: values[11] });
      rows.push(inserted); return { rows: [inserted] };
    }
    if (/from operator_reminders/i.test(sql) && /for update/i.test(sql)) return { rows: rows.filter((item) => item.id === values[0] && item.circuit_key === values[1] && item.data_source_id === values[2] && item.source_host_id === values[3] && item.created_by === values[4] && item.status === "scheduled") };
    if (/from operator_reminders/i.test(sql)) return { rows: rows.filter((item) => item.circuit_key === values[0] && item.data_source_id === values[1] && item.source_host_id === values[2] && ["scheduled", "processing"].includes(item.status)) };
    if (/update operator_reminders set scheduled_for/i.test(sql)) { const item = rows.find((candidate) => candidate.id === values[2]); item.scheduled_for = values[0]; item.updated_at = values[1]; return { rows: [item] }; }
    if (/update operator_reminders set status = 'cancelled'/i.test(sql)) { const item = rows.find((candidate) => candidate.id === values[1]); item.status = "cancelled"; item.cancelled_at = values[0]; item.updated_at = values[0]; return { rows: [item] }; }
    if (/insert into audit_logs/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  return { rows, queries, transaction: async (work) => work(client) };
}

function handler({ db = database(), link = activeLink(), authorize = async () => actor } = {}) {
  return { db, handler: createOperatorReminderHandler({ authorize, transaction: db.transaction, resolveLink: async () => link, idFactory: () => REMINDER_ID, now: () => NOW }) };
}

test("OV-P0-290 creates future reminder from backend actor and snapshots a circuit with INC", async () => {
  const { db, handler: route } = handler(); const res = response();
  await route(request("POST", { scheduled_for: "2026-09-04T12:30:00-03:00", created_by: "forged" }), res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.item.created_by, actor.id); assert.equal(res.body.item.created_by_name, actor.name);
  assert.equal(res.body.item.initial_incident_number, "INC001"); assert.equal(res.body.item.scheduled_for, "2026-09-04T15:30:00.000Z");
  assert.equal(db.rows[0].context_snapshot.customer.name, "Havan");
  assert.ok(db.queries.some(({ sql }) => /REMINDER_CREATED/.test(sql) || /insert into audit_logs/i.test(sql)));
});

test("OV-P0-290 permits no-INC snapshot, rejects past time and normal circuit", async () => {
  const withoutIncident = handler({ link: activeLink({ current_incident: null }) }); const success = response();
  await withoutIncident.handler(request("POST", { scheduled_for: "2026-09-04T13:00:00Z" }), success);
  assert.equal(success.statusCode, 201); assert.equal(success.body.item.initial_incident_number, null);
  const past = response(); await withoutIncident.handler(request("POST", { scheduled_for: "2026-09-04T11:59:00Z" }), past); assert.equal(past.statusCode, 400); assert.equal(past.body.error, "invalid_scheduled_for");
  const normal = handler({ link: activeLink({ active_alerts: 0, has_active_alert: false }) }); const refused = response();
  await normal.handler(request("POST", { scheduled_for: "2026-09-04T13:00:00Z" }), refused); assert.equal(refused.statusCode, 409); assert.equal(refused.body.error, "circuit_not_active");
});

test("OV-P0-290 authenticated API scopes GET, updates schedule and cancels without physical deletion", async () => {
  const db = database([row(), row({ id: "22222222-2222-4222-8222-222222222222", circuit_key: "other-circuit" })]); const { handler: route } = handler({ db });
  const get = response(); await route(request("GET"), get); assert.equal(get.statusCode, 200); assert.deepEqual(get.body.items.map((item) => item.id), [REMINDER_ID]);
  const patch = response(); await route(request("PATCH", { reminder_id: REMINDER_ID, scheduled_for: "2026-09-04T14:00:00Z" }), patch); assert.equal(patch.statusCode, 200); assert.equal(patch.body.item.scheduled_for, "2026-09-04T14:00:00.000Z");
  const cancel = response(); await route(request("DELETE", { reminder_id: REMINDER_ID }), cancel); assert.equal(cancel.statusCode, 200); assert.equal(cancel.body.item.status, "cancelled"); assert.equal(db.rows.find((item) => item.id === REMINDER_ID).status, "cancelled");
  assert.ok(db.queries.filter(({ sql }) => /insert into audit_logs/i.test(sql)).length >= 2);
});

test("OV-P0-290 requires auth and owner for mutations", async () => {
  const unauthenticated = handler({ authorize: async () => null }); const denied = response();
  await unauthenticated.handler(request("GET"), denied); assert.equal(denied.statusCode, 0);
  const db = database([row({ created_by: "another-user" })]); const own = handler({ db }); const forbidden = response();
  await own.handler(request("DELETE", { reminder_id: REMINDER_ID }), forbidden); assert.equal(forbidden.statusCode, 404); assert.equal(forbidden.body.error, "reminder_not_found");
});

test("OV-P0-290 drawer uses persisted reminder CRUD and has no Theo/Webex behavior", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8");
  assert.match(page, /Lembrete agendado/); assert.match(page, /fetchOperatorReminders/); assert.match(page, /Criado por/);
  assert.match(api, /createOperatorReminder/); assert.match(api, /updateOperatorReminder/); assert.match(api, /cancelOperatorReminder/);
  assert.doesNotMatch(page, /Theo|Webex/);
});
