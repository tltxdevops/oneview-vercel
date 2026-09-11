import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOperatorReminderFeedHandler } from "../api/_lib/oneview-operator-reminders.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const actor = { id: "analyst-1", name: "Ana Analista" };
const response = () => ({ statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } });
const request = (query = {}) => ({ method: "GET", query, headers: {}, socket: {} });

function row(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    circuit_key: "ds-1:havan-host:meraki:143-marilia:wan1", data_source_id: "ds-1", source_host_id: "havan-host",
    scheduled_for: "2026-09-11T15:00:00.000Z", status: "scheduled", created_by: actor.id, created_by_name: actor.name,
    initial_alert_id: "alert-1", initial_incident_sys_id: "incident-1", initial_incident_number: "INC0081617",
    context_snapshot: { customer: { name: "Havan" }, circuit: { host_name: "143 - Marília" }, link: { service_name: "wan1", uplink_key: "wan1" }, alert: { severity: "high" }, incident: { number: "INC0081617", state: "2" } },
    created_at: NOW, updated_at: NOW, sent_at: null, cancelled_at: null, skipped_at: null, skip_reason: null, last_error: null,
    ...overrides,
  };
}

function feedDatabase(rows) {
  const queries = [];
  const client = { async query(sql, values = []) {
    queries.push({ sql, values });
    if (/select r\.status, count/i.test(sql)) {
      return { rows: [...new Set(rows.map((item) => item.status))].map((status) => {
        const statusRows = rows.filter((item) => item.status === status);
        return { status, count: statusRows.length, mine_count: statusRows.filter((item) => item.created_by === actor.id).length, recent_sent_count: status === "sent" ? statusRows.length : 0 };
      }) };
    }
    if (/group by value/i.test(sql)) return { rows: [{ value: "Havan", count: rows.length }] };
    if (/from operator_reminders/i.test(sql)) {
      const statuses = values.find(Array.isArray) || [];
      const filtered = rows.filter((item) => statuses.includes(item.status));
      return { rows: filtered.map((item) => ({ ...item, activity_at: item.sent_at || item.skipped_at || item.cancelled_at || item.updated_at || item.scheduled_for, total_items: filtered.length })) };
    }
    throw new Error(`unexpected query: ${sql}`);
  } };
  return { queries, query: async (work) => work(client) };
}

test("OV-P0-297 default feed retains scheduled and processing while history remains counted", async () => {
  const rows = [row(), row({ id: "22222222-2222-4222-8222-222222222222", status: "processing" }), row({ id: "33333333-3333-4333-8333-333333333333", status: "sent", sent_at: NOW }), row({ id: "44444444-4444-4444-8444-444444444444", status: "cancelled", cancelled_at: NOW })];
  const db = feedDatabase(rows);
  const route = createOperatorReminderFeedHandler({ authorize: async () => actor, query: db.query, logger: () => undefined, now: () => NOW });
  const res = response(); await route(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((item) => item.status), ["scheduled", "processing"]);
  assert.equal(res.body.counts.sent, 1);
  assert.equal(res.body.counts.cancelled, 1);
  assert.equal(res.body.counts.all, 4);
  assert.equal(res.body.items.some((item) => "created_by" in item || "last_error" in item), false);
  assert.deepEqual(db.queries.at(-1).values[0], ["scheduled", "processing"]);
});

test("OV-P0-297 historical feed validates and applies status, period, filters, order and limit server-side", async () => {
  const db = feedDatabase([row({ status: "sent", sent_at: NOW })]);
  const route = createOperatorReminderFeedHandler({ authorize: async () => actor, query: db.query, logger: () => undefined, now: () => NOW });
  const res = response();
  await route(request({ status: "sent", scope: "mine", from: "2026-09-11T08:00:00.000Z", to: "2026-09-11T12:00:00.000Z", client: "Havan", severity: "high", has_incident: "true", search: "Marília", sort: "recent", limit: "1", offset: "1" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(db.queries.at(-1).sql, /order by activity_at desc/i);
  assert.match(db.queries.at(-1).sql, /limit \$\d+ offset \$\d+/i);
  assert.ok(db.queries.at(-1).values.some((value) => value === "%Havan%"));
  assert.ok(db.queries.at(-1).values.includes("high"));
  assert.ok(db.queries.at(-1).values.includes("%Marília%"));
  assert.deepEqual(res.body.pagination, { limit: 1, offset: 1, total_items: 1, has_next: false });
  const invalid = response(); await route(request({ status: "unknown" }), invalid);
  assert.equal(invalid.statusCode, 400);
});

test("OV-P0-297 feed is read-only and keeps viewer authorization", async () => {
  const source = await readFile(new URL("../api/_lib/oneview-operator-reminders.js", import.meta.url), "utf8");
  assert.match(source, /requireOneViewAuth\(req, res, "viewer"\)/);
  assert.match(source, /if \(method !== "GET"\) return methodNotAllowed/);
  assert.match(source, /status = any\(/);
  assert.match(source, /sent_at/);
  assert.match(source, /skipped_at/);
  assert.match(source, /cancelled_at/);
  assert.match(source, /offset \$\$\{page\.values\.length \+ 2\}/);
});

test("OV-P0-297 page exposes history views, compact filters and the existing drawer", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  assert.match(page, /<OperatorRemindersPanel onOpenCircuit=\{openLink\}/);
  assert.match(page, /Agendados/); assert.match(page, /Lembrados/); assert.match(page, /Ignorados/); assert.match(page, /Falhas/); assert.match(page, /Cancelados/); assert.match(page, /Todos/);
  assert.match(page, /30m/); assert.match(page, /24h/); assert.match(page, /Personalizado/);
  assert.match(page, /ACK: filtro adiado/);
  assert.match(page, /onOpenCircuit=\{\(\) => onOpenCircuit\(reminderHistoryCircuit\(item\)\)\}/);
  assert.match(page, /item\.mine && item\.status === "scheduled"/);
  assert.match(page, /Theo acionado/);
  assert.doesNotMatch(page, /Webex entregue/);
});

test("OV-P0-297 history card never offers a false ACK state or technical failure detail", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  assert.match(page, /Falha no envio/);
  assert.match(page, /Alerta normalizou antes do horário/);
  assert.doesNotMatch(page, /last_error.*Falha no envio/);
  assert.doesNotMatch(page, /ACK:.*Reconhecido/);
});
