import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("canonical Central route is /central-alertas and old paths redirect with query", () => {
  const app = read("src/App.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const helper = read("src/lib/central-alertas-path.ts");
  assert.match(helper, /CENTRAL_ALERTAS_PATH = "\/central-alertas"/);
  assert.match(helper, /export function centralAlertasHref/);
  assert.match(helper, /export function centralAlertasHistoryHref/);
  assert.match(app, /path=\{CENTRAL_ALERTAS_PATH\}/);
  assert.match(app, /path="\/alertas"/);
  assert.match(app, /path="\/alerts"/);
  assert.match(app, /path="\/historico"/);
  assert.match(app, /PreserveSearchRedirect to=\{CENTRAL_ALERTAS_PATH\}/);
  assert.match(app, /centralAlertasHref\(params\)/);
  assert.match(app, /params.set\("view", "history"\)/);
  assert.match(app, /recurrence_key/);
  assert.match(sidebar, /href: "\/central-alertas"/);
  assert.match(sidebar, /secondary: "Central de Alertas"/);
  assert.match(read("src/pages/Alerts.tsx"), /PageHeader title="Central de Alertas"/);
  assert.match(read("src/pages/Alerts.tsx"), /const dateField: AlertsDateField = "first_seen"/);
  assert.match(read("src/pages/Alerts.tsx"), /function formatQueueCount/);
  assert.match(read("src/pages/Alerts.tsx"), /readFiniteCount\(counts\[view\]\)/);
  assert.match(read("src/components/oneview/AlertSuppressAction.tsx"), /SUPPRESS_WRITES_ENABLED = false/);
  assert.match(read("src/components/oneview/OneViewErrorBoundary.tsx"), /error\.message/);
});
