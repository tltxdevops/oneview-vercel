import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Alertas consumes only frozen Operational UI primitives for its migrated shell", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /ConfigurableMetricStrip/);
  assert.match(alerts, /TabsList/);
  assert.match(alerts, /ConfigurableTableToolbar/);
  assert.match(alerts, /OneViewPill/);
  assert.match(alerts, /OneViewSemanticStatusBadge/);
  assert.match(alerts, /ov-operational-table/);
  assert.match(alerts, /searchLabel="Buscar na tabela de alertas"/);
  assert.doesNotMatch(alerts, /CompactMetricStrip/);
  assert.doesNotMatch(alerts, /ov-filter-control|OV_FILTER_CONTROL/);
});

test("Alertas keeps operational queues and severity KPIs in one official row", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  for (const label of [
    "Em acompanhamento",
    "Pendentes de ação",
    "Suprimidos",
    "Sem confirmação",
    "information",
    "warning",
    "average",
    "high",
    "disaster",
    "not_classified",
  ]) assert.match(alerts, new RegExp(label, "i"));

  assert.match(alerts, /const summaryCards = \[\.\.\.operationalCards, \.\.\.severityCards, notClassifiedCard\]/);
  assert.match(alerts, /gridProfile="twelve"/);
  assert.doesNotMatch(alerts, /Severidade fora da faixa visual|border-dashed/);
});

test("Alertas keeps Cliente in the collapsed table filters instead of crowding the topbar", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /clientSelect=\{<PageHeader title="Central de Alertas" \/>\}/);
  assert.doesNotMatch(alerts, /<PageHeader title="Central de Alertas" aside=\{clientSelector\}/);
  assert.match(alerts, /<ConfigurableTableToolbar[\s\S]*?filters=\{\([\s\S]*?Cliente\{clientSelector\}/);
});

test("Alertas keeps rendering when a stale filtered response contains an invalid item", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /candidateItems\.filter\(\(item\): item is OneViewAlert => Boolean\(item && typeof item === "object"\)\)/);
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

test("Alertas keeps claim, source ACK and details as fixed quick actions and full actions in the drawer", async () => {
  const [alerts, alertDrawer, detailActions, actions] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/IncidentDetailActions.tsx"),
    read("src/components/oneview/IncidentActions.tsx"),
  ]);

  assert.match(alerts, /const ALERT_QUICK_INCIDENT_ACTIONS = \["claim"\] as const/);
  assert.match(alerts, /visibleActions=\{ALERT_QUICK_INCIDENT_ACTIONS\}/);
  assert.match(alerts, /<AlertSourceAckRowAction/);
  assert.match(alerts, /aria-label="Ver detalhes"/);
  assert.doesNotMatch(alerts, /<AlertTableActionPicker/);
  assert.doesNotMatch(alerts, /<AlertOperatorLinkControls/);
  assert.match(actions, /aria-label="Assumir chamado"/);
  assert.match(actions, /fetchIncidentDetail\(incident\.sys_id\)/);
  assert.match(actions, /Consulta o estado do chamado ao clicar/);
  assert.match(alertDrawer, /<IncidentDetailDrawer/);
  assert.equal(detailActions.match(/visibleActions=\{visibleActions\}/g)?.length, 1);
  assert.match(detailActions, /<IncidentActions\s+incident=\{incident\}\s+alertArtifact=\{alertArtifact\}\s+placement=\{placement\}\s+onClaimed=/);
});

test("Alertas leaves data, ACK and BFF behavior on the existing paths", async () => {
  const alerts = await read("src/pages/Alerts.tsx");

  assert.match(alerts, /fetchAlerts\(/);
  assert.match(alerts, /requestAlertAcknowledgement\(/);
  assert.match(alerts, /sourceAckPresentation\(alert\)/);
  assert.doesNotMatch(alerts, /datasources: selectedDatasources|ZabbixSourceFilter|Campo de data/);
  assert.match(alerts, /dateField: "first_seen"/);
  assert.match(alerts, /OperationalFacetMultiSelect/);
  assert.match(alerts, /writeAlertsUrlParams/);
});
