/**
 * OV-P0-246 — Home operational queue: Todos by default, latest arrival first.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function homeAlertArrivalAt(alert) {
  const timestamp = Date.parse(String(alert.first_seen_at || alert.started_at || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareHomeAlerts(left, right) {
  const diff = homeAlertArrivalAt(right) - homeAlertArrivalAt(left);
  if (diff !== 0) return diff;
  return String(right.id || "").localeCompare(String(left.id || ""));
}

function parseHomeSeveritySelection(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || "").split(",").map((item) => item.trim());
  const all = ["information", "warning", "average", "high", "disaster"];
  const seen = new Set();
  for (const item of raw) {
    const normalized = String(item || "").trim().toLowerCase();
    if (!all.includes(normalized)) continue;
    seen.add(normalized);
  }
  return [...seen];
}

function resolveHomeAlertSeverities(mode, severityFilter) {
  const all = ["information", "warning", "average", "high", "disaster"];
  const prioritary = ["average", "high", "disaster"];
  const base = mode === "all" ? [...all] : [...prioritary];
  const selected = parseHomeSeveritySelection(severityFilter);
  if (!selected.length) return base;
  return selected;
}

function formatDurationSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

test("OV-P0-246 default is Todos; Prioritários stays opt-in with canonical severities", () => {
  assert.deepEqual(
    resolveHomeAlertSeverities("all", "all"),
    ["information", "warning", "average", "high", "disaster"],
  );
  assert.deepEqual(
    resolveHomeAlertSeverities("prioritary", "all"),
    ["average", "high", "disaster"],
  );
  assert.deepEqual(resolveHomeAlertSeverities("prioritary", "warning"), ["warning"]);
  assert.deepEqual(resolveHomeAlertSeverities("all", "disaster"), ["disaster"]);
  assert.deepEqual(
    resolveHomeAlertSeverities("all", ["average", "high"]),
    ["average", "high"],
  );
  assert.deepEqual(
    resolveHomeAlertSeverities("prioritary", []),
    ["average", "high", "disaster"],
  );
});

test("OV-P0-246 newest Warning ranks above older Disaster; Sanepar Disaster is not frozen on top", () => {
  const sorted = [
    { id: "sanepar-old", severity: "disaster", first_seen_at: "2026-08-28T16:51:00.000Z" },
    { id: "new-warning", severity: "warning", first_seen_at: "2026-08-28T16:58:00.000Z" },
    { id: "mid-high", severity: "high", first_seen_at: "2026-08-28T16:55:00.000Z" },
    { id: "info", severity: "information", first_seen_at: "2026-08-28T16:57:00.000Z" },
  ].sort(compareHomeAlerts);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ["new-warning", "info", "mid-high", "sanepar-old"],
  );
});

test("OV-P0-246 duration never renders negative values", () => {
  assert.equal(formatDurationSeconds(-12), "—");
  assert.equal(formatDurationSeconds(Number.NaN), "—");
  assert.equal(formatDurationSeconds(null), "—");
  assert.equal(formatDurationSeconds(90), "1 min 30 s");
});

test("OV-P0-246 Home sources: default Todos, arrival sort, filters and drawer preserved", async () => {
  const [home, index] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
  ]);

  assert.match(home, /DEFAULT_HOME_ALERT_MODE: HomeAlertMode = HOME_ALERT_MODE\.all/);
  assert.match(home, /HOME_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(home, /sort: "first_seen_at"/);
  assert.match(home, /order: "desc"/);
  assert.doesNotMatch(home, /sort: "severity"/);
  assert.doesNotMatch(home, /sort: "duration"/);
  assert.match(home, /parseHomeSeveritySelection/);
  assert.match(home, /toggleHomeSeveritySelection/);
  assert.match(home, /homeSeverityFilterTriggerLabel/);
  assert.match(home, /first_seen_at \|\| alert\.started_at/);

  assert.match(index, /useState<HomeAlertMode>\(DEFAULT_HOME_ALERT_MODE\)/);
  assert.match(index, /label: "Todos"/);
  assert.match(index, /label: "Prioritários"/);
  assert.match(index, /ClientFilterCombobox/);
  assert.match(index, /toggleHomeSeveritySelection/);
  assert.match(index, /homeSeverityFilterTriggerLabel/);
  assert.match(index, /selectedSeverities/);
  assert.match(index, /Popover/);
  assert.match(home, /homeModeDefaultSeverities/);
  assert.match(home, /isHomePrioritarySeveritySelection/);
  assert.match(index, /changeAlertMode/);
  assert.match(index, /homeModeDefaultSeverities/);
  assert.match(index, /loadLists\("quiet"\)/);
  assert.match(index, /setAlertMode\(HOME_ALERT_MODE\.all\)/);
  assert.doesNotMatch(index, /setSeverityFilter\("all"\)/);
  assert.match(index, /searchParams\.get\("alert"\)/);
  assert.match(index, /next\.set\("alert", alert\.id\)/);
  assert.match(index, /AlertDetailDrawer/);
  assert.match(index, /canonicalHostName\(alert\)/);
  assert.match(index, /formatCompactFirstSeen\(alert\.first_seen_at \|\| alert\.started_at\)/);
  assert.match(index, /seconds < 0\) return "—"/);
  assert.match(index, /OneViewSeverityBadge severity=\{alert\.severity\}/);
});
