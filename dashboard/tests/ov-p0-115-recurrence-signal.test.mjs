/**
 * OV-P0-115 — sinal compacto de recorrência no Alert Detail Drawer.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAlertRecurrenceSignal,
  formatRecurrenceCountLabel,
  formatRecurrenceWhen,
  isRecurrenceFlapping,
} from "../src/lib/oneview-recurrence-signal.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-115 não mostra sinal quando não é recorrente", () => {
  assert.equal(buildAlertRecurrenceSignal(null), null);
  assert.equal(buildAlertRecurrenceSignal({ recurrence_count_7d: 0, recurrence_count_24h: 0 }), null);
  assert.equal(buildAlertRecurrenceSignal({ recurrence_count_7d: 1, is_recurrent: false }), null);
});

test("OV-P0-115 Recorrente · N em 7 dias quando count_7d >= 2", () => {
  const signal = buildAlertRecurrenceSignal({
    is_recurrent: true,
    recurrence_count_7d: 3,
    recurrence_count_24h: 1,
  });
  assert.equal(signal?.kind, "recurrent");
  assert.equal(signal?.headline, "Recorrente · 3 ocorrências em 7 dias");
});

test("OV-P0-115 Flapping substitui Recorrente (24h >= 5 ou 7d >= 10)", () => {
  const by24h = buildAlertRecurrenceSignal({
    is_recurrent: true,
    recurrence_count_7d: 6,
    recurrence_count_24h: 5,
  });
  assert.equal(by24h?.kind, "flapping");
  assert.equal(by24h?.headline, "Flapping · 6 ocorrências em 7 dias");

  const by7d = buildAlertRecurrenceSignal({
    recurrence_count_7d: 10,
    recurrence_count_24h: 2,
  });
  assert.equal(by7d?.kind, "flapping");
  assert.equal(by7d?.headline, "Flapping · 10 ocorrências em 7 dias");

  assert.equal(isRecurrenceFlapping(4, 9), false);
  assert.equal(isRecurrenceFlapping(5, 5), true);
  assert.equal(isRecurrenceFlapping(0, 10), true);
});

test("OV-P0-115 cap de exibição 99+", () => {
  assert.equal(formatRecurrenceCountLabel(99), "99");
  assert.equal(formatRecurrenceCountLabel(100), "99+");
  assert.equal(formatRecurrenceCountLabel(945), "99+");
  const signal = buildAlertRecurrenceSignal({
    is_recurrent: true,
    recurrence_count_7d: 120,
    recurrence_count_24h: 8,
  });
  assert.equal(signal?.headline, "Flapping · 99+ ocorrências em 7 dias");
});

test("OV-P0-115 formata ocorrência anterior e recovery em dd/MM HH:mm", () => {
  const when = formatRecurrenceWhen("2026-08-12T14:32:00");
  assert.match(String(when), /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  assert.equal(formatRecurrenceWhen(null), null);
  assert.equal(formatRecurrenceWhen("not-a-date"), null);

  const signal = buildAlertRecurrenceSignal({
    is_recurrent: true,
    recurrence_count_7d: 2,
    previous_occurrence_at: "2026-08-12T14:32:00.000Z",
    previous_recovery_at: "2026-08-12T15:01:00.000Z",
  });
  assert.ok(signal?.previous_occurrence_at);
  assert.ok(signal?.previous_recovery_at);
});

test("OV-P0-115 drawer: bloco discreto abaixo do problema, sem Monitoramento", async () => {
  const [drawer, signal, component, monitoring, recurrence] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/lib/oneview-recurrence-signal.ts"),
    read("src/components/oneview/AlertRecurrenceSignal.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("api/_lib/oneview-recurrence.js"),
  ]);

  assert.match(drawer, /AlertRecurrenceSignal/);
  assert.match(drawer, /<AlertRecurrenceSignal alert=\{alert\} \/>/);
  assert.doesNotMatch(drawer, /SeverityBadge[\s\S]*Recorrente ·/);
  assert.doesNotMatch(drawer, /Badge[\s\S]{0,200}Flapping/);

  const problemIdx = drawer.indexOf("Alerta sem descrição");
  const signalIdx = drawer.indexOf("<AlertRecurrenceSignal alert={alert} />");
  assert.ok(problemIdx > 0 && signalIdx > problemIdx, "sinal deve ficar abaixo do problema");
  assert.match(drawer, /<div hidden>/);
  assert.match(drawer, /AlertRelatedIncidentsSection/);

  assert.match(component, /text-xs text-muted-foreground/);
  assert.match(component, /Última ocorrência anterior/);
  assert.match(component, /Última recuperação/);
  assert.match(component, /RECURRENCE_SIGNAL_TOOLTIP/);
  assert.doesNotMatch(component, /variant="destructive"|bg-red-|SeverityBadge/);

  assert.match(signal, /data_source_id \+ source_host_id \+ source_trigger_id/);
  assert.match(signal, /RECURRENCE_MIN_COUNT_7D = 2/);
  assert.match(signal, /RECURRENCE_FLAPPING_24H = 5/);
  assert.match(signal, /RECURRENCE_FLAPPING_7D = 10/);
  assert.match(recurrence, /data_source_id \+ source_host_id \+ source_trigger_id/);

  assert.doesNotMatch(monitoring, /is_recurrent|Recorrente ·|AlertRecurrenceSignal|Flapping ·/);
});
