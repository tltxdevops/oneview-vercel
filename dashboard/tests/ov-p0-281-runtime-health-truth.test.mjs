import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  SILENT_BADGE,
  classifyActiveTruth,
  classifyCustomerIntegrity,
  classifyHostRegistry,
  classifyLinkHealth,
  classifyServiceNowWriteReadiness,
  classifyWriteReadiness,
  classifyZabbixSourceTruth,
  fraportProbeForSource,
} from "../api/_lib/oneview-runtime-health-truth.js";

const now = Date.parse("2026-09-02T20:00:00.000Z");
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("OV-P0-281 current successful FOR sync is healthy without replaying a historical TLS probe", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "fraport-for",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastSyncAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-09-02T19:50:00.000Z",
    intervalSeconds: 60,
    failureCount: 0,
    probe: fraportProbeForSource("fraport-for"),
    now,
  });
  assert.equal(truth.status, "HEALTHY");
  assert.equal(truth.cause, null);
  assert.equal(truth.dimensions.SYNC_PROCESS.status, "HEALTHY");
  assert.equal(truth.dimensions.SOURCE_CONNECTIVITY.status, "HEALTHY");
  assert.equal(truth.dimensions.TCP.status, "HEALTHY");
  assert.equal(truth.dimensions.API.status, "HEALTHY");
  assert.equal(truth.dimensions.AUTH.status, "HEALTHY");
  assert.equal(truth.dimensions.TLS_STRICT.status, "UNKNOWN");
  assert.equal(truth.dimensions.TLS_INSECURE.status, "UNKNOWN");
  assert.equal(truth.recommended_action, null);
});

test("OV-P0-281 current successful POA sync follows the same live-evidence contract", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "fraport-poa",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-09-02T19:50:00.000Z",
    intervalSeconds: 60,
    failureCount: 0,
    probe: fraportProbeForSource("fraport-poa"),
    now,
  });
  assert.equal(truth.status, "HEALTHY");
  assert.equal(truth.cause, null);
});

test("OV-P0-281 a current explicit Fraport TLS failure still degrades health", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "fraport-for",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-09-02T19:50:00.000Z",
    intervalSeconds: 60,
    failureCount: 0,
    probe: fraportProbeForSource("fraport-for", {
      tcp: "HEALTHY",
      api: "HEALTHY",
      auth: "HEALTHY",
      tls_strict: "FAILED",
      cause: "TLS_HOSTNAME_MISMATCH+PRIVATE_CA_NOT_IN_SYSTEM_TRUST",
      checked_at: "2026-09-02T19:59:30.000Z",
    }),
    now,
  });
  assert.equal(truth.status, "DEGRADED");
  assert.equal(truth.dimensions.TLS_STRICT.status, "DEGRADED");
  assert.equal(truth.cause, "TLS_HOSTNAME_MISMATCH+PRIVATE_CA_NOT_IN_SYSTEM_TRUST");
});

test("OV-P0-281 false-green: sync success + silent source keeps STALE badge", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "castrolanda",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-08-26T14:06:50.000Z",
    lastSourceEventAt: "2026-08-26T14:06:50.000Z",
    intervalSeconds: 60,
    failureCount: 0,
    now,
  });
  assert.equal(truth.status, "STALE");
  assert.equal(truth.badge, SILENT_BADGE);
  assert.equal(truth.dimensions.SYNC_PROCESS.status, "HEALTHY");
  assert.equal(truth.dimensions.SOURCE_CONNECTIVITY.status, "HEALTHY");
  assert.equal(truth.dimensions.SOURCE_API.status, "HEALTHY");
  assert.match(truth.detail, /nenhum novo evento existe no Zabbix/i);
  assert.doesNotMatch(String(truth.detail), /worker atrasado|sync falhou/i);
});

test("OV-P0-281 false-green: sync success + active truth mismatch is DEGRADED", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "teletex-http",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-09-02T19:50:00.000Z",
    intervalSeconds: 60,
    failureCount: 0,
    activeTruth: {
      source_active: 10,
      db_active: 8,
      missing: 2,
      extra: 0,
      extra_explained: 0,
    },
    now,
  });
  assert.equal(truth.status, "DEGRADED");
  assert.equal(truth.dimensions.ACTIVE_TRUTH.status, "DEGRADED");
  assert.equal(truth.dimensions.SYNC_PROCESS.status, "HEALTHY");
});

