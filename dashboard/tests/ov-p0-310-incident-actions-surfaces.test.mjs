/**
 * OV-P0-310 — IncidentActions V1 em todas as superfícies operacionais (drawer).
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

test("OV-P0-310: IncidentDetailDrawer centraliza ações sticky acima do ServiceNow", async () => {
  const drawer = await read("src/components/oneview/IncidentDetailDrawer.tsx");
  assert.match(drawer, /IncidentDetailActions/);
  assert.match(drawer, /sticky bottom-0/);
  assert.match(drawer, /ServiceNowDevLink/);
  assert.match(drawer, /buildAlertArtifactFromIncidentRelatedAlert/);
});

test("OV-P0-310: Home, Monitoring, Chamados e Alertas usam drawer compartilhado", async () => {
  const [home, monitoring, chamados, alertDrawer, operadoras] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/pages/Operadoras.tsx"),
  ]);

  assert.match(home, /IncidentDetailDrawer/);
  assert.match(monitoring, /IncidentDetailDrawer/);
  assert.match(chamados, /IncidentDetailDrawer/);
  assert.match(alertDrawer, /IncidentDetailDrawer/);
  assert.doesNotMatch(home, /<IncidentActions/);
  assert.doesNotMatch(monitoring, /<IncidentActions/);
  assert.doesNotMatch(chamados, /IncidentOperationalActions/);
  assert.match(alertDrawer, /buildAlertArtifactFromOneViewAlert/);
  assert.match(operadoras, /IncidentDetailActions/);
  assert.match(operadoras, /ServiceNowDevLink/);
  assert.doesNotMatch(operadoras, /<IncidentActions/);
});

test("OV-P0-310: IncidentActions expõe Mais ações e mensagem sem alerta relacionado", async () => {
  const actions = await read("src/components/oneview/IncidentActions.tsx");
  assert.match(actions, /Mais ações/);
  assert.match(actions, /Não há alerta relacionado disponível/);
  assert.match(actions, /placement/);
});

test("OV-P0-310: tabelas Home/Chamados/Alertas usam IncidentTableActionsCell; Histórico sem ações inline", async () => {
  const [home, chamados, alerts, historico, queue] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/OperationalIncidentsQueueList.tsx"),
  ]);

  assert.match(queue, /IncidentTableActionsCell/);
  assert.match(home, /onActionComplete/);
  assert.match(chamados, /IncidentTableActionsCell/);
  assert.match(alerts, /IncidentTableActionsCell/);
  assert.doesNotMatch(historico, /IncidentTableActionsCell/);
});
