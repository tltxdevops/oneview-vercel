import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

test("Central uses a defined canonical date field and accepts the legacy recent URL", () => {
  const alerts = read("src/pages/Alerts.tsx");
  assert.match(alerts, /const ALERTS_DATE_FIELD = "first_seen" as const/);
  assert.match(alerts, /explicit === "recent" \|\| explicit === "recentes"/);
  assert.match(alerts, /initialQuery\.getAll\("severity"\)/);
  assert.match(alerts, /applyDateFieldToFetchParams\(request, dateField, dateBounds\)/);
  assert.match(alerts, /\[ackActorFilter, alertsView, dateField,/);
});

test("operational reads, including drawer detail, join the canonical origin snapshot", () => {
  const database = read("api/_lib/oneview-db.js");
  const queue = read("api/_lib/oneview-operational-queue.js");
  assert.match(database, /const summarySql = `[\s\S]*?join data_sources d[\s\S]*?\$\{ORIGIN_SNAPSHOT_JOIN_SQL\}[\s\S]*?\$\{whereSql\}/);
  assert.match(database, /const temporalSql = `[\s\S]*?join data_sources d[\s\S]*?\$\{ORIGIN_SNAPSHOT_JOIN_SQL\}[\s\S]*?\$\{baseWhereSql\}/);
  assert.match(database, /async function fetchAlertDetailPayload[\s\S]*?join data_sources d[\s\S]*?\$\{ORIGIN_SNAPSHOT_JOIN_SQL\}[\s\S]*?where a\.id = \$1/);
  assert.match(database, /async function fetchAlertDetailPayload[\s\S]*?origin_snap\.origin_snapshot_complete[\s\S]*?payload_origin_seen_in_complete_snapshot[\s\S]*?d\.last_sync_status/);
  assert.match(queue, /left join lateral/);
  assert.match(queue, /order by sl\.started_at desc, sl\.id desc/);
  assert.match(queue, /limit 1/);
  assert.match(queue, /offset 0/);
  assert.doesNotMatch(queue, /select distinct on \(sl\.data_source_id\)/);
  assert.match(queue, /origin_snap on origin_snap\.data_source_id = d\.id/);
  assert.match(queue, /where sl\.data_source_id = d_snap\.id/);
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

test("Central keeps suppression in the drawer and never as a row quick action", () => {
  const alerts = read("src/pages/Alerts.tsx");
  const drawer = read("src/components/oneview/AlertDetailDrawer.tsx");
  assert.doesNotMatch(alerts, /AlertSuppressAction/);
  assert.match(drawer, /AlertSuppressAction/);
  assert.match(drawer, /Confirmação da origem/);
});

test("safe snapshot fails closed into review instead of inventing current activity", () => {
  const fallback = read("api/_lib/oneview-fallback.js");
  assert.match(fallback, /origin_activity_confirmed: false/);
  assert.match(fallback, /state: "unknown",\s*stale: true/);
  assert.match(fallback, /snapshot_available: false/);
});

test("source ACK clock accepts ACK events only; suppression action 36 is not ACK", () => {
  const database = read("api/_lib/oneview-db.js");
  assert.match(database, /action_type, ''\)\) in \('acknowledged', 'ack_message'\)/);
  assert.doesNotMatch(database, /action_type[^\n]*36/);
});
