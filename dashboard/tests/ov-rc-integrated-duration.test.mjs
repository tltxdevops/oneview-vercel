import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveAlertTemporalIntegrity } from "../api/_lib/oneview-temporal-integrity.js";
import {
  classifyOperationalQueue,
  recoveryDurationSeconds,
  timeToAckSeconds,
} from "../api/_lib/oneview-operational-queue.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const start = "2026-10-15T12:00:00.000Z";
const now = Date.parse("2026-10-15T14:00:00.000Z");
const active = {
  status_source: "active",
  status_internal: "new",
  first_seen_at: start,
  resolved_at: null,
  source_recovery_event_id: null,
  acknowledged_source: false,
};

test("A active without ACK counts two hours and has no time to ACK", () => {
  assert.equal(deriveAlertTemporalIntegrity(active, now).duration_seconds, 7200);
  assert.equal(timeToAckSeconds(active), null);
});

test("B active with ACK five minutes ago stays open for two hours", () => {
  const alert = {
    ...active,
    acknowledged_source: true,
    acknowledged_source_at: "2026-10-15T13:55:00.000Z",
    ack_history_first_at: "2026-10-15T13:55:00.000Z",
  };
  assert.equal(deriveAlertTemporalIntegrity(alert, now).duration_seconds, 7200);
  assert.equal(timeToAckSeconds(alert), 6900);
  assert.notEqual(timeToAckSeconds(alert), deriveAlertTemporalIntegrity(alert, now).duration_seconds);
});

test("C resolved without ACK uses recovery and leaves time to ACK empty", () => {
  const alert = {
    ...active,
    status_source: "resolved",
    resolved_at: "2026-10-15T13:30:00.000Z",
    source_recovery_event_id: "9001",
  };
  assert.equal(deriveAlertTemporalIntegrity(alert, now).duration_seconds, 5400);
  assert.equal(recoveryDurationSeconds(alert), 5400);
  assert.equal(timeToAckSeconds(alert), null);
});

test("D resolved with ACK keeps recovery duration separate from time to ACK", () => {
  const alert = {
    ...active,
    status_source: "resolved",
    resolved_at: "2026-10-15T13:30:00.000Z",
    source_recovery_event_id: "9001",
    acknowledged_source: true,
    acknowledged_source_at: "2026-10-15T12:10:00.000Z",
    ack_history_first_at: "2026-10-15T12:10:00.000Z",
  };
  assert.equal(deriveAlertTemporalIntegrity(alert, now).duration_seconds, 5400);
  assert.equal(timeToAckSeconds(alert), 600);
});

test("E suppressed and still active keeps counting and stays in the suppressed queue", () => {
  const alert = {
    ...active,
    acknowledged_source: true,
    payload_suppressed: "true",
    payload_suppression_confirmation: "confirmed",
    payload_suppressed_source: "true",
    payload_suppression_origin: "maintenance",
    payload_suppression_maintenance_id: "44",
    payload_suppress_until: String(Math.floor(now / 1000) + 3600),
    payload_suppress_until_kind: "finite",
  };
  assert.equal(classifyOperationalQueue(alert, now), "suppressed");
  assert.equal(deriveAlertTemporalIntegrity(alert, now).duration_seconds, 7200);
});

test("F reopened episode starts again and drops an ACK from the previous episode", () => {
  const alert = {
    ...active,
    last_reopened_at: "2026-10-15T13:00:00.000Z",
    acknowledged_source: true,
    acknowledged_source_at: "2026-10-15T12:20:00.000Z",
    ack_history_first_at: "2026-10-15T12:20:00.000Z",
    resolved_at: "2026-10-15T12:40:00.000Z",
    source_recovery_event_id: "9001",
  };
  assert.equal(deriveAlertTemporalIntegrity(alert, now).duration_seconds, 3600);
  assert.equal(timeToAckSeconds(alert), null);
  assert.equal(timeToAckSeconds({ ...alert, ack_history_first_at: "2026-10-15T13:10:00.000Z" }), 600);
});

