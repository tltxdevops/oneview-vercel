import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveAlertTemporalIntegrity } from "../api/_lib/oneview-temporal-integrity.js";
import { incidentOpenDurationSeconds } from "../api/_lib/oneview-incidents-read-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recovered = (first_seen_at, resolved_at) => ({
  status_source: "resolved",
  first_seen_at,
  resolved_at,
  source_recovery_event_id: "evt-recovery",
});

test("OV-P0-242 derives valid recovered durations, including zero", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:01:30.000Z")), { duration_seconds: 90, temporal_integrity: null });
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:00:00.000Z")), { duration_seconds: 0, temporal_integrity: null });
});

test("OV-P0-242 marks inverted source time instead of returning a negative duration", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:01:00.000Z", "2026-08-28T10:00:00.000Z")), { duration_seconds: null, temporal_integrity: "source_clock_inconsistent" });
});

test("OV-P0-242 excludes invalid rows from duration averages, not alert counts", () => {
  const rows = [...Array.from({ length: 9 }, (_, index) => recovered("2026-08-28T10:00:00.000Z", `2026-08-28T10:0${index + 1}:00.000Z`)), recovered("2026-08-28T10:10:00.000Z", "2026-08-28T10:00:00.000Z")];
  const durations = rows.map((row) => deriveAlertTemporalIntegrity(row).duration_seconds).filter((value) => value !== null);
  assert.equal(rows.length, 10);
  assert.equal(durations.length, 9);
  assert.equal(durations.reduce((sum, value) => sum + value, 0) / durations.length, 300);
});

test("OV-P0-242 preserves timestamps and prevents negative temporal UI/metrics", async () => {
  const [database, metrics, drawer, recurrence] = await Promise.all([
    readFile(path.join(root, "api/_lib/oneview-db.js"), "utf8"),
    readFile(path.join(root, "api/alerts/metrics.js"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertDetailDrawer.tsx"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertRecurrenceInvestigation.tsx"), "utf8"),
  ]);
  assert.match(database, /temporal_integrity: temporal\.temporal_integrity/);
  assert.match(database, /a\.resolved_at >= a\.first_seen_at/);
  assert.match(metrics, /resolved_at >= first_seen_at/);
  assert.match(drawer, /Duração indisponível/);
  assert.match(drawer, /Relógio da origem inconsistente/);
  assert.match(recurrence, /Duração indisponível/);
});

test("OV-P0-242 freezes acknowledged alert duration at ACK and ignores later now", () => {
  const first_seen_at = "2026-08-28T10:00:00.000Z";
  const acknowledged_source_at = "2026-08-28T10:02:00.000Z";
  const laterNow = Date.parse("2026-08-28T11:00:00.000Z");
  const alert = {
    status_source: "active",
    first_seen_at,
    acknowledged_source: true,
    acknowledged_source_at,
  };
  assert.deepEqual(deriveAlertTemporalIntegrity(alert, laterNow), { duration_seconds: 120, temporal_integrity: null });
  assert.deepEqual(deriveAlertTemporalIntegrity({ ...alert, acknowledged_internal: true, acknowledged_internal_at: "2026-08-28T10:01:30.000Z" }, laterNow), {
    duration_seconds: 90,
    temporal_integrity: null,
  });
});

test("OV-P0-242 recovered duration stays on resolved_at when there is no ACK", () => {
  const laterNow = Date.parse("2026-08-28T12:00:00.000Z");
  assert.deepEqual(
    deriveAlertTemporalIntegrity(recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:04:00.000Z"), laterNow),
    { duration_seconds: 240, temporal_integrity: null },
  );
});

test("OV-P0-242 recovered duration freezes at ACK when ACK is earlier than resolved_at", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity({
    ...recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:10:00.000Z"),
    acknowledged_source: true,
    acknowledged_source_at: "2026-08-28T10:03:00.000Z",
  }), { duration_seconds: 180, temporal_integrity: null });
});

test("OV-P0-242 acknowledged alert without usable ACK time does not keep counting", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity({
    status_source: "active",
    first_seen_at: "2026-08-28T10:00:00.000Z",
    acknowledged_source: true,
  }, Date.parse("2026-08-28T11:00:00.000Z")), { duration_seconds: null, temporal_integrity: "source_clock_inconsistent" });
});

test("OV-P0-242 live table duration freezes on ACK timestamps", async () => {
  const alerts = await readFile(path.join(root, "src/pages/Alerts.tsx"), "utf8");
  assert.match(alerts, /function alertDurationFreezeMs/);
  assert.match(alerts, /if \(isResolvedAlert\(alert\) \|\| acknowledged\(alert\)\)/);
  assert.match(alerts, /acknowledged_internal_at/);
  assert.match(alerts, /source_ack\?\.acknowledged_at/);
});

test("incident open duration freezes on resolved_at or closed_at", () => {
  const opened_at = "2026-08-28T10:00:00.000Z";
  const laterNow = Date.parse("2026-08-28T12:00:00.000Z");
  assert.equal(incidentOpenDurationSeconds({
    state: "6",
    opened_at,
    resolved_at: "2026-08-28T10:05:00.000Z",
  }, laterNow), 300);
  assert.equal(incidentOpenDurationSeconds({
    state: "7",
    opened_at,
    closed_at: "2026-08-28T10:08:00.000Z",
    resolved_at: "2026-08-28T10:05:00.000Z",
  }, laterNow), 480);
  assert.equal(incidentOpenDurationSeconds({
    state: "closed",
    opened_at,
    closed_at: "2026-08-28T10:06:00.000Z",
  }, laterNow), 360);
  assert.equal(incidentOpenDurationSeconds({
    state: "8",
    opened_at,
  }, laterNow), null);
});

test("incident open duration keeps advancing while the ticket is open", () => {
  const opened_at = "2026-08-28T10:00:00.000Z";
  const now = Date.parse("2026-08-28T10:04:00.000Z");
  assert.equal(incidentOpenDurationSeconds({ state: "1", opened_at }, now), 240);
  assert.equal(incidentOpenDurationSeconds({ state: "2", opened_at }, now), 240);
  assert.equal(incidentOpenDurationSeconds({ state: "3", opened_at }, now), 240);
});
