import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-TABLES: shared tools persist visibility and draggable order per actor", () => {
  const tools = read("src/components/oneview/ConfigurableTableTools.tsx");
  const preferences = read("src/lib/oneview-table-preferences.ts");

  assert.match(tools, /ConfigurableTableToolbar/);
  assert.match(tools, /ConfigurableTableColumns/);
  assert.match(tools, /draggable/);
  assert.match(tools, /controller\.reorder/);
  assert.match(tools, /controller\.move/);
  assert.match(tools, /Filtros específicos/);
  assert.match(preferences, /oneview\.table\.\$\{tableId\}/);
  assert.match(preferences, /actorId/);
  assert.match(preferences, /column\.required \? true/);
  assert.match(preferences, /window\.localStorage/);
  assert.match(preferences, /normalizePreferences/);
  assert.match(preferences, /readyStorageKey/);
});

test("OV-TABLES: every operational data surface exposes direct search and columns", () => {
  const expectations = [
    ["src/pages/Index.tsx", "home-events"],
    ["src/pages/Index.tsx", "home-alerts"],
    ["src/pages/Index.tsx", "home-incidents"],
    ["src/pages/Index.tsx", "home-operators"],
    ["src/pages/Monitoring.tsx", "monitor-alerts"],
    ["src/pages/Monitoring.tsx", "monitor-incidents"],
    ["src/pages/Alerts.tsx", "alerts"],
    ["src/pages/Historico.tsx", "history-alerts"],
    ["src/pages/Historico.tsx", "history-events"],
    ["src/pages/Chamados.tsx", "incidents"],
    ["src/pages/Operadoras.tsx", "operator-links"],
  ];
  for (const [path, tableId] of expectations) {
    const source = read(path);
    assert.match(source, new RegExp(`tableId: "${tableId}"`), `${path} sem preferência de ${tableId}`);
    assert.match(source, /ConfigurableTable(?:Toolbar|Columns)/, `${path} sem ferramentas de tabela`);
  }
});

test("OV-METRICS: cards keep the requested compact bordered design", () => {
  const compact = read("src/components/oneview/CompactMetricStrip.tsx");
  const design = read("src/components/oneview/OneViewDesignSystem.tsx");
  const css = read("src/styles/oneview-design-tokens.css");

  assert.match(compact, /surface = false/);
  assert.match(design, /ov-surface ov-kpi-official/);
  assert.match(css, /\.ov-live-metric \{[\s\S]*?min-height: 5\.5rem;[\s\S]*?border: 1px solid/);
  assert.match(css, /\.ov-surface\.ov-kpi-official \{[\s\S]*?min-height: 5\.5rem/);
  assert.doesNotMatch(css, /\.ov-kpi-official\[data-tone=.*border-top-color/);
  assert.match(css, /\.ov-live-metric\[data-tone="danger"\] \.ov-live-metric-value/);
  assert.doesNotMatch(compact, /ov-live-metric-selected/);
  assert.doesNotMatch(design, /ring-1 ring-\[hsl\(var\(--ov-color-accent-blue\)\)\]/);
});

test("OV-LAYOUT: display mode removes artificial widget height and packs gaps", () => {
  const css = read("src/styles/oneview-design-tokens.css");
  assert.match(css, /\.ov-dashboard-widget > \.ov-panel,[\s\S]*?min-height: 0/);
  assert.match(css, /grid-auto-flow: dense/);
  assert.match(css, /\.ov-dashboard-widget-editing \{ min-height: calc\(var\(--ov-dashboard-height/);
  assert.doesNotMatch(css, /\.ov-dashboard-widget \{[^}]*min-height: calc/);
});
