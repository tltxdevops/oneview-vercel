import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-UI-KIT: centraliza tokens, tema e catálogo semântico", () => {
  const css = read("src/styles/oneview-design-tokens.css");
  const catalog = read("src/lib/oneview-design-system.ts");
  const main = read("src/main.tsx");

  for (const token of [
    "--ov-color-background",
    "--ov-color-surface",
    "--ov-color-surface-muted",
    "--ov-color-border",
    "--ov-color-text-primary",
    "--ov-color-accent-blue",
    "--ov-color-recurrence",
    "--ov-font-body",
    "--ov-font-technical",
    "--ov-radius-control",
    "--ov-radius-surface",
    "--ov-radius-pill",
    "--ov-control-height-compact",
    "--ov-control-height-default",
    "--ov-table-header-height",
    "--ov-table-row-height",
    "--ov-space-4",
    "--ov-space-32",
  ]) {
    assert.match(css, new RegExp(token.replaceAll("-", "\\-")), `token ausente: ${token}`);
  }

  for (const status of [
    "monitoring-down",
    "monitoring-normalized",
    "incident-new",
    "incident-progress",
    "incident-waiting",
    "incident-resolved",
    "incident-closed",
    "incident-cancelled",
    "divergence",
    "recurrence",
    "classification-pending",
  ]) {
    assert.match(catalog, new RegExp(`\\b${status.replaceAll("-", "\\-")}\\b`), `status ausente: ${status}`);
  }

  assert.match(css, /\.dark\s*\{/);
  assert.match(main, /import "\.\/styles\/oneview-design-tokens\.css"/);
});

