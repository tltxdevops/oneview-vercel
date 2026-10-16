import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { executeMaintenanceCreate } from "../api/_lib/oneview-maintenance-executor.js";
import {
  authorizeMaintenanceCreate,
  planMaintenanceOperations,
  planMaintenanceReminders,
  reminderDedupeKey,
  validateMaintenanceDraft,
  ZABBIX_MAINTENANCE_COMPATIBILITY,
} from "../api/_lib/oneview-maintenance.js";

const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const futureEnd = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

function draft(overrides = {}) {
  return {
    customer: "Sanepar",
    datasource: "teletex-http",
    hosts: [{ name: "fw-01" }],
    reason: "Janela de rede",
    requester: "NOC",
    duration_preset: "2h",
    active_since: futureStart,
    active_till: futureEnd,
    ...overrides,
  };
}

test("maintenance writes stay denied without the dedicated allowlist", () => {
  assert.equal(authorizeMaintenanceCreate({ email: "noc@teletex.com.br" }, {
    ONEVIEW_MAINTENANCE_WRITES_ENABLED: "false",
    ONEVIEW_MAINTENANCE_OPERATOR_EMAILS: "noc@teletex.com.br",
  }).reason, "maintenance_writes_disabled");
  assert.equal(authorizeMaintenanceCreate({ email: "admin@teletex.com.br" }, {
    ONEVIEW_MAINTENANCE_WRITES_ENABLED: "true",
    ONEVIEW_ADMIN_EMAILS: "admin@teletex.com.br",
  }).reason, "maintenance_permission_denied");
  assert.equal(authorizeMaintenanceCreate({ email: "noc@teletex.com.br" }, {
    ONEVIEW_MAINTENANCE_WRITES_ENABLED: "true",
    ONEVIEW_MAINTENANCE_OPERATOR_EMAILS: "noc@teletex.com.br",
  }).allowed, true);
});

test("a customer is not expanded into a host group and unresolved hosts cannot be confirmed", () => {
  const validated = validateMaintenanceDraft(draft());
  assert.equal(validated.groups.length, 0);
  assert.equal(validated.hosts[0].resolved, false);
  assert.equal(validated.maintenance_type, 0);
  const [operation] = planMaintenanceOperations(validated);
  assert.equal(operation.customer_is_not_a_hostgroup, true);
  assert.equal(operation.can_confirm, false);
  assert.equal(operation.maintenance_create, "not_sent");
  assert.ok(operation.blockers.includes("hostids_not_confirmed"));
  assert.throws(() => validateMaintenanceDraft(draft({ groups: [{ groupid: "4" }] })), /groups_not_allowed/);
});

test("maps is in the read catalog and the executor never calls Zabbix", () => {
  assert.equal(ZABBIX_MAINTENANCE_COMPATIBILITY.maps.expected_version, "6.0.5");
  assert.equal(ZABBIX_MAINTENANCE_COMPATIBILITY.maps.maintenance_get, true);
  assert.equal(ZABBIX_MAINTENANCE_COMPATIBILITY.maps.write_ready, false);
  assert.throws(() => executeMaintenanceCreate(), /maintenance_writes_disabled/);
  const handler = readFileSync(new URL("../api/oneview/maintenances.js", import.meta.url), "utf8");
  const executor = readFileSync(new URL("../api/_lib/oneview-maintenance-executor.js", import.meta.url), "utf8");
  assert.doesNotMatch(handler, /executeMaintenanceCreate|jsonrpc|maintenance\.create\(/);
  assert.doesNotMatch(executor, /jsonrpc|fetch\(/);
});

test("reminders dedupe by datasource, maintenance id and milestone", () => {
  const key = reminderDedupeKey({ datasource: "zurich", maintenanceId: "44", milestone: "before_end_15m" });
  assert.equal(key, "zurich:44:before_end_15m");
  assert.equal(reminderDedupeKey({ datasource: "zurich", maintenanceId: "44", milestone: "other" }), null);
  const reminders = planMaintenanceReminders({ datasource: "zurich", maintenanceId: "44", customer: "Zurich", hostCount: 2 });
  assert.equal(reminders.length, 3);
  assert.deepEqual(reminders.map((item) => item.status), ["not_sent", "not_sent", "not_sent"]);
  assert.ok(reminders.every((item) => item.theo === "withheld_containment"));
});

test("problem scope separates suppressed problems from resolved history", () => {
  const all = buildAlertListQuery({ query: { problem_scope: "all", status: "all" } });
  assert.equal(all.filters.problemScope, "all");
  assert.equal(all.filters.operationalView, "");
  assert.match(all.whereSql, /resolved_at is null/);
  assert.doesNotMatch(all.whereSql, /status_source', ''\)\) = 'resolved'/);
  const suppressed = buildAlertListQuery({ query: { operational_view: "suppressed", suppression_origin: "maintenance" } });
  assert.equal(suppressed.filters.suppressionOrigin, "maintenance");
  assert.match(suppressed.whereSql, /suppression_origin/);
  assert.throws(() => buildAlertListQuery({ query: { problem_scope: "resolved" } }), /invalid_query/);
});