test("OV-P0-281 active truth explains live extras from 286A without DEGRADED", () => {
  const explained = classifyActiveTruth({
    sourceActive: 100,
    dbActive: 120,
    missing: 0,
    extra: 20,
    extraExplained: 20,
  });
  assert.equal(explained.dimension.status, "HEALTHY");
  assert.equal(explained.metrics.EXTRA_EXPLAINED, 20);

  const unexplained = classifyActiveTruth({
    sourceActive: 100,
    dbActive: 90,
    missing: 10,
    extra: 0,
    extraExplained: 0,
  });
  assert.equal(unexplained.dimension.status, "DEGRADED");
});

test("OV-P0-281 recovered FOR sync supersedes a historical persisted error", () => {
  const truth = classifyZabbixSourceTruth({
    sourceName: "fraport-for",
    enabled: true,
    configured: true,
    lastSuccessAt: "2026-09-02T19:59:00.000Z",
    lastDbEventAt: "2026-09-02T19:50:00.000Z",
    intervalSeconds: 60,
    lastError: "previous temporary unreachable",
    failureCount: 0,
    probe: fraportProbeForSource("fraport-for"),
    now,
  });
  assert.equal(truth.dimensions.TCP.status, "HEALTHY");
  assert.equal(truth.dimensions.API.status, "HEALTHY");
  assert.equal(truth.dimensions.AUTH.status, "HEALTHY");
  assert.equal(truth.status, "HEALTHY");
  assert.notEqual(truth.status, "DOWN");
  assert.notEqual(truth.status, "UNKNOWN");
});

test("OV-P0-281 ACK and ServiceNow write stay READY_DISABLED", () => {
  const ack = classifyWriteReadiness({
    apiSupported: true,
    executorReady: true,
    executionEnabled: false,
  });
  assert.equal(ack.status, "READY_DISABLED");
  assert.equal(ack.metrics.ACK_API_SUPPORTED, "YES");
  assert.equal(ack.metrics.ACK_EXECUTOR_READY, "YES");
  assert.equal(ack.metrics.ACK_EXECUTION_ENABLED, false);
  assert.notEqual(ack.status, "DEGRADED");
  assert.notEqual(ack.status, "DOWN");

  const sn = classifyServiceNowWriteReadiness({
    executorReady: true,
    executionEnabled: false,
  });
  assert.equal(sn.status, "READY_DISABLED");
  assert.notEqual(sn.status, "DOWN");
});

test("OV-P0-281 customer integrity / host registry / links gates", () => {
  assert.equal(classifyCustomerIntegrity({
    activeClassifiableButUnclassified: 0,
    dbClassifiedHostButAlertUnclassified: 0,
  }).status, "HEALTHY");
  assert.equal(classifyCustomerIntegrity({
    activeClassifiableButUnclassified: 1,
    dbClassifiedHostButAlertUnclassified: 0,
  }).status, "DEGRADED");

  const hostsOk = classifyHostRegistry({
    total: 8676,
    classified: 8000,
    sourceInsufficient: 50,
    needsMapping: 0,
  });
  assert.equal(hostsOk.status, "HEALTHY");
  assert.match(String(hostsOk.warning), /SOURCE_INSUFFICIENT/);

  const hostsBad = classifyHostRegistry({
    total: 8676,
    classified: 8000,
    sourceInsufficient: 0,
    needsMapping: 12,
  });
  assert.equal(hostsBad.status, "DEGRADED");

  const links = classifyLinkHealth({
    total: 186,
    customerMismatch: 0,
    nonLinkContamination: 0,
    carrierKnown: 0,
  });
  assert.equal(links.status, "HEALTHY");
  assert.match(String(links.warning), /Carrier metadata unavailable/i);
});

test("OV-P0-281 wire-up keeps runtime-health as single frontend source", () => {
  const db = read("api/_lib/oneview-db.js");
  const settings = read("src/pages/Settings.tsx");
  const truth = read("api/_lib/oneview-runtime-health-truth.js");
  assert.match(db, /classifyZabbixSourceTruth/);
  assert.match(db, /fraportProbeForSource/);
  assert.match(db, /zabbix-ack/);
  assert.match(db, /servicenow-write/);
  assert.match(db, /host-registry/);
  assert.match(db, /link-inventory/);
  assert.match(db, /READY_DISABLED/);
  assert.match(truth, /TLS_HOSTNAME_MISMATCH\+PRIVATE_CA_NOT_IN_SYSTEM_TRUST/);
  assert.match(truth, /HEALTHY_SILENT/);
  assert.match(settings, /dimensions|badge|recommended_action|Origem silenciosa/);
});
