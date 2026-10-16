import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import {
  OPERATIONAL_QUEUE_VIEWS,
  classifyOperationalQueue,
  describeDatasourceSync,
  describeSuppression,
  operationalQueueSql,
  recoveryDurationSeconds,
  recoveryEvidenceOf,
  timeToAckSeconds,
} from "../api/_lib/oneview-operational-queue.js";

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

const active = {
  status_source: "active",
  status_internal: "new",
  acknowledged_source: false,
  resolved_at: null,
  source_recovery_event_id: null,
};

test("pending is active and unacknowledged, including status_internal=new", () => {
  assert.equal(classifyOperationalQueue(active), "pending");
  assert.equal(classifyOperationalQueue({ ...active, status_internal: "viewed" }), "pending");
  assert.equal(classifyOperationalQueue({ ...active, severity: "disaster", first_seen_at: "2020-01-01T00:00:00Z" }), "pending");
});

test("acknowledged high and disaster stay in follow-up", () => {
  for (const severity of ["high", "disaster"]) {
    assert.equal(classifyOperationalQueue({ ...active, severity, acknowledged_source: true }), "acknowledged");
  }
});

test("history keeps proven recovery and legacy rows as different evidence", () => {
  const proven = {
    ...active,
    status_source: "resolved",
    status_internal: "normalized",
    resolved_at: "2026-10-15T12:00:00Z",
    source_recovery_event_id: "9001",
  };
  assert.equal(classifyOperationalQueue(proven), "history");
  assert.equal(recoveryEvidenceOf(proven), "proven");
  const legacy = {
    ...active,
    status_source: "resolved",
    resolved_at: "2026-10-15T12:00:00Z",
    source_recovery_event_id: null,
  };
  assert.equal(classifyOperationalQueue(legacy), "history");
  assert.equal(recoveryEvidenceOf(legacy), "legacy");
  assert.equal(classifyOperationalQueue({
    ...active,
    status_internal: "normalized",
  }), "unconfirmed");
});

test("acknowledged is not treated as resolved", () => {
  const row = { ...active, acknowledged_source: true, status_internal: "acknowledged" };
  assert.equal(classifyOperationalQueue(row), "acknowledged");
  assert.notEqual(classifyOperationalQueue(row), "history");
});

test("operational view defaults status to all, preserves explicit status and never filters by age", () => {
  const pending = buildAlertListQuery(request({ operational_view: "pending", status: "active" }));
  assert.match(pending.whereSql, /acknowledged_source/);
  assert.equal(pending.whereSql.includes(operationalQueueSql("pending")), true);
  assert.equal(pending.scopeWhereSql.includes(operationalQueueSql("pending")), false);
  assert.doesNotMatch(pending.whereSql, /interval '1 minute'/);

  const history = buildAlertListQuery(request({ operational_view: "history" }));
  assert.equal(history.filters.status, "all");
  assert.match(history.whereSql, /source_recovery_event_id/);
  assert.match(history.whereSql, /resolved_at is not null/);
  const historyActive = buildAlertListQuery(request({ operational_view: "history", status: "active" }));
  assert.equal(historyActive.filters.status, "active");
  assert.match(historyActive.whereSql, /status_internal/);
  const suppressed = buildAlertListQuery(request({ operational_view: "suppressed" }));
  assert.match(suppressed.whereSql, /payload_normalized->>'suppressed'/);
  assert.match(suppressed.whereSql, /suppress_until/);
  assert.equal(suppressed.scopeWhereSql.includes(operationalQueueSql("suppressed")), false);
  assert.equal(history.scopeWhereSql.includes(operationalQueueSql("history")), false);

  const legacy = buildAlertListQuery(request({ status: "active" }));
  assert.match(legacy.whereSql, /status_internal/);
  assert.throws(() => buildAlertListQuery(request({ operational_view: "resolved" })), /invalid_query/);
});

test("snapshot fallback applies the same operational queue and returns scoped counters", () => {
  const fallback = readFileSync(new URL("../api/_lib/oneview-fallback.js", import.meta.url), "utf8");
  assert.match(fallback, /classifyOperationalQueue\(item\) === filters\.operationalView/);
  assert.match(fallback, /OPERATIONAL_QUEUE_VIEWS\.map/);
  assert.match(fallback, /operational_queues:/);
  assert.match(fallback, /origin_sync:/);
});

test("datasource sync failure is distinct from a fresh empty queue", () => {
  const now = Date.parse("2026-10-15T15:00:00Z");
  assert.equal(describeDatasourceSync({
    last_success_at: "2026-10-15T14:59:00Z",
    sync_interval_seconds: 60,
  }, now).state, "fresh");
  assert.equal(describeDatasourceSync({
    last_success_at: "2026-10-15T12:00:00Z",
    sync_interval_seconds: 60,
  }, now).state, "stale");
  assert.equal(describeDatasourceSync({ last_sync_status: "failed" }, now).state, "failed");
  assert.equal(describeDatasourceSync({}, now).state, "unknown");
  assert.equal(describeDatasourceSync({}, now).stale, false);
  assert.equal(classifyOperationalQueue({
    ...active,
    payload_suppressed: "false",
    last_sync_status: "failed",
  }, now), "pending");
});