test("OV-UI-KIT: prioriza decisões e patterns antes de primitives", () => {
  const page = read("src/pages/UiKit.tsx");
  const sections = read("src/components/oneview/UiKitSections.tsx");

  for (const section of [
    "FOUNDATIONS",
    "COMPONENTS",
    "PATTERNS",
    "TEMPLATES",
    "SEMANTIC STATES",
    "ONEVIEW DESIGN RULES",
    "DESIGN DECISIONS",
    "Typography",
    "Accent",
    "Title Signature",
    "Navigation",
    "Buttons",
    "Forms",
    "Cards",
    "Inputs",
    "Select",
    "Search",
    "Checkbox",
    "TAB ≠ PILL ≠ BADGE",
    "Panel",
    "KPI",
    "Operational Table",
    "Drawer",
    "Modal",
    "Tooltip",
    "Dropdown",
    "Empty State",
    "Skeleton",
    "Feedback",
    "OLD / V1.1",
    "Health",
  ]) {
    assert.match(`${page}\n${sections}`, new RegExp(section.replace("/", "\\/")), `seção ausente: ${section}`);
  }

  for (const [number, title] of [
    ["01", "Page Header"],
    ["02", "Operational Page"],
    ["03", "Filter Bar"],
    ["04", "Operational Table"],
    ["05", "Drawer"],
    ["06", "Dashboard"],
    ["07", "Form"],
    ["09", "NOC Monitoring"],
  ]) assert.match(sections, new RegExp(`number="${number}" title="${title}"`), `pattern ausente: ${number} ${title}`);

  for (const template of ["Operational List", "Dashboard", "History/Search", "Incident Queue", "NOC Monitoring", "Settings/Form"]) {
    assert.match(sections, new RegExp(template.replace("/", "\\/")), `template ausente: ${template}`);
  }

  assert.match(sections, /OneViewKpiCard/);
  assert.match(sections, /Control states[\s\S]*Default[\s\S]*Focus[\s\S]*Disabled/);
  assert.match(sections, /NOC Monitoring[\s\S]*OperationalFilterBar, QuickFilters, SeverityStrip, NocGrid 60\/40, OperationalQueue e IncidentQueue/);
  assert.ok(page.indexOf('value: "patterns"') < page.indexOf('value: "components"'), "Patterns deve preceder Components");
  assert.doesNotMatch(`${page}\n${sections}`, /fetch\s*\(/, "UI Kit deve ser independente de dados e APIs");
  assert.doesNotMatch(`${page}\n${sections}`, /#[\da-fA-F]{3,8}\b/, "UI Kit não deve criar cores hex locais");
});

test("OV-UI-KIT: reduz decisões oficiais e isola compatibilidade legacy", () => {
  const catalog = read("src/lib/oneview-design-system.ts");
  const css = read("src/styles/oneview-design-tokens.css");
  const sections = read("src/components/oneview/UiKitSections.tsx");

  for (const token of ["CONTROL_RADIUS", "SURFACE_RADIUS", "PILL_RADIUS", "CONTROL_COMPACT", "CONTROL_DEFAULT", "16px", "18px", "24px", "information", "warning", "average", "high", "disaster"]) {
    assert.match(`${catalog}\n${css}\n${sections}`, new RegExp(token), `regra ausente: ${token}`);
  }

  const radiusBlock = catalog.match(/ONEVIEW_RADIUS_DECISIONS = \[([\s\S]*?)\] as const;/)?.[1] || "";
  const spacingBlock = catalog.match(/ONEVIEW_SPACING_TOKENS = \[([\s\S]*?)\] as const;/)?.[1] || "";
  const typographyBlock = catalog.match(/ONEVIEW_TYPOGRAPHY_TOKENS = \[([\s\S]*?)\] as const;/)?.[1] || "";

  assert.equal((radiusBlock.match(/name:/g) || []).length, 3);
  assert.equal((spacingBlock.match(/pixels:/g) || []).length, 6);
  assert.doesNotMatch(spacingBlock, /pixels:\s*20\b/);
  assert.equal((typographyBlock.match(/specification:/g) || []).length, 6);
  assert.doesNotMatch(typographyBlock, /card-title|table-row|table-header|small/);
  assert.match(catalog, /ONEVIEW_BUTTON_VARIANTS = \["Primary", "Secondary", "Ghost", "Danger"\]/);
  assert.match(catalog, /ONEVIEW_ACTION_COLORS/);
  assert.doesNotMatch(sections, />Outline</);
  assert.doesNotMatch(sections, />Link</);
  assert.match(sections, /Legacy \/ compatibility[\s\S]*<details>/);
  assert.match(catalog, /ONEVIEW_SEVERITY_CATALOG/);
  assert.match(catalog, /ONEVIEW_FEEDBACK_CATALOG/);
  assert.match(css, /\.ov-severity-badge/);
  assert.match(css, /\.ov-feedback-success/);
  assert.match(css, /\.ov-surface-official[\s\S]*box-shadow:\s*none/);
});

test("OV-UI-KIT: congela o contrato V1 e exige adoção na ordem oficial", () => {
  const catalog = read("src/lib/oneview-design-system.ts");
  const page = read("src/pages/UiKit.tsx");

  assert.match(catalog, /ONEVIEW OPERATIONAL UI v1\.1 IS FROZEN/);
  assert.match(catalog, /status:\s*"frozen"/);
  assert.match(catalog, /Reutilizar token oficial\.[\s\S]*Reutilizar componente oficial\.[\s\S]*Reutilizar Pattern oficial\./);
  assert.match(catalog, /atualizar primeiro \/ui-kit e depois consumir na página/);
  assert.match(catalog, /Legacy permanece somente por compatibilidade/);
  assert.match(page, /ONEVIEW_OPERATIONAL_UI_V1_1\.statement/);
});

test("OV-UI-KIT v1.1: oficializa fontes, assinatura, accent e feedback sem novas escalas", () => {
  const html = read("index.html");
  const tailwind = read("tailwind.config.ts");
  const css = read("src/styles/oneview-design-tokens.css");
  const components = read("src/components/oneview/OneViewDesignSystem.tsx");
  const sections = read("src/components/oneview/UiKitSections.tsx");

  assert.match(html, /family=JetBrains\+Mono/);
  assert.match(html, /family=Lato/);
  assert.doesNotMatch(html, /Poppins/);
  assert.match(tailwind, /sans:\s*\["Lato"/);
  assert.match(tailwind, /mono:\s*\["JetBrains Mono"/);
  assert.match(css, /\.ov-type-page-title\s*\{[^}]*var\(--ov-font-technical\)/);
  assert.match(css, /\.ov-type-body\s*\{[^}]*var\(--ov-font-body\)/);
  assert.match(css, /\.ov-semantic-badge-dot[\s\S]*0\.375rem/);
  assert.match(components, /export function SectionAccentTitle/);
  assert.match(components, /ov-title-signature-accent/);
  assert.match(components, /export function SemanticBadge/);
  assert.match(components, /export function OneViewFeedback/);
  assert.match(sections, /Success message[\s\S]*Warning message[\s\S]*Error message[\s\S]*Info message/);
  assert.match(sections, /Operational Overview[\s\S]*PageHeader, ContextBar, OperationalSummary, ActionGrid 60\/40/);
  assert.match(sections, /Links de operadoras[\s\S]*Eventos recentes/);
});

test("OV-UI-KIT: rota é lazy, autenticada e prefetchable sem item na sidebar", () => {
  const app = read("src/App.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const prefetch = read("src/lib/oneview-route-prefetch.ts");

  const protectedStart = app.indexOf('<Route element={<ProtectedRoute />}>');
  const uiKitRoute = app.indexOf('<Route path="/ui-kit"');
  const protectedEnd = app.indexOf("</Route>", uiKitRoute);

  assert.ok(protectedStart >= 0 && uiKitRoute > protectedStart && protectedEnd > uiKitRoute);
  assert.match(app, /lazy\(\(\) => import\("@\/pages\/UiKit"\)\)/);
  assert.doesNotMatch(sidebar, /name="UI Kit" to="\/ui-kit"/);
  assert.match(prefetch, /"\/ui-kit": \(\) => import\("@\/pages\/UiKit"\)/);
});
