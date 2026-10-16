import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("Central uses a defined canonical date field and accepts the legacy recent URL", () => {
  const alerts = read("src/pages/Alerts.tsx");
  assert.match(alerts, /const ALERTS_DATE_FIELD = "first_seen" as const/);
  assert.match(alerts, /explicit === "recent" \|\| explicit === "recentes"/);
  assert.match(alerts, /initialQuery\.getAll\("severity"\)/);
  assert.match(alerts, /applyDateFieldToFetchParams\(request, ALERTS_DATE_FIELD, dateBounds\)/);
  assert.doesNotMatch(alerts, /\[ackActorFilter, alertsView, dateField,/);
});

test("operational summary and temporal SQL join the canonical origin snapshot", () => {
  const database = read("api/_lib/oneview-db.js");
  const queue = read("api/_lib/oneview-operational-queue.js");
  assert.match(database, /const summarySql = `[\s\S]*?join data_sources d[\s\S]*?\$\{ORIGIN_SNAPSHOT_JOIN_SQL\}[\s\S]*?\$\{whereSql\}/);
  assert.match(database, /const temporalSql = `[\s\S]*?join data_sources d[\s\S]*?\$\{ORIGIN_SNAPSHOT_JOIN_SQL\}[\s\S]*?\$\{baseWhereSql\}/);
  assert.match(queue, /select distinct on \(sl\.data_source_id\)/);
  assert.match(queue, /origin_snap on origin_snap\.data_source_id = d\.id/);
  assert.doesNotMatch(queue, /where sl\.data_source_id = d\.id/);
});

test("legacy History is local-only and production redirects into Central", () => {
  const app = read("src/App.tsx");
  const flag = read("src/lib/legacy-history-route.ts");
  const boundary = read("src/components/oneview/OneViewErrorBoundary.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(flag, /import\.meta\.env\.DEV/);
  assert.match(flag, /VITE_ENABLE_LEGACY_HISTORY_PAGE/);
  assert.match(app, /legacyHistoryRouteEnabled \? lazy\(\(\) => import\("@\/pages\/Historico"\)\) : null/);
  assert.match(app, /HistoricoPage \? route\(<HistoricoPage \/>\) : <HistoricoRedirect \/>/);
  assert.match(app, /params\.set\("view", "history"\)/);
  assert.match(boundary, /legacyHistoryRouteEnabled \?/);
  assert.doesNotMatch(sidebar, /href: "\/historico"/);
});

test("suppression writes remain disabled", () => {
  assert.match(read("src/components/oneview/AlertSuppressAction.tsx"), /SUPPRESS_WRITES_ENABLED = false/);
});