test("suppression scenarios stay distinct from ack, recovery and an expired window", () => {
  const now = Date.parse("2026-10-15T15:00:00Z");
  const future = String(Math.floor(now / 1000) + 3600);
  const past = String(Math.floor(now / 1000) - 3600);
  const maintenance = [{ maintenanceid: "44", userid: "0", suppress_until: future }];
  const manual = [{ maintenanceid: "0", userid: "7", suppress_until: "0" }];

  const suppressed = {
    ...active,
    payload_suppressed: "true",
    payload_suppression_data: maintenance,
    servicenow_reference: { number: "INC001" },
  };
  assert.equal(classifyOperationalQueue(suppressed, now), "suppressed");
  assert.equal(describeSuppression(suppressed, now).origin, "maintenance");
  assert.equal(suppressed.servicenow_reference.number, "INC001");

  const acknowledgedAndSuppressed = { ...suppressed, acknowledged_source: true, acknowledged_source_at: "2026-10-15T14:00:00Z", first_seen_at: "2026-10-15T13:00:00Z" };
  assert.equal(classifyOperationalQueue(acknowledgedAndSuppressed, now), "suppressed");
  assert.equal(timeToAckSeconds(acknowledgedAndSuppressed), null);
  assert.equal(timeToAckSeconds({ ...acknowledgedAndSuppressed, ack_history_first_at: "2026-10-15T14:00:00Z" }), 3600);

  const manualSuppression = { ...active, payload_suppressed: "true", payload_suppression_data: manual };
  assert.equal(describeSuppression(manualSuppression, now).origin, "manual");
  assert.equal(classifyOperationalQueue(manualSuppression, now), "suppressed");

  const recoveredDuringMaintenance = {
    ...suppressed,
    status_source: "resolved",
    resolved_at: "2026-10-15T14:30:00Z",
    first_seen_at: "2026-10-15T13:00:00Z",
    source_recovery_event_id: "9001",
  };
  assert.equal(classifyOperationalQueue(recoveredDuringMaintenance, now), "history");
  assert.equal(recoveryEvidenceOf(recoveredDuringMaintenance), "proven");
  assert.equal(describeSuppression(recoveredDuringMaintenance, now).state, "active");
  assert.equal(recoveryDurationSeconds(recoveredDuringMaintenance), 5400);
  assert.equal(timeToAckSeconds(recoveredDuringMaintenance), null);

  const expired = { ...active, payload_suppressed: "true", payload_suppression_data: [{ maintenanceid: "44", suppress_until: past }] };
  assert.equal(describeSuppression(expired, now).state, "expired");
  assert.equal(classifyOperationalQueue(expired, now), "pending");

  assert.equal(classifyOperationalQueue({ ...active, acknowledged_source: true, payload_suppressed: "false" }, now), "acknowledged");
  assert.equal(describeSuppression({ ...active }, now).state, "unavailable");
  assert.equal(describeSuppression({ ...active }, now).explicit_unconfirmed, false);
});

