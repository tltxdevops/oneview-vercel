import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-DASHBOARD: centraliza widgets, presets e persistência local V1", () => {
  const model = read("src/lib/oneview-dashboard-layout.ts");

  for (const page of ["home", "monitoring", "alerts", "incidents", "history", "operators"]) {
    assert.match(model, new RegExp(`"${page}"`), `página ausente: ${page}`);
  }
  for (const template of ["compact", "operational", "ultrawide", "wallboard"]) {
    assert.match(model, new RegExp(`\\b${template}\\b`), `preset ausente: ${template}`);
  }
  for (const field of ["id", "title", "minWidth", "minHeight", "defaultSize", "itemLimitOptions", "defaultItemLimit", "allowedPages"]) {
    assert.match(model, new RegExp(`\\b${field}\\b`), `contrato do widget ausente: ${field}`);
  }
  assert.match(model, /oneview\.dashboard-layout\.v\$\{ONEVIEW_DASHBOARD_LAYOUT_VERSION\}/);
  assert.match(model, /oneview\.dashboard-preferences\.v\$\{ONEVIEW_DASHBOARD_LAYOUT_VERSION\}/);
  assert.match(model, /window\.localStorage/);
  assert.match(model, /actorId/);
  assert.match(model, /applyOneViewDashboardTemplate/);
  assert.match(model, /repairOneViewDashboardLayout/);
  assert.match(model, /compactOneViewDashboardWidgets/);
  assert.match(model, /Array\.from\(\{ length: prepared\.length \}/);
  assert.match(model, /movable\[movableIndex\+\+\] \?\? prepared\[order\]/);
  assert.doesNotMatch(model, /Array\(prepared\.length\)/);
  assert.match(model, /pinned/);
  assert.match(model, /resetOneViewDashboardPreferences/);
  assert.match(model, /operational: \{[\s\S]*?"operational-summary": \{ width: 12, height: 2 \}/);
});

test("OV-DASHBOARD: editor direto oferece arrastar, resize pelo canto e conclusão visível", () => {
  const component = read("src/components/oneview/ConfigurableDashboard.tsx");
  const tokens = read("src/styles/oneview-design-tokens.css");

  assert.match(component, /onPointerDown=\{startDrag\}/);
  assert.match(component, /onPointerMove=\{continueDrag\}/);
  assert.match(component, /onPointerUp=\{finishDrag\}/);
  assert.match(component, /data-dashboard-widget-id=\{definition\.id\}/);
  assert.match(component, /setPreviewSize\(\{ width, height \}\)/);
  assert.doesNotMatch(component, /onDragStart=/);
  assert.match(component, /ov-dashboard-drag-handle/);
  assert.match(component, /ov-dashboard-resize-handle/);
  assert.match(component, /setPointerCapture/);
  assert.match(component, /onPointerMove=\{continueResize\}/);
  assert.match(component, /data-dashboard-width=\{width\}/);
  assert.match(component, /Mostrar menos itens em \$\{definition\.title\}/);
  assert.match(component, /Mostrar mais itens em \$\{definition\.title\}/);
  assert.match(component, /finishEditing/);
  assert.match(component, /ov-dashboard-finish-button/);
  assert.match(component, /controller\.setDraggedId\(null\)/);
  assert.doesNotMatch(component, /Diminuir largura de \$\{definition\.title\}/);
  assert.doesNotMatch(component, /Diminuir altura de \$\{definition\.title\}/);
  assert.doesNotMatch(component, /Mover \$\{definition\.title\} para antes/);
  assert.match(component, /Ajustar tamanho e posição/);
  assert.match(component, /Restaurar/);
  assert.match(component, /Sair do wallboard/);
  assert.match(component, /aria-label="Organizar painel"/);
  assert.match(component, /ov-dashboard-organize-fab/);
  assert.doesNotMatch(component, /Personalizar painel/);
  assert.match(component, /lastVisible/);
  assert.match(component, /draggedId/);
  assert.match(component, /compactOneViewDashboardWidgets/);
  assert.match(tokens, /min-width: 1024px.*max-width: 1279px/);
  assert.match(tokens, /min-width: 1280px/);
  assert.match(tokens, /--ov-dashboard-tablet-width/);
  assert.match(tokens, /ov-dashboard-resize-handle/);
  assert.match(tokens, /ov-dashboard-finish-button/);
  assert.match(tokens, /safe-area-inset-bottom/);
});

