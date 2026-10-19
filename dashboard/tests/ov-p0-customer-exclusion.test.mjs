import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { resolveAlertsCustomerFilter, writeAlertsUrlParams } from "../src/lib/alerts-query.ts";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const request = (query = {}) => ({ query: { status: "all", ...query } });
const urlState = (overrides = {}) => ({
  view: "pending",
  customers: [],
  severities: [],
  status: "all",
  acknowledgedSource: "all",
  oneviewAckStatus: "all",
  dateField: "first_seen",
  datePreset: "7d",
  searchField: "all",
  search: "",
  sort: "first_seen_at",
  order: "desc",
  page: 1,
  pageSize: 50,
  ...overrides,
});

test("Todos exceto Zurich uses a canonical parameterized exclusion", () => {
  const built = buildAlertListQuery(request({ customer_exclude: "Zurich", page: "2", page_size: "50" }));
  assert.deepEqual(built.filters.customers, []);
  assert.deepEqual(built.filters.excludedCustomers, ["zurich"]);
  assert.equal(built.filters.customerFilterMode, "exclude");
  assert.equal(built.offset, 50);
  assert.ok(built.params.some((value) => Array.isArray(value) && value.length === 1 && value[0] === "zurich"));
  assert.match(built.whereSql, /not \(case[\s\S]*?= any\(\$\d+::text\[\]\)\)/);
  assert.match(built.scopeWhereSql, /not \(case[\s\S]*?= any\(\$\d+::text\[\]\)\)/);
});

test("multiple exclusions are deduplicated and no exclusion stays unbounded", () => {
  const multiple = buildAlertListQuery(request({ customer_exclude: ["Zurich", "Castrolanda", "zurich"] }));
  assert.deepEqual(multiple.filters.excludedCustomers, ["zurich", "castrolanda"]);
  const all = buildAlertListQuery(request());
  assert.deepEqual(all.filters.excludedCustomers, []);
  assert.deepEqual(all.filters.excludedDatasources, []);
  assert.equal(all.filters.customerFilterMode, "all");
});

test("exclusion wins explicitly when inclusion and exclusion coexist", () => {
  const resolved = resolveAlertsCustomerFilter(["RHP"], ["Zurich", "Castrolanda"]);
  assert.deepEqual(resolved, { mode: "exclude", selectedKeys: ["zurich", "castrolanda"], conflict: true });
  const built = buildAlertListQuery(request({ customer: "rhp", customer_exclude: "zurich" }));
  assert.deepEqual(built.filters.customers, []);
  assert.deepEqual(built.filters.excludedCustomers, ["zurich"]);
  assert.equal(built.filters.customerFilterConflict, true);
});

test("dedicated customer datasource exclusions and hostile text stay parameterized", () => {
  const maps = buildAlertListQuery(request({ customer_exclude: "maps" }));
  assert.deepEqual(maps.filters.excludedDatasources, ["maps"]);
  assert.match(maps.whereSql, /not \(d\.name = any\(\$\d+::text\[\]\)\)/);
  const hostile = "' OR 1=1 --";
  const safe = buildAlertListQuery(request({ customer_exclude: hostile }));
  assert.equal(safe.whereSql.includes(hostile), false);
  assert.ok(safe.params.some((value) => Array.isArray(value) && value.includes(hostile.toLowerCase())));
});

test("new and legacy URLs use separate compatible parameters", () => {
  const excluded = writeAlertsUrlParams(urlState({ excludedCustomers: ["zurich", "castrolanda"] }));
  assert.deepEqual(excluded.getAll("customer_exclude"), ["zurich", "castrolanda"]);
  assert.deepEqual(excluded.getAll("customer"), []);
  assert.equal(excluded.get("view"), "pending");
  assert.equal(excluded.get("date_preset"), "7d");
  assert.equal(excluded.get("sort"), "first_seen_at");
  const legacy = writeAlertsUrlParams(urlState({ customers: ["rhp", "teletex"] }));
  assert.deepEqual(legacy.getAll("customer"), ["rhp", "teletex"]);
  assert.deepEqual(legacy.getAll("customer_exclude"), []);
});

test("UI, search suggestions, fallback and counters share the effective exclusion", () => {
  const alerts = read("src/pages/Alerts.tsx");
  const api = read("src/lib/oneview-api.ts");
  const fallback = read("api/_lib/oneview-fallback.js");
  const database = read("api/_lib/oneview-db.js");
  assert.match(alerts, /<SelectItem value="include">Incluir<\/SelectItem><SelectItem value="exclude">Excluir<\/SelectItem>/);
  assert.match(alerts, /excludedCustomers: customerFilterMode === "exclude" \? selectedCustomerKeys : \[\]/);
  assert.match(alerts, /Filtro efetivo: \$\{tableCustomerScope\}/);
  const tabChange = alerts.match(/const applyAlertsView = \(view: AlertsView\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  assert.doesNotMatch(tabChange, /setCustomerFilterMode|setSelectedCustomerKeys/);
  assert.match(api, /search\.append\("customer_exclude", customer\)/);
  assert.match(fallback, /filters\.excludedCustomers\.includes/);
  assert.match(database, /const queueSql = `[^`]*\$\{scopeWhereSql\}/s);
  assert.match(database, /const itemsSql = `[^`]*\$\{whereSql\}[^`]*limit \$\$\{params\.length \+ 1\}/s);
});
