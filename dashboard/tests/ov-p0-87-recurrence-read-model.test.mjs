import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildAlertRecurrenceReadModel,
  emptyAlertRecurrenceReadModel,
  hasRecurrenceIdentity,
  selectRecurrenceEpisodes,
} from "../api/_lib/oneview-recurrence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const NOW = new Date("2026-08-11T18:00:00.000Z");

function alert(partial) {
  return {
    data_source_id: "ds-1",
    source_host_id: "host-1",
    source_trigger_id: "trig-1",
    ...partial,
  };
}

test("OV-P0-87 identidade exige data_source_id + source_host_id + source_trigger_id", () => {
  assert.equal(hasRecurrenceIdentity(alert({ id: "a" })), true);
  assert.equal(hasRecurrenceIdentity(alert({ source_host_id: null })), false);
  assert.equal(hasRecurrenceIdentity(alert({ source_trigger_id: "" })), false);
  assert.deepEqual(buildAlertRecurrenceReadModel({ current: alert({ id: "a", source_host_id: null }) }), emptyAlertRecurrenceReadModel());
});

test("OV-P0-87 não conta episódio sem resolved_at no predecessor", () => {
  const episodes = selectRecurrenceEpisodes([
    alert({ id: "1", first_seen_at: "2026-08-10T10:00:00.000Z", resolved_at: null }),
    alert({ id: "2", first_seen_at: "2026-08-11T10:00:00.000Z", resolved_at: null }),
  ]);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].id, "1");
});

test("OV-P0-87 conta episódio só após recovery do predecessor", () => {
  const episodes = selectRecurrenceEpisodes([
    alert({ id: "1", first_seen_at: "2026-08-10T10:00:00.000Z", resolved_at: "2026-08-10T12:00:00.000Z" }),
    alert({ id: "2", first_seen_at: "2026-08-10T11:00:00.000Z", resolved_at: null }), // antes do recovery — ignora
    alert({ id: "3", first_seen_at: "2026-08-11T10:00:00.000Z", resolved_at: null }), // depois do recovery — conta
  ]);
  assert.deepEqual(episodes.map((item) => item.id), ["1", "3"]);
});

test("OV-P0-87 read model devolve contagens, previous_* e is_recurrent", () => {
  const current = alert({
    id: "c",
    first_seen_at: "2026-08-11T12:00:00.000Z",
    resolved_at: null,
  });
  const siblings = [
    alert({ id: "a", first_seen_at: "2026-08-09T08:00:00.000Z", resolved_at: "2026-08-09T09:00:00.000Z" }),
    alert({ id: "b", first_seen_at: "2026-08-10T08:00:00.000Z", resolved_at: "2026-08-10T09:00:00.000Z" }),
    current,
  ];
  const model = buildAlertRecurrenceReadModel({ current, siblings, now: NOW });
  assert.equal(model.recurrence_count_7d, 3);
  assert.equal(model.recurrence_count_24h, 1);
  assert.equal(model.previous_occurrence_at, "2026-08-10T08:00:00.000Z");
  assert.equal(model.previous_recovery_at, "2026-08-10T09:00:00.000Z");
  assert.equal(model.is_recurrent, true);
});

test("OV-P0-87 ocorrência única em 7d não é recorrente", () => {
  const current = alert({
    id: "only",
    first_seen_at: "2026-08-11T12:00:00.000Z",
    resolved_at: null,
  });
  const model = buildAlertRecurrenceReadModel({ current, siblings: [current], now: NOW });
  assert.equal(model.recurrence_count_7d, 1);
  assert.equal(model.is_recurrent, false);
  assert.equal(model.previous_occurrence_at, null);
  assert.equal(model.previous_recovery_at, null);
});

test("OV-P0-87 BFF detail anexa recurrence e drawer exibe só se recorrente", async () => {
  const db = await read("api/_lib/oneview-db.js");
  const recurrence = await read("api/_lib/oneview-recurrence.js");
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  const api = await read("src/lib/oneview-api.ts");
  const monitoring = await read("src/pages/Monitoring.tsx");

  assert.match(recurrence, /data_source_id \+ source_host_id \+ source_trigger_id|source_host_id/);
  assert.match(db, /oneview-recurrence/);
  assert.match(db, /buildAlertRecurrenceReadModel/);
  assert.match(db, /source_host_id = \$2/);
  assert.match(db, /source_trigger_id = \$3/);
  assert.doesNotMatch(db.match(/async function fetchAlertList[\s\S]*?async function fetchAlertDetailPayload/)?.[0] ?? "", /buildAlertRecurrenceReadModel/);

  assert.match(api, /recurrence_count_7d/);
  assert.match(api, /is_recurrent/);

  assert.match(drawer, /AlertRecurrenceSignal/);
  const signalUi = await read("src/components/oneview/AlertRecurrenceSignal.tsx");
  const signalLib = await read("src/lib/oneview-recurrence-signal.ts");
  assert.match(signalLib, /Recorrente/);
  assert.match(signalLib, /ocorrências em 7 dias/);
  assert.match(signalUi, /buildAlertRecurrenceSignal/);

  // Monitoramento: ainda sem coluna/chip de recorrência.
  assert.doesNotMatch(monitoring, /is_recurrent|Recorrente ·|AlertRecurrenceSignal/);
});
