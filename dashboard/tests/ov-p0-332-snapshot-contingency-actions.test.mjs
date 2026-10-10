import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SNAPSHOT_MUTATION_UNAVAILABLE_REASON,
  alertsContingencyState,
  formatSnapshotCopyClock,
} from "../src/lib/oneview-snapshot-actions.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("database_unavailable snapshot disables mutable actions and labels the copy clock", () => {
  const state = alertsContingencyState("snapshot", "2026-10-09T21:05:32.000Z");
  assert.equal(state.contingency, true);
  assert.equal(state.mutationsEnabled, false);
  assert.equal(state.copyLabel, "Cópia de 18:05:32");
  assert.equal(formatSnapshotCopyClock("2026-10-09T21:05:32.000Z"), "Cópia de 18:05:32");
  assert.equal(state.mutationReason, "Indisponível enquanto a origem em tempo real não puder ser validada.");
  assert.equal(state.mutationReason, SNAPSHOT_MUTATION_UNAVAILABLE_REASON);
});

test("DB returns and mutable actions are enabled again", () => {
  const down = alertsContingencyState("snapshot", "2026-10-09T21:05:32.000Z");
  const up = alertsContingencyState("database", "2026-10-09T21:06:10.000Z");
  assert.equal(down.mutationsEnabled, false);
  assert.equal(up.contingency, false);
  assert.equal(up.mutationsEnabled, true);
  assert.equal(up.copyLabel, null);
  assert.equal(up.mutationReason, null);
});

test("alerts page keeps the banner, blocks POSTs on the copy, and refetches when the database returns", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const ack = await read("src/components/oneview/AlertSourceAckAction.tsx");
  const claim = await read("src/components/oneview/IncidentActions.tsx");
  const share = await read("src/components/oneview/ClientShareDialog.tsx");
  assert.match(alerts, /Dados em modo de contingência/);
  assert.match(alerts, /não o estado operacional atual/);
  assert.match(alerts, /formatSnapshotCopyClock\(snapshotCopyAt \|\| lastCheckedAt\)/);
  assert.match(alerts, /Cópia da fila\. Não é o estado operacional atual\./);
  assert.match(alerts, /mutationsBlocked=\{alertsAreCopy\}/);
  assert.match(alerts, /liveStateUnavailable=\{alertsAreCopy\}/);
  assert.match(alerts, /liveStateUnavailable=\{liveStateUnavailable\}/);
  assert.match(alerts, /if \(wasCopy && !alertsAreCopy && selectedAlertId\) void loadSelectedAlert\(selectedAlertId\)/);
  assert.match(alerts, /void loadAlerts\(\{ quiet: true \}\)/);
  assert.match(ack, /if \(liveStateUnavailable \|\| !canOpen \|\| submitting \|\| currentAlert\.source_ack_available !== true\) return/);
  assert.match(claim, /if \(mutationsBlocked \|\| !incident\.sys_id \|\| submitting\) return/);
  assert.match(share, /if \(mutationsBlocked \|\| sending \|\| !canSend \|\| !selected\) return/);
  assert.doesNotMatch(alerts, /Cópia de \{formatDateTime/);
});
