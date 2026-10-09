/**
 * OV-P0-70 — helpers Prioritários|Todos (mantidos; layout migrado em OV-P0-72).
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

const MONITOR_ALERT_MODE = { prioritary: "prioritary", all: "all" };
const MONITOR_PRIORITARY_SEVERITIES = ["average", "high", "disaster"];
const MONITOR_ALL_SEVERITIES = ["information", "warning", "average", "high", "disaster"];

function parseMonitorSeveritySelection(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || "").split(",").map((item) => item.trim());
  const seen = new Set();
  for (const item of raw) {
    const normalized = String(item || "").trim().toLowerCase();
    if (MONITOR_ALL_SEVERITIES.includes(normalized)) seen.add(normalized);
  }
  return [...seen];
}

function resolveMonitorAlertSeverities(mode, severityFilter) {
  const base = mode === MONITOR_ALERT_MODE.all
    ? [...MONITOR_ALL_SEVERITIES]
    : [...MONITOR_PRIORITARY_SEVERITIES];
  const selected = parseMonitorSeveritySelection(severityFilter);
  if (!selected.length) return base;
  return selected;
}

test("OV-P0-70 helpers: Prioritários = Avg+High+Disaster; Todos = 5 severidades", () => {
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.prioritary, "all"),
    ["average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.all, null),
    ["information", "warning", "average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.prioritary, "disaster"),
    ["disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.all, ["warning", "high"]),
    ["warning", "high"],
  );
});

test("OV-P0-70 oneview-monitoring.ts: Prioritários sem ACK; Todos sem filtro ACK", async () => {
  const [monitoringLib, recent, home, index] = await Promise.all([
    read("src/lib/oneview-monitoring.ts"),
    read("src/lib/oneview-recent.ts"),
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
  ]);

  assert.match(monitoringLib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(monitoringLib, /MONITOR_ALL_SEVERITIES/);
  assert.match(monitoringLib, /export async function fetchMonitoringAlerts/);
  assert.match(monitoringLib, /status: "active"/);
  assert.match(monitoringLib, /firstSeenFrom: isoAgo/);
  assert.match(monitoringLib, /acknowledgedSource: params\.mode === MONITOR_ALERT_MODE\.prioritary \? false : undefined/);
  assert.match(monitoringLib, /buildMonitoringAlertHref/);
  assert.match(monitoringLib, /parseMonitorSeveritySelection/);

  // Home e oneview-recent não são alterados por este card.
  assert.match(home, /fetchHomeAlerts/);
  assert.match(index, /fetchHomeAlerts/);
  assert.doesNotMatch(index, /fetchMonitoringAlerts/);
  assert.match(recent, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
  assert.match(recent, /export async function fetchRecentPriorityAlerts/);
});

test("OV-P0-70 Monitoring: fila Prioritários|Todos + helpers (command center em OV-P0-75)", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.match(monitoring, /from "@\/lib\/oneview-monitoring"/);
  assert.match(monitoring, /fetchMonitoringAlerts/);
  assert.match(monitoring, /MONITOR_ALERT_MODE/);
  assert.match(monitoring, /Prioritários/);
  assert.match(monitoring, /Todos/);
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.match(monitoring, /label="Janela temporal"|aria-label="Janela temporal"/);
  assert.match(monitoring, /MONITOR_WINDOW_OPTIONS\.map/);
  assert.match(monitoring, /OperationalSegmentedControl|Prioritários/);
  assert.match(monitoring, /MonitorAlertRow/);
  assert.match(monitoring, /sourceAckRowLabel|Sem ACK|Com ACK/);
  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(monitoring, /<Sidebar/);
  assert.match(monitoring, /monitoringCollapse/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.match(monitoring, /html\.style\.overflow = "hidden"/);
  assert.doesNotMatch(monitoring, /FullscreenFab|requestFullscreen/);

  assert.doesNotMatch(monitoring, /Alertas prioritários/);
  assert.doesNotMatch(monitoring, /title=\{`Recentes · \$\{windowLabel\}`\}/);
  assert.doesNotMatch(monitoring, /fetchRecentPriorityAlerts/);
  assert.doesNotMatch(monitoring, /fetchRecentAlerts/);
  // Shell do monitoring permanece sem scroll; overflow-y-auto só nos drawers (OV-P0-76).
  assert.match(monitoring, /noc-monitor[\s\S]*overflow-hidden/);
  assert.match(monitoring, /SheetContent[\s\S]*overflow-y-auto/);
});
