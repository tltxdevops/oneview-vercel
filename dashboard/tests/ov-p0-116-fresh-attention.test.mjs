/**
 * OV-P0-116 — pulse de atenção para High/Disaster novos no Monitoramento.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FRESH_ATTENTION_DURATION_MS,
  activeFreshAttentionIds,
  freshAttentionTone,
  isFreshAttentionSeverity,
  isFreshByFirstSeen,
  reconcileFreshAttention,
  remainingFreshAttentionMs,
} from "../src/lib/oneview-fresh-attention.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function isoAgo(ms, now) {
  return new Date(now - ms).toISOString();
}

test("OV-P0-116 só High/Disaster/critical legado entram no pulse", () => {
  assert.equal(isFreshAttentionSeverity("disaster"), true);
  assert.equal(isFreshAttentionSeverity("high"), true);
  assert.equal(isFreshAttentionSeverity("CRITICAL"), true);
  assert.equal(isFreshAttentionSeverity("average"), false);
  assert.equal(isFreshAttentionSeverity("warning"), false);
  assert.equal(freshAttentionTone("disaster"), "disaster");
  assert.equal(freshAttentionTone("critical"), "high");
  assert.equal(freshAttentionTone("high"), "high");
  assert.equal(freshAttentionTone("average"), null);
});

test("OV-P0-116 primeiro snapshot não pinta a fila inteira", () => {
  const now = Date.parse("2026-08-13T14:00:00.000Z");
  const next = reconcileFreshAttention({
    alerts: [
      { id: "old-d", severity: "disaster", first_seen_at: isoAgo(10 * 60_000, now) },
      { id: "old-h", severity: "high", first_seen_at: isoAgo(2 * 60_000, now) },
      { id: "fresh-d", severity: "disaster", first_seen_at: isoAgo(20_000, now) },
      { id: "avg", severity: "average", first_seen_at: isoAgo(5_000, now) },
    ],
    knownIds: new Set(),
    attentionStartedAt: new Map(),
    isFirstSnapshot: true,
    now,
  });

  assert.equal(next.knownIds.size, 4);
  assert.equal(next.attentionStartedAt.has("fresh-d"), true);
  assert.equal(next.attentionStartedAt.has("old-d"), false);
  assert.equal(next.attentionStartedAt.has("old-h"), false);
  assert.equal(next.attentionStartedAt.has("avg"), false);
});

test("OV-P0-116 poll não reinicia timer e não reanima alerta já visto", () => {
  const now = Date.parse("2026-08-13T14:00:00.000Z");
  const first = reconcileFreshAttention({
    alerts: [{ id: "a1", severity: "high", first_seen_at: isoAgo(10_000, now) }],
    knownIds: new Set(),
    attentionStartedAt: new Map(),
    isFirstSnapshot: true,
    now,
  });
  const startedAt = first.attentionStartedAt.get("a1");
  assert.equal(startedAt, now);

  const later = now + 30_000;
  const second = reconcileFreshAttention({
    alerts: [
      { id: "a1", severity: "high", first_seen_at: isoAgo(40_000, later) },
      { id: "a2", severity: "disaster", first_seen_at: isoAgo(5_000, later) },
    ],
    knownIds: first.knownIds,
    attentionStartedAt: first.attentionStartedAt,
    isFirstSnapshot: false,
    now: later,
  });

  assert.equal(second.attentionStartedAt.get("a1"), startedAt);
  assert.equal(second.attentionStartedAt.get("a2"), later);

  const third = reconcileFreshAttention({
    alerts: [{ id: "a1", severity: "high", first_seen_at: isoAgo(5_000, later + 90_000) }],
    knownIds: second.knownIds,
    attentionStartedAt: second.attentionStartedAt,
    isFirstSnapshot: false,
    now: later + 90_000,
  });
  assert.equal(third.attentionStartedAt.get("a1"), startedAt);
  assert.equal(remainingFreshAttentionMs(startedAt, later + 90_000), 0);
  assert.equal(activeFreshAttentionIds(third.attentionStartedAt, later + 90_000).has("a1"), false);
});

test("OV-P0-116 alerta antigo que entra por filtro não pulsa; average nunca pulsa", () => {
  const now = Date.parse("2026-08-13T14:00:00.000Z");
  const seeded = reconcileFreshAttention({
    alerts: [{ id: "seed", severity: "warning", first_seen_at: isoAgo(1_000, now) }],
    knownIds: new Set(),
    attentionStartedAt: new Map(),
    isFirstSnapshot: true,
    now,
  });
  const next = reconcileFreshAttention({
    alerts: [
      { id: "old-high", severity: "high", first_seen_at: isoAgo(2 * 60 * 60_000, now) },
      { id: "avg-new", severity: "average", first_seen_at: isoAgo(3_000, now) },
    ],
    knownIds: seeded.knownIds,
    attentionStartedAt: seeded.attentionStartedAt,
    isFirstSnapshot: false,
    now,
  });
  assert.equal(next.attentionStartedAt.has("old-high"), false);
  assert.equal(next.attentionStartedAt.has("avg-new"), false);
  assert.equal(next.knownIds.has("old-high"), true);
});

test("OV-P0-116 duração máxima 60s", () => {
  const now = 1_000_000;
  assert.equal(remainingFreshAttentionMs(now, now), FRESH_ATTENTION_DURATION_MS);
  assert.equal(remainingFreshAttentionMs(now, now + 59_000) > 0, true);
  assert.equal(remainingFreshAttentionMs(now, now + 60_000), 0);
  assert.equal(isFreshByFirstSeen(isoAgo(89_000, now), now), true);
  assert.equal(isFreshByFirstSeen(isoAgo(91_000, now), now), false);
});

test("OV-P0-116 Monitoramento aplica pulse só na fila; outras telas intactas", async () => {
  const [monitoring, css, alerts, historico, index] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/index.css"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Index.tsx"),
  ]);

  assert.match(monitoring, /reconcileFreshAttention/);
  assert.match(monitoring, /freshAttentionIds/);
  assert.match(monitoring, /ov-fresh-attention-disaster/);
  assert.match(monitoring, /ov-fresh-attention-high/);
  assert.match(monitoring, /\bNovo\b/);
  assert.match(monitoring, /freshTone=\{freshAttentionIds\.has\(alert\.id\)/);
  assert.doesNotMatch(monitoring, /new Audio|AudioContext|play\(\)/);
  assert.doesNotMatch(monitoring, /sessionStorage.*fresh|localStorage.*fresh/);

  assert.match(css, /ov-fresh-attention-disaster/);
  assert.match(css, /ov-fresh-attention-high/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /ov-fresh-attention[\s\S]{0,80}background-color:\s*hsl\(0/);

  assert.doesNotMatch(alerts, /ov-fresh-attention|reconcileFreshAttention/);
  assert.doesNotMatch(historico, /ov-fresh-attention|reconcileFreshAttention/);
  assert.doesNotMatch(index, /ov-fresh-attention|reconcileFreshAttention/);
});
