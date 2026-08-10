/**
 * SN-P0-20 — testes focados do report de cobertura elegível (sem rede/DB).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ageMinutes,
  buildEligibleCoverageReport,
  ELIGIBLE_SEVERITIES,
  lagMinutes,
  MIN_AGE_MINUTES,
} from "../scripts/sn-p0-20-eligible-alert-incident-coverage.mjs";

test("SN-P0-20 elegíveis: só average/high/disaster; min age 10m", () => {
  assert.deepEqual(ELIGIBLE_SEVERITIES, ["average", "high", "disaster"]);
  assert.equal(MIN_AGE_MINUTES, 10);
});

test("SN-P0-20 ageMinutes / lagMinutes", () => {
  const now = new Date("2026-08-10T15:00:00.000Z");
  assert.equal(ageMinutes("2026-08-10T14:00:00.000Z", now), 60);
  assert.equal(lagMinutes("2026-08-10T14:00:00.000Z", "2026-08-10T14:05:00.000Z"), 5);
  assert.equal(lagMinutes("2026-08-10T14:00:00.000Z", null), null);
});

test("SN-P0-20 report: match% por severity/cliente e zero-match", () => {
  const now = new Date("2026-08-10T15:00:00.000Z");
  const report = buildEligibleCoverageReport({
    windowHours: 24,
    now,
    rows: [
      {
        id: "1",
        source_event_id: "100",
        severity: "high",
        customer: "Sanepar",
        host: "h1",
        first_seen_at: "2026-08-10T14:00:00.000Z",
        matched: true,
        incident_opened_at: "2026-08-10T14:03:00.000Z",
      },
      {
        id: "2",
        source_event_id: "101",
        severity: "high",
        customer: "Sanepar",
        host: "h2",
        first_seen_at: "2026-08-10T13:00:00.000Z",
        matched: false,
      },
      {
        id: "3",
        source_event_id: "102",
        severity: "average",
        customer: "FPS",
        host: "h3",
        first_seen_at: "2026-08-10T12:00:00.000Z",
        matched: false,
      },
      {
        id: "4",
        source_event_id: "103",
        severity: "disaster",
        customer: "Unicap",
        host: "h4",
        first_seen_at: "2026-08-10T11:00:00.000Z",
        matched: true,
        incident_opened_at: "2026-08-10T11:10:00.000Z",
      },
    ],
  });

  assert.equal(report.total_eligible, 4);
  assert.equal(report.matched, 2);
  assert.equal(report.unmatched, 2);
  assert.equal(report.match_pct, 50);
  assert.deepEqual(report.excluded_from_denominator, ["information", "warning"]);

  const high = report.by_severity.find((item) => item.severity === "high");
  assert.equal(high.total, 2);
  assert.equal(high.matched, 1);
  assert.equal(high.match_pct, 50);

  const average = report.by_severity.find((item) => item.severity === "average");
  assert.equal(average.match_pct, 0);

  const fps = report.by_customer.find((item) => item.customer === "FPS");
  assert.equal(fps.matched, 0);
  assert.equal(fps.match_pct, 0);

  assert.ok(report.unmatched_high_average_examples.length >= 2);
  assert.equal(report.lag_first_seen_to_opened_minutes.sample, 2);
  assert.equal(report.lag_first_seen_to_opened_minutes.avg, 6.5);
  assert.equal(report.answer.clients_or_severities_with_zero_incidents, true);
  assert.ok(report.answer.zero_match_severities.includes("average"));
  assert.ok(report.answer.zero_match_customers_sample.includes("FPS"));
});

test("SN-P0-20 information/warning nunca entram no report builder via severity list", () => {
  // Denominador do script SQL filtra; o report só agrega o que recebe.
  // Garante que a lista pública exclui info/warning.
  assert.ok(!ELIGIBLE_SEVERITIES.includes("information"));
  assert.ok(!ELIGIBLE_SEVERITIES.includes("warning"));
});
