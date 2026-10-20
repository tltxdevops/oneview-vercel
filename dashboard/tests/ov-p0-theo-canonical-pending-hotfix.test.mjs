import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  confirmTheoCanonicalOrigin,
  claimEligibleTheoOutbox,
  THEO_UNSEEN_ALERT_ACTION_TYPE,
} from "../api/_lib/oneview-theo-dispatch.js";
import {
  observedDuringLatestCompleteSnapshot,
  theoOriginActivityConfirmed,
  originActivityConfirmed,
} from "../api/_lib/oneview-operational-queue.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const REF_TELETEX = {
  alertId: "00000000-0000-4000-8000-000000000001",
  dataSourceId: "ds-teletex",
  sourceEventId: "449324423",
};
const REF_ZURICH = {
  alertId: "00000000-0000-4000-8000-000000000002",
  dataSourceId: "ds-zurich",
  sourceEventId: "137541600",
};

function productionAlert({ sourceEventId, dataSourceId, overrides = {} }) {
  const snapshotStarted = "2026-10-20T14:55:00.000Z";
  const snapshotFinished = "2026-10-20T14:56:30.000Z";
  const lastSeen = "2026-10-20T14:56:10.000Z";
  return {
    id: overrides.id || (sourceEventId === "449324423" ? REF_TELETEX.alertId : REF_ZURICH.alertId),
    data_source_id: dataSourceId,
    source_event_id: sourceEventId,
    source_trigger_id: "22001",
    source_recovery_event_id: null,
    status_source: "active",
    status_internal: "new",
    resolved_at: null,
    suppressed: false,
    maintenance_status: null,
    payload_event_id: sourceEventId,
    payload_trigger_id: "22001",
    payload_value: "1",
    payload_recovery_event_id: "0",
    payload_suppressed: "false",
    payload_origin_seen_in_complete_snapshot: "false",
    origin_snapshot_id: "sync-cycle",
    origin_snapshot_started_at: snapshotStarted,
    origin_snapshot_finished_at: snapshotFinished,
    origin_snapshot_fetched: 1800,
    origin_snapshot_mode: "problem_get",
    origin_snapshot_complete: true,
    last_success_at: snapshotFinished,
    last_sync_at: snapshotFinished,
    last_sync_status: "success",
    sync_interval_seconds: 300,
    last_seen_at: lastSeen,
    ...overrides,
  };
}

test("Teletex 449324423: false in_page flag with in-cycle last_seen authorizes Theo dispatch", async () => {
  const alert = productionAlert({ sourceEventId: "449324423", dataSourceId: "ds-teletex" });
  assert.equal(observedDuringLatestCompleteSnapshot(alert), true);
  assert.equal(originActivityConfirmed(alert, NOW), false);
  assert.equal(theoOriginActivityConfirmed(alert, NOW), true);
  const confirmation = await confirmTheoCanonicalOrigin(REF_TELETEX, alert, NOW);
  assert.deepEqual(confirmation, { state: "active" });
});

test("Zurich 137541600: same snapshot-window rule applies without widening Central semantics", async () => {
  const alert = productionAlert({ sourceEventId: "137541600", dataSourceId: "ds-zurich" });
  assert.equal(theoOriginActivityConfirmed(alert, NOW), true);
  const confirmation = await confirmTheoCanonicalOrigin(REF_ZURICH, alert, NOW);
  assert.deepEqual(confirmation, { state: "active" });
});

test("explicit false with last_seen before snapshot start stays origin-unconfirmed for Theo", async () => {
  const alert = productionAlert({
    sourceEventId: "449324423",
    dataSourceId: "ds-teletex",
    overrides: { last_seen_at: "2026-10-20T14:50:00.000Z" },
  });
  assert.equal(theoOriginActivityConfirmed(alert, NOW), false);
  const confirmation = await confirmTheoCanonicalOrigin(REF_TELETEX, alert, NOW);
  assert.equal(confirmation.state, "unavailable");
});

test("recovered episode stays blocked even when last_seen is inside snapshot window", async () => {
  const alert = productionAlert({
    sourceEventId: "449324423",
    dataSourceId: "ds-teletex",
    overrides: {
      payload_recovery_event_id: "449324999",
      source_recovery_event_id: "449324999",
    },
  });
  assert.equal(theoOriginActivityConfirmed(alert, NOW), false);
  const confirmation = await confirmTheoCanonicalOrigin(REF_TELETEX, alert, NOW);
  assert.equal(confirmation.state, "resolved");
});

test("Theo claim SQL respects available_at for unseen pending rows", async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  await claimEligibleTheoOutbox(client, {
    actionType: THEO_UNSEEN_ALERT_ACTION_TYPE,
    allowAutomation: true,
    lockedBy: "test",
  });
  assert.match(calls[0].sql, /coalesce\(o\.available_at, o\.created_at\) <= now\(\)/);
});

test("production dispatcher uses theoOriginActivityConfirmed gate", () => {
  const source = readFileSync(new URL("../api/_lib/oneview-theo-dispatch.js", import.meta.url), "utf8");
  assert.match(source, /theoOriginActivityConfirmed/);
  assert.doesNotMatch(source, /[^a-zA-Z]originActivityConfirmed\(/);
});