test("canonical worker suppression fields drive the read-only queue and counters", () => {
  const now = Date.parse("2026-10-15T15:00:00Z");
  const until = "2026-10-15T16:00:00.000Z";
  const manual = {
    ...active,
    client_name: "Teletex",
    host_name: "core-01",
    problem_name: "ICMP",
    severity: "high",
    payload_suppression_confirmation: "confirmed",
    payload_suppressed_source: "true",
    payload_suppression_origin: "manual",
    payload_suppression_user_id: "7",
    payload_suppress_until: until,
  };
  const described = describeSuppression(manual, now);
  assert.equal(classifyOperationalQueue(manual, now), "suppressed");
  assert.equal(described.origin, "manual");
  assert.equal(described.user_id, "7");
  assert.equal(described.suppress_until, until);
  assert.equal(described.started_at, null);
  assert.equal(described.remaining_seconds, 3600);

  const maintenance = {
    ...manual,
    payload_suppression_origin: "maintenance",
    payload_suppression_maintenance_id: "44",
    payload_suppress_until: null,
  };
  assert.equal(describeSuppression(maintenance, now).origin, "maintenance");
  assert.equal(describeSuppression(maintenance, now).remaining_seconds, null);
  assert.equal(classifyOperationalQueue(maintenance, now), "suppressed");

  const expired = { ...manual, payload_suppress_until: "2026-10-15T14:00:00.000Z" };
  assert.equal(describeSuppression(expired, now).state, "expired");
  assert.equal(classifyOperationalQueue(expired, now), "pending");

  const cleared = { ...active, payload_suppression_confirmation: "confirmed", payload_suppressed_source: "false" };
  assert.equal(classifyOperationalQueue(cleared, now), "pending");
  assert.equal(classifyOperationalQueue({ ...cleared, acknowledged_source: true }, now), "acknowledged");

  const unconfirmed = { ...manual, payload_suppression_confirmation: "unconfirmed", payload_suppressed_source: "false" };
  assert.equal(describeSuppression(unconfirmed, now).explicit_unconfirmed, true);
  assert.equal(describeSuppression(unconfirmed, now).state, "unavailable");
  assert.equal(classifyOperationalQueue(unconfirmed, now), "unconfirmed");

  const recovered = {
    ...manual,
    status_source: "resolved",
    resolved_at: "2026-10-15T15:30:00.000Z",
    source_recovery_event_id: "9001",
  };
  assert.equal(classifyOperationalQueue(recovered, now), "history");
  assert.equal(describeSuppression(recovered, now).state, "active");

  const counts = {};
  for (const view of OPERATIONAL_QUEUE_VIEWS) {
    const query = buildAlertListQuery(request({ operational_view: view }));
    counts[view] = query.whereSql.includes(operationalQueueSql(view));
    assert.equal(query.scopeWhereSql.includes(operationalQueueSql(view)), false);
  }
  assert.deepEqual(counts, {
    pending: true,
    acknowledged: true,
    suppressed: true,
    history: true,
    unconfirmed: true,
  });
  assert.match(operationalQueueSql("suppressed"), /suppression_confirmation/);
  assert.match(operationalQueueSql("unconfirmed"), /suppression_confirmation/);
  assert.match(operationalQueueSql("suppressed"), /origin_snapshot_started_at/);
  assert.match(operationalQueueSql("suppressed"), /origin_seen_in_complete_snapshot/);
  assert.doesNotMatch(operationalQueueSql("suppressed"), /now\(\) - interval/);
  const module = readFileSync(new URL("../api/_lib/oneview-operational-queue.js", import.meta.url), "utf8");
  assert.match(module, /snapshot_complete/);
  assert.match(module, /snapshot_mode/);
  assert.match(module, /event_stream_fast/);
  assert.doesNotMatch(module, /fetched_count >= 10/);
  assert.doesNotMatch(module, /token\.create|event\.acknowledge|insert into|update alerts/);
});

test("stale suppression leaves Suprimidos without becoming recovery", () => {
  const now = Date.parse("2026-10-16T12:30:00Z");
  const current = {
    ...active,
    payload_suppressed_source: "true",
    payload_suppression_confirmation: "confirmed",
    last_seen_at: "2026-10-16T12:29:50Z",
    origin_snapshot_started_at: "2026-10-16T12:29:40Z",
    last_sync_status: "success",
  };
  assert.equal(classifyOperationalQueue(current, now), "suppressed");

  const stale = {
    ...current,
    last_seen_at: "2026-10-14T08:00:00Z",
  };
  assert.equal(classifyOperationalQueue(stale, now), "unconfirmed");
  assert.notEqual(classifyOperationalQueue(stale, now), "history");
  assert.notEqual(classifyOperationalQueue(stale, now), "pending");

  const unavailable = {
    ...stale,
    origin_snapshot_started_at: null,
    last_sync_status: "failed",
  };
  assert.equal(classifyOperationalQueue(unavailable, now), "suppressed");

  const explicitFalse = {
    ...current,
    payload_origin_seen_in_complete_snapshot: "false",
  };
  assert.equal(classifyOperationalQueue(explicitFalse, now), "unconfirmed");

  const incompleteSnapshot = {
    ...stale,
    origin_snapshot_complete: false,
    last_sync_status: "success",
  };
  assert.equal(classifyOperationalQueue(incompleteSnapshot, now), "suppressed");
});

