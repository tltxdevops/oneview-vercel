import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyRuntimeDatasource, classifyRuntimeHealth, runtimeOverallStatus } from "../api/_lib/oneview-db.js";

const now = Date.parse("2026-08-21T12:00:00.000Z");
const at = (seconds) => new Date(now - seconds * 1000).toISOString();
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("OV-P0-165 canonical statuses cover datasource freshness and configuration", () => {
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: true, lastSuccessAt: at(60), intervalSeconds: 60, now }), "HEALTHY");
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: true, lastSuccessAt: at(150), intervalSeconds: 60, now }), "DEGRADED");
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: true, lastSuccessAt: at(240), intervalSeconds: 60, now }), "STALE");
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: true, lastSuccessAt: at(1), lastError: "TLS certificate failure", now }), "DOWN");
  assert.equal(classifyRuntimeHealth({ enabled: false, configured: true, now }), "READY_DISABLED");
  assert.equal(classifyRuntimeHealth({ enabled: false, configured: true, lastError: "TLS certificate failure", now }), "CONFIG_MISSING");
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: false, now }), "CONFIG_MISSING");
  assert.equal(classifyRuntimeHealth({ enabled: true, configured: true, now }), "UNKNOWN");
  assert.equal(runtimeOverallStatus([{ status: "HEALTHY" }, { status: "READY_DISABLED" }]), "HEALTHY");
});

test("OV-P0-166 separates activation blockers from historical disabled-source errors", () => {
  const historical = classifyRuntimeDatasource({ enabled: false, configured: true, lastError: "column alerts.scope does not exist", now });
  assert.deepEqual(historical, {
    status: "READY_DISABLED",
    currentError: null,
    lastHistoricalError: "column alerts.scope does not exist",
  });

  const tlsBlocker = classifyRuntimeDatasource({ enabled: false, configured: true, lastError: "TLS certificate failure", now });
  assert.equal(tlsBlocker.status, "CONFIG_MISSING");
  assert.equal(tlsBlocker.currentError, "TLS certificate failure");
  assert.equal(tlsBlocker.lastHistoricalError, null);

  const missingConfig = classifyRuntimeDatasource({ enabled: false, configured: false, now });
  assert.equal(missingConfig.status, "CONFIG_MISSING");
  assert.equal(missingConfig.currentError, null);
  assert.equal(missingConfig.lastHistoricalError, null);
});

test("OV-P0-165 runtime health is the single frontend health source", () => {
  const strip = read("src/components/oneview/PlatformHealthStrip.tsx");
  const settings = read("src/pages/Settings.tsx");
  const db = read("api/_lib/oneview-db.js");
  assert.match(strip, /fetchRuntimeHealth\(\)/);
  assert.match(settings, /fetchRuntimeHealth\(\)/);
  assert.match(db, /from data_sources d where coalesce\(d.type, 'zabbix'\) = 'zabbix'/);
  assert.match(db, /servicenow_sync_state/);
  assert.match(db, /integration_outbox/);
  assert.match(db, /READY_DISABLED/);
  assert.match(db, /fraport-poa/);
  assert.match(db, /ZABBIX_SOURCES_WITH_MISSING_RUNTIME_CONFIG/);
  assert.match(settings, /Erro atual:/);
  assert.match(settings, /Último erro histórico:/);
});
