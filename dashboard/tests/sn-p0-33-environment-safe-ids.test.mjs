/**
 * SN-P0-33 — Environment-safe ServiceNow IDs.
 * Caller Zabbix via env; sem fallback DEV; seeds opcionais; /chamados independente.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildIncidentCallerFacets,
  buildRelatedIncidentsSysparmQuery,
  createIncidentsHandler,
  fetchIncidentsBySourceEventId,
  resolveCallerFilterSeeds,
  resolveZabbixMonitoringCallerId,
} from "../api/_lib/oneview-incidents.js";
import {
  getServiceNowConfig,
  mapServiceNowErrorToHttpStatus,
  mapServiceNowErrorToPublicCode,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import { createRelatedIncidentsHandler } from "../api/_lib/oneview-alert-incidents.js";
import { fetchIncidentsByExactNumbers } from "../api/_lib/oneview-inc-correlation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_CALLER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXTURE_NOC = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEV_ZABBIX_ID = "aa62f29f47477610082e3d02e26d4358";

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(value) {
      this.body = value ? JSON.parse(value) : undefined;
    },
  };
}

function requestMock(query = {}, method = "GET") {
  return { method, query, headers: {} };
}

const snConfig = {
  configured: true,
  baseUrl: "https://example.service-now.com",
  username: "integration",
  password: "secret",
  timeoutMs: 5000,
  defaultLimit: 100,
  zabbixMonitoringCallerId: FIXTURE_CALLER,
  callerFilterSeeds: [],
};

test("SN-P0-33 config: lê SERVICENOW_ZABBIX_MONITORING_CALLER_ID sem default DEV", () => {
  const empty = getServiceNowConfig({
    SERVICENOW_BASE_URL: "https://example.service-now.com",
    SERVICENOW_USERNAME: "u",
    SERVICENOW_PASSWORD: "p",
  });
  assert.equal(empty.zabbixMonitoringCallerId, "");
  assert.deepEqual(empty.callerFilterSeeds, []);
  assert.equal(resolveZabbixMonitoringCallerId(empty), "");

  const configured = getServiceNowConfig({
    SERVICENOW_BASE_URL: "https://example.service-now.com",
    SERVICENOW_USERNAME: "u",
    SERVICENOW_PASSWORD: "p",
    SERVICENOW_ZABBIX_MONITORING_CALLER_ID: FIXTURE_CALLER,
    SERVICENOW_CALLER_FILTER_SEEDS: `${FIXTURE_NOC},invalid,${FIXTURE_CALLER}`,
  });
  assert.equal(configured.zabbixMonitoringCallerId, FIXTURE_CALLER);
  assert.deepEqual(configured.callerFilterSeeds, [FIXTURE_NOC, FIXTURE_CALLER]);
  assert.equal(resolveZabbixMonitoringCallerId(configured), FIXTURE_CALLER);
  assert.deepEqual(resolveCallerFilterSeeds(configured), [FIXTURE_NOC, FIXTURE_CALLER]);
});

test("SN-P0-33 correlation: query usa caller da config; sem caller falha fechado", () => {
  const query = buildRelatedIncidentsSysparmQuery("327191633", { callerId: FIXTURE_CALLER });
  assert.match(query, new RegExp(`caller_id=${FIXTURE_CALLER}`));
  assert.doesNotMatch(query, new RegExp(DEV_ZABBIX_ID));

  assert.throws(
    () => buildRelatedIncidentsSysparmQuery("327191633"),
    (error) => error instanceof ServiceNowClientError
      && error.code === "servicenow_caller_not_configured",
  );
  assert.throws(
    () => buildRelatedIncidentsSysparmQuery("327191633", { callerId: "" }),
    (error) => error.code === "servicenow_caller_not_configured",
  );

  assert.equal(mapServiceNowErrorToPublicCode({
    name: "ServiceNowClientError",
    code: "servicenow_caller_not_configured",
  }), "servicenow_caller_not_configured");
  assert.equal(mapServiceNowErrorToHttpStatus({
    name: "ServiceNowClientError",
    code: "servicenow_caller_not_configured",
  }), 503);
});

test("SN-P0-33 fetchIncidentsBySourceEventId exige caller env", async () => {
  await assert.rejects(
    () => fetchIncidentsBySourceEventId("1", {
      config: { ...snConfig, zabbixMonitoringCallerId: "" },
      getPage: async () => {
        throw new Error("não deve chamar ServiceNow sem caller");
      },
    }),
    (error) => error.code === "servicenow_caller_not_configured",
  );

  let seenQuery = null;
  await fetchIncidentsBySourceEventId("327191633", {
    config: snConfig,
    getPage: async (_table, options) => {
      seenQuery = options.sysparm_query;
      return { records: [], count: 0, totalCount: 0 };
    },
  });
  assert.match(seenQuery, new RegExp(`caller_id=${FIXTURE_CALLER}`));
});

test("SN-P0-33 related-incidents: falta de caller não quebra lookup por número", async () => {
  const handler = createRelatedIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => ({ ...snConfig, zabbixMonitoringCallerId: "" }),
    logger: () => undefined,
    lookupByNumber: async () => ({
      incidents: [{
        sys_id: "sys-n",
        number: "INC0001001",
        state: "2",
        priority: "3",
        assignment_group: "g1",
        assigned_to: "u1",
        sys_updated_on: "2026-08-07 12:00:00",
        zabbix_event_id: null,
        servicenow_url: "https://example.service-now.com/incident.do?sys_id=sys-n",
      }],
      checked_at: new Date().toISOString(),
    }),
    lookup: async () => {
      throw new ServiceNowClientError("servicenow_caller_not_configured");
    },
  });

  const byNumber = responseMock();
  await handler(requestMock({ inc: "INC0001001" }), byNumber);
  assert.equal(byNumber.statusCode, 200);
  assert.equal(byNumber.body.matched, true);
  assert.equal(byNumber.body.relation_source, "zabbix_inc_reference");

  const byEvent = responseMock();
  await handler(requestMock({ source_event_id: "327191633" }), byEvent);
  assert.equal(byEvent.statusCode, 503);
  assert.equal(byEvent.body.error, "servicenow_caller_not_configured");
  assert.equal(byEvent.body.matched, false);
});

test("SN-P0-33 facets: sem seeds hardcoded; seeds só via env", () => {
  assert.deepEqual(buildIncidentCallerFacets({}), []);
  const seeded = buildIncidentCallerFacets({}, {
    seedIds: [FIXTURE_NOC],
    displayHints: { [FIXTURE_NOC]: "NOC Protege" },
  });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].value, FIXTURE_NOC);
  assert.equal(seeded[0].label, "NOC Protege");
});

test("SN-P0-33 /chamados lista sem caller env (não quebra)", async () => {
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => ({ ...snConfig, zabbixMonitoringCallerId: "", callerFilterSeeds: [] }),
    logger: () => undefined,
    getPage: async () => ({
      table: "incident",
      records: [{
        sys_id: "sys-1",
        number: "INC0001",
        short_description: "Host down",
        description: "eventid=1",
        state: { value: "2", display_value: "Em andamento" },
        priority: { value: "3", display_value: "3 - Moderada" },
        caller_id: { value: FIXTURE_CALLER, display_value: "zabbix monitoring" },
        contact_type: { value: "monitoring", display_value: "Monitoramento" },
        assignment_group: { value: "g1", display_value: "NOC" },
        assigned_to: { value: "u1", display_value: "Operador" },
        company: { value: "c1", display_value: "Cliente" },
        opened_at: "2026-08-01 10:00:00",
        sys_updated_on: "2026-08-07 12:00:00",
      }],
      count: 1,
      offset: 0,
      limit: 25,
      totalCount: 1,
    }),
    getStats: async (_table, options) => {
      if (options.sysparm_group_by === "caller_id") {
        return {
          table: "incident",
          rows: [{
            stats: { count: "1" },
            groupby_fields: [{ field: "caller_id", value: FIXTURE_CALLER }],
          }],
          count: 1,
          total: null,
          groupBy: "caller_id",
        };
      }
      return {
        table: "incident",
        rows: [{ stats: { count: "1" } }],
        count: 1,
        total: 1,
        groupBy: null,
      };
    },
  });

  const res = responseMock();
  await handler(requestMock({ page: "1", page_size: "25" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.filters.caller_id, null);
  assert.ok(res.body.facets.callers.some((item) => item.value === FIXTURE_CALLER));
});

test("SN-P0-33 código/runtime sem hardcode DEV obrigatório + FE só facets", async () => {
  const [incidents, chamados, envLocal, envRoot] = await Promise.all([
    read("api/_lib/oneview-incidents.js"),
    read("src/pages/Chamados.tsx"),
    read(".env.local.example"),
    read("../.env.example"),
  ]);

  assert.doesNotMatch(incidents, /export const ZABBIX_MONITORING_CALLER_ID/);
  assert.doesNotMatch(incidents, /export const NOC_PROTEGE_CALLER_ID/);
  assert.doesNotMatch(incidents, /Gwms Integration|Janine Scavone/);
  assert.doesNotMatch(incidents, new RegExp(DEV_ZABBIX_ID));
  assert.doesNotMatch(incidents, /50e065b3fb55f210fb0ef9285eefdcee/);
  assert.match(incidents, /SERVICENOW_ZABBIX_MONITORING_CALLER_ID|zabbixMonitoringCallerId/);
  assert.match(incidents, /servicenow_caller_not_configured/);

  assert.doesNotMatch(chamados, /CALLER_FILTER_SEEDS/);
  assert.doesNotMatch(chamados, new RegExp(DEV_ZABBIX_ID));
  assert.doesNotMatch(chamados, /50e065b3fb55f210fb0ef9285eefdcee/);
  assert.match(chamados, /facets\?\.callers/);

  assert.match(envLocal, /SERVICENOW_ZABBIX_MONITORING_CALLER_ID=/);
  assert.match(envLocal, /SERVICENOW_CALLER_FILTER_SEEDS=/);
  assert.match(envRoot, /SERVICENOW_ZABBIX_MONITORING_CALLER_ID=/);
  assert.match(envRoot, /SERVICENOW_CALLER_FILTER_SEEDS=/);
});

test("SN-P0-33 lookup por número não exige caller Zabbix", async () => {
  const result = await fetchIncidentsByExactNumbers(["INC0001001"], {
    config: { ...snConfig, zabbixMonitoringCallerId: "" },
    getPage: async (_table, options) => {
      assert.match(options.sysparm_query, /number=INC0001001|numberIN/);
      assert.doesNotMatch(options.sysparm_query, /caller_id=/);
      return {
        records: [{
          sys_id: "sys-n",
          number: "INC0001001",
          short_description: "x",
          description: "y",
          state: { value: "1", display_value: "Novo" },
          priority: { value: "3", display_value: "3" },
          caller_id: { value: "other", display_value: "Other" },
          contact_type: { value: "monitoring", display_value: "Monitoramento" },
          sys_updated_on: "2026-08-07 12:00:00",
        }],
        count: 1,
        totalCount: 1,
      };
    },
  });
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].number, "INC0001001");
});
