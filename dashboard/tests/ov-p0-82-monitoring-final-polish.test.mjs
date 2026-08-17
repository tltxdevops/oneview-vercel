/**
 * OV-P0-82 — Monitoring Final Polish
 * Severidades clicáveis, sem hosts rodapé, highlight de seleção, N sem responsável.
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

test("OV-P0-82 faixa de severidades clicável (filtro server-side na /monitoramento)", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.match(monitoring, /MONITOR_VISUAL_SEVERITY_STRIP/);
  assert.match(monitoring, /CompactMetricStrip/);
  assert.match(monitoring, /toggleSeverityChip/);
  assert.match(monitoring, /selected:\s*activeSeverities\.includes\(severity\)/);
  assert.match(monitoring, /onClick:\s*\(\)\s*=>\s*toggleSeverityChip\(severity\)/);
  assert.match(monitoring, /severity:\s*severitySelection/);
  // Continua na própria página — sem navegar a faixa para /alertas.
  const stripSlice = monitoring.slice(
    monitoring.indexOf("const severityStripItems"),
    monitoring.indexOf("const queueEmpty"),
  );
  assert.doesNotMatch(stripSlice, /href:\s*["'`]\/alertas/);
});

test("OV-P0-82 remove Hosts mais impactados; CTAs únicos de contexto", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.doesNotMatch(monitoring, /Hosts mais impactados/);
  assert.doesNotMatch(monitoring, /MONITOR_HOSTS_LIMIT|topHosts/);
  assert.match(monitoring, /Ver todos em Alertas/);
  assert.match(monitoring, /Ver todos em Chamados/);
});

test("OV-P0-82 highlight discreto de ?alert= e ?incident= (sem bg de severidade na row)", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.match(monitoring, /selected=\{selectedAlertId === alert\.id\}/);
  assert.match(monitoring, /selected=\{selectedIncidentKey === incidentKey\(item\)\}/);
  assert.match(monitoring, /aria-current=\{selected \? "true" : undefined\}/);
  assert.match(monitoring, /selected && "bg-muted\/55 ring-1 ring-inset ring-border\/80"/);
  assert.doesNotMatch(monitoring, /selected && .*bg-(red|orange|yellow|amber|rose|severity)/i);
  assert.match(monitoring, /SeverityBadge/);
});

test("OV-P0-82 painel N sem responsável com scroll interno e drawer inline", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.match(monitoring, /sem responsável/);
  assert.match(monitoring, /unassignedPanelTitle/);
  assert.match(monitoring, /overflow-y-auto/);
  assert.match(monitoring, /AlertDetailDrawer/);
  assert.match(monitoring, /Sheet open=\{selectedIncident !== null\}/);
  assert.match(monitoring, /MonitorUnassignedRow/);
});