test("OV-DASHBOARD: telas operacionais compartilham o organizador responsivo", () => {
  const home = read("src/pages/Index.tsx");
  const monitoring = read("src/pages/Monitoring.tsx");
  const alerts = read("src/pages/Alerts.tsx");
  const incidents = read("src/pages/Chamados.tsx");
  const history = read("src/pages/Historico.tsx");
  const operators = read("src/pages/Operadoras.tsx");
  const appLayout = read("src/components/layout/AppLayout.tsx");
  const settings = read("src/pages/Settings.tsx");

  assert.match(home, /useOneViewDashboardLayout\(\{/);
  for (const slot of ["operational-summary", "recent-alerts", "incidents", "failed-links", "recent-events"]) {
    assert.match(home, new RegExp(`ConfigurableDashboardWidget id="${slot}"`), `slot Home ausente: ${slot}`);
  }
  assert.match(home, /visibleHomeAlerts/);
  assert.match(home, /visibleHomeIncidents/);
  assert.match(home, /operatorItemLimit/);
  assert.match(home, /visibleRecentEvents/);
  assert.match(home, /contentClassName="gap-2 p-3 lg:px-4"/);
  for (const [source, slots] of [
    [monitoring, ["operational-summary", "monitoring-queue", "incidents"]],
    [alerts, ["operational-summary", "alerts-table"]],
    [incidents, ["operational-summary", "incidents-table"]],
    [history, ["history-filters", "history-summary", "history-results"]],
    [operators, ["operators-summary", "operators-filters", "operators-queue"]],
  ]) {
    assert.match(source, /useOneViewDashboardLayout\(\{/);
    for (const slot of slots) assert.match(source, new RegExp(`ConfigurableDashboardWidget id="${slot}"`));
  }
  assert.doesNotMatch(monitoring, /COMMAND_CENTER_GRID/);
  assert.match(monitoring, /<PlatformHealthStrip \/>/);
  assert.match(appLayout, /wallboard\?: boolean/);
  assert.match(appLayout, /!wallboard \? <Sidebar/);
  assert.match(settings, /Preferências de painel/);
  assert.match(settings, /setOneViewDashboardPreferredTemplate\(page, template/);
  assert.match(settings, /resetOneViewDashboardPreferences/);
  for (const page of ["home", "monitoring", "alerts", "incidents", "history", "operators"]) {
    assert.match(settings, new RegExp(`\\["${page}"`));
  }
});

test("OV-DASHBOARD: Chamados oferece busca de tabela, filtros recolhíveis, colunas e resumo vivo", () => {
  const incidents = read("src/pages/Chamados.tsx");
  const metrics = read("src/components/oneview/CompactMetricStrip.tsx");
  const tableTools = read("src/components/oneview/ConfigurableTableTools.tsx");
  const tablePreferences = read("src/lib/oneview-table-preferences.ts");
  const tokens = read("src/styles/oneview-design-tokens.css");

  assert.match(incidents, /Buscar na tabela por INC, cliente ou descrição/);
  assert.match(incidents, /Filtros específicos/);
  assert.match(incidents, /ConfigurableTableColumns/);
  assert.match(incidents, /INCIDENT_COLUMN_OPTIONS/);
  assert.match(incidents, /useOneViewTableColumns/);
  assert.match(tableTools, /Colunas visíveis/);
  assert.match(tableTools, /draggable/);
  assert.match(tablePreferences, /oneview\.table\./);
  assert.match(incidents, /window\.setInterval\(refresh, 30_000\)/);
  assert.match(incidents, /setRefreshVersion/);
  assert.match(metrics, /data-tone/);
  assert.match(tokens, /ov-live-metric\[data-tone="danger"\]/);
});

test("OV-DASHBOARD: Home respeita preferência persistida e compartilha drag", () => {
  const controller = read("src/lib/oneview-dashboard-controller.ts");
  const app = read("src/App.tsx");
  assert.match(controller, /readOneViewDashboardPreferences\(actorId\)\.templates\[page\]/);
  assert.doesNotMatch(controller, /initialTemplate = "operational"/);
  assert.match(controller, /repairOneViewDashboardLayout\(next, widgets\)/);
  assert.match(controller, /draggedId/);
  const model = read("src/lib/oneview-dashboard-layout.ts");
  assert.match(model, /Preserve the user's order/);
  assert.match(model, /left\.item\.order - right\.item\.order/);
  assert.match(app, /Carregando tela/);
  assert.doesNotMatch(app, /fallback=\{null\}/);
});

test("OV-DASHBOARD: aplicar template preenche todos os slots com id", () => {
  const prepared = ["a", "b", "c", "d", "e"].map((id, order) => ({ id, order }));
  const slots = Array.from({ length: prepared.length }, () => null);
  let movableIndex = 0;
  const widgets = slots.map((item, order) => ({ ...(item ?? prepared[movableIndex++] ?? prepared[order]), order }));
  assert.equal(widgets.length, 5);
  assert.deepEqual(widgets.map((item) => item.id), ["a", "b", "c", "d", "e"]);

  const sparse = Array(prepared.length);
  const broken = sparse.map((item, order) => ({ ...(item ?? prepared[order]), order }));
  assert.equal(broken.filter((item) => item && item.id).length, 0);
});

test("OV-DASHBOARD: indicadores responsivos compartilham organizacao e preferencias", () => {
  const strip = read("src/components/oneview/ConfigurableMetricStrip.tsx");
  const preferences = read("src/lib/oneview-metric-strip-preferences.ts");
  const tokens = read("src/styles/oneview-design-tokens.css");

  assert.match(strip, /gridProfile\?: OneViewMetricGridProfile/);
  assert.match(strip, /gridClassName\?: string/);
  assert.match(strip, /gridProfile=\{gridProfile\}/);
  assert.match(strip, /gridClassName=\{gridClassName\}/);
  assert.match(preferences, /setVisible/);
  assert.match(preferences, /setSpan/);
  assert.match(preferences, /setRowSpan/);
  assert.match(preferences, /window\.localStorage/);
  assert.match(tokens, /@media \(max-width: 767px\)/);
  for (const [source, stripId] of [
    [read("src/pages/Index.tsx"), "home-summary"],
    [read("src/pages/Monitoring.tsx"), "monitoring-summary"],
    [read("src/pages/Alerts.tsx"), "alerts-summary"],
  ]) {
    assert.match(source, new RegExp(`stripId: "${stripId}"`));
    assert.match(source, /useOneViewMetricStrip/);
    assert.match(source, /<ConfigurableDashboard controller=\{dashboard\}[\s\S]*metricStrip=/);
    assert.match(source, /<ConfigurableMetricStrip[\s\S]*editable=\{dashboard\.isEditing\}/);
    assert.match(source, /gridProfile="twelve"/);
  }
});
