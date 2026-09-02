/**
 * OV-P0-69 — Home V2: Alertas | Chamados | Eventos (sem Clientes impactados).
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

/** Espelho das regras Home (src/lib/oneview-home.ts). */
const HOME_ALERT_MODE = { prioritary: "prioritary", all: "all" };
const HOME_PRIORITARY_SEVERITIES = ["average", "high", "disaster"];
const HOME_ALL_SEVERITIES = ["information", "warning", "average", "high", "disaster"];

function parseHomeAlertMode(value) {
  return value === HOME_ALERT_MODE.prioritary ? HOME_ALERT_MODE.prioritary : HOME_ALERT_MODE.all;
}

function resolveHomeAlertSeverities(mode, severityFilter) {
  const base = mode === HOME_ALERT_MODE.all
    ? [...HOME_ALL_SEVERITIES]
    : [...HOME_PRIORITARY_SEVERITIES];
  const raw = String(severityFilter || "").trim().toLowerCase();
  if (!raw || raw === "all") return base;
  if (HOME_ALL_SEVERITIES.includes(raw)) return [raw];
  return base;
}

test("OV-P0-69 helpers: Prioritários = Avg+High+Disaster; Todos = 5 severidades", () => {
  assert.deepEqual(
    resolveHomeAlertSeverities(HOME_ALERT_MODE.prioritary, "all"),
    ["average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveHomeAlertSeverities(HOME_ALERT_MODE.all, null),
    ["information", "warning", "average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveHomeAlertSeverities(HOME_ALERT_MODE.prioritary, "high"),
    ["high"],
  );
  assert.equal(parseHomeAlertMode(null), "all");
  assert.equal(parseHomeAlertMode("all"), "all");
  assert.equal(parseHomeAlertMode("prioritary"), "prioritary");
});

test("OV-P0-69 oneview-home.ts: constantes e fetchers isolados do Monitoramento", async () => {
  const [home, recent, monitoring] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/lib/oneview-recent.ts"),
    read("src/pages/Monitoring.tsx"),
  ]);

  assert.match(home, /HOME_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(home, /HOME_ALL_SEVERITIES = \[[\s\S]*"information"[\s\S]*"warning"[\s\S]*"average"[\s\S]*"high"[\s\S]*"disaster"/);
  assert.match(home, /export async function fetchHomeAlerts/);
  assert.match(home, /export async function fetchHomeIncidents/);
  assert.match(home, /status: params\.status \?\? "active"|status: "active"/);
  assert.match(home, /firstSeenFrom: isoAgo/);
  assert.match(home, /fetchOperationalIncidents|fetchIncidents\(\{/);
  assert.match(home, /HOME_INCIDENTS_PAGE_SIZE/);
  assert.match(home, /HOME_ALERTS_PAGE_SIZE/);

  const incidentsFn = home.slice(
    home.indexOf("export async function fetchHomeIncidents"),
    home.indexOf("export function buildHomeAlertsHref"),
  );
  assert.doesNotMatch(incidentsFn, /callerId:/);
  assert.doesNotMatch(incidentsFn, /mock|fake|INC000/i);

  // Monitoramento permanece no contrato antigo (disaster/high + ACK).
  assert.match(recent, /PRIORITY_SEVERITIES = \["disaster", "high"\]/);
  assert.match(recent, /export async function fetchRecentPriorityAlerts/);
  assert.match(monitoring, /fetchMonitoringAlerts|fetchRecentPriorityAlerts/);
});

test("OV-P0-69 Home layout: Alertas|Chamados|Eventos; drawer/?alert=; sem Clientes impactados", async () => {
  const index = await read("src/pages/Index.tsx");

  assert.match(index, /from "@\/lib\/oneview-home"/);
  assert.match(index, /fetchHomeAlerts/);
  assert.match(index, /fetchOperationalIncidents/);
  assert.match(index, /HOME_ALERT_MODE/);
  assert.match(index, /Prioritários/);
  assert.match(index, /Todos/);
  assert.match(index, /title="Alertas Recentes"/);
  assert.match(index, /title=\{incidentsPanelTitle\}/);
  assert.match(index, /title="Eventos recentes"/);
  assert.match(index, /lg:grid-cols-5/);
  assert.match(index, /lg:col-span-3/);
  assert.match(index, /lg:col-span-2/);
  assert.match(index, /Ver todos/);
  assert.match(index, /buildOperationalChamadosHref/);
  assert.match(index, /ClientFilterCombobox/);
  assert.match(index, /HOME_SEVERITY_FILTER_OPTIONS|Filtrar por severidade/);
  assert.doesNotMatch(index, /isServiceNowIncidentsUiEnabled|VITE_SERVICENOW_INCIDENTS_ENABLED/);
  assert.doesNotMatch(index, /não estão habilitados|ServiceNow desabilitado/);
  assert.match(index, /Chamados indisponíveis|ServiceNow indisponível/);
  assert.match(index, /HOME_OPERATIONAL_WINDOW_OPTIONS/);
  assert.match(index, /HOME_VISUAL_SEVERITY_STRIP|CompactMetricStrip/);
  assert.match(index, /fetchRecentOperationalMetrics/);
  assert.match(index, /fetchRecentOperationalEvents/);

  assert.doesNotMatch(index, /Clientes mais impactados/);
  assert.doesNotMatch(index, /Prioridade agora/);
  assert.doesNotMatch(index, /fetchClientsTopSummary/);
  assert.doesNotMatch(index, /fetchRecentPriorityAlerts/);
  assert.doesNotMatch(index, /mockIncidents|fakeIncidents/);

  // Drawer + deep-link preservados
  assert.match(index, /searchParams\.get\("alert"\)/);
  assert.match(index, /next\.set\("alert", alert\.id\)/);
  assert.match(index, /next\.delete\("alert"\)/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /open=\{selectedAlertId !== null\}/);

  // Ordem: Alertas/Chamados antes de Eventos
  assert.ok(index.indexOf('title="Alertas Recentes"') < index.indexOf('title="Eventos recentes"'));
  assert.ok(index.indexOf("incidentsPanelTitle") < index.indexOf('title="Eventos recentes"'));
});
