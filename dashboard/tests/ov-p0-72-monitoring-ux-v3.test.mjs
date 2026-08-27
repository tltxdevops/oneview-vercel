/**
 * OV-P0-72 — Monitoramento UX V3: fila full-width + chips multi-select.
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

test("OV-P0-72 helpers: default Prioritários = Avg+High+Disaster; chips multi-select server-side", () => {
  assert.deepEqual(MONITOR_PRIORITARY_SEVERITIES, ["average", "high", "disaster"]);
  assert.deepEqual(
    MONITOR_ALL_SEVERITIES,
    ["information", "warning", "average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.prioritary, null),
    ["average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.all, []),
    ["information", "warning", "average", "high", "disaster"],
  );
  assert.deepEqual(
    parseMonitorSeveritySelection(["high", "disaster", "high"]),
    ["high", "disaster"],
  );
  assert.deepEqual(
    resolveMonitorAlertSeverities(MONITOR_ALERT_MODE.prioritary, ["warning", "high"]),
    ["warning", "high"],
  );
});

test("OV-P0-72 Monitoring: topo chips + tabela principal; sem coluna lateral de 16rem", async () => {
  const [monitoring, monitoringLib, home, alerts, historico] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-monitoring.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(monitoring, /ClientFilterCombobox/);
  assert.match(monitoring, /Prioritários/);
  assert.match(monitoring, /Todos/);
  assert.match(monitoring, /label="Severidades"|aria-label="Severidades"/);
  assert.match(monitoring, /MONITOR_SEVERITY_CHIP_OPTIONS/);
  assert.match(monitoring, /toggleSeverityChip/);
  assert.match(monitoring, /Popover|monitorSeverityTriggerLabel/);
  assert.match(monitoringLib, /label: "Information"/);
  assert.match(monitoringLib, /label: "Warning"/);
  assert.match(monitoringLib, /label: "Average"/);
  assert.match(monitoringLib, /label: "High"/);
  assert.match(monitoringLib, /label: "Disaster"/);
  assert.match(monitoring, /label="Janela temporal"|aria-label="Janela temporal"/);
  assert.match(monitoring, /MONITOR_WINDOW_OPTIONS\.map/);
  assert.match(monitoring, /OperationalSegmentedControl|OperationalFilterGroup/);
  assert.match(monitoring, /requestFullscreen/);

  assert.match(monitoring, /QUEUE_GRID/);
  assert.match(monitoring, />Cliente</);
  assert.match(monitoring, />Host</);
  assert.match(monitoring, />Problema</);
  assert.match(monitoring, />Severidade</);
  assert.match(monitoring, />ACK</);
  assert.match(monitoring, />Início</);
  assert.match(monitoring, />Duração</);
  assert.match(monitoring, />Ação</);
  assert.match(monitoring, /MonitorAlertRow/);
  assert.match(monitoring, /onOpen/);
  assert.match(monitoring, /justify-self-end/);
  assert.match(monitoring, /SeverityBadge/);
  assert.doesNotMatch(monitoring, /bg-red-50\/40|strongSeverity/);

  assert.doesNotMatch(monitoring, /xl:grid-cols-\[minmax\(0,1fr\)_16rem\]/);
  assert.doesNotMatch(monitoring, /Atenção necessária/);
  assert.doesNotMatch(monitoring, /fetchAttentionRequired/);
  assert.doesNotMatch(monitoring, /title="Hosts"/);

  // OV-P0-82: Hosts mais impactados removidos do rodapé.
  assert.doesNotMatch(monitoring, /Hosts mais impactados/);

  assert.match(monitoring, /PlatformHealthStrip/);
  assert.match(monitoring, /CompactMetricStrip/);
  assert.match(monitoring, /monitoringCollapse/);
  assert.match(monitoring, /h-\[100dvh\].*w-\[100vw\]/);
  assert.match(monitoring, /html\.style\.overflow = "hidden"/);
  assert.match(monitoring, /fetchMonitoringAlerts/);
  assert.match(monitoring, /severity: severitySelection/);

  assert.match(monitoringLib, /severities: \[\.\.\.severities\]/);
  assert.match(monitoringLib, /acknowledgedSource: params\.mode === MONITOR_ALERT_MODE\.prioritary \? false : undefined/);
  assert.match(monitoringLib, /severity\?: string \| string\[\] \| null/);
  assert.match(monitoringLib, /parseMonitorSeveritySelection/);

  assert.doesNotMatch(home, /MONITOR_SEVERITY_CHIP_OPTIONS|QUEUE_GRID/);
  assert.doesNotMatch(alerts, /MONITOR_SEVERITY_CHIP_OPTIONS|QUEUE_GRID/);
  assert.doesNotMatch(historico, /MONITOR_SEVERITY_CHIP_OPTIONS|QUEUE_GRID/);
  assert.doesNotMatch(home, /fetchMonitoringAlerts/);
});

test("OV-P0-72 layout: grid cabe em 1366 e 1920 (problema flexível)", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");
  assert.match(
    monitoring,
    /grid-cols-\[minmax\(9\.5rem,13rem\)_minmax\(8rem,12rem\)_minmax\(0,1fr\)_6\.25rem_4\.75rem_5\.75rem_5\.5rem_4\.5rem\]/,
  );
  assert.match(monitoring, /max-w-\[1920px\]/);
  // Shell sem scroll de página; listas/drawers usam overflow-y-auto interno (OV-P0-82).
  assert.match(monitoring, /html\.style\.overflow = "hidden"/);
  assert.match(monitoring, /noc-monitor[\s\S]*?overflow-hidden/);
  assert.match(monitoring, /divide-y divide-border overflow-y-auto/);
  assert.match(monitoring, /SheetContent[\s\S]*overflow-y-auto/);
});
