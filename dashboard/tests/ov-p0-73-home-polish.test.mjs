/**
 * OV-P0-73 — Home V2 Polish: headers, 7 linhas, eventos compactos.
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

test("OV-P0-73 oneview-home: máximos visuais 7", async () => {
  const home = await read("src/lib/oneview-home.ts");
  assert.match(home, /HOME_ALERTS_PAGE_SIZE = 7/);
  assert.match(home, /HOME_EVENTS_LIMIT = 7/);
});

test("OV-P0-73 Home: Alertas header título+count+Ver todos; filtros na 2ª linha", async () => {
  const index = await read("src/pages/Index.tsx");

  assert.match(index, /aria-label="Alertas recentes"|Alertas recentes/);
  assert.match(index, /HomePanelCount value=\{alertsTotal\}/);
  assert.match(index, /Ver todos/);
  assert.match(index, /HOME_FILTER_ROW|Prioritários/);
  assert.match(index, /ClientFilterCombobox/);
  assert.match(index, /Filtrar por severidade/);
  assert.match(index, /queueOverflowLabel\(alertsTotal, visibleHomeAlerts\.length\)/);
  assert.match(index, /\+ N na fila|queueOverflowLabel/);

  // Arquitetura preservada (dashboard configurável)
  assert.match(index, /ConfigurableDashboard/);
  assert.match(index, /ConfigurableDashboardWidget id="recent-alerts"/);
  assert.match(index, /ConfigurableDashboardWidget id="incidents"/);
  assert.match(index, /Resumo operacional/);
  assert.match(index, /title="Eventos recentes"|Eventos recentes/);
});

test("OV-P0-73 Home: Chamados iguais ao Monitoramento, coluna própria, lista rolável", async () => {
  const [index, list] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/components/oneview/OperationalIncidentsQueueList.tsx"),
  ]);

  assert.match(index, /description=\{incidentsPanelTitle\}/);
  assert.match(index, /OperationalIncidentsToolbar/);
  assert.match(index, /OperationalIncidentsQueueList/);
  assert.match(index, /buildOperationalChamadosHref/);
  assert.match(index, /Ver todos em Chamados/);
  assert.match(index, /HOME_PANEL_HEADER_ASIDE/);
  assert.match(list, /OPERATIONAL_INCIDENT_QUEUE_COLUMNS/);
  assert.match(list, /description/);
  assert.match(list, /overflow-x-auto overflow-y-auto/);
  assert.match(index, /tableId: "home-alerts"/);
  assert.match(index, /tableId: "home-incidents"/);
  assert.match(index, /tableId: "home-operators"/);
  assert.match(index, /ConfigurableTableColumns controller=\{homeAlertColumns\}/);
  assert.match(index, /ConfigurableTableColumns controller=\{homeIncidentColumns\}/);
  assert.match(index, /IncidentDetailDrawer/);
});

test("OV-P0-73 Home: Eventos Cliente|Host|Problema|Severidade|Horário + Abrir histórico", async () => {
  const index = await read("src/pages/Index.tsx");

  assert.match(index, /Abrir histórico/);
  assert.match(index, /to="\/historico"/);
  assert.match(index, /HomePanelCount value=\{eventsTotal\}/);
  assert.match(index, /max-h-\[18rem\]|max-h-\[20rem\]/);

  assert.match(index, /HOME_EVENT_COLUMNS/);
  const eventColumnBlock = index.slice(
    index.indexOf("const HOME_EVENT_COLUMNS"),
    index.indexOf("const HOME_ALERT_COLUMNS"),
  );
  assert.match(eventColumnBlock, /label: "Cliente"/);
  assert.match(eventColumnBlock, /label: "Host"/);
  assert.match(eventColumnBlock, /label: "Problema"/);
  assert.match(eventColumnBlock, /label: "Severidade"/);
  assert.match(eventColumnBlock, /label: "Horário"/);
  assert.match(index, /tableId: "home-events"/);
  assert.doesNotMatch(eventColumnBlock, /label: "Tipo"/);
});

test("OV-P0-73 Home: drawer e filtros preservados", async () => {
  const index = await read("src/pages/Index.tsx");
  assert.match(index, /searchParams\.get\("alert"\)/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /open=\{selectedAlertId !== null\}/);
  assert.match(index, /HOME_ALERT_MODE/);
  assert.match(index, /ClientFilterCombobox/);
  assert.match(index, /HOME_SEVERITY_FILTER_OPTIONS/);
  assert.match(index, /HOME_OPERATIONAL_WINDOW_OPTIONS/);
  // OV-P0-111 — linha tabular de alerta: início compacto + duração + colunas configuráveis.
  assert.match(index, /formatCompactFirstSeen\(alert\.first_seen_at \|\| alert\.started_at\)/);
  assert.match(index, /formatDurationSeconds\(alert\.duration_seconds\)/);
  assert.match(index, /ov-monitoring-table-grid/);
  assert.match(index, /HOME_ALERT_COLUMNS/);
});

test("OV-P0-73 Home: coluna Ação dispara FAZER ACK em vez de Abrir", async () => {
  const index = await read("src/pages/Index.tsx");
  const row = index.slice(index.indexOf("function HomeAlertRow"), index.indexOf("function HomeOperatorRow"));
  assert.match(row, /buttonLabel="FAZER ACK"/);
  assert.match(row, /<AlertSourceAckAction/);
  assert.match(row, /variant="button"/);
  assert.doesNotMatch(row, />Abrir</);
  assert.doesNotMatch(row, /<Eye/);
  assert.match(index, /handleSourceAckRequestAccepted/);
  assert.match(index, /invalidateOneViewReadCache\("\/oneview\/alerts"\)/);
});
