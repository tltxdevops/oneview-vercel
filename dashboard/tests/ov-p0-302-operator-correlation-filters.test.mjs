import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildLinksPayload,
  correlateLinkIncidents,
  parseLinkFilters,
} from "../api/_lib/oneview-links.js";
import { buildOperationalRecurrenceReadModel } from "../api/_lib/oneview-operational-recurrence.js";

const NOW = Date.parse("2026-09-14T18:00:00.000Z");
const baseFilters = (overrides = {}) => ({
  customer: null, datasource: null, classification: null, state: null, ack: null, severity: null,
  incident: null, incident_state: null, carrier: null, search: null, tab: "all", resolved_window: "today",
  divergence: null, recurrence: null, operational_situation: null, activity_period: "all",
  sort: "recent", page: 1, page_size: 100, ...overrides,
});
const inc = (state, number, updated_at = "2026-09-14T17:00:00.000Z") => ({
  sys_id: `sys-${number}`, number, state, state_display: null, opened_at: "2026-09-14T16:00:00.000Z", updated_at,
});
const row = (id, overrides = {}) => ({
  id, data_source_id: "ds-1", source_host_id: `host-${id}`, customer_key: "cliente", customer_name: "Cliente",
  datasource: "zabbix", classification: "wan_link", carrier_name: null, service_name: id,
  resolution_status: "resolved", active_alerts: 0, unack_alerts: 0, disaster_alerts: 0, high_alerts: 0,
  average_alerts: 0, warning_alerts: 0, state: "normal", max_severity: null, incident_count: 0,
  incidents: [], current_incident: null, latest_incident: null, open_incident_count: 0,
  resolved_incident_count: 0, closed_incident_count: 0, cancelled_incident_count: 0,
  unknown_incident_count: 0, incident_correlation_status: "available",
  latest_activity_at: "2026-09-14T10:00:00.000Z", updated_at: "2026-09-14T10:00:00.000Z",
  ...overrides,
});
const withIncident = (id, state, active = true, updatedAt) => {
  const incident = inc(state, `INC00${id}`, updatedAt);
  const open = ["1", "2", "3"].includes(state);
  return row(id, {
    active_alerts: active ? 1 : 0,
    state: active ? "alert" : "normal",
    incident_count: 1,
    incidents: [incident],
    current_incident: open ? incident : null,
    latest_incident: incident,
    open_incident_count: open ? 1 : 0,
    resolved_incident_count: state === "6" ? 1 : 0,
    closed_incident_count: state === "7" ? 1 : 0,
    cancelled_incident_count: state === "8" ? 1 : 0,
  });
};

const rows = [
  row("no-inc", { active_alerts: 1, state: "alert" }),
  withIncident("new", "1"),
  withIncident("progress", "2"),
  withIncident("waiting", "3"),
  withIncident("resolved", "6"),
  withIncident("closed", "7"),
  withIncident("cancelled", "8"),
  withIncident("normalized-open", "2", false),
  withIncident("normalized-closed", "7", false),
];
const ids = (filters) => buildLinksPayload(rows, baseFilters(filters), NOW).items.map((item) => item.id).sort();

test("A/B/C/F: operational correlation filters keep monitoring and ServiceNow semantics separate", () => {
  assert.deepEqual(ids({ operational_situation: "failure_without_incident" }), ["no-inc"]);
  assert.deepEqual(ids({ operational_situation: "failure_with_open_incident" }), ["new", "progress", "waiting"]);
  assert.deepEqual(ids({ operational_situation: "failure_with_closed_incident" }), ["cancelled", "closed", "resolved"]);
  assert.deepEqual(ids({ operational_situation: "normalized_with_open_incident" }), ["normalized-open"]);
  assert.deepEqual(ids({ operational_situation: "normalized_without_open_incident" }), ["normalized-closed"]);
});

test("C/D/E/G: exact ServiceNow states and divergence states remain specific", () => {
  for (const [state, expected] of [["1", ["new"]], ["2", ["normalized-open", "progress"]], ["3", ["waiting"]], ["6", ["resolved"]], ["7", ["closed", "normalized-closed"]], ["8", ["cancelled"]]]) {
    assert.deepEqual(ids({ incident_state: state }), expected);
  }
  const payload = buildLinksPayload(rows, baseFilters(), NOW);
  for (const id of ["resolved", "closed", "cancelled"]) {
    assert.equal(payload.items.find((item) => item.id === id).divergence_type, "a");
  }
  assert.equal(payload.items.find((item) => item.id === "normalized-open").divergence_type, "b");
});

