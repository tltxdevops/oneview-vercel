/**
 * OV-P0-112 — Histórico / Alertas / Drawer incident-aware.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-112 Histórico: colunas operacionais, ACK com ator/hora, linha abre drawer, sem Abrir", async () => {
  const historico = await read("src/pages/Historico.tsx");
  assert.match(historico, /<TableHead[^>]*>Cliente<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Severidade<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Host<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Problema<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Início<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>ACK<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Chamado<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Estado<\/TableHead>/);
  assert.match(historico, /Pendente/);
  assert.match(historico, /text-muted-foreground.*formatWhen\(ackAt\)|formatWhen\(ackAt\)/);
  assert.match(historico, /AlertServiceNowReferenceCell/);
  assert.match(historico, /defaultTab="history"/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}/);
  assert.doesNotMatch(historico, />\s*Abrir\s*</);
});

test("OV-P0-112 Alertas: coluna compacta Chamado com INC clicável", async () => {
  const [alerts, cell] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertServiceNowReferenceCell.tsx"),
  ]);
  assert.match(alerts, /<TableHead[^>]*>Chamado<\/TableHead>/);
  assert.match(alerts, /AlertServiceNowReferenceCell/);
  assert.match(alerts, /não limpa detail\/history|não zera detail\/history/);
  assert.match(cell, /stopPropagation/);
  assert.match(cell, /target="_blank"/);
  assert.match(cell, /extra_count/);
});

test("OV-P0-112 Drawer: chamado com INC clicável, skeleton só no detalhe, tags internas ocultas, timeline unificada", async () => {
  const [drawer, section, timeline] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/lib/oneview-alert-timeline.ts"),
  ]);

  assert.match(drawer, /AlertRelatedIncidentsSection/);
  assert.match(drawer, /buildAlertOperationalTimeline/);
  assert.match(drawer, /filterOperationalAlertTags/);
  assert.match(drawer, /aria-label="Timeline do alerta"/);
  assert.match(drawer, /Vínculo com ServiceNow|kind === "servicenow"/);
  assert.doesNotMatch(drawer, /setDetail\(null\).*fetchAlertHistory|setHistory\(null\).*loadSelectedAlert/);

  assert.match(section, /ProjectedIncidentCard/);
  assert.match(section, /Carregando detalhe do chamado/);
  assert.match(section, /target="_blank"/);
  assert.match(section, /Estado/);
  assert.match(section, /Prioridade/);
  assert.match(section, /Analista/);
  assert.match(section, /Grupo/);
  assert.match(section, /Última atualização/);
  assert.match(section, /servicenow_reference/);
  assert.doesNotMatch(section, /u_hostname_zabbix/);

  assert.match(timeline, /Abertura do alerta/);
  assert.match(timeline, /kind: "acknowledged"/);
  assert.match(timeline, /kind: "comment"/);
  assert.match(timeline, /Vínculo com ServiceNow/);
  assert.match(timeline, /kind: "recovery"/);
  assert.match(timeline, /internal_acknowledged/);
});

test("OV-P0-112 Técnico oculta __zbx_servicenow_*", async () => {
  const [drawer, filter] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/lib/oneview-inc-correlation.ts"),
  ]);
  assert.match(drawer, /collectOperationalTags/);
  assert.match(drawer, /filterOperationalAlertTags/);
  assert.match(filter, /INTERNAL_TAG_PREFIX/);
  assert.match(filter, /__zbx_/);
});
