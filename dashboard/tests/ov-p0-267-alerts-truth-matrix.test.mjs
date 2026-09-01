import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import {
  ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES,
  splitAlertCustomerFilter,
} from "../api/_lib/oneview-scope.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.join(root, "..");

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

const OPERATIONAL = [...ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES];

test("OV-P0-267: operational customer values remap to datasource names", () => {
  for (const name of OPERATIONAL) {
    const split = splitAlertCustomerFilter([name.toUpperCase(), name]);
    assert.deepEqual(split.datasources, [name]);
    assert.deepEqual(split.customers, []);
  }
  const mixed = splitAlertCustomerFilter(["Zurich", "berneck", "unclassified", "maps"]);
  assert.deepEqual(mixed.datasources, ["zurich"]);
  assert.deepEqual(mixed.customers, ["berneck", "unclassified", "maps"]);
});

test("OV-P0-267: Maps cannot enter the operational customer remap", () => {
  const split = splitAlertCustomerFilter(["maps", "MAPS"]);
  assert.deepEqual(split.datasources, []);
  assert.deepEqual(split.customers, ["maps"]);
});

test("OV-P0-267: /alerts customer=zurich scopes d.name, not customer_name identity", () => {
  const query = buildAlertListQuery(request({
    status: "active",
    customer: "Zurich",
    first_seen_from: "2026-08-31T15:00:00.000Z",
    first_seen_to: "2026-09-01T15:00:00.000Z",
  }));
  assert.deepEqual(query.filters.customers, []);
  assert.ok(query.filters.datasources.includes("zurich"));
  assert.doesNotMatch(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
  assert.ok(query.params.some((value) => Array.isArray(value) && value.includes("zurich")));
  assert.match(query.whereSql, /d\.name = any\(\$\d+::text\[\]\)/);
});

test("OV-P0-267: real company customer filter stays on identity key", () => {
  const query = buildAlertListQuery(request({
    status: "active",
    customer: "Berneck",
  }));
  assert.deepEqual(query.filters.customers, ["berneck"]);
  assert.deepEqual(query.filters.datasources, []);
  assert.match(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
});

test("OV-P0-267: six operational sources stay in the allowlist; Maps stays out", () => {
  assert.deepEqual([...OPERATIONAL].sort(), [
    "castrolanda",
    "fraport-for",
    "fraport-poa",
    "rhp",
    "teletex-http",
    "zurich",
  ].sort());
  assert.equal(OPERATIONAL.includes("maps"), false);
});

test("OV-P0-267: Alerts Cliente combobox includes datasource facets and does not hardcode names", async () => {
  const alerts = await readFile(path.join(dashboardRoot, "src/pages/Alerts.tsx"), "utf8");
  assert.match(alerts, /facets\?\.datasources/);
  assert.match(alerts, /datasourceCards/);
  assert.doesNotMatch(alerts, /FRAPORT|Zurich|Castrolanda/);
  const scope = await readFile(path.join(dashboardRoot, "api/_lib/oneview-scope.js"), "utf8");
  assert.match(scope, /splitAlertCustomerFilter/);
  const db = await readFile(path.join(dashboardRoot, "api/_lib/oneview-db.js"), "utf8");
  assert.match(db, /splitAlertCustomerFilter\(rawCustomers/);
});

test("OV-P0-267: Cliente=fonte for all six operational sources remaps to d.name", () => {
  for (const name of OPERATIONAL) {
    const query = buildAlertListQuery(request({
      status: "active",
      customer: name,
      first_seen_from: "2026-08-31T15:00:00.000Z",
      first_seen_to: "2026-09-01T15:00:00.000Z",
    }));
    assert.equal(query.filters.customers.length, 0, name);
    assert.ok(query.filters.datasources.includes(name), name);
    assert.doesNotMatch(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
  }
});

test("OV-P0-267: status contract uses resolved_at + status_source + status_internal", () => {
  const active = buildAlertListQuery(request({ status: "active" }));
  const resolved = buildAlertListQuery(request({ status: "resolved" }));
  const all = buildAlertListQuery(request({ status: "all" }));
  assert.equal(active.filters.status, "active");
  assert.match(active.whereSql, /a\.resolved_at is null/);
  assert.match(active.whereSql, /status_source/);
  assert.match(active.whereSql, /status_internal/);
  assert.doesNotMatch(active.whereSql, /acknowledged_source.*resolved/);
  assert.equal(resolved.filters.status, "resolved");
  assert.match(resolved.whereSql, /a\.resolved_at is not null/);
  assert.equal(all.filters.status, "all");
  assert.doesNotMatch(all.whereSql, /a\.resolved_at is null/);
  const omitted = buildAlertListQuery(request({}));
  assert.equal(omitted.filters.status, "active");
});

test("OV-P0-267: ACK filter uses acknowledged_source and is not resolved", () => {
  const ack = buildAlertListQuery(request({ status: "active", acknowledged_source: "true" }));
  const pending = buildAlertListQuery(request({ status: "active", acknowledged_source: "false" }));
  assert.equal(ack.filters.acknowledgedSource, "true");
  assert.match(ack.whereSql, /coalesce\(a\.acknowledged_source, false\) = \$/);
  assert.doesNotMatch(ack.whereSql, /a\.resolved_at is not null/);
  assert.equal(pending.filters.acknowledgedSource, "false");
  const combined = buildAlertListQuery(request({ status: "active", acknowledged: "true" }));
  assert.equal(combined.filters.acknowledged, "true");
  assert.match(combined.whereSql, /acknowledged_source/);
});

test("OV-P0-267: severity values stay canonical; high family is UI expansion not BFF rewrite", () => {
  for (const severity of ["information", "warning", "average", "high", "disaster", "not_classified", "critical"]) {
    const query = buildAlertListQuery(request({ status: "active", severity }));
    assert.deepEqual(query.filters.severities, [severity]);
    assert.ok(query.params.some((value) => Array.isArray(value) && value.includes(severity)));
  }
  const highOnly = buildAlertListQuery(request({ status: "active", severity: "high" }));
  assert.deepEqual(highOnly.filters.severities, ["high"]);
  assert.equal(highOnly.filters.severities.includes("disaster"), false);
  const family = buildAlertListQuery(request({ status: "active", severity: ["high", "critical"] }));
  assert.deepEqual(family.filters.severities, ["high", "critical"]);
});

test("OV-P0-267: window filters first_seen_at with inclusive ISO bounds", () => {
  const from = "2026-08-31T15:00:00.000Z";
  const to = "2026-09-01T15:00:00.000Z";
  const query = buildAlertListQuery(request({
    status: "active",
    first_seen_from: from,
    first_seen_to: to,
  }));
  assert.equal(query.filters.firstSeenFrom, from);
  assert.equal(query.filters.firstSeenTo, to);
  assert.match(query.whereSql, /a\.first_seen_at >= \$/);
  assert.match(query.whereSql, /a\.first_seen_at <= \$/);
  const before = buildAlertListQuery(request({
    status: "active",
    first_seen_from: "2026-08-31T14:59:59.000Z",
    first_seen_to: "2026-08-31T14:59:59.000Z",
  }));
  assert.equal(before.filters.firstSeenFrom, "2026-08-31T14:59:59.000Z");
});

test("OV-P0-267: UI combinations send customer+status+window+severity+ack as BFF params", () => {
  const combos = [
    { customer: "zurich", status: "active", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { customer: "rhp", status: "all", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { customer: "teletex-http", status: "resolved", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { customer: "castrolanda", status: "active", severity: ["high", "critical"], first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { customer: "fraport-for", status: "active", severity: "average", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { customer: "fraport-poa", status: "active", acknowledged_source: "true", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { status: "active" },
  ];
  for (const combo of combos) {
    const query = buildAlertListQuery(request(combo));
    if (combo.customer) {
      assert.equal(query.filters.customers.length, 0, JSON.stringify(combo));
      assert.ok(query.filters.datasources.includes(combo.customer), JSON.stringify(combo));
    } else {
      assert.deepEqual(query.filters.datasources, []);
    }
    assert.equal(query.filters.status, combo.status);
  }
});

test("OV-P0-267: pagination stays stable with a.id tie-break and default page size 50", () => {
  const query = buildAlertListQuery(request({
    datasource: "zurich",
    status: "active",
    page: "3",
    page_size: "50",
    sort: "last_seen_at",
    order: "desc",
  }));
  assert.equal(query.page, 3);
  assert.equal(query.pageSize, 50);
  assert.equal(query.offset, 100);
  assert.match(query.orderSql, /a\.id desc/);
});

test("OV-P0-267: KPI summary high aggregates critical legado; disaster stays separate", async () => {
  const db = await readFile(path.join(dashboardRoot, "api/_lib/oneview-db.js"), "utf8");
  assert.match(db, /a\.severity in \('high', 'critical'\)\)::int as high/);
  assert.match(db, /critical legado: agregado em high somente no summary/);
  assert.match(db, /Disaster nunca entra em High/);
  const api = await readFile(path.join(dashboardRoot, "src/lib/oneview-api.ts"), "utf8");
  assert.match(api, /if \(seen\.has\("high"\)\) seen\.add\("critical"\)/);
  assert.doesNotMatch(api, /if \(seen\.has\("disaster"\)\) seen\.add\("critical"\)/);
});

test("OV-P0-267: Alerts tabs apply only the documented filters", async () => {
  const alerts = await readFile(path.join(dashboardRoot, "src/pages/Alerts.tsx"), "utf8");
  assert.match(alerts, /if \(view === "recent"\) \{[\s\S]*setDatePreset\("24h"\)/);
  assert.match(alerts, /if \(view === "open"\) \{[\s\S]*setDatePreset\("all"\)/);
  assert.match(alerts, /if \(view === "priority"\) \{[\s\S]*setSelectedSeverities\(\["disaster", "high"\]\)/);
  assert.match(alerts, /if \(view === "forgotten"\) \{[\s\S]*setSourceAckFilter\("unacknowledged"\)/);
  assert.match(alerts, /if \(view === "resolved"\) \{[\s\S]*setStatusFilter\("resolved"\)/);
  assert.match(alerts, /setDatePreset\("30d"\)/);
  assert.match(alerts, /customers: selectedCustomerKeys/);
  assert.match(alerts, /writeAlertsUrlParams/);
  assert.match(alerts, /options\?\.quiet && alertsRequestRef\.current && !alertsRequestRef\.current\.signal\.aborted/);
  assert.match(alerts, /if \(requestId !== alertsRequestIdRef\.current\) return/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(alerts, /searchParams\.get\("alert"\)/);
});

test("OV-P0-267: fetchAlerts keeps customer= for UI contract and expands high→critical", async () => {
  const api = await readFile(path.join(dashboardRoot, "src/lib/oneview-api.ts"), "utf8");
  assert.match(api, /search\.append\("customer", customer\)/);
  assert.match(api, /canonicalizeSeveritiesForApi\(params\?\.severities/);
  const query = await readFile(path.join(dashboardRoot, "src/lib/alerts-query.ts"), "utf8");
  assert.match(query, /for \(const customer of state\.customers\) next\.append\("customer", customer\)/);
  assert.doesNotMatch(query, /next\.append\("datasource"/);
});
