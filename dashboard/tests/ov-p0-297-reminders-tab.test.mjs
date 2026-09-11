import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOperatorReminderFeedHandler } from "../api/_lib/oneview-operator-reminders.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const actor = { id: "analyst-1", name: "Ana Analista", email: "ana@teletex.com" };
const response = () => ({ statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } });
const request = (method = "GET", query = {}) => ({ method, query, headers: {}, socket: {} });

function row(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    circuit_key: "ds-1:havan-host:meraki:143-marilia:wan1",
    data_source_id: "ds-1",
    source_host_id: "havan-host",
    scheduled_for: "2026-09-04T15:00:00.000Z",
    status: "scheduled",
    created_by: actor.id,
    created_by_name: actor.name,
    initial_alert_id: "alert-1",
    initial_incident_sys_id: "incident-1",
    initial_incident_number: "INC0081617",
    context_snapshot: {},
    created_at: NOW,
    updated_at: NOW,
    cancelled_at: null,
    ...overrides,
  };
}

function feedDatabase(rows) {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/from operator_reminders/i.test(sql)) {
        return { rows: rows.filter((item) => values[0].includes(item.status)) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { queries, query: async (work) => work(client) };
}

const otherRow = row({ id: "22222222-2222-4222-8222-222222222222", created_by: "analyst-2", created_by_name: "Bruno Operador", circuit_key: "ds-1:other-host:meraki:vilhena:wan2" });

test("OV-P0-297 feed lists active reminders across circuits with ownership resolved server side", async () => {
  const db = feedDatabase([row(), otherRow, row({ id: "33333333-3333-4333-8333-333333333333", status: "cancelled" })]);
  const route = createOperatorReminderFeedHandler({
    authorize: async () => actor,
    query: db.query,
    logger: () => undefined,
    now: () => NOW,
  });

  const res = response();
  await route(request("GET"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((item) => item.mine), [true, false]);
  assert.deepEqual(res.body.counts, { all: 2, mine: 1 });
  assert.equal(res.body.items[0].created_by_name, actor.name);
  // Cross-circuit feed must never broadcast another operator's Entra oid.
  assert.equal(res.body.items.some((item) => "created_by" in item), false);
  assert.doesNotMatch(JSON.stringify(res.body), /analyst-1|analyst-2/);
  const [{ values }] = db.queries;
  assert.deepEqual(values[0], ["scheduled", "processing"]);
  assert.equal(values[1], 200);
});

test("OV-P0-297 feed is GET only, honours scope=mine and rejects unknown scopes", async () => {
  const db = feedDatabase([row(), otherRow]);
  const route = createOperatorReminderFeedHandler({ authorize: async () => actor, query: db.query, logger: () => undefined, now: () => NOW });

  const mine = response();
  await route(request("GET", { scope: "mine" }), mine);
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.body.items.map((item) => item.mine), [true]);
  assert.deepEqual(mine.body.counts, { all: 2, mine: 1 });

  const invalid = response();
  await route(request("GET", { scope: "everyone" }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, "invalid_query");

  const posted = response();
  await route(request("POST"), posted);
  assert.equal(posted.statusCode, 405);
});

test("OV-P0-297 feed failure stays sanitized and classified", async () => {
  const logs = [];
  const route = createOperatorReminderFeedHandler({
    authorize: async () => actor,
    query: async () => {
      const error = new Error("secret database detail");
      error.code = "actions_database_not_configured";
      throw error;
    },
    logger: (entry) => logs.push(entry),
    now: () => NOW,
  });

  const res = response();
  await route(request("GET"), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "actions_database_not_configured");
  assert.deepEqual(logs, [{
    event: "oneview_reminder_request",
    route: "/api/oneview/reminders",
    method: "GET",
    operation: "feed",
    status: 503,
    error_code: "actions_database_not_configured",
    cause: "missing_env",
    duration_ms: logs[0].duration_ms,
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /secret|ana@|analyst-1/i);
});

test("OV-P0-297 feed reads with the viewer role, like every other OneView list", async () => {
  const source = await readFile(new URL("../api/_lib/oneview-operator-reminders.js", import.meta.url), "utf8");
  const factory = source.match(/export function createOperatorReminderFeedHandler\(\{[\s\S]*?\n\} = \{\}\)/)?.[0] || "";
  assert.match(factory, /authorize = \(req, res\) => requireOneViewAuth\(req, res, "viewer"\)/);
});

test("OV-P0-297 reminder snapshot carries the SD-WAN member so the card can label the circuit", async () => {
  const source = await readFile(new URL("../api/_lib/oneview-operator-reminders.js", import.meta.url), "utf8");
  const snapshot = source.match(/function snapshot\(link\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(snapshot, /member_key: link\.member_key \|\| null/);
  assert.match(snapshot, /uplink_key: link\.uplink_key \|\| null/);
});

test("OV-P0-297 links page exposes a reminders tab with Todos and Criados por mim", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../api/oneview/reminders.js", import.meta.url), "utf8");

  assert.match(route, /operatorReminderFeed as default/);
  assert.match(page, /view === "reminders" \? <OperatorRemindersPanel \/>/);
  assert.match(page, /Todos \(\$\{counts\.all\}\)/);
  assert.match(page, /Criados por mim \(\$\{counts\.mine\}\)/);
  // "Para mim" is intentionally absent: operator_reminders stores no assignee, only the creator.
  assert.doesNotMatch(page, /Para mim/);
});

test("OV-P0-297 reminder card shows the scheduled slot, circuit, INC and owner-only actions", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  const card = page.match(/function ReminderFeedCard\(\{[\s\S]*?\n\}\n/)?.[0] || "";

  assert.match(card, /reminderFeedTime\(item\.scheduled_for\)/);
  assert.match(card, /snapshotText\(snapshot, "customer", "name"\)/);
  assert.match(card, /snapshotText\(snapshot, "circuit", "host_name"\)/);
  assert.match(card, /member \? `member \$\{member\}`/);
  assert.match(card, /item\.initial_incident_number/);
  assert.match(card, /Criado por \{text\(item\.created_by_name/);
  // Mutations are owner-scoped in the BFF, so a foreign reminder must not offer the actions.
  assert.match(card, /item\.mine \? \([\s\S]*?Alterar[\s\S]*?Cancelar/);
  // No assignee column exists, so the card must not invent a "Responsável" line.
  assert.doesNotMatch(card, /Respons[áa]vel/);
});

test("OV-P0-297 reminders tab reuses the circuit mutation contract and refreshes after each change", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  const panel = page.match(/function OperatorRemindersPanel\(\) \{[\s\S]*?\n\}\n/)?.[0] || "";

  assert.match(panel, /updateOperatorReminder\(operatorReminderIdentity\(item\), item\.id/);
  assert.match(panel, /cancelOperatorReminder\(operatorReminderIdentity\(item\), item\.id\)/);
  assert.match(panel, /reminderMutationError\(cause, "alterar"\)/);
  assert.match(panel, /reminderMutationError\(cause, "cancelar"\)/);
  assert.doesNotMatch(panel, /Dados temporariamente indispon/);
});
