/**
 * OV-P0-81 — Histórico Operational Audit UX
 * Histórico = auditoria temporal (drawer unificado, aba Histórico, sem CTA “Abrir em Alertas”).
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

test("OV-P0-81: tabela Histórico mantém colunas de auditoria e abre drawer na linha", async () => {
  const historico = await read("src/pages/Historico.tsx");

  assert.match(historico, /<TableHead[^>]*>Cliente<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Severidade<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Host<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Problema<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Início<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>ACK<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Chamado<\/TableHead>/);
  assert.match(historico, /<TableHead[^>]*>Estado<\/TableHead>/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}/);
  assert.match(historico, /role="button"/);
  assert.match(historico, /cursor-pointer/);
  assert.match(historico, /HISTORY_RISK_PRESETS|applyHistoryRiskPreset/);
  assert.doesNotMatch(historico, /Abrir em Alertas/);
  assert.doesNotMatch(historico, /navigate\(|useNavigate\(/);
  assert.doesNotMatch(historico, /<TableHead className="text-right">Ação<\/TableHead>/);
});

test("OV-P0-81: drawer do Histórico abre aba Histórico com ênfase de auditoria", async () => {
  const [historico, drawer] = await Promise.all([
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);

  assert.match(historico, /AlertDetailDrawer/);
  assert.match(historico, /defaultTab="history"/);
  assert.match(historico, /auditEmphasis/);
  assert.match(historico, /Auditoria temporal do alerta/);
  assert.match(historico, /alertsQueueHref/);
  assert.match(historico, /Ver na fila de Alertas|from=historico/);
  assert.doesNotMatch(historico, /Abrir em Alertas/);

  assert.match(drawer, /defaultTab/);
  assert.match(drawer, /auditEmphasis/);
  assert.match(drawer, /alertsQueueHref/);
  assert.match(drawer, /Ocorrências anteriores/);
  assert.match(drawer, /label="Início"/);
  assert.match(drawer, /label="Recovery"/);
  assert.match(drawer, /label="Duração"/);
  assert.match(drawer, /label="ACK"/);
  assert.match(drawer, /Chamado/);
  assert.match(drawer, /Ver na fila de Alertas/);
  assert.doesNotMatch(drawer, /Abrir em Alertas/);
  assert.doesNotMatch(drawer, /Button[\s\S]{0,80}Ver na fila de Alertas/);
});

test("OV-P0-81: Home/Monitoramento/Alertas continuam com Resumo como aba padrão", async () => {
  const [home, monitoring, alerts, drawer] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);

  assert.match(drawer, /defaultTab = "summary"/);
  assert.doesNotMatch(home, /defaultTab="history"/);
  assert.doesNotMatch(monitoring, /defaultTab="history"/);
  assert.doesNotMatch(alerts, /defaultTab="history"/);
  assert.doesNotMatch(home, /auditEmphasis/);
  assert.doesNotMatch(monitoring, /auditEmphasis/);
  assert.doesNotMatch(alerts, /auditEmphasis/);
});
