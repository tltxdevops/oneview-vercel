import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLinksHandler, fetchCanonicalLinks } from "../api/_lib/oneview-links.js";

const response = () => ({
  statusCode: 0, body: null,
  setHeader() { return this; },
  status(value) { this.statusCode = value; return this; },
  end(value) { this.body = JSON.parse(value); },
});
const operatorAlert = {
  id: "operator-alert", data_source_id: "ds-1", datasource: "teletex-http", source_host_id: "host-1", source_trigger_id: "trigger-1",
  host_name: "HAVAN", customer_key: "havan", customer_name: "Havan", item_key: "meraki.uplink.status[143 - Marilia, wan1, primary]",
  event_tags: [{ tag: "escalation", value: "operator" }, { tag: "__zbx_servicenow_number", value: "INC0012345" }], trigger_tags: [], host_tags: [], template_tags: [],
  severity: "average", status_source: "active", status_internal: "new", acknowledged_source: false, is_active: true,
};

test("OV-P0-287 ServiceNow read-model failure degrades links without fabricating zero incidents", async () => {
  const pool = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    if (/from zabbix_link_inventory l join data_sources/.test(sql)) return { rows: [] };
    if (/from alerts a join data_sources/.test(sql)) return { rows: [operatorAlert] };
    throw new Error("servicenow read model unavailable");
  } };
  const rows = await fetchCanonicalLinks({ pool });
  assert.equal(rows.integration_status.servicenow, "degraded");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].incident_correlation_status, "degraded");
  assert.equal(rows[0].incident_count, null);
  for (const key of ["inventory_query_ms", "alerts_query_ms", "servicenow_correlation_ms", "circuit_discovery_ms", "composition_ms", "total_ms"]) assert.equal(Number.isFinite(rows.timings[key]), true);

  const res = response();
  await createLinksHandler({ authorize: async () => true, list: async () => rows })({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.integration_status.servicenow, "degraded");
  assert.equal(res.body.totals.incident_links, null);
  assert.equal(res.body.items[0].incident_count, null);
});

test("OV-P0-287 Operadoras retains the last payload and serializes replacement refreshes", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  assert.match(page, /lastSuccessfulRefreshAt/);
  assert.match(page, /setRefreshError\(/);
  assert.match(page, /initialError && !payload/);
  assert.match(page, /Tentar novamente/);
  assert.match(page, /integration_status\?\.servicenow === "degraded"/);
  assert.match(page, /await requestDone\.current/);
  assert.match(page, /requestVersion\.current/);
  assert.match(page, /mode === "quiet" && request\.current/);
  assert.doesNotMatch(page, /setPayload\(null\)/);
});
