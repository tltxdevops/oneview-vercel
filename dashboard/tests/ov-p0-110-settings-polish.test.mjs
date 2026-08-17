/**
 * OV-P0-110 — Settings polish: só Tema / Saúde / Fontes.
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

test("OV-P0-110 Settings: três blocos; sem auto-refresh; sem banner read-only; sem sync morto", async () => {
  const settings = await read("src/pages/Settings.tsx");

  assert.match(settings, />Tema</);
  assert.match(settings, /Saúde da automação/);
  assert.match(settings, /Fontes de dados/);
  assert.match(settings, /Último sync/);
  assert.match(settings, /Próximo esperado/);
  assert.match(settings, /Falhas seguidas/);
  assert.match(settings, /Recovery/);
  assert.match(settings, /Operacional/);
  assert.match(settings, /buildPlatformHealthSnapshot/);
  assert.match(settings, /fetchOperationsHealth/);
  assert.match(settings, /fetchOneViewHealth/);

  assert.doesNotMatch(settings, /Atualização automática/);
  assert.doesNotMatch(settings, /getStoredRefreshInterval|setStoredRefreshInterval/);
  assert.doesNotMatch(settings, /Intervalo em segundos/);
  assert.doesNotMatch(settings, /requestDataSourceSync/);
  assert.doesNotMatch(settings, /ONEVIEW_READ_ONLY_MESSAGE/);
  assert.doesNotMatch(settings, /Ações operacionais desabilitadas/);
  assert.doesNotMatch(settings, /Nenhum ACK real/);
  assert.doesNotMatch(settings, /border-warning\/40 bg-warning\/10/);
  assert.doesNotMatch(settings, /URL da API|Token configurado/);
  // Botão de sync manual removido do JSX (comentários de arquivo não contam).
  const jsx = settings.slice(settings.indexOf("export default function SettingsPage"));
  assert.doesNotMatch(jsx, /Solicitar sincronização/);
});

test("OV-P0-110 Fontes: colunas compactas de produto", async () => {
  const settings = await read("src/pages/Settings.tsx");
  assert.match(settings, />Fonte</);
  assert.match(settings, />Status</);
  assert.match(settings, /Sincronização habilitada/);
  assert.match(settings, /Último sucesso/);
  assert.match(settings, /Alertas ativos/);
  assert.match(settings, />Falhas</);
  assert.match(settings, /sourceDisplayName/);
});
