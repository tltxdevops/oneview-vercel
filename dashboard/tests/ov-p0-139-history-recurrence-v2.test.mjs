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
  assert.deepEqual(query.params.slice(0, 4), ["teletex-http", "source-a", "host-42", "trigger-9"]);
  assert.throws(() => buildAlertListQuery({ query: { recurrence_key: "invalid" } }, "teletex-http"), /invalid_query/);
});

test("OV-P0-139 drawer separa reincidência, timeline e mesmo problema", async () => {
  const [drawer, investigation, history, api, db] = await Promise.all([
    readFile(path.join(root, "src/components/oneview/AlertDetailDrawer.tsx"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertRecurrenceInvestigation.tsx"), "utf8"),
    readFile(path.join(root, "src/pages/Historico.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/oneview-api.ts"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-db.js"), "utf8"),
  ]);

  assert.match(drawer, /AlertRecurrenceInvestigation/);
  assert.match(drawer, /Linha do tempo atual/);
  assert.match(drawer, /Estado final/);
  assert.match(investigation, /Reincidência deste ativo/);
  assert.match(investigation, /Ocorrências 24 h/);
  assert.match(investigation, /ACK actor/);
  assert.match(investigation, /INC relacionado/);
  assert.match(investigation, /Mesmo problema na operação/);
  assert.match(investigation, /não representa reincidência deste ativo/);
  assert.match(investigation, /Ver histórico completo/);
  assert.match(history, /recurrenceKey/);
  assert.match(history, /recurrenceKey: recurrenceKey/);
  assert.match(api, /recurrenceKey\?: string/);
  assert.match(api, /recurrence_key/);
  assert.match(db, /previous_episode_id/);
  assert.match(db, /source_trigger_id = \$2/);
  assert.doesNotMatch(`${investigation}\n${history}`, /host_name.*recurrence|recurrence.*host_name/i);
});
