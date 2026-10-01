/**
 * OV-P0-80 — Unified Alert Detail Drawer
 * Um único AlertDetailDrawer em Home / Monitoramento / Alertas / Histórico.
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

test("OV-P0-80: AlertDetailDrawer único com Resumo / Histórico / Técnico", async () => {
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");

  assert.match(drawer, /export function AlertDetailDrawer/);
  assert.match(drawer, /TabsTrigger value="summary"/);
  assert.match(drawer, /TabsTrigger value="history"/);
  assert.match(drawer, /TabsTrigger value="technical"/);
  assert.match(drawer, /aria-label="Cabeçalho do alerta"|ClientIdentity/);
  assert.match(drawer, /SeverityBadge/);
  assert.match(drawer, /ACK pendente|ACK/);
  assert.match(drawer, /Identidade/);
  assert.match(drawer, /Trigger\/Problema/);
  assert.match(drawer, /Primeira ocorrência/);
  assert.match(drawer, /Estado da origem/);
  assert.match(drawer, /ACK origem/);
  assert.match(drawer, /ACK OneView/);
  assert.match(drawer, /Fonte Zabbix/);
  assert.match(drawer, /Grupos e tags|host_groups/);
  assert.match(drawer, /Fonte da identidade do cliente|customer_source/);
  assert.match(drawer, /Confiança/);
  assert.match(drawer, /safeHostIp\(alert\.host_ip\)/);
  assert.match(drawer, /interfaceFromAlertTags/);
  assert.match(drawer, /AlertRelatedIncidentsSection/);
  assert.match(drawer, /Ocorrências anteriores/);
  assert.match(drawer, /filterOperationalAlertTags/);
  assert.doesNotMatch(drawer, /Atribuir|Comentar|disabled className="w-full"/);
  assert.doesNotMatch(drawer, /setDetail\(null\).*fetchAlertHistory|setHistory\(null\).*loadSelectedAlert/);
  assert.doesNotMatch(drawer, /Integração ServiceNow em preparação/);
  assert.doesNotMatch(drawer, /Abrir em Alertas/);
});

test("OV-P0-80: Resumo operacional não carrega dados técnicos", async () => {
  const summary = await read("src/components/oneview/AlertOperationalSummary.tsx");
  assert.match(summary, /aria-label="Resumo operacional"/);
  assert.match(summary, /\["Início"/);
  assert.match(summary, /\["Duração"/);
  assert.match(summary, /\["Última atualização"/);
  assert.doesNotMatch(summary, /Origem da classificação|Confiança da classificação/);
  assert.doesNotMatch(summary, /Fonte Zabbix|host_groups|safeHostIp\(alert/);
});

test("OV-P0-80: quatro páginas reutilizam AlertDetailDrawer e deep-link ?alert=", async () => {
  const [home, monitoring, alerts, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  for (const [name, source] of [
    ["Home", home],
    ["Monitoring", monitoring],
    ["Alerts", alerts],
    ["Historico", historico],
  ]) {
    assert.match(source, /AlertDetailDrawer/, name);
    assert.match(source, /searchParams\.get\("alert"\)/, name);
  }

  assert.match(home, /Consulta rápida sem sair da Home/);
  assert.match(monitoring, /Consulta rápida sem sair do Monitoramento/);
  assert.match(alerts, /Informações operacionais seguras/);
  assert.match(historico, /Consulta sem perder os filtros do Histórico|Auditoria temporal do alerta/);

  assert.match(home, /fetchAlertHistory/);
  assert.match(monitoring, /fetchAlertHistory/);
  assert.match(alerts, /fetchAlertHistory/);
  assert.match(historico, /fetchAlertHistory/);

  assert.doesNotMatch(home, /Abrir em Alertas/);
  assert.doesNotMatch(historico, /Abrir em Alertas/);
  assert.doesNotMatch(historico, /to=\{`\/alertas\?alert=/);
  assert.doesNotMatch(alerts, /Integração ServiceNow em preparação/);
  assert.doesNotMatch(alerts, /Atribuir|Comentar|disabled className="w-full"/);
});

test("OV-P0-80: rotas permanecem; Histórico abre drawer no clique", async () => {
  const [app, historico, monitoring] = await Promise.all([
    read("src/App.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Monitoring.tsx"),
  ]);

  assert.match(app, /path="\/"/);
  assert.match(app, /path="\/monitoramento"/);
  assert.match(app, /path="\/alertas"/);
  assert.match(app, /path="\/historico"/);
  assert.match(historico, /openAlertDetail/);
  assert.match(historico, /patchParams\(\{ alert: alertId \}\)/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}|onClick=\{\(\) => openAlertDetail\(item\.alert_id\)\}/);
  assert.match(monitoring, /path|\/monitoramento|MonitoringPage/);
});
