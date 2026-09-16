import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Alertas consumes only frozen Operational UI primitives for its migrated shell", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /OneViewKpiCard/);
  assert.match(alerts, /TabsList/);
  assert.match(alerts, /FilterBar/);
  assert.match(alerts, /OneViewPill/);
  assert.match(alerts, /OneViewSemanticStatusBadge/);
  assert.match(alerts, /className="ov-operational-table/);
  assert.match(alerts, /className="ov-control-official h-9/);
  assert.doesNotMatch(alerts, /CompactMetricStrip/);
  assert.doesNotMatch(alerts, /ov-filter-control|OV_FILTER_CONTROL/);
});

test("Alertas keeps all nine KPI filters in one official KPI row", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  for (const label of [
    "Em acompanhamento",
    "Reconhecidos",
    "Pendentes",
    "information",
    "warning",
    "average",
    "high",
    "disaster",
    "not_classified",
  ]) assert.match(alerts, new RegExp(label, "i"));

  assert.match(alerts, /const summaryCards = \[\.\.\.operationalCards, \.\.\.severityCards, notClassifiedCard\]/);
  assert.match(alerts, /2xl:grid-cols-9/);
  assert.doesNotMatch(alerts, /Severidade fora da faixa visual|border-dashed/);
});

test("Alertas preserves table columns and exposes the official detail action", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  for (const column of ["Severidade", "Cliente", "Host", "Problema", "Início", "Duração", "ACK", "Chamado", "Estado", "Ações"]) {
    assert.match(alerts, new RegExp(column));
  }
  assert.match(alerts, /aria-label="Ver detalhes"/);
  assert.match(alerts, /<Eye className="h-4 w-4" \/>/);
  assert.match(alerts, /<TooltipContent>Ver detalhes<\/TooltipContent>/);
  assert.match(alerts, /status=\{isActive \? "monitoring-down" : "monitoring-normalized"\}/);
});

test("Alertas leaves data, ACK and BFF behavior on the existing paths", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /fetchAlerts\(/);
  assert.match(alerts, /requestAlertAcknowledgement\(/);
  assert.match(alerts, /sourceAckPresentation\(alert\)/);
  assert.match(alerts, /datasources: selectedDatasources/);
  assert.match(alerts, /writeAlertsUrlParams/);
});
