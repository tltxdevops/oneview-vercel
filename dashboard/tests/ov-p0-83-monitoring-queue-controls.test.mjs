/**
 * OV-P0-83 — Monitoring Queue Controls
 * Ordenação server-side + first_seen_at na fila + URL persist.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

const MONITOR_QUEUE_SORT = {
  recent: "recent",
  oldest: "oldest",
  severity: "severity",
};

function parseMonitorQueueSort(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === MONITOR_QUEUE_SORT.oldest) return MONITOR_QUEUE_SORT.oldest;
  if (value === MONITOR_QUEUE_SORT.severity) return MONITOR_QUEUE_SORT.severity;
  return MONITOR_QUEUE_SORT.recent;
}

function resolveMonitorQueueSortParams(sort) {
  if (sort === MONITOR_QUEUE_SORT.oldest) return { sort: "first_seen_at", order: "asc" };
  if (sort === MONITOR_QUEUE_SORT.severity) return { sort: "severity", order: "desc" };
  return { sort: "first_seen_at", order: "desc" };
}

test("OV-P0-83 sort helpers: default recent; oldest/severity mapeiam BFF", () => {
  assert.equal(parseMonitorQueueSort(null), MONITOR_QUEUE_SORT.recent);
  assert.equal(parseMonitorQueueSort(""), MONITOR_QUEUE_SORT.recent);
  assert.equal(parseMonitorQueueSort("oldest"), MONITOR_QUEUE_SORT.oldest);
  assert.equal(parseMonitorQueueSort("severity"), MONITOR_QUEUE_SORT.severity);
  assert.equal(parseMonitorQueueSort("bogus"), MONITOR_QUEUE_SORT.recent);

  assert.deepEqual(resolveMonitorQueueSortParams(MONITOR_QUEUE_SORT.recent), {
    sort: "first_seen_at",
    order: "desc",
  });
  assert.deepEqual(resolveMonitorQueueSortParams(MONITOR_QUEUE_SORT.oldest), {
    sort: "first_seen_at",
    order: "asc",
  });
  assert.deepEqual(resolveMonitorQueueSortParams(MONITOR_QUEUE_SORT.severity), {
    sort: "severity",
    order: "desc",
  });
});

test("OV-P0-83 lib: options + resolveMonitorQueueSortParams + fetch sort server-side", async () => {
  const lib = await read("src/lib/oneview-monitoring.ts");

  assert.match(lib, /MONITOR_QUEUE_SORT/);
  assert.match(lib, /label: "Mais recentes"/);
  assert.match(lib, /label: "Mais antigos"/);
  assert.match(lib, /label: "Maior severidade"/);
  assert.match(lib, /export function parseMonitorQueueSort/);
  assert.match(lib, /export function resolveMonitorQueueSortParams/);
  assert.match(lib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);

  const fn = lib.slice(
    lib.indexOf("export async function fetchMonitoringAlerts"),
    lib.indexOf("export async function fetchMonitoringUnassignedIncidents"),
  );
  assert.match(fn, /resolveMonitorQueueSortParams|parseMonitorQueueSort/);
  assert.match(fn, /sort:\s*sortParams\.sort/);
  assert.match(fn, /order:\s*sortParams\.order/);
  assert.match(fn, /acknowledgedSource: params\.mode === MONITOR_ALERT_MODE\.prioritary \? false/);
  assert.doesNotMatch(fn, /\.sort\(compareMonitorAlerts\)/);
});

test("OV-P0-83 Monitoring UI: ordenação URL + Início (first_seen_at) + Duração", async () => {
  const [monitoring, home, alerts, historico] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(monitoring, /parseMonitorQueueSort|MONITOR_QUEUE_SORT/);
  assert.match(monitoring, /searchParams\.get\("sort"\)/);
  assert.match(monitoring, /setQueueSort|next\.set\("sort"/);
  assert.match(monitoring, /MONITOR_QUEUE_SORT_OPTIONS\.map/);
  assert.match(monitoring, /sort:\s*queueSort/);
  assert.match(monitoring, /formatCompactFirstSeen/);
  assert.match(monitoring, /first_seen_at/);
  assert.match(monitoring, />Início</);
  assert.match(monitoring, />Duração</);
  assert.match(monitoring, /formatDurationSeconds\(alert\.duration_seconds\)/);
  assert.match(monitoring, /aria-label="Ordenação da fila"/);

  // Escopo: só Monitoramento
  assert.doesNotMatch(home, /MONITOR_QUEUE_SORT|parseMonitorQueueSort|formatCompactFirstSeen/);
  assert.doesNotMatch(alerts, /MONITOR_QUEUE_SORT|parseMonitorQueueSort|formatCompactFirstSeen/);
  assert.doesNotMatch(historico, /MONITOR_QUEUE_SORT|parseMonitorQueueSort|formatCompactFirstSeen/);
});
