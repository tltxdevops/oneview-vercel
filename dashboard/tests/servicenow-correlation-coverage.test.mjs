/**
 * SN-P0-09 — testes focados do report de coverage (sem rede/DB).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ageBucket,
  ageHours,
  buildCorrelationCoverageReport,
} from "../scripts/servicenow-correlation-coverage.mjs";

test("ageHours / ageBucket classificam opened_at", () => {
  const now = new Date("2026-08-07T15:00:00.000Z");
  assert.equal(ageHours("2026-08-07 03:00:00", now), 12);
  assert.equal(ageBucket(12), "lt_24h");
  assert.equal(ageBucket(48), "1_7d");
  assert.equal(ageBucket(24 * 10), "7_30d");
  assert.equal(ageBucket(24 * 45), "30_90d");
  assert.equal(ageBucket(24 * 120), "gt_90d");
  assert.equal(ageBucket(null), "unknown");
});

test("buildCorrelationCoverageReport calcula match% e unmatched", () => {
  const now = new Date("2026-08-07T15:00:00.000Z");
  const report = buildCorrelationCoverageReport({
    now,
    rows: [
      {
        raw: { company: { display_value: "Cliente A", value: "a" } },
        incident: {
          number: "INC1",
          company: "a",
          opened_at: "2026-08-07 10:00:00",
          zabbix_event_id: "111",
          short_description: "matched",
        },
        matched: true,
        alert: { id: "alert-1" },
      },
      {
        raw: { company: { display_value: "Cliente A", value: "a" } },
        incident: {
          number: "INC2",
          company: "a",
          opened_at: "2026-07-01 10:00:00",
          zabbix_event_id: "222",
          short_description: "unmatched",
        },
        matched: false,
        alert: null,
      },
      {
        raw: { company: { display_value: "Cliente B", value: "b" } },
        incident: {
          number: "INC3",
          company: "b",
          opened_at: "2026-08-01 10:00:00",
          zabbix_event_id: null,
          short_description: "sem eventid",
        },
        matched: false,
        alert: null,
      },
    ],
  });

  assert.equal(report.incidentes_analisados, 3);
  assert.equal(report.com_eventid, 2);
  assert.equal(report.sem_eventid, 1);
  assert.equal(report.matched, 1);
  assert.equal(report.unmatched, 1);
  assert.equal(report.match_pct, 50);
  assert.equal(report.unmatched_examples.length, 1);
  assert.equal(report.unmatched_examples[0].number, "INC2");
  assert.equal(report.by_client.length, 1);
  assert.equal(report.by_client[0].client, "Cliente A");
  assert.equal(report.by_client[0].matched, 1);
  assert.equal(report.by_client[0].unmatched, 1);
  assert.equal(report.unmatched_temporal.age_buckets["30_90d"], 1);
  assert.equal(report.fallback, "none");
  assert.equal(report.match_strategy, "zabbix_event_id_eq_source_event_id");
});

test("script SN-P0-09 permanece read-only e usa lookup estrito", async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL("../scripts/servicenow-correlation-coverage.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /findAlertBySourceEventId/);
  assert.match(source, /SN-P0-09/);
  assert.match(source, /MAX_RECORDS = 500/);
  assert.match(source, /fallback:\s*"none"/);
  assert.match(source, /Sem writes\. Sem fallback/i);
  assert.doesNotMatch(source, /\b(INSERT|UPDATE\s+\w+|DELETE\s+FROM|upsert)\b/i);
  assert.doesNotMatch(source, /matchByHost|fallbackByHost|matchByDescription/i);
});
