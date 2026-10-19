import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const { buildAlertListQuery } = require("../api/_lib/oneview-db.js");
const {
  effectiveOperationalSourceAckQuery,
  operationalSourceAckConflictsQueue,
} = require("../api/_lib/oneview-alerts-operational-filters.js");

function request(query) {
  return { query };
}

test("ACK filter conflicts with pending/acknowledged queues are dropped", () => {
  assert.equal(effectiveOperationalSourceAckQuery("acknowledged", "false"), null);
  assert.equal(effectiveOperationalSourceAckQuery("pending", "true"), null);
  assert.equal(effectiveOperationalSourceAckQuery("acknowledged", "true"), null);
  assert.equal(effectiveOperationalSourceAckQuery("pending", "false"), null);
  assert.equal(effectiveOperationalSourceAckQuery("history", "false"), "false");
});

test("FE reconciles Sem ACK when entering Acompanhamento", () => {
  const filters = read("src/lib/oneview-alerts-operational-filters.ts");
  assert.match(filters, /reconcileSourceAckFilterForQueue/);
  assert.match(filters, /effectiveOperationalSourceAckParam/);
  assert.equal(operationalSourceAckConflictsQueue("acknowledged", "false"), true);
});

test("BFF list query omits contradictory acknowledged_source on Acompanhamento", () => {
  const query = buildAlertListQuery(request({
    operational_view: "acknowledged",
    acknowledged_source: "false",
    status: "all",
  }));
  assert.doesNotMatch(query.whereSql, /acknowledged_source, false\) = false/);
  assert.match(query.whereSql, /coalesce\(a\.acknowledged_source, false\) = true/);
});

test("Central wires reconciliation on tab change and effective ACK param", () => {
  const alerts = read("src/pages/Alerts.tsx");
  assert.match(alerts, /reconcileSourceAckFilterForQueue/);
  assert.match(alerts, /effectiveOperationalSourceAckParam/);
  assert.match(alerts, /toast\.message\(reconciled\.message/);
});

test("drawer separates Zabbix alert state and ServiceNow incident state", () => {
  const drawer = read("src/components/oneview/AlertDetailDrawer.tsx");
  const callout = read("src/components/oneview/AlertOperationalStateCallout.tsx");
  const states = read("src/lib/oneview-alert-operational-states.ts");
  assert.match(drawer, /AlertOperationalStateCallout/);
  assert.match(callout, /Estado do alerta \(Zabbix\)/);
  assert.match(callout, /Estado do chamado \(ServiceNow\)/);
  assert.match(states, /recovery_pending_reconciliation/);
  assert.match(states, /incident_closed_alert_active/);
});

test("suppression action hidden when suppression already confirmed", () => {
  const action = read("src/components/oneview/AlertSuppressAction.tsx");
  assert.match(action, /operational_queue === "suppressed"/);
  assert.match(action, /suppression\?\.state === "active"/);
});
