/** OV-P0-248 — Home V3 operational command center. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { alertHasOperatorTag } from "../api/_lib/oneview-operator-tags.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

function request(query = {}) {
  return { query };
}

function compareArrival(left, right) {
  const ts = (item) => Date.parse(item.first_seen_at || item.started_at || "") || 0;
  return ts(right) - ts(left);
}

test("OV-P0-248: newest Warning stays ahead of older Disaster", () => {
  const items = [
    { id: "old-disaster", severity: "disaster", first_seen_at: "2026-08-31T10:00:00.000Z" },
    { id: "new-warning", severity: "warning", first_seen_at: "2026-08-31T10:03:00.000Z" },
  ].sort(compareArrival);
  assert.deepEqual(items.map((item) => item.id), ["new-warning", "old-disaster"]);
});

test("OV-P0-248: canonical operator tag is excluded only by explicit Home filter", () => {
  const operator = {
    event_tags: [{ tag: "description", value: "OPERADORA-4G" }],
    trigger_tags: [],
    host_tags: [],
  };
  assert.equal(alertHasOperatorTag(operator), true);
  assert.equal(alertHasOperatorTag({
    event_tags: [], trigger_tags: [], host_tags: [],
    host_name: "operadora-gw", customer_name: "Operadora Cliente", problem_name: "Operadora down",
  }), false);

  const home = buildAlertListQuery(request({ exclude_operator: "true" }), "teletex-http");
  const alerts = buildAlertListQuery(request(), "teletex-http");
  assert.match(home.whereSql, /not \(\s*exists \(/);
  assert.doesNotMatch(alerts.whereSql, /operadora\|operador\|escalonamento/i);
  assert.equal(home.filters.excludeOperator, true);
  assert.equal(alerts.filters.excludeOperator, false);
});

test("OV-P0-248: Home V3 keeps alert deep link, operator panel, and monitoring incident queue", async () => {
  const [home, page, api, operator] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-operator-queue.js"),
  ]);

  assert.match(home, /sort: "first_seen_at"/);
  assert.match(home, /order: "desc"/);
  assert.match(home, /excludeOperator: true/);
  assert.match(home, /assigned_to/);
  assert.match(page, /title="Alertas Recentes"/);
  assert.match(page, /title="Links"/);
  assert.match(page, /Ver conectividade/);
  assert.match(page, /OperationalIncidentsToolbar/);
  assert.match(page, /OperationalIncidentsQueueList/);
  assert.match(page, /IncidentQuickSheet/);
  assert.match(page, /fetchOperationalIncidents/);
  assert.match(page, /Ver todos em Chamados/);
  assert.match(page, /searchParams\.get\("alert"\)/);
  assert.match(page, /next\.set\("alert", alert\.id\)/);
  assert.match(api, /excludeOperator\?: boolean/);
  assert.match(api, /alertStatus\?: "all" \| "active" \| "resolved"/);
  assert.match(operator, /alert_status/);
  assert.match(operator, /a\.resolved_at is null/);
});
