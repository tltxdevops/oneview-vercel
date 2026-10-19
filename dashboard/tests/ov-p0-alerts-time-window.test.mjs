import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  alertsDateBounds,
  applyDateFieldToFetchParams,
  writeAlertsUrlParams,
} from "../src/lib/alerts-query.ts";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const now = Date.parse("2026-10-19T12:00:00.000Z");

test("quick windows use exact UTC bounds and Todos remains unbounded", () => {
  assert.deepEqual(alertsDateBounds("24h", undefined, now), {
    from: "2026-10-18T12:00:00.000Z",
    to: "2026-10-19T12:00:00.000Z",
  });
  assert.deepEqual(alertsDateBounds("7d", undefined, now), {
    from: "2026-10-12T12:00:00.000Z",
    to: "2026-10-19T12:00:00.000Z",
  });
  assert.deepEqual(alertsDateBounds("30d", undefined, now), {
    from: "2026-09-19T12:00:00.000Z",
    to: "2026-10-19T12:00:00.000Z",
  });
  assert.deepEqual(alertsDateBounds("all", undefined, now), {});
});

test("history filters by recovery while operational queues filter by first seen", () => {
  const bounds = alertsDateBounds("7d", undefined, now);
  assert.deepEqual(applyDateFieldToFetchParams({}, "first_seen", bounds), {
    firstSeenFrom: bounds.from,
    firstSeenTo: bounds.to,
  });
  assert.deepEqual(applyDateFieldToFetchParams({}, "resolved", bounds), {
    resolvedFrom: bounds.from,
    resolvedTo: bounds.to,
  });
});

test("custom date field and deep links survive URL serialization", () => {
  const query = writeAlertsUrlParams({
    view: "history", customers: [], severities: [], status: "all", acknowledgedSource: "all", oneviewAckStatus: "all",
    dateField: "resolved", datePreset: "custom", dateRange: { from: new Date("2026-10-01T00:00:00.000Z") },
    searchField: "all", search: "", sort: "resolved_at", order: "desc", page: 1, pageSize: 50, alert: "00000000-0000-0000-0000-000000000000",
  });
  assert.equal(query.get("date_field"), "resolved");
  assert.equal(query.get("alert"), "00000000-0000-0000-0000-000000000000");
  assert.equal(query.get("date_from"), "2026-10-01T00:00:00.000Z");
});

test("Central defaults each queue and sends the selected field to the BFF", () => {
  const alerts = read("src/pages/Alerts.tsx");
  assert.match(alerts, /return view === "history" \? "30d" : "7d"/);
  assert.match(alerts, /applyDateFieldToFetchParams\(request, dateField, dateBounds\)/);
  assert.match(alerts, /setDateField\(view === "history" \? "resolved" : ALERTS_DATE_FIELD\)/);
  assert.match(alerts, /Detalhe aberto por link\. Este alerta pode estar fora da janela ou dos filtros atuais\./);
  assert.match(alerts, /trailing=\{compactPeriodSelector\}/);
});

test("BFF applies temporal clauses before the paginated items query and scoped counters", () => {
  const database = read("api/_lib/oneview-db.js");
  assert.match(database, /if \(firstSeenFrom\) push\("a\.first_seen_at >= \?", firstSeenFrom\);[\s\S]*?const scopeClauses/);
  assert.match(database, /const itemsSql = `[\s\S]*?\$\{whereSql\}[\s\S]*?limit \$\$\{params\.length \+ 1\}/);
  assert.match(database, /const queueSql = `[\s\S]*?\$\{scopeWhereSql\}/);
});