test("five queues stay exclusive for the seven datasources and the sampled events", () => {
  const now = Date.parse("2026-10-15T16:00:00Z");
  const future = "2026-10-15T18:00:00.000Z";
  const samples = [
    ["teletex-http", "438250534", "maintenance", "65", null, future, false],
    ["zurich", "134077184", "maintenance", "9", null, future, false],
    ["rhp", "108402207", "maintenance", "12", null, future, true],
    ["fraport-for", "36383112", "manual", null, "4", future, true],
    ["fraport-poa", "36390001", "maintenance", "3", null, future, false],
    ["castrolanda", "489416319", "manual", null, "8", null, false],
    ["maps", "6001001", "maintenance", null, null, null, false],
  ];
  const queues = new Set();
  for (const [datasource, eventId, origin, maintenanceId, userId, until, acked] of samples) {
    const row = {
      ...active,
      datasource_name: datasource,
      source_event_id: eventId,
      acknowledged_source: acked,
      acknowledged_source_at: acked ? "2026-10-15T15:00:00Z" : null,
      first_seen_at: "2026-10-15T14:00:00Z",
      payload_suppression_confirmation: "confirmed",
      payload_suppressed_source: "true",
      payload_suppression_origin: origin,
      payload_suppression_maintenance_id: maintenanceId,
      payload_suppression_user_id: userId,
      payload_suppress_until: until,
      payload_suppress_until_kind: until ? "finite" : (datasource === "maps" ? "unsupported" : "indefinite"),
    };
    assert.equal(classifyOperationalQueue(row, now), "suppressed");
    const described = describeSuppression(row, now);
    assert.equal(described.origin, origin);
    assert.equal(described.maintenance_id, maintenanceId);
    assert.equal(described.user_id, userId);
    if (acked) {
      assert.equal(timeToAckSeconds(row), null);
      assert.equal(timeToAckSeconds({ ...row, ack_history_first_at: "2026-10-15T15:00:00Z" }), 3600);
      assert.equal(recoveryDurationSeconds(row), null);
    }
    queues.add(classifyOperationalQueue(row, now));
  }
  assert.deepEqual([...queues], ["suppressed"]);

  const recovered = {
    ...active,
    datasource_name: "teletex-http",
    source_event_id: "438162265",
    status_source: "resolved",
    resolved_at: "2026-10-15T15:30:00Z",
    first_seen_at: "2026-10-15T14:00:00Z",
    source_recovery_event_id: "438162900",
    payload_suppression_confirmation: "confirmed",
    payload_suppressed_source: "true",
    payload_suppression_origin: "maintenance",
    payload_suppression_maintenance_id: "65",
  };
  assert.equal(classifyOperationalQueue(recovered, now), "history");
  assert.equal(describeSuppression(recovered, now).maintenance_id, "65");
  assert.equal(recoveryDurationSeconds(recovered), 5400);

  const conflict = { ...active, payload_suppression_confirmation: "confirmed", payload_suppressed_source: "false", suppressed: true };
  assert.equal(describeSuppression(conflict, now).evidence, "conflict");
  assert.equal(classifyOperationalQueue(conflict, now), "unconfirmed");
  assert.notEqual(classifyOperationalQueue(conflict, now), "pending");

  const sameEpisode = { ...active, source_event_id: "438250534", payload_suppression_confirmation: "confirmed", payload_suppressed_source: "false" };
  assert.equal(classifyOperationalQueue(sameEpisode, now), "pending");
  assert.equal(classifyOperationalQueue({ ...sameEpisode, acknowledged_source: true }, now), "acknowledged");

  const mapper = readFileSync(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  const mapped = mapper.slice(mapper.indexOf("function mapAlertRows"), mapper.indexOf("function mapTopHosts"));
  assert.doesNotMatch(mapped, /payload_raw|payload_suppression_data|suppression_data:/);
});

test("green flash is armed only by a source ack or source recovery snapshot", () => {
  const live = readFileSync(new URL("../src/lib/oneview-live-transition.ts", import.meta.url), "utf8");
  const alerts = readFileSync(new URL("../src/pages/Alerts.tsx", import.meta.url), "utf8");
  assert.match(live, /acknowledged_internal: false/);
  assert.match(live, /status_internal: null/);
  assert.match(alerts, /sourceConfirmedAlertSnapshot/);
  assert.doesNotMatch(alerts, /snapshotFromAlert\(/);
});

test("UI keeps 50/100 pagination, long age filters and recovery-based duration", () => {
  const alerts = readFileSync(new URL("../src/pages/Alerts.tsx", import.meta.url), "utf8");
  const query = readFileSync(new URL("../src/lib/alerts-query.ts", import.meta.url), "utf8");
  const drawer = readFileSync(new URL("../src/components/oneview/AlertDetailDrawer.tsx", import.meta.url), "utf8");
  assert.match(alerts, /PageHeader title="Central de Alertas"/);
  assert.doesNotMatch(alerts, /<SelectItem value="25">25<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="50">50<\/SelectItem>/);
  assert.match(alerts, /<SelectItem value="100">100<\/SelectItem>/);
  assert.match(query, /id: "90d"/);
  assert.match(query, /id: "365d"/);
  assert.match(alerts, /ACK mede tempo de resposta; não encerra a indisponibilidade/);
  assert.match(drawer, /Até o recovery/);
  assert.match(drawer, /Problema ainda ativo/);
  assert.match(drawer, /Tempo até ACK/);
  assert.doesNotMatch(drawer, /recovery confirmou o fim/);
  assert.doesNotMatch(drawer, /value=\{formatDurationSeconds\(alert\.recovery_duration_seconds\)\}/);
});
