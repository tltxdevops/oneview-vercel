import test from "node:test";
import assert from "node:assert/strict";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import { buildGlobalHistoryScopeClauses } from "../api/_lib/oneview-db.js";
import { buildLinksPayload, parseLinkFilters } from "../api/_lib/oneview-links.js";

test("OV-P0-323 incident origin keeps caller-only manual/automatic classification", () => {
  assert.equal(parseIncidentFilters({ query: { assignment_group: "N1 - Servicos" } }).assignment_group, "N1 - Servicos");
  assert.equal(parseIncidentFilters({ query: { origin: "manual" } }).origin, "manual");
  assert.equal(parseIncidentFilters({ query: { origin: "automatic" } }).origin, "automatic");
  assert.throws(() => parseIncidentFilters({ query: { origin: "contact_type" } }));
});

test("OV-P0-323 history actor is an independent structured predicate", () => {
  const result = buildGlobalHistoryScopeClauses({ query: { actor: "Ana" } }, ["zabbix"]);
  assert.match(result.clauses.join(" "), /actor_name/);
  assert.equal(result.params.at(-1), "Ana");
});

test("OV-P0-323 links filter operator escalation and known or unknown carrier in memory", () => {
  assert.equal(parseLinkFilters({ query: { operator_escalation: "yes", carrier: "vivo" } }).operator_escalation, "yes");
  const rows = [
    { id: "a", customer_name: "A", state: "normal", carrier_name: "Vivo", operator_escalation: true, resolution_status: "resolved", active_alerts: 0, incidents: [] },
    { id: "b", customer_name: "B", state: "normal", carrier_name: null, operator_escalation: true, resolution_status: "resolved", active_alerts: 0, incidents: [] },
    { id: "c", customer_name: "C", state: "normal", carrier_name: null, operator_escalation: false, resolution_status: "resolved", active_alerts: 0, incidents: [] },
  ];
  const defaults = { tab: "all", resolved_window: "today", sort: "recent", page: 1, page_size: 50 };
  assert.equal(buildLinksPayload(rows, { ...defaults, operator_escalation: "yes" }).pagination.total_items, 2);
  assert.equal(buildLinksPayload(rows, { ...defaults, carrier: "unknown" }).pagination.total_items, 2);
  assert.equal(buildLinksPayload(rows, { ...defaults, carrier: "vivo" }).pagination.total_items, 1);
});
