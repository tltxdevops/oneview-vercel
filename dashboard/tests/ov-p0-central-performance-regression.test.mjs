import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { withOneViewReadonlyTransaction } from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const config = { statementTimeoutMs: 10_000, idleInTransactionTimeoutMs: 15_000 };

function createPool(max = 2) {
  let inUse = 0;
  let waiting = 0;
  let peakInUse = 0;
  const waiters = [];
  const clients = [];
  return {
    clients,
    stats: () => ({ inUse, waiting, peakInUse }),
    get totalCount() { return inUse; },
    get idleCount() { return Math.max(0, max - inUse); },
    get waitingCount() { return waiting; },
    get options() { return { max }; },
    async connect() {
      if (inUse >= max) {
        waiting += 1;
        await new Promise((resolve) => waiters.push(resolve));
        waiting -= 1;
      }
      inUse += 1;
      peakInUse = Math.max(peakInUse, inUse);
      let activeQueries = 0;
      const client = {
        overlapped: false,
        async query() {
          activeQueries += 1;
          if (activeQueries > 1) client.overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 1));
          activeQueries -= 1;
          return { rows: [{ reachable: 1 }] };
        },
        release() { inUse -= 1; waiters.shift()?.(); },
      };
      clients.push(client);
      return client;
    },
  };
}

test("Central não monta v_datasource_health nem bloqueia itens por contadores", async () => {
  const [db, alerts, workerHealth] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("src/pages/Alerts.tsx"),
    read("api/health/worker.js"),
  ]);
  const list = alerts.slice(alerts.indexOf("const loadAlerts"), alerts.indexOf("const loadSummaryResources"));

  assert.doesNotMatch(db, /v_datasource_health/);
  assert.match(workerHealth, /v_datasource_health/);
  assert.match(list, /fetchAlerts\(\{ \.\.\.request, include: "items" \}\)/);
  assert.match(list, /setAlerts\(normalized\.items\)[\s\S]*fetchAlerts\(\{ \.\.\.request, include: "summary,temporal" \}\)/);
  assert.match(alerts, /if \(!hasLoadedAlerts \|\| isAlertsFilling\) return;/);
  assert.match(alerts, /SUMMARY_REFRESH_MS = 30_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
});

test("runtime health usa um checkout serial; 503 do resumo não substitui a lista", async () => {
  const [db, alerts, cache] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("src/pages/Alerts.tsx"),
    read("api/_lib/oneview-runtime-cache.js"),
  ]);
  const runtime = db.slice(db.indexOf("async function fetchRuntimeHealthPayload"), db.indexOf("const EXPLICIT_SERVICENOW_TAG_SQL"));
  const summary = alerts.slice(alerts.indexOf("const loadSummaryResources"), alerts.indexOf("const loadSelectedAlert"));

  assert.match(runtime, /withOneViewReadonlyTransaction\(config/);
  assert.match(runtime, /const serialQuery = \(text, values = \[\]\)/);
  assert.match(runtime, /operation: "runtime_health"/);
  assert.match(runtime, /await Promise\.allSettled/);
  assert.match(runtime, /const rejected = results\.find/);
  assert.doesNotMatch(runtime, /getOneViewDbPool\(config\)\.query/);
  assert.match(summary, /Promise\.allSettled/);
  assert.match(summary, /A tabela de alertas continua usando sua própria resposta em tempo real\./);
  assert.doesNotMatch(summary, /setAlertsError\(/);
  assert.match(cache, /withOneViewSummaryCache\(loader, \{ bypass = false, ttlMs = 30_000 \}/);
});

test("moderate concurrency keeps runtime probes on serial pool checkouts", async () => {
  const pool = createPool(2);
  await Promise.all(Array.from({ length: 6 }, () => withOneViewReadonlyTransaction(config, async (query) => {
    for (let index = 0; index < 6; index += 1) await query(`select runtime_probe_${index}`);
  }, { pool, operation: "runtime_health" })));
  assert.equal(pool.clients.every((client) => !client.overlapped), true);
  assert.ok(pool.stats().peakInUse <= 2);
  assert.equal(pool.stats().waiting, 0);
  assert.equal(pool.stats().inUse, 0);
});
