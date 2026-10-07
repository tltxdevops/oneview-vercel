/**
 * OV-P0-268 — feedback visual de transição ao vivo na fila do Monitoramento.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LIVE_TRANSITION_DURATION_MS,
  detectLiveTransitions,
  isLiveTransitionActive,
  mergeLiveTransitionQueue,
  prunePinnedByTransitions,
  reconcileLiveTransitions,
  snapshotFromAlert,
  toLiveSnapshotMap,
} from "../src/lib/oneview-live-transition.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function alert(partial) {
  return snapshotFromAlert({
    id: "a1",
    status_source: "active",
    status_internal: "active",
    acknowledged_source: false,
    acknowledged_internal: false,
    ...partial,
  });
}

test("OV-P0-268: first snapshot does not emit transitions", () => {
  const next = toLiveSnapshotMap([
    alert({ id: "a1", acknowledged_source: true }),
    alert({ id: "a2", status_source: "resolved" }),
  ]);
  const detected = detectLiveTransitions({
    previousById: new Map(),
    nextById: next,
    previousSnapshotReady: false,
  });
  assert.equal(detected.length, 0);
});

test("OV-P0-268: unack → ack pulses once and does not reflash", () => {
  const previous = toLiveSnapshotMap([alert({ id: "a1", acknowledged_source: false })]);
  const next = toLiveSnapshotMap([alert({ id: "a1", acknowledged_source: true })]);
  const now = Date.parse("2026-09-01T18:00:00.000Z");
  const detected = detectLiveTransitions({
    previousById: previous,
    nextById: next,
    previousSnapshotReady: true,
    now,
  });
  assert.equal(detected.length, 1);
  assert.equal(detected[0].kind, "acknowledged");
  assert.equal(detected[0].label, "✓ Reconhecido");
  assert.equal(detected[0].endsAt - detected[0].startedAt, LIVE_TRANSITION_DURATION_MS);

  const first = reconcileLiveTransitions({
    current: new Map(),
    detected,
    consumedVersionKeys: new Set(),
    now,
  });
  assert.equal(first.active.get("a1")?.kind, "acknowledged");

  const again = detectLiveTransitions({
    previousById: next,
    nextById: next,
    previousSnapshotReady: true,
    consumedVersionKeys: first.consumedVersionKeys,
    now: now + 10_000,
  });
  assert.equal(again.length, 0);

  const second = reconcileLiveTransitions({
    current: first.active,
    detected: again,
    consumedVersionKeys: first.consumedVersionKeys,
    now: now + 10_000,
  });
  assert.equal(second.active.has("a1"), false);
});

test("OV-P0-268: active → resolved pulses once and holds until transition ends", () => {
  const previous = toLiveSnapshotMap([alert({ id: "a1", status_source: "active" })]);
  const next = toLiveSnapshotMap([alert({ id: "a1", status_source: "resolved" })]);
  const now = Date.parse("2026-09-01T18:00:00.000Z");
  const detected = detectLiveTransitions({
    previousById: previous,
    nextById: next,
    previousSnapshotReady: true,
    now,
  });
  assert.equal(detected[0]?.kind, "resolved");
  assert.equal(detected[0]?.label, "✓ Resolvido");

  const reconciled = reconcileLiveTransitions({
    current: new Map(),
    detected,
    consumedVersionKeys: new Set(),
    now,
  });
  const pinned = new Map([["a1", { id: "a1", status_source: "resolved" }]]);
  const held = mergeLiveTransitionQueue({
    serverItems: [],
    pinnedById: pinned,
    transitions: reconciled.active,
    passesFilter: (item) => item.status_source === "active",
    filter: { hideResolved: true },
    now,
  });
  assert.equal(held.length, 1);
  assert.equal(held[0].id, "a1");

  const after = mergeLiveTransitionQueue({
    serverItems: [],
    pinnedById: pinned,
    transitions: reconciled.active,
    passesFilter: (item) => item.status_source === "active",
    filter: { hideResolved: true },
    now: now + LIVE_TRANSITION_DURATION_MS + 1,
  });
  assert.equal(after.length, 0);
});

test("OV-P0-268: unassigned → assigned shows assignee label", () => {
  const previous = toLiveSnapshotMap([
    alert({ id: "i1", assigned_to: null, assigned_to_display: null }),
  ]);
  const next = toLiveSnapshotMap([
    alert({ id: "i1", assigned_to: "sys1", assigned_to_display: "Ana Silva" }),
  ]);
  const detected = detectLiveTransitions({
    previousById: previous,
    nextById: next,
    previousSnapshotReady: true,
  });
  assert.equal(detected[0]?.kind, "assigned");
  assert.equal(detected[0]?.label, "✓ Assumido por Ana Silva");
});

test("OV-P0-268: identical snapshot does not reflash", () => {
  const snap = toLiveSnapshotMap([alert({ id: "a1", acknowledged_source: true })]);
  const detected = detectLiveTransitions({
    previousById: snap,
    nextById: snap,
    previousSnapshotReady: true,
  });
  assert.equal(detected.length, 0);
});

test("OV-P0-268: disappearance alone is not a transition", () => {
  const previous = toLiveSnapshotMap([alert({ id: "a1" })]);
  const detected = detectLiveTransitions({
    previousById: previous,
    nextById: new Map(),
    previousSnapshotReady: true,
  });
  assert.equal(detected.length, 0);
});

test("OV-P0-268: resolved filter keeps item; active filter delays removal", () => {
  const now = 1_000;
  const transition = {
    id: "a1",
    kind: "resolved",
    versionKey: "a1::resolved::1",
    label: "✓ Resolvido",
    startedAt: now,
    endsAt: now + LIVE_TRANSITION_DURATION_MS,
  };
  const transitions = new Map([["a1", transition]]);
  const item = { id: "a1", status_source: "resolved" };

  const onResolvedFilter = mergeLiveTransitionQueue({
    serverItems: [item],
    pinnedById: new Map(),
    transitions,
    passesFilter: () => true,
    filter: { hideResolved: false },
    now,
  });
  assert.equal(onResolvedFilter.length, 1);

  const onActiveFilter = mergeLiveTransitionQueue({
    serverItems: [],
    pinnedById: new Map([["a1", item]]),
    transitions,
    passesFilter: () => false,
    filter: { hideResolved: true },
    now,
  });
  assert.equal(onActiveFilter.length, 1);
  assert.equal(isLiveTransitionActive(transition, now), true);
});

test("OV-P0-268: prune drops pins after transition ends", () => {
  const now = 1_000;
  const transitions = new Map([
    ["a1", {
      id: "a1",
      kind: "acknowledged",
      versionKey: "a1::acknowledged::1",
      label: "✓ Reconhecido",
      startedAt: now,
      endsAt: now + 10,
    }],
  ]);
  const pinned = new Map([["a1", { id: "a1" }], ["a2", { id: "a2" }]]);
  const kept = prunePinnedByTransitions(pinned, transitions, now);
  assert.equal(kept.has("a1"), true);
  assert.equal(kept.has("a2"), false);
  const gone = prunePinnedByTransitions(pinned, transitions, now + 11);
  assert.equal(gone.size, 0);
});

test("OV-P0-268: Monitoring wires engine, stale guard, CSS and reduced motion", async () => {
  const page = await read("src/pages/Monitoring.tsx");
  const css = await read("src/index.css");
  const engine = await read("src/lib/oneview-live-transition.ts");

  assert.match(engine, /detectLiveTransitions/);
  assert.match(engine, /previousSnapshotReady/);
  assert.match(engine, /versionKey/);
  assert.match(page, /oneview-live-transition/);
  assert.match(page, /detectLiveTransitions/);
  assert.match(page, /mergeLiveTransitionQueue/);
  assert.match(page, /pollGenerationRef/);
  assert.match(page, /ov-live-transition/);
  assert.match(engine, /Reconhecido|Resolvido|Assumido/);
  assert.match(css, /ov-live-transition-pulse/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(page, /REFRESH_MS\s*=\s*10_000/);
});