test("unknown ServiceNow state is neither a divergence nor an inferred operational situation", () => {
  const unknown = withIncident("unknown", "5");
  const item = buildLinksPayload([unknown], baseFilters(), NOW).items[0];
  assert.equal(item.servicenow_state, "unknown");
  assert.equal(item.divergence_type, null);
  assert.equal(item.operational_situation, null);
});

test("H: 4h activity uses existing alert or incident timestamps", () => {
  const recentIncident = withIncident("recent-incident", "2", true, "2026-09-14T17:30:00.000Z");
  const old = row("old", { latest_activity_at: "2026-09-14T10:00:00.000Z" });
  const payload = buildLinksPayload([recentIncident, old], baseFilters({ activity_period: "4h" }), NOW);
  assert.deepEqual(payload.items.map((item) => item.id), ["recent-incident"]);
  assert.equal(payload.items[0].last_operational_activity_at, "2026-09-14T17:30:00.000Z");
});

function alert(id, started, resolved, incidentNumber = null) {
  return {
    id, data_source_id: "ds-1", source_host_id: "same-host", source_trigger_id: "trigger-1",
    first_seen_at: started, resolved_at: resolved,
    event_tags: incidentNumber ? [{ tag: "__zbx_servicenow_number", value: incidentNumber }] : [],
    trigger_tags: [], host_tags: [], template_tags: [],
  };
}

test("I/J/K: episodes receive only explicit, unambiguous INC correlation; hostname never correlates", () => {
  const tagged = alert("tagged", "2026-09-14T12:00:00.000Z", "2026-09-14T12:10:00.000Z", "INC0083313");
  const untagged = alert("untagged", "2026-09-14T13:00:00.000Z", null);
  const incidents = [inc("3", "INC0083313"), { ...inc("6", "INC0099999"), u_hostname_zabbix: "same-host" }];
  const matches = correlateLinkIncidents([tagged, untagged], incidents);
  const model = buildOperationalRecurrenceReadModel({ alerts: [tagged, untagged], now: new Date(NOW), recentLimit: 5, incidentMatches: matches });
  assert.equal(model.recent_episodes[1].incident_number, "INC0083313");
  assert.equal(model.recent_episodes[1].incident_state, "3");
  assert.equal(model.recent_episodes[0].incident_number, null);
  assert.deepEqual(matches.get("untagged"), []);
});

test("ambiguous explicit episode correlation fails closed", () => {
  const first = alert("alias-a", "2026-09-14T12:00:00.000Z", "2026-09-14T12:10:00.000Z", "INC0000001");
  const alias = alert("alias-b", "2026-09-14T12:05:00.000Z", "2026-09-14T12:15:00.000Z", "INC0000002");
  const incidents = [inc("2", "INC0000001"), inc("2", "INC0000002")];
  const model = buildOperationalRecurrenceReadModel({ alerts: [first, alias], now: new Date(NOW), recentLimit: 5, incidentMatches: correlateLinkIncidents([first, alias], incidents) });
  assert.equal(model.recent_episodes[0].incident_number, null);
});

test("parser and UI expose card filters; recurrence correlation remains query-free", async () => {
  const parsed = parseLinkFilters({ query: { incident_state: "3", operational_situation: "failure_with_open_incident", activity_period: "4h" } });
  assert.equal(parsed.incident_state, "3");
  assert.equal(parsed.operational_situation, "failure_with_open_incident");
  assert.equal(parsed.activity_period, "4h");
  assert.throws(() => parseLinkFilters({ query: { incident_state: "5" } }), /invalid_query/);

  const [page, links, recurrence] = await Promise.all([
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-links.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-operational-recurrence.js", import.meta.url), "utf8"),
  ]);
  for (const label of ["Status do chamado", "Situação operacional", "Última atividade", "Somente divergências", "Sem chamado correlacionado"]) assert.match(page, new RegExp(label));
  assert.doesNotMatch(recurrence, /pool\.query|getOneViewDbPool|host_name|hostname/i);
  assert.equal((links.match(/from servicenow_incidents/g) || []).length, 1);
  assert.match(links, /const incidentMatches = correlateLinkIncidents\(alerts, incidents\)/);
});
