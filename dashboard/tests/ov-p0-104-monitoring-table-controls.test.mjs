/**
 * OV-P0-104 — Monitoring Table Controls
 * Filtros no header da FILA; topo só título/health/sync/fullscreen.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
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

test("OV-P0-104 topo: título + health + sync + fullscreen; sem filtros operacionais", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");
  const header = headerSlice(monitoring);

  assert.match(header, /Monitoramento/);
  assert.match(header, /PlatformHealthStrip/);
  assert.match(header, /TeletexMark/);
  assert.match(monitoring, /FullscreenFab/);
  assert.match(monitoring, /ov-fullscreen-fab|FullscreenFab/);
  assert.doesNotMatch(header, /aria-label=\{isFullscreen/);
  assert.doesNotMatch(header, /ClientFilterCombobox/);
  assert.doesNotMatch(header, /OperationalSegmentedControl/);
  assert.doesNotMatch(header, /aria-label="Severidades"/);
  assert.doesNotMatch(header, /Ordenação da fila/);
  assert.doesNotMatch(header, /Janela temporal|MONITOR_WINDOW_OPTIONS/);
  assert.doesNotMatch(header, /HOME_WINDOW_OPTIONS/);
});

test("OV-P0-104 Fila: Cliente|Modo|Severidade|Ordenação|30m·2h·8h·24h + faixa acima da tabela", async () => {
  const [monitoring, lib] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-monitoring.ts"),
  ]);
  const queue = queuePanelSlice(monitoring);

  assert.match(queue, /toolbar=\{/);
  assert.match(queue, /ClientFilterCombobox/);
  assert.match(queue, /OperationalSegmentedControl/);
  assert.match(queue, /Prioritários/);
  assert.match(queue, /Todos/);
  assert.match(queue, /aria-label="Severidades"/);
  assert.match(queue, /Ordenação da fila/);
  assert.match(queue, /MONITOR_WINDOW_OPTIONS\.map/);
  assert.match(queue, /CompactMetricStrip/);
  assert.match(queue, /toggleSeverityChip/);
  assert.match(queue, /QUEUE_GRID/);

  // Faixa imediatamente acima da tabela (no painel da fila).
  assert.ok(queue.indexOf("CompactMetricStrip") < queue.indexOf("QUEUE_GRID"));
  assert.ok(queue.indexOf("toolbar={") < queue.indexOf("CompactMetricStrip"));

  assert.match(lib, /MONITOR_WINDOW_PRESETS/);
  assert.match(lib, /DEFAULT_MONITOR_WINDOW: MonitorWindowPreset = "2h"/);
  assert.match(lib, /"30m": 30 \* 60_000/);
  assert.match(lib, /"8h": 8 \* 60 \* 60_000/);
  assert.match(lib, /"24h": 24 \* 60 \* 60_000/);
  assert.doesNotMatch(lib, /"15m":|"1h":|"6h":/);

  // Defaults preservados
  assert.match(lib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(lib, /MONITOR_QUEUE_SORT\.recent/);
  assert.match(monitoring, /parseMonitorAlertMode/);
  assert.match(monitoring, /parseMonitorQueueSort/);
});

test("OV-P0-104 layout 1366/1920 e escopo: Chamados separado; Home intacta", async () => {
  const [monitoring, index, chamados] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(monitoring, /COMMAND_CENTER_GRID|min-\[1440px\]:grid-cols/);
  assert.match(monitoring, /max-w-\[1920px\]/);
  assert.match(monitoring, /QUEUE_GRID/);
  assert.match(monitoring, /1366/);
  assert.match(monitoring, /sem responsável/);
  assert.match(monitoring, /MonitorUnassignedRow/);

  assert.doesNotMatch(index, /MONITOR_WINDOW_OPTIONS|parseMonitorWindow|OV-P0-104/);
  assert.doesNotMatch(chamados, /MONITOR_WINDOW_OPTIONS|parseMonitorWindow|OV-P0-104/);
  assert.match(index, /HOME_OPERATIONAL_WINDOW_OPTIONS/);
});
