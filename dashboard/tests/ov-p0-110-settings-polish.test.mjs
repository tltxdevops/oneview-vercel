/**
 * OV-P0-110 — Settings: usuário primeiro; saúde compacta com Expandir; Ajuda.
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

test("OV-P0-110 Settings: preferências primeiro; saúde atrás de Expandir; Ajuda Webex", async () => {
  const settings = await read("src/pages/Settings.tsx");

  const conta = settings.indexOf('title="Conta"');
  const painel = settings.indexOf('title="Preferências de painel"');
  const notificacoes = settings.indexOf('title="Notificações"');
  const saude = settings.indexOf('title="Saúde"');
  const ajuda = settings.indexOf('title="Ajuda"');

  assert.ok(conta >= 0, "seção Conta ausente");
  assert.ok(painel > conta, "Preferências de painel deve vir depois de Conta");
  assert.ok(notificacoes > painel, "Notificações deve vir depois de Preferências de painel");
  assert.ok(saude > notificacoes, "Saúde deve vir depois de Notificações");
  assert.ok(ajuda > saude, "Ajuda deve vir depois de Saúde");

  assert.match(settings, /Collapsible/);
  assert.match(settings, /healthExpanded \? "Recolher" : "Expandir"/);
  assert.match(settings, /healthExpanded/);
  assert.match(settings, /Último sync/);
  assert.match(settings, /fetchRuntimeHealth/);
  assert.match(settings, /operationalToneFromGroup/);

  assert.match(settings, /guilherme\.franco/);
  assert.match(settings, /Problemas de desenvolvimento/);

  assert.doesNotMatch(settings, /Saúde da automação/);
  assert.doesNotMatch(settings, /buildPlatformHealthSnapshot/);
  assert.doesNotMatch(settings, /fetchOperationsHealth/);
  assert.doesNotMatch(settings, /fetchOneViewHealth/);
  assert.doesNotMatch(settings, /fetchSyncLogs/);

  assert.doesNotMatch(settings, /Atualização automática/);
  assert.doesNotMatch(settings, /getStoredRefreshInterval|setStoredRefreshInterval/);
  assert.doesNotMatch(settings, /Intervalo em segundos/);
  assert.doesNotMatch(settings, /requestDataSourceSync/);
  assert.doesNotMatch(settings, /ONEVIEW_READ_ONLY_MESSAGE/);
  assert.doesNotMatch(settings, /Ações operacionais desabilitadas/);
  assert.doesNotMatch(settings, /Nenhum ACK real/);
  assert.doesNotMatch(settings, /border-warning\/40 bg-warning\/10/);
  assert.doesNotMatch(settings, /URL da API|Token configurado/);
  const jsx = settings.slice(settings.indexOf("export default function SettingsPage"));
  assert.doesNotMatch(jsx, /Solicitar sincronização/);
  assert.doesNotMatch(jsx, /dataSource=\{dataSource\}/);
  assert.doesNotMatch(jsx, /checkedAt=\{checkedAt\}/);
});

test("OV-P0-110 Fontes: colunas compactas de produto no detalhe expandido", async () => {
  const settings = await read("src/pages/Settings.tsx");
  assert.match(settings, /Fontes de dados/);
  assert.match(settings, /label="Fonte"/);
  assert.match(settings, /label="Status"/);
  assert.match(settings, /Sincronização habilitada/);
  assert.match(settings, /Último sucesso/);
  assert.match(settings, /Alertas ativos/);
  assert.match(settings, /label="Falhas"/);
  assert.match(settings, /sourceDisplayName/);
  assert.match(settings, /CollapsibleContent/);
});
