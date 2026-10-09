import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isOperationalPendingAlert,
  isOneViewAckPending,
  isSourceAcknowledged,
  summarizeOperationalAckCounts,
} from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function alert(partial = {}) {
  return {
    id: "a1",
    status_source: "active",
    status_internal: "new",
    resolved_at: null,
    acknowledged_source: false,
    oneview_ack: { status: "none" },
    ...partial,
  };
}

test("active + source unack -> pending; active + source ack -> recognized", () => {
  const pending = alert({ acknowledged_source: false });
  const recognized = alert({ acknowledged_source: true });
  assert.equal(isOperationalPendingAlert(pending), true);
  assert.equal(isSourceAcknowledged(pending), false);
  assert.equal(isOperationalPendingAlert(recognized), false);
  assert.equal(isSourceAcknowledged(recognized), true);
});

test("resolved + source unack/ack nunca é pending operacional", () => {
  const resolvedUnack = alert({
    status_source: "resolved",
    resolved_at: "2026-10-08T18:00:00.000Z",
    acknowledged_source: false,
  });
  const resolvedAck = alert({
    status_source: "resolved",
    resolved_at: "2026-10-08T18:00:00.000Z",
    acknowledged_source: true,
  });
  assert.equal(isOperationalPendingAlert(resolvedUnack), false);
  assert.equal(isOperationalPendingAlert(resolvedAck), false);
  assert.equal(isSourceAcknowledged(resolvedAck), true);
});

test("ACK OneView pending é exclusivo de pending/processing e não mistura cancelled", () => {
  const inFlight = alert({ oneview_ack: { status: "pending" } });
  const processing = alert({ oneview_ack: { status: "processing" } });
  const cancelledResolved = alert({
    status_source: "resolved",
    resolved_at: "2026-10-08T18:00:00.000Z",
    acknowledged_source: false,
    oneview_ack: { status: "cancelled" },
  });
  assert.equal(isOneViewAckPending(inFlight), true);
  assert.equal(isOneViewAckPending(processing), true);
  assert.equal(isOneViewAckPending(cancelledResolved), false);
  assert.equal(isOperationalPendingAlert(cancelledResolved), false);
});

test("fixture 100 resolved sem ACK + 20 resolved com ACK => pending operacional 0", () => {
  const items = [
    ...Array.from({ length: 100 }, (_, index) => alert({
      id: `resolved-unack-${index}`,
      status_source: "resolved",
      resolved_at: "2026-10-08T18:00:00.000Z",
      acknowledged_source: false,
    })),
    ...Array.from({ length: 20 }, (_, index) => alert({
      id: `resolved-ack-${index}`,
      status_source: "resolved",
      resolved_at: "2026-10-08T18:00:00.000Z",
      acknowledged_source: true,
    })),
  ];
  const summary = summarizeOperationalAckCounts(items);
  assert.equal(summary.resolved, 120);
  assert.equal(summary.active, 0);
  assert.equal(summary.acknowledged_source, 20);
  assert.equal(summary.unacknowledged_source, 100);
  assert.equal(summary.operational_pending, 0);
  assert.equal(summary.oneview_ack_pending, 0);
});

test("summary SQL e cards usam pending operacional, sem misturar OneView ACK", async () => {
  const [db, fallback, alerts, metrics] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-fallback.js"),
    read("src/pages/Alerts.tsx"),
    read("api/alerts/metrics.js"),
  ]);
  assert.match(db, /OPERATIONAL_PENDING_SQL/);
  assert.match(db, /ONEVIEW_ACK_PENDING_SQL/);
  assert.match(db, /as operational_pending/);
  assert.match(db, /as oneview_ack_pending/);
  assert.match(db, /operational_pending: integerValue\(row\?\.operational_pending, 0\)/);
  assert.match(fallback, /operational_pending: filteredItems\.filter\(isOperationalPendingAlert\)\.length/);
  assert.match(fallback, /oneview_ack_pending: filteredItems\.filter\(isOneViewAckPending\)\.length/);
  assert.match(alerts, /filteredSummary\.operational_pending/);
  assert.doesNotMatch(alerts, /pendingTotal = filteredSummary\s*\n\s*\? filteredSummary\.unacknowledged_source/);
  assert.match(metrics, /acknowledged_source = false/);
  assert.doesNotMatch(metrics, /acknowledged_internal = false/);
});
