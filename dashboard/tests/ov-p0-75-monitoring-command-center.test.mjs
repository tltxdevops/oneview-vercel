/**
 * OV-P0-75 — Monitoring Command Center: fila ~72% + chamados sem responsável ~28%.
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

test("OV-P0-75 oneview-monitoring: unassigned via incidents API, estados operacionais, teto 100", async () => {
  const [lib, helper] = await Promise.all([
    read("src/lib/oneview-monitoring.ts"),
    read("src/lib/oneview-operational-incidents.ts"),
  ]);

  assert.match(lib, /MONITOR_UNASSIGNED_LIMIT = OPERATIONAL_INCIDENTS_PAGE_SIZE/);
  assert.match(lib, /MONITOR_UNASSIGNED_OPERATIONAL_STATES = OPERATIONAL_INCIDENT_STATES/);
  assert.match(helper, /OPERATIONAL_INCIDENTS_PAGE_SIZE = 100/);
  assert.match(helper, /OPERATIONAL_INCIDENT_STATES = "1,2,3"/);
  assert.match(lib, /export async function fetchMonitoringUnassignedIncidents/);
  assert.match(helper, /fetchIncidents\(\{/);
  assert.match(helper, /unassigned: mode === INCIDENTS_QUEUE_MODE\.unassigned \? true : undefined/);
  assert.doesNotMatch(
    lib.slice(
      lib.indexOf("export async function fetchMonitoringUnassignedIncidents"),
      lib.indexOf("export function buildMonitoringUnassignedChamadosHref"),
    ),
    /callerId|caller_id/,
  );
  assert.match(lib, /buildMonitoringUnassignedChamadosHref/);
  assert.match(helper, /\/chamados\?unassigned=true/);

  // Prioritários / Todos preservados
  assert.match(lib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(lib, /acknowledgedSource: params\.mode === MONITOR_ALERT_MODE\.prioritary \? false : undefined/);
});

test("OV-P0-75 Monitoring layout: 72/28 a partir de 1440; empilha em 1366; sem coluna 16rem", async () => {
  const [monitoring, home, alerts, historico] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(monitoring, /COMMAND_CENTER_GRID|min-\[1440px\]:grid-cols-\[minmax\(0,60fr\)_minmax\(0,40fr\)\]/);
  assert.match(monitoring, /sem responsável/);
  assert.match(monitoring, /fetchMonitoringUnassignedIncidents/);
  assert.match(monitoring, /fetchMonitoringUnassignedIncidents|OPERATIONAL_INCIDENTS/);
  assert.match(monitoring, /buildMonitoringChamadosHref|buildMonitoringUnassignedChamadosHref|chamadosHref/);
  assert.match(monitoring, /Ver todos em Alertas|Ver todos/);
  assert.match(monitoring, /Ver todos em Chamados|Ver todos/);
  assert.match(monitoring, /MonitorUnassignedRow/);
  assert.match(monitoring, /sys_updated_on|formatUpdatedAgo/);
  assert.match(monitoring, /fetchMonitoringUnassignedIncidents/);
  assert.doesNotMatch(monitoring, /isServiceNowIncidentsUiEnabled|VITE_SERVICENOW_INCIDENTS_ENABLED/);
  // OV-P0-82: faixa de hosts removida do rodapé.
  assert.doesNotMatch(monitoring, /Hosts mais impactados/);

  // Filtros da fila preservados
  assert.match(monitoring, /ClientFilterCombobox/);
  assert.match(monitoring, /Prioritários/);
  assert.match(monitoring, /Todos/);
  assert.match(monitoring, /MONITOR_SEVERITY_CHIP_OPTIONS/);
  assert.match(monitoring, /MONITOR_WINDOW_OPTIONS/);
  assert.match(monitoring, /QUEUE_GRID/);
  assert.match(monitoring, /MonitorAlertRow/);

  // Não reintroduzir sidebar fixa de 16rem (hosts/atenção)
  assert.doesNotMatch(monitoring, /xl:grid-cols-\[minmax\(0,1fr\)_16rem\]/);
  assert.doesNotMatch(monitoring, /\bw-\[16rem\]\b|\bw-64\b/);

  // Escopo: só Monitoring
  assert.doesNotMatch(home, /fetchMonitoringUnassignedIncidents|COMMAND_CENTER_GRID/);
  assert.doesNotMatch(alerts, /fetchMonitoringUnassignedIncidents|COMMAND_CENTER_GRID/);
  assert.doesNotMatch(historico, /fetchMonitoringUnassignedIncidents|COMMAND_CENTER_GRID/);
});
