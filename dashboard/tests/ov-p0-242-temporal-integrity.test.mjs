import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveAlertTemporalIntegrity } from "../api/_lib/oneview-temporal-integrity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recovered = (first_seen_at, resolved_at) => ({
  status_source: "resolved",
  source_recovery_event_id: "9001",
  first_seen_at,
  resolved_at,
});

test("OV-P0-242 derives valid recovered durations, including zero", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:01:30.000Z")), { duration_seconds: 90, temporal_integrity: null });
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:00:00.000Z")), { duration_seconds: 0, temporal_integrity: null });
});

test("OV-P0-242 marks inverted source time instead of returning a negative duration", () => {
  assert.deepEqual(deriveAlertTemporalIntegrity(recovered("2026-08-28T10:01:00.000Z", "2026-08-28T10:00:00.000Z")), { duration_seconds: null, temporal_integrity: "source_clock_inconsistent" });
});

test("OV-P0-242 does not invent duration without canonical recovery evidence", () => {
  const legacy = { ...recovered("2026-08-28T10:00:00.000Z", "2026-08-28T10:01:30.000Z"), source_recovery_event_id: null };
  assert.deepEqual(deriveAlertTemporalIntegrity(legacy), { duration_seconds: null, temporal_integrity: "source_recovery_unverified" });
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
