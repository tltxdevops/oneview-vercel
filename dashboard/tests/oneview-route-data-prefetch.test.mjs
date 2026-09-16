import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("route data prefetch warms cookie-authenticated defaults without AbortSignal", async () => {
  const prefetch = await read("src/lib/oneview-route-data-prefetch.ts");
  assert.match(prefetch, /ONEVIEW_ROUTE_DATA_PREFETCH_DEBOUNCE_MS = 300/);
  assert.match(prefetch, /"\/alertas"/);
  assert.match(prefetch, /"\/chamados"/);
  assert.match(prefetch, /"\/operadoras"/);
  assert.match(prefetch, /getOneViewFacets\(\)/);
  assert.match(prefetch, /fetchHomeAlerts\(/);
  assert.match(prefetch, /fetchMonitoringAlerts\(/);
  assert.match(prefetch, /fetchAlerts\(defaultAlertsFetchParams\(now\)\)/);
  assert.match(prefetch, /fetchIncidents\(DEFAULT_INCIDENTS_FETCH_PARAMS\)/);
  assert.match(prefetch, /fetchCanonicalLinks/);
  assert.doesNotMatch(prefetch, /signal:/);
  assert.match(prefetch, /credentials: "include"|fetchHomeAlerts|fetchAlerts/);
});

test("bundle prefetch also warms route data on hover and after login", async () => {
  const [prefetch, sidebar, cta, protectedRoute, auth] = await Promise.all([
    read("src/lib/oneview-route-prefetch.ts"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/components/oneview/OperationalCta.tsx"),
    read("src/components/auth/ProtectedRoute.tsx"),
    read("src/context/AuthContext.tsx"),
  ]);
  assert.match(prefetch, /prefetchOneViewRouteData/);
  assert.match(prefetch, /options\?\.dataImmediate === true/);
  assert.match(sidebar, /prefetchOneViewRoute\(to\)/);
  assert.match(sidebar, /onPointerDown=\{\(\) => prefetchOneViewRoute\(to, \{ dataImmediate: true \}\)\}/);
  assert.match(cta, /onPointerDown=\{\(\) => prefetchOneViewRoute\(to, \{ dataImmediate: true \}\)\}/);
  assert.match(protectedRoute, /prefetchOneViewRoute\(location\.pathname, \{ dataImmediate: true \}\)/);
  assert.doesNotMatch(protectedRoute, /prefetchOneViewOperationalRoutes/);
  assert.match(auth, /clearOneViewRouteDataPrefetch/);
});

test("peek cache and facets store are wired for instant paint", async () => {
  const [api, store, hook, alerts, chamados, operadoras, index] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/lib/oneview-facets-store.ts"),
    read("src/hooks/useOneViewWarmRead.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Operadoras.tsx"),
    read("src/pages/Index.tsx"),
  ]);
  assert.match(api, /export function peekOneViewReadCache/);
  assert.match(api, /const shared = inFlightReads\.get\(key\);/);
  assert.match(api, /cached\.freshUntil <= Date\.now\(\)/);
  assert.match(api, /export function bucketOneViewReadNow/);
  assert.match(api, /ONEVIEW_READ_CACHE_TTL_MS = 8_000/);
  assert.match(store, /export function getOneViewFacets/);
  assert.match(store, /export function clearOneViewFacetsStore/);
  assert.match(store, /if \(inFlight === tracked\) inFlight = null/);
  assert.match(store, /peekOneViewReadCache<OneViewFacetsResponse>\(ONEVIEW_FACETS_PATH\)/);
  assert.match(hook, /useOneViewWarmRead/);
  assert.match(alerts, /useOneViewWarmRead<AlertListResponse>/);
  assert.match(alerts, /bucketOneViewReadNow\(\)/);
  assert.match(alerts, /getOneViewFacets\(\)/);
  assert.match(chamados, /oneViewIncidentsPath\(DEFAULT_INCIDENTS_FETCH_PARAMS\)/);
  assert.match(operadoras, /oneViewLinksPath\(\{ \.\.\.DEFAULT_CANONICAL_LINKS_QUERY \}\)/);
  assert.match(index, /defaultHomeAlertsFetchParams/);
  assert.match(index, /getOneViewFacets\(\)/);
});

test("Home paints its alert queue before secondary panels", async () => {
  const index = await read("src/pages/Index.tsx");
  assert.match(index, /const loadCriticalHomeAlerts = useCallback/);
  assert.match(index, /setCriticalHomeReady\(true\)/);
  assert.match(index, /if \(!criticalHomeReady\) return;\s*void loadSummary/);
  assert.match(index, /if \(!criticalHomeReady\) return;\s*void loadLists/);
  assert.ok(index.indexOf("void loadCriticalHomeAlerts()") < index.indexOf("void loadSummary("));
});
