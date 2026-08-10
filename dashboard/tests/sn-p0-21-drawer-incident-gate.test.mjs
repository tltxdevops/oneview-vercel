/**
 * SN-P0-21 — gate operacional do drawer (severity → mensagem de ausência).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("SN-P0-21 gate: eligible vs warning/information + mensagens", async () => {
  const section = await read("src/components/oneview/AlertRelatedIncidentsSection.tsx");

  assert.match(section, /INCIDENT_ELIGIBLE_SEVERITIES/);
  assert.match(section, /"average"/);
  assert.match(section, /"high"/);
  assert.match(section, /"disaster"/);
  assert.match(section, /isIncidentEligibleSeverity/);

  assert.match(section, /Nenhum incidente relacionado localizado/);
  assert.doesNotMatch(section, /Nenhum incidente relacionado no ServiceNow/);
  assert.match(section, /ServiceNow indisponível/);
  assert.match(section, /setError\("ServiceNow indisponível"\)/);

  // Warning/Information: ausência some a seção (não apresenta como erro).
  assert.match(section, /hideNonEligibleEmpty/);
  assert.match(section, /showEmptyEligible/);
  assert.match(section, /severity\?:/);
});

test("SN-P0-21 Home/Alertas passam severity ao drawer", async () => {
  const [alerts, index] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
  ]);

  assert.match(alerts, /AlertRelatedIncidentsSection/);
  assert.match(alerts, /sourceEventId=\{selectedAlert\.source_event_id\}/);
  assert.match(alerts, /severity=\{selectedAlert\.severity\}/);

  assert.match(index, /AlertRelatedIncidentsSection/);
  assert.match(index, /sourceEventId=\{selectedAlert\.source_event_id\}/);
  assert.match(index, /severity=\{selectedAlert\.severity\}/);
});
