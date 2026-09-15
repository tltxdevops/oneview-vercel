import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLinksPayload } from "../api/_lib/oneview-links.js";

const now = Date.parse("2026-09-04T15:00:00Z");
const filters = (overrides = {}) => ({
  customer: null, datasource: null, classification: null, state: null, ack: null, severity: null,
  incident: null, carrier: null, search: null, tab: "all", resolved_window: "today", divergence: null,
  recurrence: null, sort: "recent", page: 1, page_size: 100, ...overrides,
});
const incident = (state, number = `INC${state}`) => ({ sys_id: number, number, state, state_display: null, priority: null, assigned_to: null, assignment_group: null });
const row = (id, overrides = {}) => ({
  id, customer_key: "cliente", customer_name: "Cliente", datasource: "teletex-http", classification: "wan_link",
  carrier_name: null, service_name: id, source_host_id: id, resolution_status: "resolved", active_alerts: 0,
  unack_alerts: 0, disaster_alerts: 0, high_alerts: 0, average_alerts: 0, warning_alerts: 0, state: "normal",
  max_severity: null, incident_count: 0, incidents: [], alerts: [], latest_activity_at: "2026-09-04T14:00:00Z",
  updated_at: "2026-09-04T14:00:00Z", ...overrides,
});

const rows = [
  row("A-active-no-inc", { active_alerts: 1, state: "alert", active_since_at: "2026-09-04T12:00:00Z" }),
  row("B-active-open-inc", { active_alerts: 1, state: "alert", incidents: [incident("3", "INC0082499")], incident_count: 1 }),
  row("C-normalized-open-inc", { incidents: [incident("2", "INC0002")], incident_count: 1 }),
  row("D-active-resolved-inc", { active_alerts: 1, state: "alert", incidents: [incident("6", "INC0006")], incident_count: 1 }),
  row("D2-active-cancelled-inc", { active_alerts: 1, state: "alert", incidents: [incident("8", "INC0008")], incident_count: 1 }),
  row("E-recurrent", { active_alerts: 1, state: "alert", is_recurrent: true, occurrences_24h: 6 }),
  row("F-not-recurrent", { active_alerts: 1, state: "alert", is_recurrent: false, occurrences_24h: 1 }),
];

function ids(payload) {
  return payload.items.map((item) => item.id).sort();
}

function item(id) {
  return buildLinksPayload(rows, filters({ tab: "all" }), now).items.find((entry) => entry.id === id);
}

test("A active alert without INC is down + none", () => {
  const entry = item("A-active-no-inc");
  assert.equal(entry.monitoring_state, "down");
  assert.equal(entry.servicenow_state, "none");
  assert.deepEqual(ids(buildLinksPayload(rows, filters({ tab: "open", incident: "no" }), now)), ["A-active-no-inc", "E-recurrent", "F-not-recurrent"]);
});

test("B active alert with open INC is down + open", () => {
  const entry = item("B-active-open-inc");
  assert.equal(entry.monitoring_state, "down");
  assert.equal(entry.servicenow_state, "open");
  assert.ok(ids(buildLinksPayload(rows, filters({ tab: "open", incident: "yes" }), now)).includes("B-active-open-inc"));
});

test("C normalized alert with open INC is normalized + open and stays visible", () => {
  const entry = item("C-normalized-open-inc");
  assert.equal(entry.monitoring_state, "normalized");
  assert.equal(entry.servicenow_state, "open");
  assert.equal(entry.divergence_type, "b");
  assert.deepEqual(ids(buildLinksPayload(rows, filters({ tab: "normalized", incident: "open" }), now)), ["C-normalized-open-inc"]);
  assert.ok(ids(buildLinksPayload(rows, filters({ tab: "all", incident: "open" }), now)).includes("C-normalized-open-inc"));
});

test("D active alert with resolved or cancelled INC is down + divergence", () => {
  const resolved = item("D-active-resolved-inc");
  const cancelled = item("D2-active-cancelled-inc");
  assert.equal(resolved.monitoring_state, "down");
  assert.equal(resolved.servicenow_state, "resolved");
  assert.equal(resolved.divergence_type, "a");
  assert.equal(cancelled.monitoring_state, "down");
  assert.equal(cancelled.servicenow_state, "cancelled");
  assert.equal(cancelled.divergence_type, "a");
  assert.deepEqual(ids(buildLinksPayload(rows, filters({ tab: "open", incident: "cancelled" }), now)), ["D2-active-cancelled-inc"]);
  assert.ok(ids(buildLinksPayload(rows, filters({ divergence: "any" }), now)).includes("D-active-resolved-inc"));
  assert.ok(ids(buildLinksPayload(rows, filters({ divergence: "any" }), now)).includes("C-normalized-open-inc"));
});

test("E recurrent filter keeps occurrences_24h >= 2", () => {
  assert.deepEqual(ids(buildLinksPayload(rows, filters({ tab: "all", recurrence: "recurrent" }), now)), ["E-recurrent"]);
});

test("F non-recurrent does not appear in recurrent filter", () => {
  assert.equal(ids(buildLinksPayload(rows, filters({ tab: "all", recurrence: "recurrent" }), now)).includes("F-not-recurrent"), false);
});

test("G monitoring tabs do not rewrite ServiceNow state", () => {
  const open = buildLinksPayload(rows, filters({ tab: "open" }), now).items.find((entry) => entry.id === "B-active-open-inc");
  const all = buildLinksPayload(rows, filters({ tab: "all" }), now).items.find((entry) => entry.id === "B-active-open-inc");
  const normalizedMissing = buildLinksPayload(rows, filters({ tab: "normalized" }), now).items.find((entry) => entry.id === "B-active-open-inc");
  assert.equal(open.servicenow_state, "open");
  assert.equal(all.servicenow_state, "open");
  assert.equal(normalizedMissing, undefined);
  assert.equal(buildLinksPayload(rows, filters({ tab: "all" }), now).totals.operational.with_open_incident, 2);
  assert.equal(buildLinksPayload(rows, filters({ tab: "all" }), now).totals.operational.without_incident, 3);
});

test("Operadoras navigation separates monitoring tabs from INC and recurrence filters", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  const links = await readFile(new URL("../api/_lib/oneview-links.js", import.meta.url), "utf8");
  assert.match(page, /\["open", "Em falha"\]/);
  assert.match(page, /\["normalized", "Normalizados"\]/);
  assert.match(page, /Filtro de chamado/);
  assert.match(page, /Filtro de recorrência/);
  assert.match(page, /\{ value: "1", label: "Novo" \}/);
  assert.match(page, /\{ value: "3", label: "Em espera" \}/);
  assert.match(page, /\{ value: "6", label: "Resolvido" \}/);
  assert.match(page, /\{ value: "8", label: "Cancelado" \}/);
  assert.match(page, /function divergenceLabel/);
  assert.match(page, /Alerta ativo com chamado \$\{state\}/);
  assert.match(page, /Normalizado com chamado \$\{state\}/);
  assert.doesNotMatch(page, /return `[^`]*chamado encerrado/i);
  assert.match(links, /monitoring_state: row\.monitoring_state, servicenow_state: row\.servicenow_state, divergence_type: row\.divergence_type/);
  assert.doesNotMatch(page, /Resolvidos hoje/);
  assert.doesNotMatch(links, /pool\.query\(\s*\{[^}]*servicenow_incidents[^}]*\}\s*\)\s*;\s*\n\s*for \(const row/);
});
