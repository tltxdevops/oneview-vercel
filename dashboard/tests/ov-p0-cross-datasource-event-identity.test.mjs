/**
 * OV-P0-331 — identidade canônica datasource + eventid, sem correlação cruzada.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  findAlertBySourceEventId,
  findAlertForIncidentReverseLookup,
} from "../api/_lib/oneview-db.js";

const RHP_ID = "11111111-1111-4111-8111-111111111111";
const ZURICH_ID = "22222222-2222-4222-8222-222222222222";

function alertRow({ id, dataSourceId, datasourceName, sourceEventId = "shared-evt" } = {}) {
  return {
    id,
    data_source_id: dataSourceId,
    datasource_name: datasourceName,
    source_event_id: sourceEventId,
    host_name: `${datasourceName}-host`,
    customer_name: datasourceName,
    severity: "high",
    status_source: "active",
    problem_name: "problem",
    first_seen_at: "2026-10-20T12:00:00.000Z",
  };
}

function queuedRows(...responses) {
  const calls = [];
  return {
    calls,
    queryRows: async (_config, sql, values) => {
      calls.push({ sql, values });
      return responses.shift() || [];
    },
  };
}

test("A/E — mesmo eventid em dois datasources sem contexto falha fechado", async () => {
  const lookup = queuedRows([
    alertRow({ id: "rhp-alert", dataSourceId: RHP_ID, datasourceName: "rhp" }),
    alertRow({ id: "zurich-alert", dataSourceId: ZURICH_ID, datasourceName: "zurich" }),
  ]);

  await assert.rejects(
    findAlertBySourceEventId("shared-evt", { connectionString: "postgres://test" }, lookup),
    (error) => error?.code === "ambiguous_source_event",
  );
  assert.equal(lookup.calls.length, 1);
  assert.match(lookup.calls[0].sql, /a\.source_event_id = \$1/);
  assert.match(lookup.calls[0].sql, /limit 2/i);
  assert.doesNotMatch(lookup.calls[0].sql, /order by/i);
});

test("B/C — datasource explícito seleciona só episódio da fonte correta", async () => {
  const lookup = queuedRows([
    alertRow({ id: "rhp-alert", dataSourceId: RHP_ID, datasourceName: "rhp" }),
  ]);
  const alert = await findAlertBySourceEventId("shared-evt", { connectionString: "postgres://test" }, {
    dataSourceId: RHP_ID,
    queryRows: lookup.queryRows,
  });

  assert.equal(alert.id, "rhp-alert");
  assert.equal(alert.data_source_id, RHP_ID);
  assert.match(lookup.calls[0].sql, /a\.data_source_id = \$2::uuid/);
  assert.deepEqual(lookup.calls[0].values, ["shared-evt", RHP_ID]);
});

test("D — datasource incorreto não retorna alerta de outra fonte", async () => {
  const lookup = queuedRows([], []);
  const alert = await findAlertBySourceEventId("shared-evt", { connectionString: "postgres://test" }, {
    dataSourceId: ZURICH_ID,
    queryRows: lookup.queryRows,
  });

  assert.equal(alert, null);
  assert.equal(lookup.calls.length, 2);
  assert.ok(lookup.calls.every((call) => call.values[1] === ZURICH_ID));
});

test("G — source_problem_id é fallback escopado; episódio ambíguo não é escolhido", async () => {
  const correct = queuedRows([], [
    alertRow({ id: "rhp-problem", dataSourceId: RHP_ID, datasourceName: "rhp", sourceEventId: "recovery-evt" }),
  ]);
  const alert = await findAlertBySourceEventId("original-problem", { connectionString: "postgres://test" }, {
    dataSourceName: "rhp",
    queryRows: correct.queryRows,
  });
  assert.equal(alert.id, "rhp-problem");
  assert.match(correct.calls[1].sql, /a\.source_problem_id = \$1/);
  assert.deepEqual(correct.calls[1].values, ["original-problem", "rhp"]);

  const ambiguous = queuedRows([], [
    alertRow({ id: "rhp-old", dataSourceId: RHP_ID, datasourceName: "rhp" }),
    alertRow({ id: "rhp-new", dataSourceId: RHP_ID, datasourceName: "rhp" }),
  ]);
  await assert.rejects(
    findAlertBySourceEventId("original-problem", { connectionString: "postgres://test" }, {
      dataSourceName: "rhp",
      queryRows: ambiguous.queryRows,
    }),
    (error) => error?.code === "ambiguous_source_event",
  );
});

test("F — referência ServiceNow explícita mantém prioridade sobre eventid", async () => {
  const result = await findAlertForIncidentReverseLookup(
    { sysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", zabbixEventId: "shared-evt" },
    { connectionString: "postgres://test" },
    {
      findByExplicitServiceNowReference: async () => ({
        relation_source: "sys_id",
        alert: { id: "explicit-sys-id" },
      }),
      findBySourceEventId: async () => {
        throw new Error("eventid lookup must not run after explicit ServiceNow match");
      },
    },
  );
  assert.equal(result.relation_source, "sys_id");
  assert.equal(result.alert.id, "explicit-sys-id");
});

test("I — ambiguidade reversa retorna sem associação e sem write", async () => {
  const result = await findAlertForIncidentReverseLookup(
    { zabbixEventId: "shared-evt" },
    { connectionString: "postgres://test" },
    {
      findByExplicitServiceNowReference: async () => ({ relation_source: "none", alert: null }),
      findBySourceEventId: async () => {
        const error = new Error("ambiguous_source_event");
        error.code = "ambiguous_source_event";
        throw error;
      },
    },
  );
  assert.deepEqual(result, { relation_source: "none", alert: null });

  const source = await fs.readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8");
  const lookup = source.slice(
    source.indexOf("export async function findAlertBySourceEventId"),
    source.indexOf("function mapIncidentRelatedAlertRow"),
  );
  assert.doesNotMatch(lookup, /\b(insert|update|delete|upsert)\b/i);
});

test("H — ACK não usa o lookup de correlação cross-datasource", async () => {
  const ackSource = await fs.readFile(new URL("../api/_lib/oneview-ack-request.js", import.meta.url), "utf8");
  assert.doesNotMatch(ackSource, /findAlertBySourceEventId|findAlertForIncidentReverseLookup/);
});
