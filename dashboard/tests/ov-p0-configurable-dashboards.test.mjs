import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-DASHBOARD: centraliza widgets, presets e persistência local V1", () => {
  const model = read("src/lib/oneview-dashboard-layout.ts");

  for (const page of ["home", "monitoring"]) {
    assert.match(model, new RegExp(`"${page}"`), `página ausente: ${page}`);
  }
  for (const template of ["compact", "operational", "ultrawide", "wallboard"]) {
    assert.match(model, new RegExp(`\\b${template}\\b`), `preset ausente: ${template}`);
  }
  for (const field of ["id", "title", "minWidth", "minHeight", "defaultSize", "allowedPages"]) {
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

test("OV-DASHBOARD: editor oferece arrastar, resize, ocultar, fixar e reset", () => {
  const component = read("src/components/oneview/ConfigurableDashboard.tsx");

  assert.match(component, /draggable=\{editable && !item\.pinned\}/);
  assert.match(component, /onDragStart=/);
  assert.match(component, /onDrop=/);
  assert.match(component, /Largura \$\{preset\.label\}/);
  assert.match(component, /label: "1\/2"/);
  assert.match(component, /Cheia/);
  assert.match(component, /Altura \$\{label\}/);
  assert.match(component, /Ajustar tamanho e posição/);
  assert.match(component, /Ocultar/);
  assert.match(component, /Fixar/);
  assert.match(component, /Restaurar/);
  assert.match(component, /Sair do wallboard/);
  assert.match(component, /aria-label="Organizar painel"/);
  assert.doesNotMatch(component, /Personalizar painel/);
  assert.match(component, /lastVisible/);
  assert.match(component, /draggedId/);
  assert.match(component, /compactOneViewDashboardWidgets/);
});

test("OV-DASHBOARD: Home é configurável; Monitoramento preserva o fluxo NOC estável", () => {
  const home = read("src/pages/Index.tsx");
  const monitoring = read("src/pages/Monitoring.tsx");
  const appLayout = read("src/components/layout/AppLayout.tsx");
  const settings = read("src/pages/Settings.tsx");

  assert.match(home, /useOneViewDashboardLayout\(\{/);
  for (const slot of ["operational-summary", "recent-alerts", "incidents", "failed-links", "recent-events"]) {
    assert.match(home, new RegExp(`ConfigurableDashboardWidget id="${slot}"`), `slot Home ausente: ${slot}`);
  }
  assert.doesNotMatch(monitoring, /ConfigurableDashboardWidget|useOneViewDashboardLayout/);
  assert.match(monitoring, /COMMAND_CENTER_GRID/);
  assert.match(monitoring, /grid-cols-\[minmax\(0,60fr\)_minmax\(0,40fr\)\]/);
  assert.match(monitoring, /<PlatformHealthStrip \/>/);
  assert.match(appLayout, /wallboard\?: boolean/);
  assert.match(appLayout, /!wallboard \? <Sidebar/);
  assert.match(settings, /Preferências de painel/);
  assert.match(settings, /setOneViewDashboardPreferredTemplate\("home"/);
  assert.match(settings, /resetOneViewDashboardPreferences/);
  assert.match(settings, /Operacional fixo/);
});

test("OV-DASHBOARD: Home respeita preferência persistida e compartilha drag", () => {
  const controller = read("src/lib/oneview-dashboard-controller.ts");
  const app = read("src/App.tsx");
  assert.match(controller, /readOneViewDashboardPreferences\(actorId\)\.templates\[page\]/);
  assert.doesNotMatch(controller, /initialTemplate = "operational"/);
  assert.match(controller, /repairOneViewDashboardLayout\(next, widgets\)/);
  assert.match(controller, /draggedId/);
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
