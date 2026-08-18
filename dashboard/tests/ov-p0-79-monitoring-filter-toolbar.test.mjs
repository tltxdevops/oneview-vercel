/**
 * OV-P0-79 — Monitoring Filter Toolbar (atualizado por OV-P0-104).
 * Controles operacionais no header da FILA; topo só health/fullscreen.
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

function headerSlice(monitoring) {
  const start = monitoring.indexOf("<header");
  const end = monitoring.indexOf("</header>");
  assert.ok(start >= 0 && end > start, "header not found");
  return monitoring.slice(start, end);
}

function queuePanelSlice(monitoring) {
  const start = monitoring.indexOf('title={`Fila · ${modeLabel} · ${windowLabel}`}');
  const end = monitoring.indexOf('title={unassignedPanelTitle}');
  assert.ok(start >= 0 && end > start, "Fila panel not found");
  return monitoring.slice(start, end);
}

test("OV-P0-79/104 toolbar: filtros na FILA; topo sem Cliente/Modo/Severidade/Janela", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");
  const header = headerSlice(monitoring);
  const queue = queuePanelSlice(monitoring);

  assert.match(header, /PlatformHealthStrip/);
  assert.match(header, /requestFullscreen|toggleFullscreen/);
  assert.doesNotMatch(header, /ClientFilterCombobox/);
  assert.doesNotMatch(header, /OperationalSegmentedControl/);
  assert.doesNotMatch(header, /HOME_WINDOW_OPTIONS|MONITOR_WINDOW_OPTIONS/);

  assert.match(queue, /ClientFilterCombobox/);
  assert.match(queue, /OperationalSegmentedControl/);
  assert.match(queue, /Prioritários/);
  assert.match(queue, /Todos/);
  assert.match(queue, /Popover/);
  assert.match(queue, /monitorSeverityTriggerLabel|Severidade ·/);
  assert.match(queue, /aria-label="Severidades"/);
  assert.match(queue, /label="Janela temporal"|aria-label="Janela temporal"/);
  assert.match(queue, /MONITOR_WINDOW_OPTIONS\.map/);
  assert.match(queue, /MONITOR_SEVERITY_CHIP_OPTIONS\.map/);

  assert.ok(queue.indexOf("ClientFilterCombobox") < queue.indexOf("Janela temporal"));
  assert.ok(queue.indexOf("OperationalSegmentedControl") < queue.indexOf("MONITOR_WINDOW_OPTIONS"));
});

test("OV-P0-79 defaults Prioritários/Todos preservados; tabela/chamados intactos", async () => {
  const [monitoring, lib, combobox] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-monitoring.ts"),
    read("src/components/oneview/ClientFilterCombobox.tsx"),
  ]);

  assert.match(lib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(lib, /acknowledgedSource: params\.mode === MONITOR_ALERT_MODE\.prioritary \? false : undefined/);
  assert.match(monitoring, /QUEUE_GRID/);
  assert.match(monitoring, /COMMAND_CENTER_GRID|min-\[1440px\]:grid-cols/);
  assert.match(monitoring, /sem responsável/);
  assert.match(monitoring, /MonitorAlertRow/);
  assert.match(monitoring, /MonitorUnassignedRow/);

  assert.match(combobox, /Cliente ·/);
  assert.match(combobox, /items-center gap-2/);
  assert.doesNotMatch(combobox, /uppercase leading-none tracking-wide[\s\S]*Cliente/);
});

test("OV-P0-79 escopo: não altera Home/Alertas/Histórico pages", async () => {
  const [index, alerts, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);
  assert.doesNotMatch(index, /monitorSeverityTriggerLabel|OV-P0-79/);
  assert.doesNotMatch(alerts, /monitorSeverityTriggerLabel|OV-P0-79/);
  assert.doesNotMatch(historico, /monitorSeverityTriggerLabel|OV-P0-79/);
});
