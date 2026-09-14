import test from "node:test";
import assert from "node:assert/strict";
import { buildLinksPayload, classifyLinkIncidentState, parseLinkFilters } from "../api/_lib/oneview-links.js";

const now = Date.parse("2026-09-04T15:00:00Z");
const filters = (overrides = {}) => ({
  customer: null, datasource: null, classification: null, state: null, ack: null, severity: null,
  incident: null, carrier: null, search: null, tab: "all", resolved_window: "today", divergence: null,
  sort: "recent", page: 1, page_size: 100, ...overrides,
});
const incident = (state, number = `INC${state}`) => ({ sys_id: number, number, state, state_display: null, priority: null, assigned_to: null, assignment_group: null });
const row = (id, overrides = {}) => ({
  id, customer_key: "cliente", customer_name: "Cliente", datasource: "teletex-http", classification: "wan_link",
  carrier_name: null, service_name: id, source_host_id: id, resolution_status: "resolved", active_alerts: 0,
  unack_alerts: 0, disaster_alerts: 0, high_alerts: 0, average_alerts: 0, warning_alerts: 0, state: "normal",
  max_severity: null, incident_count: 0, incidents: [], alerts: [], latest_activity_at: "2026-09-04T14:00:00Z",
  updated_at: "2026-09-04T14:00:00Z", ...overrides,
});

test("OV-P0-286 explicit ServiceNow states are classified without incident_count semantics", () => {
  assert.equal(classifyLinkIncidentState(incident("1")), "open");
  assert.equal(classifyLinkIncidentState(incident("2")), "open");
  assert.equal(classifyLinkIncidentState(incident("3")), "open");
  assert.equal(classifyLinkIncidentState(incident("6")), "resolved");
  assert.equal(classifyLinkIncidentState(incident("7")), "closed");
  assert.equal(classifyLinkIncidentState(incident("8")), "cancelled");
  assert.equal(classifyLinkIncidentState(incident("99")), "unknown");
});

test("OV-P0-286 monitoring tabs stay independent from ServiceNow filters", () => {
  const rows = [
    row("active-no-inc", { active_alerts: 1, state: "alert", active_since_at: "2026-09-04T12:00:00Z" }),
    row("active-open-inc", { active_alerts: 1, state: "alert", incidents: [incident("2")], incident_count: 1 }),
    row("active-history-only", { active_alerts: 1, state: "alert", incidents: [incident("7")], incident_count: 1 }),
    row("normalized", { resolved_at: "2026-09-04T13:00:00Z" }),
  ];
  assert.deepEqual(buildLinksPayload(rows, filters({ tab: "open" }), now).items.map((item) => item.id).sort(), ["active-history-only", "active-no-inc", "active-open-inc"]);
  assert.deepEqual(buildLinksPayload(rows, filters({ tab: "normalized" }), now).items.map((item) => item.id), ["normalized"]);
  assert.equal(buildLinksPayload(rows, filters({ tab: "all" }), now).pagination.total_items, 4);
  assert.deepEqual(buildLinksPayload(rows, filters({ tab: "open", incident: "no" }), now).items.map((item) => item.id), ["active-no-inc"]);
  assert.deepEqual(buildLinksPayload(rows, filters({ tab: "open", incident: "yes" }), now).items.map((item) => item.id).sort(), ["active-history-only", "active-open-inc"]);
  const openTab = buildLinksPayload(rows, filters({ tab: "open" }), now).items.find((item) => item.id === "active-open-inc");
  const allTab = buildLinksPayload(rows, filters({ tab: "all" }), now).items.find((item) => item.id === "active-open-inc");
  assert.equal(openTab.servicenow_state, "open");
  assert.equal(allTab.servicenow_state, "open");
  assert.equal(openTab.monitoring_state, "down");
});

test("OV-P0-286 divergences detect historical-only active alerts and inactive links with open incidents", () => {
  const rows = [
    row("a", { active_alerts: 1, state: "alert", incidents: [incident("7")], incident_count: 1 }),
    row("b", { incidents: [incident("3")], incident_count: 1 }),
    row("normal", { active_alerts: 1, state: "alert" }),
  ];
  const any = buildLinksPayload(rows, filters({ divergence: "any" }), now);
  assert.deepEqual(any.items.map((item) => item.id).sort(), ["a", "b"]);
  assert.equal(any.totals.operational.divergence_a, 1);
  assert.equal(any.totals.operational.divergence_b, 1);
});

test("OV-P0-286 parser validates queue controls and normal filters still apply", () => {
  const parsed = parseLinkFilters({ query: { tab: "normalized", resolved_window: "7d", sort: "severity", divergence: "b", customer: "Cliente", incident: "cancelled" } });
  assert.equal(parsed.tab, "normalized");
  assert.equal(parsed.incident, "cancelled");
  assert.equal(parsed.resolved_window, "7d");
  assert.equal(parsed.sort, "severity");
  assert.equal(parsed.divergence, "b");
  assert.throws(() => parseLinkFilters({ query: { tab: "invalid" } }));
});
