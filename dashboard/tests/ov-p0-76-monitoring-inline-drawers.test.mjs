/**
 * OV-P0-76 — Monitoring Inline Drawers: abrir drawers em /monitoramento com ?alert= / ?incident=.
 * Sem navegar para /alertas ou /chamados no clique da linha.
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

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("OV-P0-76 Monitoring: alerta abre drawer inline com ?alert=, sem Link para /alertas na linha", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  const alertRow = sliceBetween(monitoring, "function MonitorAlertRow", "export default function MonitoringPage");
  assert.match(alertRow, /onClick=\{\(\) => onOpen\(alert\)\}/);
  assert.match(alertRow, /\bAbrir\b/);
  assert.doesNotMatch(alertRow, /buildMonitoringAlertHref|\/alertas|useNavigate/);
  assert.doesNotMatch(alertRow, /<Link\b/);

  assert.match(monitoring, /searchParams\.get\("alert"\)/);
  assert.match(monitoring, /next\.set\("alert", alert\.id\)/);
  assert.match(monitoring, /next\.delete\("alert"\)/);
  assert.match(monitoring, /setSearchParams\(next, \{ replace: false \}\)/);
  assert.match(monitoring, /open=\{selectedAlertId !== null\}/);
  assert.match(monitoring, /AlertDetailDrawer/);
  assert.match(monitoring, /fetchAlert\(|fetchAlertHistory\(/);
});

test("OV-P0-76 Monitoring: chamado não atribuído abre drawer inline com ?incident=", async () => {
  const monitoring = await read("src/pages/Monitoring.tsx");

  const unassignedRow = sliceBetween(monitoring, "function MonitorUnassignedRow", "function MonitorAlertRow");
  assert.match(unassignedRow, /onClick=\{\(\) => onOpen\(item\)\}/);
  assert.doesNotMatch(unassignedRow, /\/chamados|<Link\b/);

  assert.match(monitoring, /searchParams\.get\("incident"\)/);
  assert.match(monitoring, /next\.set\("incident", id\)/);
  assert.match(monitoring, /next\.delete\("incident"\)/);
  assert.match(monitoring, /open=\{selectedIncident !== null\}/);
  assert.match(monitoring, /fetchIncidentRelatedAlert/);
  assert.match(monitoring, /ServiceNowDevLink/);
  assert.match(monitoring, /resolveIncidentFromId/);
});

test("OV-P0-76 Monitoring: CTAs explícitos Ver todos; drawers mutuamente exclusivos; escopo", async () => {
  const [monitoring, home, alerts, chamados] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(monitoring, /Ver todos em Alertas/);
  assert.match(monitoring, /to=\{alertsHref\}/);
  assert.match(monitoring, /Ver todos em Chamados/);
  assert.match(monitoring, /to=\{chamadosHref\}/);
  assert.match(monitoring, /buildMonitoringUnassignedChamadosHref/);

  // Ao abrir um, remove o outro da URL
  assert.match(monitoring, /next\.delete\("incident"\)[\s\S]*next\.set\("alert"/);
  assert.match(monitoring, /next\.delete\("alert"\)[\s\S]*next\.set\("incident"/);

  // Contratos dos drawers nas outras páginas permanecem
  assert.match(home, /AlertDetailDrawer/);
  assert.match(alerts, /selectedAlertId/);
  assert.match(chamados, /setSelected|Sheet open=\{Boolean\(selected\)\}|open=\{!!selected\}/);

  assert.doesNotMatch(home, /MonitorAlertRow/);
  assert.doesNotMatch(alerts, /MonitorUnassignedRow|COMMAND_CENTER_GRID/);
});
