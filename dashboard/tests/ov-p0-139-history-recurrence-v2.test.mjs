import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { buildRecurrenceKey, parseRecurrenceKey } from "../api/_lib/oneview-recurrence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const identity = {
  data_source_id: "source-a",
  source_host_id: "host-42",
  source_trigger_id: "trigger-9",
};

test("OV-P0-139 recurrence key preserva exclusivamente fonte + host + trigger", () => {
  const key = buildRecurrenceKey(identity);
  assert.deepEqual(parseRecurrenceKey(key), identity);
  assert.equal(buildRecurrenceKey({ ...identity, source_host_id: null }), null);
  assert.equal(parseRecurrenceKey("host-name-only"), null);
});

test("OV-P0-139 histórico filtra recurrence key no BFF, sem busca por host", () => {
  const key = buildRecurrenceKey(identity);
  const query = buildAlertListQuery({ query: { recurrence_key: key, status: "all" } }, "teletex-http");
  assert.match(query.whereSql, /a\.data_source_id::text/);
  assert.match(query.whereSql, /a\.source_host_id::text/);
  assert.match(query.whereSql, /a\.source_trigger_id::text/);
  assert.deepEqual(query.params.slice(0, 4), [["teletex-http"], "source-a", "host-42", "trigger-9"]);
  assert.throws(() => buildAlertListQuery({ query: { recurrence_key: "invalid" } }, "teletex-http"), /invalid_query/);
});

test("OV-P0-139 Histórico do detalhe lista só ocorrências anteriores do mesmo host e trigger", async () => {
  const [drawer, investigation, history, api, db] = await Promise.all([
    readFile(path.join(root, "src/components/oneview/AlertDetailDrawer.tsx"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertRecurrenceInvestigation.tsx"), "utf8"),
    readFile(path.join(root, "src/pages/Historico.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/oneview-api.ts"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-db.js"), "utf8"),
  ]);

  assert.match(drawer, /TabsContent value="history"/);
  assert.doesNotMatch(drawer, /TabsContent value="history"[^>]*forceMount/);
  assert.match(drawer, /Ocorrências anteriores/);
  assert.match(drawer, /Mesmo host e trigger, da mais recente para a mais antiga/);
  assert.match(drawer, /label="Início"/);
  assert.match(drawer, /label="Recovery"/);
  assert.match(drawer, /label="Duração"/);
  assert.match(drawer, /label="ACK"/);
  assert.match(drawer, /Chamado/);
  assert.match(drawer, /previousHistoryEpisodes/);
  assert.match(drawer, /filter\(\(item\) => !item\.current\)/);
  assert.match(drawer, /fetchAlerts\(\{/);
  assert.match(drawer, /recurrenceKey/);
  assert.doesNotMatch(drawer, /<div hidden>/);
  assert.match(drawer, /AlertRelatedIncidentsSection/);
  assert.match(drawer, /visibleActions=\{\["claim"\]\}/);
  assert.doesNotMatch(drawer, /<AlertRecurrenceInvestigation/);
  assert.doesNotMatch(drawer, /Linha do tempo desta ocorrência/);
  assert.match(investigation, /Recorrência deste alerta/);
  assert.match(investigation, /Últimas 24 horas/);
  assert.match(investigation, /Últimos 7 dias/);
  assert.match(investigation, /Ocorrência anterior/);
  assert.match(investigation, /Chamado da ocorrência anterior/);
  assert.match(investigation, /Mesmo problema na operação/);
  assert.match(investigation, /Contexto técnico separado/);
  assert.match(drawer, /AlertSameProblemContext alert=\{alert\}/);
  assert.match(investigation, /Ver períodos maiores no Histórico/);
  assert.match(history, /recurrenceKey/);
  assert.match(history, /recurrenceKey: recurrenceKey/);
  assert.match(api, /recurrenceKey\?: string/);
  assert.match(api, /recurrence_key/);
  assert.match(db, /previous_episode_id/);
  assert.match(db, /source_trigger_id = \$2/);
  assert.doesNotMatch(`${investigation}\n${history}`, /host_name.*recurrence|recurrence.*host_name/i);
});
