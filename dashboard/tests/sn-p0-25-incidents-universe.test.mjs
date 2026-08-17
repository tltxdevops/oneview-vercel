/**
 * SN-P0-25 — universo /chamados = contact_type=monitoring (sem caller_id default).
 * Prova: manual NOC + automático Zabbix aparecem em "Todos".
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildIncidentCallerFacets,
  buildIncidentSysparmQuery,
  createIncidentsHandler,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZABBIX_MONITORING_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
const NOC_PROTEGE_CALLER_ID = "50e065b3fb55f210fb0ef9285eefdcee";

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
  zabbixMonitoringCallerId: ZABBIX_MONITORING_CALLER_ID,
  callerFilterSeeds: [ZABBIX_MONITORING_CALLER_ID, NOC_PROTEGE_CALLER_ID],
};

function sampleIncident(overrides = {}) {
  return {
    sys_id: "sys-1",
    number: "INC0001",
    short_description: "Host down",
    description: "Host: host-a\nID original do problema: 123",
    state: { value: "2", display_value: "Em andamento" },
    priority: { value: "3", display_value: "3 - Moderada" },
    caller_id: { value: ZABBIX_MONITORING_CALLER_ID, display_value: "zabbix monitoring" },
    contact_type: { value: "monitoring", display_value: "Monitoramento" },
    assignment_group: { value: "group-1", display_value: "NOC" },
    assigned_to: { value: "user-1", display_value: "Operador" },
    company: { value: "co-1", display_value: "Cliente X" },
    opened_at: "2026-08-01 10:00:00",
    resolved_at: null,
    closed_at: null,
    sys_created_on: "2026-08-01 10:00:00",
    sys_updated_on: "2026-08-07 12:00:00",
    correlation_id: null,
    u_hostname_zabbix: "host-a",
    u_ip_zabbix: "10.0.0.1",
    ...overrides,
  };
}

test("SN-P0-25 query vazia: só contact_type=monitoring — sem caller_id default", () => {
  const filters = parseIncidentFilters(requestMock({}));
  assert.equal(filters.contact_type, "monitoring");
  assert.equal(filters.caller_id, null);
  assert.equal(filters.number, null);

  const query = buildIncidentSysparmQuery(filters);
  assert.match(query, /^contact_type=monitoring\^/);
  assert.doesNotMatch(query, /caller_id=/);
  assert.match(query, /ORDERBYDESCsys_updated_on/);
});

test("SN-P0-25 caller_id e number são filtros opcionais", () => {
  const withCaller = buildIncidentSysparmQuery(parseIncidentFilters(requestMock({
    caller_id: ZABBIX_MONITORING_CALLER_ID,
  })));
  assert.match(withCaller, new RegExp(`caller_id=${ZABBIX_MONITORING_CALLER_ID}`));

  const withNoc = buildIncidentSysparmQuery(parseIncidentFilters(requestMock({
    caller_id: NOC_PROTEGE_CALLER_ID,
  })));
  assert.match(withNoc, new RegExp(`caller_id=${NOC_PROTEGE_CALLER_ID}`));

  const withNumber = buildIncidentSysparmQuery(parseIncidentFilters(requestMock({
    number: "INC0042",
  })));
  assert.match(withNumber, /number=INC0042/);
  assert.doesNotMatch(withNumber, /caller_id=/);
});

test("SN-P0-25 facets: seeds opcionais (env) mesmo sem aggregate", () => {
  const facets = buildIncidentCallerFacets({}, {
    seedIds: [ZABBIX_MONITORING_CALLER_ID, NOC_PROTEGE_CALLER_ID],
    displayHints: {
      [ZABBIX_MONITORING_CALLER_ID]: "zabbix monitoring",
      [NOC_PROTEGE_CALLER_ID]: "NOC Protege",
    },
  });
  const values = facets.map((item) => item.value);
  assert.ok(values.includes(ZABBIX_MONITORING_CALLER_ID));
  assert.ok(values.includes(NOC_PROTEGE_CALLER_ID));
  assert.equal(
    facets.find((item) => item.value === ZABBIX_MONITORING_CALLER_ID)?.label,
    "zabbix monitoring",
  );
  assert.equal(
    facets.find((item) => item.value === NOC_PROTEGE_CALLER_ID)?.label,
    "NOC Protege",
  );
  assert.deepEqual(buildIncidentCallerFacets({}), []);
});

test("SN-P0-25 BFF Todos: manual NOC + automático Zabbix na mesma lista", async () => {
  let listQuery = null;
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    getPage: async (_table, options) => {
      listQuery = options.sysparm_query;
      return {
        table: "incident",
        records: [
          sampleIncident({
            sys_id: "sys-zabbix",
            number: "INC-AUTO-1",
            caller_id: {
              value: ZABBIX_MONITORING_CALLER_ID,
              display_value: "zabbix monitoring",
            },
            short_description: "Zabbix automático",
          }),
          sampleIncident({
            sys_id: "sys-noc",
            number: "INC-MANUAL-1",
            caller_id: {
              value: NOC_PROTEGE_CALLER_ID,
              display_value: "NOC Protege",
            },
            short_description: "NOC manual",
            u_hostname_zabbix: null,
            u_ip_zabbix: null,
            description: "Abertura manual NOC",
          }),
        ],
        count: 2,
        offset: 0,
        limit: 25,
        totalCount: 2,
      };
    },
    getStats: async (_table, options) => {
      if (options.sysparm_group_by === "caller_id") {
        return {
          table: "incident",
          rows: [
            {
              stats: { count: "120" },
              groupby_fields: [{ field: "caller_id", value: ZABBIX_MONITORING_CALLER_ID }],
            },
            {
              stats: { count: "40" },
              groupby_fields: [{ field: "caller_id", value: NOC_PROTEGE_CALLER_ID }],
            },
          ],
          count: 2,
          total: null,
          groupBy: "caller_id",
        };
      }
      if (options.sysparm_group_by === "state") {
        return {
          table: "incident",
          rows: [
            { stats: { count: "1" }, groupby_fields: [{ field: "state", value: "1" }] },
            { stats: { count: "1" }, groupby_fields: [{ field: "state", value: "2" }] },
          ],
          count: 2,
          total: null,
          groupBy: "state",
        };
      }
      if (String(options.sysparm_query || "").includes("assigned_toISEMPTY")) {
        return {
          table: "incident",
          rows: [{ stats: { count: "0" } }],
          count: 1,
          total: 0,
          groupBy: null,
        };
      }
      return {
        table: "incident",
        rows: [{ stats: { count: "2" } }],
        count: 1,
        total: 2,
        groupBy: null,
      };
    },
  });

  // Sem caller_id → universo "Todos"
  const res = responseMock();
  await handler(requestMock({ page: "1", page_size: "25" }), res);

  assert.equal(res.statusCode, 200);
  assert.match(listQuery, /^contact_type=monitoring\^/);
  assert.doesNotMatch(listQuery, /caller_id=/);

  const callers = res.body.items.map((item) => item.caller_id);
  assert.ok(callers.includes(ZABBIX_MONITORING_CALLER_ID), "Zabbix automático deve aparecer em Todos");
  assert.ok(callers.includes(NOC_PROTEGE_CALLER_ID), "NOC manual deve aparecer em Todos");
  assert.equal(res.body.items.length, 2);

  const facetValues = (res.body.facets?.callers || []).map((item) => item.value);
  assert.ok(facetValues.includes(ZABBIX_MONITORING_CALLER_ID));
  assert.ok(facetValues.includes(NOC_PROTEGE_CALLER_ID));
  assert.equal(res.body.filters.caller_id, null);
  assert.equal(res.body.filters.contact_type, "monitoring");
});

test("SN-P0-25 Chamados FE: caller default Todos + busca INC; Home usa helper sem caller", async () => {
  const [chamados, api, indexPage, home] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-home.ts"),
  ]);

  assert.match(chamados, /callerId:\s*"all"/);
  assert.match(chamados, /applied\.callerId !== "all"/);
  // SN-P0-28: campo Número removido; busca ^INC\d+$ → number no BFF.
  assert.doesNotMatch(chamados, /chamados-number/);
  assert.match(chamados, /resolveIncidentSearch|INCIDENT_EXACT_NUMBER_SEARCH_RE/);
  // SN-P0-33: sem seeds hardcoded; dropdown só facets.callers
  assert.doesNotMatch(chamados, /CALLER_FILTER_SEEDS|aa62f29f47477610082e3d02e26d4358|50e065b3fb55f210fb0ef9285eefdcee/);
  assert.match(chamados, /facets\?\.callers/);
  assert.match(chamados, /label:\s*"Todos"/);

  assert.match(api, /if \(params\?\.number\) search\.set\("number"/);
  assert.match(api, /if \(params\?\.callerId\) search\.set\("caller_id"/);
  assert.match(api, /facets\?:/);

  // OV-P0-69 / OV-P0-103: Home lista incidents via fetchHomeIncidents (unassigned, sem caller_id).
  assert.match(indexPage, /fetchHomeIncidents/);
  assert.doesNotMatch(indexPage, /CALLER_FILTER_SEEDS|chamados-number/);
  const incidentsFn = home.slice(
    home.indexOf("export async function fetchHomeIncidents"),
    home.indexOf("export function prioritizeHomeUnassignedIncidents") > 0
      ? home.indexOf("export function prioritizeHomeUnassignedIncidents")
      : home.indexOf("export function buildHomeAlertsHref"),
  );
  assert.doesNotMatch(incidentsFn, /callerId|caller_id/);
  assert.match(incidentsFn, /unassigned:\s*true/);
});
