import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ALERT_DRAWER_POLL_MS,
  ALERT_LIST_LIVE_REFRESH_MS,
  createAlertDrawerPoller,
  detectDrawerLiveTransition,
  shouldInvalidateAlertList,
  shouldPollAlertDrawer,
} from "../src/lib/oneview-alert-live-refresh.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function alert(partial = {}) {
  return {
    id: "alert-1",
    status_source: "active",
    oneview_ack: { status: "none", requested_at: null, processed_at: null, actor_name: null, reason: null, message: null },
    ...partial,
    oneview_ack: {
      status: "none",
      requested_at: null,
      processed_at: null,
      actor_name: null,
      reason: null,
      message: null,
      ...(partial.oneview_ack || {}),
    },
  };
}

test("drawer polla active ou ACK pending/processing e para no ACK terminal", () => {
  assert.equal(ALERT_DRAWER_POLL_MS, 2_000);
  assert.equal(ALERT_LIST_LIVE_REFRESH_MS, 10_000);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "active" })), true);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "resolved", oneview_ack: { status: "pending" } })), true);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "resolved", oneview_ack: { status: "processing" } })), true);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "resolved", oneview_ack: { status: "success" } })), false);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "resolved", oneview_ack: { status: "cancelled" } })), false);
  assert.equal(shouldPollAlertDrawer(alert({ status_source: "resolved", oneview_ack: { status: "failed" } })), false);
});

test("ACK pending -> success/cancelled invalida lista sem marcar success retroativo", () => {
  const pending = alert({ oneview_ack: { status: "pending" } });
  const success = detectDrawerLiveTransition(pending, alert({ oneview_ack: { status: "success" }, acknowledged_source: true }));
  const cancelled = detectDrawerLiveTransition(pending, alert({ oneview_ack: { status: "cancelled" } }));
  assert.deepEqual(success, { recovery: false, ackTerminal: true });
  assert.deepEqual(cancelled, { recovery: false, ackTerminal: true });
  assert.equal(shouldInvalidateAlertList(success), true);
  assert.equal(shouldInvalidateAlertList(cancelled), true);
});

test("active -> resolved invalida lista para sair de Em aberto", () => {
  const transition = detectDrawerLiveTransition(
    alert({ status_source: "active" }),
    alert({
      status_source: "resolved",
      resolved_at: "2026-10-08T18:00:00.000Z",
      source_recovery_event_id: "9002",
      duration_seconds: 120,
    }),
  );
  assert.equal(transition.recovery, true);
  assert.equal(shouldInvalidateAlertList(transition), true);
});

test("poller: abort cancela request; tick concorrente do mesmo alerta é ignorado", async () => {
  let refreshCalls = 0;
  let resolveRefresh;
  const transitions = [];
  const poller = createAlertDrawerPoller({
    currentAlert: () => alert({ oneview_ack: { status: "pending" } }),
    refresh: () => {
      refreshCalls += 1;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
    onTransition: (transition) => transitions.push(transition),
  });

  const first = poller.tick();
  const second = poller.tick();
  assert.equal(refreshCalls, 1);
  assert.equal(poller.inFlight(), true);
  await second;
  poller.abort();
  resolveRefresh(alert({ oneview_ack: { status: "success" } }));
  await first;
  assert.equal(transitions.length, 0);

  const switched = createAlertDrawerPoller({
    currentAlert: () => alert({ id: "alert-2", status_source: "active" }),
    refresh: async (signal) => {
      assert.equal(signal.aborted, false);
      return alert({ id: "alert-2", status_source: "resolved" });
    },
    onTransition: (transition) => transitions.push(transition),
  });
  await switched.tick();
  assert.equal(transitions.at(-1)?.recovery, true);
  switched.abort();
  await switched.tick();
});

test("telas: drawer 2s seletivo, lista 10s, sem poll global de facets/health/SN", async () => {
  const [lib, hook, alerts, monitoring, action, drawer] = await Promise.all([
    read("src/lib/oneview-alert-live-refresh.ts"),
    read("src/hooks/useAlertDrawerLiveRefresh.ts"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/oneview/AlertSourceAckAction.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
  ]);

  assert.match(lib, /ALERT_DRAWER_POLL_MS = 2_000/);
  assert.match(hook, /createAlertDrawerPoller/);
  assert.match(hook, /poller\.abort\(\)/);
  assert.match(hook, /\[options\.alertId, shouldPoll\]/);
  assert.match(hook, /if \(!shouldPoll \|\| !alertId\) return undefined/);
  assert.match(alerts, /useAlertDrawerLiveRefresh/);
  assert.match(alerts, /loadSelectedAlert\(id, \{ quiet: true, signal \}\)/);
  assert.match(alerts, /loadAlerts\(\{ quiet: true, force: true \}\)/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(alerts, /fetchAlert\(id, signal\)/);
  assert.match(alerts, /fetchAlertHistory\(id, signal\)/);
  assert.match(monitoring, /useAlertDrawerLiveRefresh/);
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(drawer, /livePollEnabled=\{false\}/);
  assert.match(action, /livePollEnabled/);
  assert.match(action, /SOURCE_ACK_POLL_INTERVAL_MS = 2_000/);

  const drawerRefresh = alerts.slice(alerts.indexOf("useAlertDrawerLiveRefresh({"), alerts.indexOf("const selectedCustomer = selectedAlert"));
  assert.match(drawerRefresh, /loadAlerts\(\{ quiet: true, force: true \}\)/);
  assert.doesNotMatch(drawerRefresh, /loadSummaryResources|getOneViewFacets|fetchOneViewHealth|fetchOperationsHealth|fetchMonitoringUnassignedIncidents/);
  assert.doesNotMatch(alerts, /setInterval\(\(\) => \{\s*void loadSelectedAlert/);
});

test("poller: fechar drawer ou trocar alerta cancela request anterior", async () => {
  let refreshCalls = 0;
  let lastSignal;
  const poller = createAlertDrawerPoller({
    currentAlert: () => alert({ status_source: "active" }),
    refresh: (signal) => {
      refreshCalls += 1;
      lastSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(null), { once: true });
      });
    },
  });
  const pending = poller.tick();
  assert.equal(refreshCalls, 1);
  poller.abort();
  assert.equal(lastSignal.aborted, true);
  await pending;
  await poller.tick();
  assert.equal(refreshCalls, 1);
});
