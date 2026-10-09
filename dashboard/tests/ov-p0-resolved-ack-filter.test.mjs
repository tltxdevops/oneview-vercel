import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.join(root, "..");

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

function ackParam(query) {
  const index = query.params.findIndex((value, i) => i > 0 && typeof value === "boolean");
  return index === -1 ? undefined : query.params[index];
}

test("P0 FILTER: Resolvidos + ACK Todos is status_source=resolved only", () => {
  const query = buildAlertListQuery(request({
    status: "resolved",
    include: "items",
  }));
  assert.equal(query.filters.status, "resolved");
  assert.equal(query.filters.acknowledgedSource, "");
  assert.equal(query.filters.oneviewAckStatus, "");
  assert.match(query.whereSql, /lower\(coalesce\(a\.status_source, ''\)\) = 'resolved'/);
  assert.doesNotMatch(query.whereSql, /acknowledged_source/);
  assert.doesNotMatch(query.whereSql, /oneview_ack|acknowledgement_type = 'source'/);
  assert.doesNotMatch(query.whereSql, /a\.resolved_at is null/);
  assert.doesNotMatch(query.whereSql, /status_source, 'active'\)\) = 'active'/);
  assert.equal(ackParam(query), undefined);
});

test("P0 FILTER: Resolvidos + Com ACK is status_source=resolved AND acknowledged_source=true", () => {
  const query = buildAlertListQuery(request({
    status: "resolved",
    acknowledged_source: "true",
    include: "items",
  }));
  assert.equal(query.filters.status, "resolved");
  assert.equal(query.filters.acknowledgedSource, "true");
  assert.match(query.whereSql, /lower\(coalesce\(a\.status_source, ''\)\) = 'resolved'/);
  assert.match(query.whereSql, /coalesce\(a\.acknowledged_source, false\) = \$/);
  assert.equal(ackParam(query), true);
});

test("P0 FILTER: Resolvidos + Sem ACK is status_source=resolved AND acknowledged_source=false", () => {
  const query = buildAlertListQuery(request({
    status: "resolved",
    acknowledged_source: "false",
    include: "items",
  }));
  assert.equal(query.filters.status, "resolved");
  assert.equal(query.filters.acknowledgedSource, "false");
  assert.match(query.whereSql, /lower\(coalesce\(a\.status_source, ''\)\) = 'resolved'/);
  assert.match(query.whereSql, /coalesce\(a\.acknowledged_source, false\) = \$/);
  assert.equal(ackParam(query), false);
});

test("P0 FILTER: status=active never uses the resolved status_source predicate", () => {
  const active = buildAlertListQuery(request({ status: "active", include: "items" }));
  assert.match(active.whereSql, /lower\(coalesce\(a\.status_source, 'active'\)\) = 'active'/);
  assert.doesNotMatch(active.whereSql, /lower\(coalesce\(a\.status_source, ''\)\) = 'resolved'/);
  const resolved = buildAlertListQuery(request({ status: "resolved", include: "items" }));
  assert.doesNotMatch(resolved.whereSql, /lower\(coalesce\(a\.status_source, 'active'\)\) = 'active'/);
});

test("P0 FILTER: front maps Estado/ACK da origem/ACK OneView without layout coupling", async () => {
  const [alerts, api, fallback] = await Promise.all([
    readFile(path.join(dashboardRoot, "src/pages/Alerts.tsx"), "utf8"),
    readFile(path.join(dashboardRoot, "src/lib/oneview-api.ts"), "utf8"),
    readFile(path.join(dashboardRoot, "api/_lib/oneview-fallback.js"), "utf8"),
  ]);
  assert.match(alerts, /(?:<SelectItem value="resolved">Resolvidos<\/SelectItem>|ALERT_STATUS_OPTIONS[\s\S]*value: "resolved", label: "Resolvido")/);
  assert.match(alerts, /status: statusFilter,/);
  assert.match(alerts, /acknowledgedSource: sourceAckFilter === "all" \? undefined : sourceAckFilter === "acknowledged"/);
  assert.match(alerts, /(?:oneviewAckStatus: oneviewAckFilter === "all" \? undefined : oneviewAckFilter|oneviewAckStatuses)/);
  assert.match(api, /if \(params\?\.status\) search\.set\("status", params\.status\)/);
  assert.match(api, /search\.set\("acknowledged_source", String\(params\.acknowledgedSource\)\)/);
  assert.match(fallback, /String\(item\.status_source \|\| ""\)\.toLowerCase\(\) === "resolved"/);
});
