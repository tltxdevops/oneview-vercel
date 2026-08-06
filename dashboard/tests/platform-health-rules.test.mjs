import assert from "node:assert/strict";
import test from "node:test";

/**
 * Cópia espelhada das regras de OV-P0-38 (src/lib/platform-health.ts)
 * para validação comportamental no suite node:test.
 */
const DEFAULT_SYNC_INTERVAL_SECONDS = 300;

function syncAgeRatio(lastSuccessAt, intervalSeconds, now) {
  const lastMs = Date.parse(String(lastSuccessAt || ""));
  if (!lastSuccessAt || Number.isNaN(lastMs)) return null;
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  return Math.max(0, now - lastMs) / intervalMs;
}

function levelFromSyncCadence({ lastSuccessAt, failureCount, intervalSeconds, operationalStatus, now }) {
  const status = String(operationalStatus || "").toLowerCase();
  if (status === "error") return "down";

  const ratio = syncAgeRatio(lastSuccessAt, intervalSeconds, now ?? Date.now());
  if (ratio == null) return "unknown";

  const hasFailureCount = Number.isFinite(failureCount);
  const failures = hasFailureCount ? Math.max(0, Number(failureCount)) : 0;

  if (ratio >= 3 || (hasFailureCount && failures >= 3)) return "down";
  if ((ratio >= 1.5 && ratio < 3) || (hasFailureCount && failures >= 1 && failures <= 2)) return "warn";
  if (ratio < 1.5 && (!hasFailureCount || failures === 0)) return "ok";
  return "unknown";
}

function levelFromDatabase(health) {
  if (!health) return "unknown";
  if (health.database_reachable === true) return "ok";
  if (health.database_reachable === false) return "down";
  return "unknown";
}

function findTeletexSource(items) {
  return (items ?? []).find((item) => String(item.name || "").toLowerCase() === "teletex-http") ?? null;
}

function ago(now, minutes) {
  return new Date(now - minutes * 60_000).toISOString();
}

test("OV-P0-38 ausência de last_success resulta em cinza", () => {
  assert.equal(levelFromSyncCadence({ lastSuccessAt: null, failureCount: 0, intervalSeconds: 300 }), "unknown");
  assert.equal(levelFromDatabase(null), "unknown");
});

test("OV-P0-38 banco: verde só com database_reachable=true", () => {
  assert.equal(levelFromDatabase({ database_reachable: true }), "ok");
  assert.equal(levelFromDatabase({ database_reachable: false }), "down");
  assert.notEqual(levelFromDatabase({ database_reachable: false }), "ok");
  assert.equal(levelFromDatabase({}), "unknown");
});

test("OV-P0-38 verde abaixo de 1,5 intervalo (<7m30s)", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");
  const interval = 300;
  for (const minutes of [4, 6, 7]) {
    assert.equal(
      levelFromSyncCadence({
        lastSuccessAt: ago(now, minutes),
        failureCount: 0,
        intervalSeconds: interval,
        now,
      }),
      "ok",
      `${minutes}m`,
    );
  }
  // 7m29s ainda verde
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: new Date(now - (7.5 * 60_000 - 1000)).toISOString(),
      failureCount: 0,
      intervalSeconds: interval,
      now,
    }),
    "ok",
  );
});

test("OV-P0-38 amarelo entre 1,5 e 3 intervalos (7m30s–<15m)", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");
  const interval = 300;
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: ago(now, 7.5),
      failureCount: 0,
      intervalSeconds: interval,
      now,
    }),
    "warn",
  );
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: ago(now, 14),
      failureCount: 0,
      intervalSeconds: interval,
      now,
    }),
    "warn",
  );
});

test("OV-P0-38 vermelho a partir de 3 intervalos (≥15m)", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: ago(now, 15),
      failureCount: 0,
      intervalSeconds: 300,
      now,
    }),
    "down",
  );
});

test("OV-P0-38 failure_count 2 = amarelo", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: ago(now, 4),
      failureCount: 2,
      intervalSeconds: 300,
      now,
    }),
    "warn",
  );
});

test("OV-P0-38 failure_count 3 = vermelho", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");
  assert.equal(
    levelFromSyncCadence({
      lastSuccessAt: ago(now, 4),
      failureCount: 3,
      intervalSeconds: 300,
      now,
    }),
    "down",
  );
});

test("OV-P0-38 teletex-http não usa items[0]", () => {
  const items = [
    { name: "castrolanda", last_success_at: "2026-07-22T11:00:00.000Z" },
    { name: "teletex-http", last_success_at: "2026-07-22T11:59:00.000Z" },
    { name: "zurich", last_success_at: "2026-07-22T10:00:00.000Z" },
  ];
  const found = findTeletexSource(items);
  assert.equal(found?.name, "teletex-http");
  assert.notEqual(found?.name, items[0].name);
});

test("OV-P0-38 fallback de intervalo é 300s", () => {
  assert.equal(DEFAULT_SYNC_INTERVAL_SECONDS, 300);
});
