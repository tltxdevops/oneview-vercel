/**
 * OV-P0-308 — Unified Incident Detail Drawer
 * Um único IncidentDetailDrawer em Home / Monitoramento / Chamados,
 * com card SN no drawer de alerta (descrição + Ver detalhe).
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

test("OV-P0-308: IncidentDetailDrawer único com Resumo / Alerta / Técnico", async () => {
  const [drawer, related, relatedIncidents, alias] = await Promise.all([
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
    read("src/components/oneview/IncidentRelatedAlertSection.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/IncidentQuickSheet.tsx"),
  ]);

  assert.match(drawer, /export function IncidentDetailDrawer/);
  assert.match(drawer, /sm:max-w-2xl/);
  assert.match(drawer, /TabsTrigger value="summary"/);
  assert.match(drawer, /TabsTrigger value="alert"/);
  assert.match(drawer, /TabsTrigger value="technical"/);
  assert.doesNotMatch(drawer, /TabsTrigger value="history"/);
  assert.match(drawer, /Detalhe do chamado/);
  assert.match(drawer, /OneViewIncidentStatusBadge/);
  assert.match(drawer, /buildProductionServiceNowIncidentLink/);
  assert.match(drawer, /Origem ServiceNow/);
  assert.match(drawer, /IncidentDetailActions/);
  assert.match(drawer, /sticky bottom-0/);
  assert.match(drawer, /ServiceNowDevLink/);
  assert.match(drawer, /fetchIncidentDetail/);
  assert.match(drawer, /IncidentRelatedAlertContent/);
  assert.match(drawer, /const relatedAlertState = useIncidentRelatedAlert\(resolved\)/);
  assert.doesNotMatch(drawer, /<IncidentRelatedAlertSection/);
  assert.match(drawer, /Detalhes adicionais/);
  assert.match(related, /export function useIncidentRelatedAlert/);
  assert.match(related, /export function IncidentRelatedAlertContent/);
  assert.match(related, /cache\/in-flight compartilhado de 8 s/);
  assert.match(related, /fetchIncidentRelatedAlert/);
  assert.match(related, /sourceEventId/);
  assert.match(related, /Alerta relacionado/);
  assert.match(related, /Sem alerta relacionado/);
  assert.match(related, /Este chamado não possui correlação com um alerta do OneView\./);
  assert.doesNotMatch(related, /new AbortController\(\)/);
  assert.doesNotMatch(relatedIncidents, /new AbortController\(\)/);
  assert.match(relatedIncidents, /in-flight\/cache curto do/);
  assert.match(alias, /IncidentDetailDrawer as IncidentQuickSheet/);
});

test("OV-P0-308: Home, Monitoring e Chamados importam o mesmo drawer", async () => {
  const [home, monitoring, chamados] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  for (const [name, source] of [
    ["Home", home],
    ["Monitoring", monitoring],
    ["Chamados", chamados],
  ]) {
    assert.match(source, /IncidentDetailDrawer/, name);
    assert.doesNotMatch(source, /SheetContent side="right"[\s\S]*Detalhe do chamado|SheetTitle className="font-mono text-lg"/, name);
  }

  assert.doesNotMatch(monitoring, /fetchIncidentRelatedAlert/);
  assert.doesNotMatch(chamados, /fetchIncidentRelatedAlert/);
  assert.match(monitoring, /Consulta rápida sem sair do Monitoramento/);
  assert.doesNotMatch(chamados, /IncidentOperationalActions/);
  assert.doesNotMatch(monitoring, /<IncidentActions/);
});

test("OV-P0-308: card SN do alerta expõe descrição e CTA de detalhe empilhado", async () => {
  const [section, alertDrawer, mapper] = await Promise.all([
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("api/_lib/oneview-alert-incidents.js"),
  ]);

  assert.match(section, /short_description/);
  assert.match(section, /Ver detalhe no OneView/);
  assert.match(section, /onOpenIncidentDetail/);
  assert.match(section, /relatedIncidentToOneViewIncident/);
  assert.match(alertDrawer, /IncidentDetailDrawer/);
  assert.match(alertDrawer, /onOpenIncidentDetail/);
  assert.match(alertDrawer, /nestedIncident/);
  assert.match(alertDrawer, /Consulta rápida sem sair do alerta/);
  assert.match(mapper, /short_description: item\.short_description/);
});
