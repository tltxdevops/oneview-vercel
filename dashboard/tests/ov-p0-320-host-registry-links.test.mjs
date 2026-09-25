import assert from "node:assert/strict";
import test from "node:test";
import { composeHostRegistryLinks } from "../api/_lib/oneview-links.js";

const registry = (overrides = {}) => ({
  id: "registry-host-1",
  data_source_id: "source-1",
  source_host_id: "host-1",
  datasource: "teletex-http",
  customer_key: "sanepar",
  customer_name: "Sanepar",
  host_name: "Sanepar - SDWAN",
  service_name: "Sanepar - SDWAN",
  classification: null,
  classification_source: null,
  classification_confidence: null,
  carrier_name: null,
  carrier_source: null,
  updated_at: "2026-09-25T00:00:00.000Z",
  ...overrides,
});

const alert = (overrides = {}) => ({
  id: "alert-1",
  data_source_id: "source-1",
  source_host_id: "host-1",
  source_trigger_id: "trigger-1",
  customer_key: "sanepar",
  customer_name: "Sanepar",
  item_key: "sdwan.tunel.classe[10.0.41.13,mpls]",
  severity: "high",
  status_source: "active",
  status_internal: "new",
  first_seen_at: "2026-09-25T00:00:00.000Z",
  last_seen_at: "2026-09-25T00:01:00.000Z",
  ...overrides,
});

test("OV-P0-320: fresh host registry is canonical, one row per datasource and host", () => {
  const rows = composeHostRegistryLinks({
    inventoryRows: [
      registry({ id: "old-host-row", updated_at: "2026-09-24T00:00:00.000Z" }),
      registry({ id: "current-host-row" }),
    ],
    alertRows: [alert(), alert({ id: "alert-2", source_trigger_id: "trigger-2" })],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "current-host-row");
  assert.equal(rows[0].active_alerts, 2);
  assert.equal(rows[0].classification, "sdwan");
  assert.equal(rows[0].classification_source, "host_registry_signal");
});

test("OV-P0-320: absent host registry never exposes a stale legacy link", () => {
  const rows = composeHostRegistryLinks({ inventoryRows: [], alertRows: [alert()] });
  assert.deepEqual(rows, []);
});

test("OV-P0-320: enabled Sanepar SD-WAN inventory remains a link without alert history", () => {
  const [row] = composeHostRegistryLinks({
    inventoryRows: [registry({
      host_groups: ["Sanepar/SDWAN/Router"],
      classification: null,
    })],
    alertRows: [],
  });

  assert.equal(row.classification, "sdwan");
  assert.equal(row.classification_source, "host_registry_group");
  assert.equal(row.active_alerts, 0);
  assert.equal(row.state, "normal");
});

test("OV-P0-320: current registry preserves complementary inventory classification and carrier", () => {
  const [row] = composeHostRegistryLinks({
    inventoryRows: [registry({
      customer_key: "tuper",
      customer_name: "Tuper",
      classification: "wan_link",
      classification_source: "legacy_inventory",
      classification_confidence: "high",
      carrier_name: "Algar",
      carrier_source: "legacy_inventory",
    })],
    alertRows: [],
  });

  assert.equal(row.classification, "wan_link");
  assert.equal(row.carrier_name, "Algar");
  assert.equal(row.active_alerts, 0);
});
