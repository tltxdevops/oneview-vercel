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

  assert.match(index, /title="Alertas Recentes"/);
  assert.match(index, /HomePanelCount value=\{alertsTotal\}/);
  assert.match(index, /Ver todos/);
  assert.match(index, /HOME_FILTER_ROW|Prioritários/);
  assert.match(index, /ClientFilterCombobox/);
  assert.match(index, /Filtrar por severidade/);
  assert.match(index, /queueOverflowLabel\(alertsTotal, homeAlerts\.length\)/);
  assert.match(index, /\+ N na fila|queueOverflowLabel/);

  // Arquitetura preservada
  assert.match(index, /lg:grid-cols-5/);
  assert.match(index, /lg:col-span-3/);
  assert.match(index, /lg:col-span-2/);
  assert.match(index, /title="Resumo operacional"|aria-label="Resumo operacional"/);
  assert.match(index, /title="Eventos recentes"/);
});

test("OV-P0-73 Home: Chamados iguais ao Monitoramento, coluna própria, lista rolável", async () => {
  const [index, list] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/components/oneview/OperationalIncidentsQueueList.tsx"),
  ]);

  assert.match(index, /title=\{incidentsPanelTitle\}/);
  assert.match(index, /OperationalIncidentsToolbar/);
  assert.match(index, /OperationalIncidentsQueueList/);
  assert.match(index, /buildOperationalChamadosHref/);
  assert.match(index, /Ver todos em Chamados/);
  assert.match(index, /HOME_PANEL_HEADER_ASIDE/);
  assert.match(index, /items-stretch/);
  assert.match(index, /lg:col-span-2/);
  assert.match(list, /Número · Cliente/);
  assert.match(list, /Atualização · Prioridade · Estado/);
  assert.match(list, /overflow-y-auto/);
  assert.match(index, /IncidentQuickSheet/);
});

test("OV-P0-73 Home: Eventos Cliente|Host|Problema|Severidade|Horário + Abrir histórico", async () => {
  const index = await read("src/pages/Index.tsx");

  assert.match(index, /Abrir histórico/);
  assert.match(index, /to="\/historico"/);
  assert.match(index, /HomePanelCount value=\{eventsTotal\}/);
  assert.match(index, /max-h-\[18rem\]|max-h-\[20rem\]/);

  const eventsBlock = index.slice(
    index.indexOf('title="Eventos recentes"'),
    index.indexOf("<IncidentQuickSheet"),
  );
  assert.match(eventsBlock, />Cliente</);
  assert.match(eventsBlock, />Host</);
  assert.match(eventsBlock, />Problema</);
  assert.match(eventsBlock, />Severidade</);
  assert.match(eventsBlock, />Horário</);
  assert.doesNotMatch(eventsBlock, /><th[^>]*>Tipo<\/th>/);
  assert.ok(eventsBlock.indexOf(">Cliente<") < eventsBlock.indexOf(">Host<"));
  assert.ok(eventsBlock.indexOf(">Host<") < eventsBlock.indexOf(">Problema<"));
  assert.ok(eventsBlock.indexOf(">Problema<") < eventsBlock.indexOf(">Severidade<"));
  assert.ok(eventsBlock.indexOf(">Severidade<") < eventsBlock.indexOf(">Horário<"));
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
  // OV-P0-111 — linha de alerta: horário de início + duração explícita.
  assert.match(index, /formatClock\(startedAt\)/);
  assert.match(index, /formatDurationSeconds\(alert\.duration_seconds\)/);
  assert.match(index, /Duração: há quanto tempo o alerta está ativo/);
});
