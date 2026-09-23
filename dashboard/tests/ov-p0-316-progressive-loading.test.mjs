import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-316: carregamento inicial evita consultas e bundles fora da tela ativa", async () => {
  const [app, home, chamados] = await Promise.all([
    read("src/App.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(app, /const SettingsPage = lazy\(\(\) => import\("@\/pages\/Settings"\)\)/);
  assert.match(home, /reuseCriticalAlertsForInitialListsRef/);
  assert.match(home, /if \(reuseCriticalAlerts\)/);
  assert.match(chamados, /if \(viewMode !== "duplicates"\) return;/);
});
