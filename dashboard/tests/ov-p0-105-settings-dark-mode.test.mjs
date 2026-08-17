/**
 * OV-P0-105 — Settings Dark Mode Fix
 * Tokens de tema em Configurações + Input/Button/Card compartilhados.
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

test("OV-P0-105 Settings: Claro/Escuro com tokens; sem bg-gray/text-white/amber-50 fixos", async () => {
  const settings = await read("src/pages/Settings.tsx");

  assert.match(settings, /aria-pressed=\{theme === "light"\}/);
  assert.match(settings, /aria-pressed=\{theme === "dark"\}/);
  assert.match(settings, /bg-primary text-primary-foreground/);
  assert.match(settings, /bg-muted text-muted-foreground/);
  assert.match(settings, /hover:bg-accent hover:text-accent-foreground/);
  assert.match(settings, /focus-visible:ring-ring/);

  assert.match(settings, /border-border bg-card/);
  assert.match(settings, /text-card-foreground|text-foreground/);
  assert.match(settings, /text-muted-foreground/);
  assert.match(settings, /hover:bg-muted\/30/);
  assert.match(settings, /Atualizar/);
  assert.doesNotMatch(settings, /border-warning\/40 bg-warning\/10/);
  assert.doesNotMatch(settings, /bg-gray-100|bg-gray-50|text-white(?!-)|bg-white|text-black/);
  assert.doesNotMatch(settings, /bg-amber-50|border-amber-200|text-amber-800/);
  assert.doesNotMatch(settings, /bg-green-50|text-green-700|bg-red-50|text-red-700/);

  assert.match(settings, /bg-success\/10 text-success/);
  assert.match(settings, /bg-error\/10 text-error/);
});

test("OV-P0-105 shared Input/Button/Card usam tokens de tema", async () => {
  const [input, button, card] = await Promise.all([
    read("src/components/ui/input.tsx"),
    read("src/components/ui/button.tsx"),
    read("src/components/ui/card.tsx"),
  ]);

  assert.match(input, /bg-background/);
  assert.match(input, /text-foreground/);
  assert.match(input, /border-input/);
  assert.match(input, /placeholder:text-muted-foreground/);
  assert.match(input, /focus-visible:ring-ring/);
  assert.match(input, /disabled:opacity-50/);
  assert.doesNotMatch(input, /bg-white|text-black|bg-gray/);

  assert.match(button, /bg-primary text-primary-foreground/);
  assert.match(button, /disabled:opacity-50/);
  assert.match(button, /border-input bg-background text-foreground/);
  assert.match(button, /disabled:border-border disabled:text-muted-foreground/);
  assert.match(button, /hover:bg-muted\/40/);
  assert.doesNotMatch(button, /bg-white|text-black|bg-gray-100/);

  assert.match(card, /border-border bg-card text-card-foreground/);
  assert.doesNotMatch(card, /bg-white|text-black/);
});

test("OV-P0-105 escopo: não altera Home/Monitoramento/Alertas páginas", async () => {
  const [index, monitoring, alerts] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);

  assert.doesNotMatch(index, /OV-P0-105|THEME_TOGGLE_BASE|sourceStatusClass/);
  assert.doesNotMatch(monitoring, /OV-P0-105|THEME_TOGGLE_BASE|sourceStatusClass/);
  assert.doesNotMatch(alerts, /OV-P0-105|THEME_TOGGLE_BASE|sourceStatusClass/);
});

test("OV-P0-105 funcionalidade Settings preservada", async () => {
  const settings = await read("src/pages/Settings.tsx");

  assert.match(settings, /applyTheme\("light"\)/);
  assert.match(settings, /applyTheme\("dark"\)/);
  assert.match(settings, /setStoredTheme|getStoredTheme/);
  assert.match(settings, /fetchDataSourcesWithMeta/);
  assert.match(settings, /showHealthStrip=\{false\}/);
  assert.doesNotMatch(settings, /setStoredRefreshInterval|getStoredRefreshInterval/);
  assert.doesNotMatch(settings, /requestDataSourceSync/);
  assert.doesNotMatch(settings, /ONEVIEW_READ_ONLY_MESSAGE/);
});
