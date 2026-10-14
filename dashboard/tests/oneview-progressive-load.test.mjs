import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAlertListInclude, buildAlertListQuery } from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("parseAlertListInclude defaults to items+summary+temporal", () => {
  assert.deepEqual(parseAlertListInclude(""), { items: true, summary: true, temporal: true });
  assert.deepEqual(parseAlertListInclude(undefined), { items: true, summary: true, temporal: true });
  assert.deepEqual(parseAlertListInclude("items"), { items: true, summary: false, temporal: false });
  assert.deepEqual(parseAlertListInclude("summary,temporal"), { items: false, summary: true, temporal: true });
  assert.deepEqual(parseAlertListInclude("items,summary,temporal"), { items: true, summary: true, temporal: true });
  assert.throws(() => parseAlertListInclude("rows"), /invalid_query/);
});

test("buildAlertListQuery exposes include=items without changing default filters", () => {
  const full = buildAlertListQuery({ query: { status: "active", page_size: "10" } });
  assert.deepEqual(full.include, { items: true, summary: true, temporal: true });
  const itemsOnly = buildAlertListQuery({ query: { status: "active", page_size: "10", include: "items" } });
  assert.deepEqual(itemsOnly.include, { items: true, summary: false, temporal: false });
  assert.equal(itemsOnly.pageSize, full.pageSize);
});

test("BFF skips summary and temporal SQL when include=items", async () => {
  const db = await read("api/_lib/oneview-db.js");
  const fallback = await read("api/_lib/oneview-fallback.js");
  assert.match(db, /export function parseAlertListInclude/);
  assert.match(db, /include\.summary \? await query/);
  assert.match(db, /include\.temporal \? await query/);
  assert.match(db, /include\.items \? await query/);
  assert.match(db, /if \(include\.summary\) payload\.filtered_summary/);
  assert.match(db, /if \(include\.temporal\) payload\.temporal_counts/);
  assert.match(fallback, /include\.summary \? \{ filtered_summary/);
  assert.match(fallback, /include\.items \? filteredItems\.slice/);
});

test("health snapshot is compact, restored on mount, and cleared on logout", async () => {
  const [snapshot, strip, auth] = await Promise.all([
    read("src/lib/oneview-health-snapshot.ts"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/context/AuthContext.tsx"),
  ]);
  assert.match(snapshot, /RUNTIME_HEALTH_SNAPSHOT_KEY/);
  assert.match(snapshot, /sessionStorage/);
  assert.match(snapshot, /export function compactRuntimeHealthSnapshot/);
  assert.match(snapshot, /export function parseRuntimeHealthSnapshot/);
  assert.match(snapshot, /export function clearRuntimeHealthSnapshot/);
  assert.match(snapshot, /checked_at: parsed\.captured_at/);
  assert.match(strip, /readRuntimeHealthSnapshot\(\)/);
  assert.match(strip, /writeRuntimeHealthSnapshot\(payload\)/);
  assert.match(strip, /runAfterOneViewFirstUseful\(\(\) => void refresh\(\)\)/);
  assert.match(strip, /snapshot \$\{snapshotAge\}/);
  assert.match(auth, /clearRuntimeHealthSnapshot\(\)/);
});

test("Alertas first wave uses 10 items then the configured page", async () => {
  const [alerts, query, prefetch, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/lib/alerts-query.ts"),
    read("src/lib/oneview-route-data-prefetch.ts"),
    read("src/lib/oneview-api.ts"),
  ]);
  assert.match(query, /FIRST_ALERTS_PAGE_SIZE = 10/);
  assert.match(query, /export function firstAlertsFetchParams/);
  assert.match(query, /include: ALERT_LIST_INCLUDE_ITEMS/);
  assert.match(api, /if \(params\?\.include\) search\.set\("include", params\.include\)/);
  assert.match(alerts, /pageSize: FIRST_ALERTS_PAGE_SIZE/);
  assert.match(alerts, /include: "items"/);
  assert.match(alerts, /useOneViewWarmRead<AlertListResponse>/);
  assert.match(alerts, /carregando o restante/);
  assert.match(prefetch, /fetchAlerts\(firstAlertsFetchParams\(now\)\)/);
});

test("Home, Monitoramento, Chamados and Histórico split first-wave reads", async () => {
  const [index, monitoring, chamados, historico, home, recent, operadoras] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/lib/oneview-home.ts"),
    read("src/lib/oneview-recent.ts"),
    read("src/pages/Operadoras.tsx"),
  ]);
  assert.match(home, /include: params.include \?\? "items"/);
  assert.match(index, /await loadCriticalHomeAlerts\(\)/);
  assert.match(index, /include: "summary"/);
  assert.match(monitoring, /include: "items"/);
  assert.match(monitoring, /await applyQueuePayload\(payload\)/);
  assert.match(monitoring, /fetchRecentOperationalMetrics/);
  assert.match(recent, /include: "summary"/);
  assert.match(chamados, /includeCounts: false/);
  assert.match(chamados, /includeItems: false/);
  assert.match(chamados, /includeCounts: true/);
  assert.match(historico, /FIRST_ALERTS_PAGE_SIZE/);
  assert.match(historico, /include: "items"/);
  assert.match(operadoras, /Carregando a primeira página de links/);
  assert.match(operadoras, /Array\.from\(\{ length: 10 \}/);
});
