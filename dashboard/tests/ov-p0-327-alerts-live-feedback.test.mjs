import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-327 Alerts mirrors fresh red attention without flashing the first snapshot", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /reconcileFreshAttention/);
  assert.match(alerts, /isFirstSnapshot: !freshSeededRef\.current/);
  assert.match(alerts, /ALERTS_FRESH_ATTENTION_DURATION_MS = 18_000/);
  assert.match(alerts, /ov-alert-fresh-attention-high/);
  assert.match(alerts, /ov-alert-fresh-attention-disaster/);
  assert.match(alerts, /isActive && !acknowledged\(alert\) && !liveTransition/);
});

test("OV-P0-327 Alerts stops red attention after fifteen pulses", async () => {
  const css = await read("src/index.css");
  assert.match(css, /\.ov-alert-fresh-attention-high\s*\{[^}]*animation: ov-fresh-ring-high 1\.2s ease-in-out 15/s);
  assert.match(css, /\.ov-alert-fresh-attention-disaster\s*\{[^}]*animation: ov-fresh-ring-disaster 1\.2s ease-in-out 15/s);
});

test("OV-P0-327 only flags global contingency when primary alert data is a snapshot", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /const primaryMetas = \[alertsMeta, metricsMeta\]/);
  assert.match(alerts, /primaryMetas\.some\(\(meta\) => meta\.source === "snapshot"\)/);
});

test("OV-P0-327 ACK and resolution are proven, pinned and shown for ten green pulses", async () => {
  const [alerts, css] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/index.css"),
  ]);
  assert.match(alerts, /ALERTS_SUCCESS_PULSE_DURATION_MS = 9_000/);
  assert.match(alerts, /detectLiveTransitions/);
  assert.match(alerts, /previousSnapshotReady: alertSnapshotReadyRef\.current/);
  assert.match(alerts, /fetchAlert\(id, controller\.signal\)/);
  assert.match(alerts, /mergeLiveTransitionQueue/);
  assert.match(alerts, /ov-alert-success-transition/);
  assert.match(alerts, /liveTransition\.label/);
  assert.match(css, /\.ov-alert-success-transition\s*\{[^}]*animation: ov-live-transition-pulse 0\.9s ease-in-out 10/s);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.ov-alert-success-transition/);
});