test("G external ACK after the first sync ignores the rewritten column", () => {
  const alert = {
    ...active,
    acknowledged_source: true,
    acknowledged_at: "2026-10-15T13:40:00.000Z",
    acknowledged_source_at: "2026-10-15T13:40:00.000Z",
  };
  assert.equal(timeToAckSeconds(alert), null);
  assert.equal(timeToAckSeconds({ ...alert, ack_history_first_at: "2026-10-15T12:15:00.000Z" }), 900);
  assert.equal(timeToAckSeconds({
    ...alert,
    source_event_id: "episode-2",
    ack_source_event_id: "episode-1",
    ack_history_first_at: "2026-10-15T12:15:00.000Z",
  }), null);
});

test("H invalid or inverted clocks stay unavailable", () => {
  assert.equal(deriveAlertTemporalIntegrity({ ...active, first_seen_at: "not-a-clock" }, now).duration_seconds, null);
  assert.equal(deriveAlertTemporalIntegrity({ ...active, first_seen_at: "2026-10-15T15:00:00.000Z" }, now).temporal_integrity, "source_clock_inconsistent");
  assert.equal(recoveryDurationSeconds({
    status_source: "resolved",
    first_seen_at: "2026-10-15T13:00:00.000Z",
    resolved_at: "2026-10-15T12:00:00.000Z",
    source_recovery_event_id: "9001",
  }), null);
  assert.equal(timeToAckSeconds({
    ...active,
    acknowledged_source: true,
    ack_history_first_at: "2026-10-15T11:00:00.000Z",
  }), null);
});

test("I list, drawer and history keep duration and time to ACK apart", async () => {
  const [alerts, drawer, history, temporal] = await Promise.all([
    readFile(path.join(root, "src/pages/Alerts.tsx"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertDetailDrawer.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/historico-query.ts"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-temporal-integrity.js"), "utf8"),
  ]);
  assert.match(alerts, /title=\{isResolved \? "Duração até o recovery" : "Duração do problema ativo"\}/);
  assert.match(alerts, /label="Reconhecido"/);
  assert.match(alerts, /label="Pendente"/);
  assert.match(alerts, /Tempo até ACK/);
  assert.match(alerts, /problemEpisodeDurationSeconds\(alert, now\)/);
  assert.match(drawer, /problemEpisodeDurationSeconds/);
  assert.doesNotMatch(alerts, /id: "time_to_ack"/);
  assert.match(drawer, /label="Duração"/);
  assert.match(drawer, /Tempo até ACK/);
  assert.match(drawer, /Até o recovery/);
  assert.match(drawer, /Problema ainda ativo/);
  assert.match(drawer, /Resumo/);
  assert.match(drawer, /Histórico/);
  assert.match(drawer, /Técnico/);
  assert.match(history, /ack_history_first_at/);
  assert.doesNotMatch(history, /acknowledged_source_at \|\| alert\.acknowledged_at/);
  assert.doesNotMatch(temporal, /acknowledgementFreezeMs/);
  assert.doesNotMatch(drawer, /host_network/);
});

test("J pagination, filters and queues stay in place", async () => {
  const [alerts, queue, database] = await Promise.all([
    readFile(path.join(root, "src/pages/Alerts.tsx"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-operational-queue.js"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-db.js"), "utf8"),
  ]);
  assert.match(alerts, /\["50", "100"\]/);
  assert.match(alerts, /Suprimidos/);
  assert.match(queue, /pending:/);
  assert.match(queue, /acknowledged:/);
  assert.match(queue, /suppressed:/);
  assert.match(queue, /history:/);
  assert.match(database, /PROVEN_SOURCE_ACK_CLOCK_SQL/);
  assert.match(database, /action_type, ''\)\) in \('acknowledged', 'ack_message'\)/);
  assert.doesNotMatch(database, /buildHostNetwork/);
  assert.doesNotMatch(database, /zabbix_host_inventory/);
});
