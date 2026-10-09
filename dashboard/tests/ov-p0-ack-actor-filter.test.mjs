import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAlertListQuery } from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("ACK actor filter is nominal and parameterized", () => {
  const query = buildAlertListQuery({ query: { ack_actor: "Guilherme Franco" } }, "teletex-http");

  assert.equal(query.filters.ackActor, "Guilherme Franco");
  assert.match(query.whereSql, /ack_actor\.operator_name/);
  assert.equal(query.params.includes("%Guilherme Franco%"), true);
});

test("ACK actor autocomplete stays scoped to source ACK actors", async () => {
  const [alerts, suggest, query, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("api/_lib/oneview-alerts-search-suggest.js"),
    read("src/lib/alerts-query.ts"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(alerts, /Analista do ACK/);
  assert.match(alerts, /fetchAckActorSuggestions/);
  assert.match(alerts, /suggestion\.kind === "actor"/);
  assert.match(alerts, /Analista ACK:/);
  assert.match(suggest, /ACK_ACTOR_EXPR/);
  assert.match(suggest, /runBucket\("actor"/);
  assert.match(query, /ackActor\?: string/);
  assert.match(query, /ack_actor/);
  assert.match(api, /params\?\.ackActor\?\.trim\(\)/);
});
