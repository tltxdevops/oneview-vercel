import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildLegacyAlertsScope } from "../api/alerts/index.js";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { buildOperatorQueuePayload, fetchOperatorTaggedAlerts } from "../api/_lib/oneview-operator-queue.js";

const request = (query = {}) => ({ method: "GET", query, headers: {} });
const CUSTOMER_MATRIX = [
  "ailos", "banrisul", "berneck", "bionexo", "castrolanda", "ebanx", "fps", "fraport for",
  "fraport poa", "grupo marista", "havan", "jfsc", "j.macedo", "nissan", "prefosasco", "protege",
  "rhp", "sanepar", "saque e pague", "teletex", "tigre", "tjrs", "triunfante", "tuper", "unicap", "zurich",
];

test("OV-P0-285A: legacy /api/alerts applies customer identity and datasource as an intersection", () => {
  const scope = buildLegacyAlertsScope({ customer: "castrolanda", datasource: "teletex-http" });
  assert.deepEqual(scope.customers, ["castrolanda"]);
  assert.deepEqual(scope.datasources, ["teletex-http"]);
  assert.match(scope.where.join(" "), /lower\(btrim\(a\.customer_name\)\)/);
  assert.equal(scope.values.length, 3);
  assert.deepEqual(scope.values[1], ["castrolanda"]);
  assert.deepEqual(scope.values[2], ["teletex-http"]);
});

test("OV-P0-285A: legacy SQL declares the canonical customer alias in count and page queries", async () => {
  const source = await readFile(new URL("../api/alerts/index.js", import.meta.url), "utf8");
  assert.match(source, /count\(\*\)::int as total from alerts a \$\{whereSql\}/);
  assert.match(source, /select \$\{ALERT_FIELDS\}[\s\S]*from alerts a[\s\S]*\$\{whereSql\}/);
});

test("OV-P0-285A: customer=castrolanda remains customer identity, never datasource", () => {
  const scope = buildLegacyAlertsScope({ customer: "castrolanda" });
  assert.deepEqual(scope.customers, ["castrolanda"]);
  assert.deepEqual(scope.datasources, []);
  const bff = buildAlertListQuery(request({ customer: "castrolanda", datasource: "teletex-http" }));
  assert.deepEqual(bff.filters.customers, ["castrolanda"]);
  assert.deepEqual(bff.filters.datasources, ["teletex-http"]);
});

test("OV-P0-285A: alerts truth is aggregate-based; page size is independent from total", () => {
  const query = buildAlertListQuery(request({ customer: "ailos", page: "6", page_size: "100" }));
  assert.equal(query.offset, 500);
  assert.equal(query.pageSize, 100);
  assert.match(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
});

test("OV-P0-285A: 26-customer matrix keeps each customer parameter on canonical identity", () => {
  assert.equal(CUSTOMER_MATRIX.length, 26);
  for (const customer of CUSTOMER_MATRIX) {
    const query = buildAlertListQuery(request({ customer, datasource: "teletex-http", status: "all", page_size: "1" }));
    assert.ok(query.filters.customers.includes(customer), customer);
    assert.ok(query.filters.datasources.includes("teletex-http"), customer);
    assert.match(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/, customer);
  }
});

test("OV-P0-285A: tagged read model has no 500-row truth cap", async () => {
  let received;
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: String(index + 1) }));
  const result = await fetchOperatorTaggedAlerts({
    pool: { query: async (query) => { received = query; return { rows }; } },
  });
  assert.equal(result.length, 501);
  assert.equal(received.values.length, 2);
  assert.doesNotMatch(received.text, /limit \$3/i);
  assert.doesNotMatch(received.text, /limit 500/i);
});

test("OV-P0-285A: customer queue pagination and facets use the complete filtered truth set", () => {
  const alert = (id, customer, datasource = "teletex-http") => ({
    id,
    customer_name: customer,
    customer_key: customer,
    datasource_name: datasource,
    event_tags: [{ tag: "operadora", value: "OPERADORA-4G" }],
    severity: "high",
    last_seen_at: `2026-09-02T00:${String(Number(id) % 60).padStart(2, "0")}:00.000Z`,
  });
  const filters = {
    tab: "all", operator_tag: null, customer: "ailos", datasource: null,
    assigned_to: null, state: null, severity: null, alert_status: "all", page: 6, page_size: 100,
  };
  const payload = buildOperatorQueuePayload([
    ...Array.from({ length: 501 }, (_, index) => alert(String(index + 1), "Ailos")),
    alert("other-customer", "RHP", "rhp"),
  ], [], filters, Date.parse("2026-09-02T01:00:00.000Z"));
  assert.equal(payload.pagination.total_items, 501);
  assert.equal(payload.items.length, 1);
  assert.deepEqual(payload.facets.customers.map((item) => item.value), ["ailos"]);
  assert.deepEqual(payload.facets.datasources.map((item) => item.value), ["teletex-http"]);
});
