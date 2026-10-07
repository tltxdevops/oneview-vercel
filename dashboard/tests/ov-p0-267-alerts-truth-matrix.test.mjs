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

test("OV-P0-267: operational teletex-http customer values remap to datasource names", () => {
  const split = splitAlertCustomerFilter(["TELETEX-HTTP", "teletex-http"]);
  assert.deepEqual(split.datasources, ["teletex-http"]);
  assert.deepEqual(split.customers, []);
  const mixed = splitAlertCustomerFilter(["Zurich", "berneck", "unclassified", "maps", "teletex-http"]);
  assert.deepEqual([...mixed.datasources].sort(), ["maps", "teletex-http"].sort());
  assert.deepEqual(mixed.customers, ["zurich", "berneck", "unclassified"]);
});

test("OV-P0-267: Maps remaps to datasource (no customer_key in DB)", () => {
  const split = splitAlertCustomerFilter(["maps", "MAPS"]);
  assert.deepEqual(split.datasources, ["maps"]);
  assert.deepEqual(split.customers, []);
});

test("OV-P0-267: /alerts customer=teletex-http scopes d.name, not customer_name identity", () => {
  const query = buildAlertListQuery(request({
    status: "active",
    customer: "teletex-http",
    first_seen_from: "2026-08-31T15:00:00.000Z",
    first_seen_to: "2026-09-01T15:00:00.000Z",
  }));
  assert.deepEqual(query.filters.customers, []);
  assert.ok(query.filters.datasources.includes("teletex-http"));
  assert.doesNotMatch(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
  assert.ok(query.params.some((value) => Array.isArray(value) && value.includes("teletex-http")));
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

test("OV-P0-267: seven operational sources stay in the allowlist including Maps", () => {
  assert.deepEqual([...OPERATIONAL].sort(), [
    "castrolanda",
    "fraport-for",
    "fraport-poa",
    "maps",
    "rhp",
    "teletex-http",
    "zurich",
  ].sort());
  assert.equal(OPERATIONAL.includes("maps"), true);
});

test("OV-P0-267: Alerts keeps datasource scope in the BFF contract without the header selector", async () => {
  const alerts = await readFile(path.join(dashboardRoot, "src/pages/Alerts.tsx"), "utf8");
  assert.match(alerts, /ZabbixSourceFilter/);
  assert.match(alerts, /datasources: selectedDatasources/);
  assert.doesNotMatch(alerts, /datasourceCards/);
  assert.doesNotMatch(alerts, /FRAPORT|Zurich|Castrolanda/);
  const scope = await readFile(path.join(dashboardRoot, "api/_lib/oneview-scope.js"), "utf8");
  assert.match(scope, /splitAlertCustomerFilter/);
  const db = await readFile(path.join(dashboardRoot, "api/_lib/oneview-db.js"), "utf8");
  assert.match(db, /splitAlertCustomerFilter\(rawCustomers/);
});

test("OV-P0-267: dedicated company customer filter stays on identity key", () => {
  for (const name of ["zurich", "castrolanda", "rhp", "fraport-for", "fraport-poa"]) {
    const query = buildAlertListQuery(request({
      status: "active",
      customer: name,
      first_seen_from: "2026-08-31T15:00:00.000Z",
      first_seen_to: "2026-09-01T15:00:00.000Z",
    }));
    assert.equal(query.filters.datasources.length, 0, name);
    assert.ok(query.filters.customers.includes(name), name);
    assert.match(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
  }
});

test("OV-P0-267B: Home, Monitoramento and Alertas share explicit datasource query", async () => {
  const home = await readFile(path.join(dashboardRoot, "src/lib/oneview-home.ts"), "utf8");
  const monitoring = await readFile(path.join(dashboardRoot, "src/lib/oneview-monitoring.ts"), "utf8");
  const alerts = await readFile(path.join(dashboardRoot, "src/pages/Alerts.tsx"), "utf8");

  assert.match(home, /datasources: params\.datasources/);
  assert.match(home, /firstSeenFrom: params\.from \?\? isoAgo\(/);
  assert.match(home, /excludeOperator: true/);
  assert.match(monitoring, /customers: params\.customers/);
  assert.match(monitoring, /datasources: params\.datasources/);
  assert.match(monitoring, /firstSeenFrom: isoAgo\(params\.windowMs, now\)/);
  assert.match(alerts, /ZabbixSourceFilter/);
  assert.match(alerts, /datasources: selectedDatasources/);

  for (const datasource of OPERATIONAL) {
    for (const firstSeenFrom of [
      "2026-09-01T14:30:00.000Z",
      "2026-09-01T13:00:00.000Z",
      "2026-09-01T07:00:00.000Z",
      "2026-08-31T15:00:00.000Z",
    ]) {
      const query = buildAlertListQuery(request({
        datasource,
        status: "active",
        severity: "average",
        first_seen_from: firstSeenFrom,
      }));
      assert.deepEqual(query.filters.customers, [], `${datasource}/${firstSeenFrom}`);
      assert.ok(query.filters.datasources.includes(datasource), `${datasource}/${firstSeenFrom}`);
      assert.equal(query.filters.status, "active");
      assert.deepEqual(query.filters.severities, ["average"]);
    }
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

test("OV-P0-267: UI combinations send datasource+status+window+severity+ack as BFF params", () => {
  const combos = [
    { datasource: "zurich", status: "active", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { datasource: "rhp", status: "all", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { datasource: "teletex-http", status: "resolved", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { datasource: "castrolanda", status: "active", severity: ["high", "critical"], first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { datasource: "fraport-for", status: "active", severity: "average", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { datasource: "fraport-poa", status: "active", acknowledged_source: "true", first_seen_from: "2026-08-31T15:00:00.000Z", first_seen_to: "2026-09-01T15:00:00.000Z" },
    { status: "active" },
  ];
  for (const combo of combos) {
    const query = buildAlertListQuery(request(combo));
    if (combo.datasource) {
      assert.equal(query.filters.customers.length, 0, JSON.stringify(combo));
      assert.ok(query.filters.datasources.includes(combo.datasource), JSON.stringify(combo));
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
  assert.match(alerts, /if \(view === "recent"\) \{[\s\S]*setDatePreset\("all"\)/);
  assert.match(alerts, /if \(view === "recent"\) \{[\s\S]*setDateField\("first_seen"\)/);
  assert.match(alerts, /if \(view === "open"\) \{[\s\S]*setDatePreset\("all"\)/);
  assert.match(alerts, /if \(view === "priority"\) \{[\s\S]*setSelectedSeverities\(\["disaster", "high"\]\)/);
  assert.match(alerts, /if \(view === "forgotten"\) \{[\s\S]*setSourceAckFilter\("unacknowledged"\)/);
  assert.match(alerts, /if \(view === "resolved"\) \{[\s\S]*setStatusFilter\("resolved"\)/);
  assert.doesNotMatch(alerts, /setDatePreset\("24h"\)/);
  assert.doesNotMatch(alerts, /setDatePreset\("30d"\)/);
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
  assert.match(query, /next\.append\("datasource"/);
});
