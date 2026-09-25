import assert from "node:assert/strict";
import test from "node:test";
import { composeHostRegistryLinks, fetchCanonicalLinks } from "../api/_lib/oneview-links.js";

const inventory = (overrides = {}) => ({
  id: "registry-1", data_source_id: "ds-1", source_host_id: "host-1", datasource: "teletex-http",
  customer_key: "sanepar", customer_name: "Sanepar", host_name: "Router SD-WAN", service_name: "Router SD-WAN",
  classification: "wan_link", classification_source: "host_registry", classification_confidence: "high",
  carrier_name: null, carrier_source: null, updated_at: "2026-09-25T10:00:00.000Z",
  ...overrides,
});

const alert = (overrides = {}) => ({
  id: "alert-1", data_source_id: "ds-1", source_host_id: "host-1", source_trigger_id: "trigger-1",
  customer_key: "sanepar", customer_name: "Sanepar", item_key: "meraki.uplink.status[wan1]",
  severity: "high", status_source: "active", status_internal: "new", acknowledged_source: false,
  first_seen_at: "2026-09-25T10:00:00.000Z", last_seen_at: "2026-09-25T10:01:00.000Z",
  event_tags: [], trigger_tags: [], host_tags: [], template_tags: [], ...overrides,
});

test("OV-P0-321: inventory link survives missing alerts; unrelated host telemetry cannot fail it", () => {
  const noAlert = composeHostRegistryLinks({ inventoryRows: [inventory()], alertRows: [] });
  assert.equal(noAlert.length, 1);
  assert.equal(noAlert[0].state, "normal");

  const [unrelated] = composeHostRegistryLinks({
    inventoryRows: [inventory()],
    alertRows: [alert({ item_key: "system.cpu.load[percpu,avg1]", problem_name: "CPU alta" })],
  });
  assert.equal(unrelated.active_alerts, 0);
  assert.equal(unrelated.state, "normal");

  const [related] = composeHostRegistryLinks({ inventoryRows: [inventory()], alertRows: [alert()] });
  assert.equal(related.active_alerts, 1);
  assert.equal(related.state, "alert");
});

test("OV-P0-321: operator escalation and carrier evidence are preserved without inventing unknown carriers", () => {
  const [identified] = composeHostRegistryLinks({
    inventoryRows: [inventory()],
    alertRows: [alert({ event_tags: [{ tag: "escalation", value: "operator" }, { tag: "carrier", value: "Claro" }] })],
  });
  assert.equal(identified.operator_escalation, true);
  assert.equal(identified.carrier_name, "Claro");
  assert.equal(identified.carrier_source, "alert_tag");
  assert.equal(identified.carrier_status, "identified");

  const [unknown] = composeHostRegistryLinks({
    inventoryRows: [inventory({ carrier_name: "Algar", carrier_source: "legacy_inventory" })],
    alertRows: [alert({ event_tags: [{ tag: "escalation", value: "operator" }, { tag: "provider", value: "Acme Telecom" }], item_key: "custom.link.status" })],
  });
  assert.equal(unknown.operator_escalation, true);
  assert.equal(unknown.carrier_name, null);
  assert.equal(unknown.carrier_status, "unknown");

});

test("OV-P0-321: list alert reads are set-based and constrained to canonical inventory host pairs", async () => {
  const queries = [];
  const pool = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    queries.push(input);
    if (/from zabbix_host_inventory h/i.test(sql)) return { rows: [inventory()] };
    if (/from unnest\(\$1::varchar\[\], \$2::text\[\]\) as pairs/i.test(sql)) return { rows: [alert()] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const rows = await fetchCanonicalLinks({ pool });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active_alerts, 1);
  const alertReads = queries.filter((item) => /from unnest\(\$1::varchar\[\], \$2::text\[\]\) as pairs/i.test(typeof item === "string" ? item : item.text));
  assert.equal(alertReads.length, 2);
  for (const query of alertReads) {
    assert.deepEqual(query.values, [["ds-1"], ["host-1"]]);
    assert.match(query.text, /candidate_alerts as materialized[\s\S]*source_host_id=any\(\$2::text\[\]\)/i);
  }
  assert.ok(alertReads.some((query) => /escalation/i.test(query.text)));
  assert.equal(new Set(rows.map((row) => `${row.data_source_id}:${row.source_host_id}`)).size, rows.length);
});
