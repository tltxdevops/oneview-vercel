import assert from "node:assert/strict";
import test from "node:test";

/**
 * Espelho das regras de ordenação/prioridade recentes (OV-P0-30 / oneview-recent.ts).
 */
const severityRank = {
  disaster: 0,
  critical: 1,
  high: 2,
  average: 3,
  warning: 4,
  information: 5,
  not_classified: 6,
};

function normalizeOneViewSeverity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(severityRank, normalized) ? normalized : "not_classified";
}

function compareRecentPriorityAlerts(left, right) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Date.parse(right.first_seen_at || "") - Date.parse(left.first_seen_at || "");
}

function canonicalizeSeveritiesForApi(values) {
  const seen = new Set();
  for (const value of values) {
    const key = String(value || "").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(severityRank, key)) continue;
    seen.add(key);
  }
  if (seen.has("high")) seen.add("critical");
  return [...seen];
}

test("OV-P0-30 Disaster aparece antes de High", () => {
  const items = [
    { severity: "high", first_seen_at: "2026-08-03T12:00:00.000Z" },
    { severity: "disaster", first_seen_at: "2026-08-03T11:00:00.000Z" },
    { severity: "high", first_seen_at: "2026-08-03T13:00:00.000Z" },
  ].sort(compareRecentPriorityAlerts);
  assert.equal(items[0].severity, "disaster");
  assert.equal(items[1].severity, "high");
  assert.equal(items[2].severity, "high");
});

test("OV-P0-30 sem Disaster mantém apenas High", () => {
  const items = [
    { severity: "high", first_seen_at: "2026-08-03T12:00:00.000Z" },
    { severity: "high", first_seen_at: "2026-08-03T13:00:00.000Z" },
  ].sort(compareRecentPriorityAlerts);
  assert.deepEqual(items.map((item) => item.severity), ["high", "high"]);
  assert.ok(items.every((item) => item.severity !== "disaster"));
});

test("OV-P0-30 disaster não é convertido para high", () => {
  assert.deepEqual(
    canonicalizeSeveritiesForApi(["disaster", "high"]).sort(),
    ["critical", "disaster", "high"],
  );
  assert.deepEqual(canonicalizeSeveritiesForApi(["disaster"]), ["disaster"]);
  assert.equal(normalizeOneViewSeverity("disaster"), "disaster");
  assert.notEqual(normalizeOneViewSeverity("disaster"), "high");
});

/** Espelho de normalizeAlertSeveritySummary (oneview-api.ts / OV-P0-42A-REGRESSION). */
function readFiniteCount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNullableCount(value) {
  const n = readFiniteCount(value);
  return n == null ? "—" : n.toLocaleString("pt-BR");
}

function normalizeAlertSeveritySummary(summary) {
  if (!summary || typeof summary !== "object") {
    return { by_severity: null, not_classified: null };
  }
  const by = summary.by_severity;
  const notClassified = readFiniteCount(summary.not_classified);
  if (!by || typeof by !== "object" || Array.isArray(by)) {
    return { by_severity: null, not_classified: notClassified };
  }
  return {
    by_severity: {
      information: readFiniteCount(by.information),
      warning: readFiniteCount(by.warning),
      average: readFiniteCount(by.average),
      high: readFiniteCount(by.high),
      disaster: readFiniteCount(by.disaster),
    },
    not_classified: notClassified,
  };
}

test("OV-P0-42A zero válido ≠ erro; not_classified separado; ordem Information→Disaster", () => {
  const ok = normalizeAlertSeveritySummary({
    by_severity: { information: 0, warning: 1, average: 2, high: 3, disaster: 4 },
    not_classified: 0,
  });
  assert.deepEqual(Object.keys(ok.by_severity), ["information", "warning", "average", "high", "disaster"]);
  assert.equal(ok.by_severity.information, 0);
  assert.equal(ok.not_classified, 0);

  const missingNc = normalizeAlertSeveritySummary({
    by_severity: { information: 1, warning: 0, average: 0, high: 0, disaster: 0 },
  });
  assert.equal(missingNc.by_severity.information, 1);
  assert.equal(missingNc.not_classified, null);

  const highNav = ["high", "critical"];
  assert.deepEqual(highNav, ["high", "critical"]);
  assert.ok(!highNav.includes("disaster"));
});

test("OV-P0-42A-REGRESSION: contrato legado/ausente não vira NaN nem inventa low", () => {
  const allZero = normalizeAlertSeveritySummary({
    by_severity: { information: 0, warning: 0, average: 0, high: 0, disaster: 0 },
    not_classified: 0,
  });
  assert.deepEqual(allZero.by_severity, {
    information: 0,
    warning: 0,
    average: 0,
    high: 0,
    disaster: 0,
  });
  assert.equal(allZero.not_classified, 0);
  assert.equal(formatNullableCount(allZero.not_classified), "0");

  const legacyLow = normalizeAlertSeveritySummary({
    by_severity: { disaster: 4, high: 10, average: 20, low: 99 },
  });
  assert.equal(legacyLow.by_severity.information, null);
  assert.equal(legacyLow.by_severity.warning, null);
  assert.equal(legacyLow.by_severity.average, 20);
  assert.equal(legacyLow.by_severity.high, 10);
  assert.equal(legacyLow.by_severity.disaster, 4);
  assert.equal(legacyLow.not_classified, null);
  assert.equal(Object.hasOwn(legacyLow.by_severity, "low"), false);
  assert.equal(formatNullableCount(legacyLow.not_classified), "—");
  assert.equal(formatNullableCount(legacyLow.by_severity.information), "—");
  assert.doesNotMatch(formatNullableCount(legacyLow.not_classified), /NaN/i);
  assert.doesNotMatch(`Not classified ${formatNullableCount(legacyLow.not_classified)}`, /NaN/i);

  const missingSummary = normalizeAlertSeveritySummary(undefined);
  assert.equal(missingSummary.by_severity, null);
  assert.equal(missingSummary.not_classified, null);
  assert.equal(formatNullableCount(undefined), "—");
  assert.equal(formatNullableCount(Number.NaN), "—");
  assert.doesNotMatch(formatNullableCount(Number.NaN), /NaN/i);

  const absentBy = normalizeAlertSeveritySummary({ total: 1, not_classified: 3 });
  assert.equal(absentBy.by_severity, null);
  assert.equal(absentBy.not_classified, 3);
});
