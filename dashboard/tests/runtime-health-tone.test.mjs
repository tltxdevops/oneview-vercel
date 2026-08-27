import assert from "node:assert/strict";
import test from "node:test";

/** Espelho de src/lib/runtime-health.ts — tons operacionais da faixa. */
const STALE_ATTENTION_MS = 14 * 60 * 1000;

function ageMs(lastSuccessAt, now) {
  const timestamp = Date.parse(String(lastSuccessAt || ""));
  if (!lastSuccessAt || Number.isNaN(timestamp)) return null;
  return Math.max(0, now - timestamp);
}

function operationalToneFromStatus(status, lastSuccessAt, now = Date.now()) {
  if (status === "DOWN") return "down";
  if (status === "HEALTHY") return "ok";
  if (status === "DEGRADED" || status === "STALE") {
    const age = ageMs(lastSuccessAt, now);
    if (age != null && age >= STALE_ATTENTION_MS) return "stale";
    return "partial";
  }
  return "unknown";
}

function operationalToneFromGroup(items, now = Date.now()) {
  if (!items.length) return "unknown";
  const healthyCount = items.filter((item) => item.status === "HEALTHY").length;
  if (healthyCount === items.length) return "ok";
  if (healthyCount > 0) return "partial";
  if (items.every((item) => item.status === "DOWN")) return "down";
  const ages = items.map((item) => ageMs(item.last_success_at, now)).filter((value) => value != null);
  if (ages.length && Math.max(...ages) >= STALE_ATTENTION_MS) return "stale";
  if (items.some((item) => item.status === "DEGRADED" || item.status === "STALE")) return "partial";
  return "unknown";
}

const now = Date.parse("2026-08-25T16:00:00.000Z");
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

test("tons operacionais: verde / amarelo parcial / vermelho 14min / branco down", () => {
  assert.equal(operationalToneFromStatus("HEALTHY", at(1), now), "ok");
  assert.equal(operationalToneFromStatus("DEGRADED", at(3), now), "partial");
  assert.equal(operationalToneFromStatus("STALE", at(5), now), "partial");
  assert.equal(operationalToneFromStatus("STALE", at(14), now), "stale");
  assert.equal(operationalToneFromStatus("DOWN", at(1), now), "down");
  assert.equal(operationalToneFromStatus("UNKNOWN"), "unknown");
});

test("Zabbix parcial não vira branco quando ainda há link saudável", () => {
  assert.equal(operationalToneFromGroup([
    { status: "HEALTHY", last_success_at: at(1) },
    { status: "DOWN", last_success_at: at(20) },
  ], now), "partial");
  assert.equal(operationalToneFromGroup([
    { status: "DOWN", last_success_at: at(20) },
    { status: "DOWN", last_success_at: at(30) },
  ], now), "down");
  assert.equal(operationalToneFromGroup([
    { status: "STALE", last_success_at: at(16) },
    { status: "STALE", last_success_at: at(18) },
  ], now), "stale");
});
