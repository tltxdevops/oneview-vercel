/**
 * OV-P0-105 — Settings Dark Mode Fix
 * Tokens de tema na Sidebar + Input/Button/Card compartilhados.
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

test("OV-P0-105 Sidebar: toggle Claro/Escuro com setStoredTheme e aria-pressed", async () => {
  const [sidebar, icons] = await Promise.all([
    read("src/components/layout/Sidebar.tsx"),
    read("src/lib/oneview-icons.ts"),
  ]);

  assert.match(sidebar, /aria-pressed=\{theme === "dark"\}/);
  assert.match(sidebar, /setStoredTheme/);
  assert.match(sidebar, /getStoredTheme/);
  assert.match(sidebar, /Ativar modo escuro/);
  assert.match(sidebar, /Ativar modo claro/);
  assert.match(sidebar, /ONEVIEW_ICON_MAP\.themeDark/);
  assert.match(sidebar, /ONEVIEW_ICON_MAP\.themeLight/);
  assert.match(icons, /themeDark:\s*Moon/);
  assert.match(icons, /themeLight:\s*Sun/);
});

test("OV-P0-105 Settings: sem card de tema; tokens sem bg-gray/text-white/amber-50 fixos", async () => {
  const settings = await read("src/pages/Settings.tsx");

  assert.doesNotMatch(settings, /aria-pressed=\{theme === "light"\}/);
  assert.doesNotMatch(settings, /applyTheme/);
  assert.doesNotMatch(settings, /getStoredTheme|setStoredTheme/);
  assert.doesNotMatch(settings, /<h2[^>]*>Tema<\/h2>/);

  assert.match(settings, /SectionPanel/);
  assert.match(settings, /ov-panel/);
  assert.match(settings, /text-card-foreground|text-foreground/);
  assert.match(settings, /text-muted-foreground/);
  assert.match(settings, /hover:bg-muted\/30/);
  assert.match(settings, /Atualizar/);
  assert.doesNotMatch(settings, /border-warning\/40 bg-warning\/10/);
  assert.doesNotMatch(settings, /bg-gray-100|bg-gray-50|text-white(?!-)|bg-white|text-black/);
  assert.doesNotMatch(settings, /bg-amber-50|border-amber-200|text-amber-800/);
  assert.doesNotMatch(settings, /bg-green-50|text-green-700|bg-red-50|text-red-700/);

  assert.match(settings, /ov-status-monitoring-normalized/);
  assert.match(settings, /ov-status-monitoring-down/);
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

  assert.match(settings, /fetchDataSourcesWithMeta/);
  assert.doesNotMatch(settings, /showHealthStrip=\{false\}/);
  assert.doesNotMatch(settings, /setStoredRefreshInterval|getStoredRefreshInterval/);
  assert.doesNotMatch(settings, /requestDataSourceSync/);
  assert.doesNotMatch(settings, /ONEVIEW_READ_ONLY_MESSAGE/);
});
