import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("bootstrap overlaps runtime config with safe shared runtime loading", async () => {
  const main = await read("src/main.tsx");
  assert.match(main, /const reactDomPromise = import\("react-dom\/client"\);\s*await loadRuntimeConfig\(\)/);
  assert.ok(main.indexOf('await loadRuntimeConfig()') < main.indexOf('import(".\/App.tsx")'));
  assert.match(main, /Promise\.all\(\[\s*reactDomPromise,\s*appModulesPromise/);
  assert.match(main, /App\/Auth evaluate only after runtime config/);
});

test("Home reuses alert summary and settles secondary panels progressively", async () => {
  const [index, home] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-home.ts"),
  ]);
  assert.match(home, /filtered_summary: response\.filtered_summary/);
  assert.match(index, /recentOperationalMetricsFromAlertSummary\(summaryPayload\)/);
  assert.doesNotMatch(index, /fetchRecentOperationalMetrics/);
  assert.match(index, /const eventsTask = fetchRecentOperationalEvents[\s\S]*?\.then\(\(payload\)/);
  assert.match(index, /const incidentsTask = fetchOperationalIncidents[\s\S]*?\.then\(\(payload\)/);
  assert.match(index, /const operatorsTask = fetchOperatorQueue[\s\S]*?\.then\(\(payload\)/);
  assert.match(index, /setListSectionLoading\("events", false\)/);
  assert.match(index, /setListSectionLoading\("incidents", false\)/);
  assert.match(index, /setListSectionLoading\("operators", false\)/);
});

test("non-critical reads wait for first useful Home content", async () => {
  const [index, health, reminders, prefetch] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/providers/OperatorReminderInboxProvider.tsx"),
    read("src/lib/oneview-route-data-prefetch.ts"),
  ]);
  assert.match(index, /runAfterOneViewFirstUseful\(\(\) => void loadFacets\(\)\)/);
  assert.match(health, /runAfterOneViewFirstUseful\(\(\) => void refresh\(\)\)/);
  assert.match(reminders, /runAfterOneViewFirstUseful/);
  const homePrefetch = prefetch.match(/if \(path === "\/"\) \{[\s\S]*?return;\s*\}/)?.[0] ?? "";
  assert.match(homePrefetch, /fetchHomeAlerts/);
  assert.doesNotMatch(homePrefetch, /getOneViewFacets/);
});

test("fingerprinted assets are immutable while application routes stay unchanged", async () => {
  const vercel = JSON.parse(await read("vercel.json"));
  assert.deepEqual(vercel.headers, [{
    source: "/assets/(.*)",
    headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
  }]);
  assert.deepEqual(vercel.rewrites, [{ source: "/((?!api/.*).*)", destination: "/index.html" }]);
});

test("performance metrics contain only fixed names and numeric browser durations", async () => {
  const metrics = await read("src/lib/oneview-performance.ts");
  assert.match(metrics, /Static names and numeric durations only/);
  assert.match(metrics, /performance\.measure/);
  assert.doesNotMatch(metrics, /sendBeacon|fetch\(/);
});
