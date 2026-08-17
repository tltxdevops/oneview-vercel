/**
 * SN-P0-30 — ServiceNow API Contract Audit (GET incidents).
 * Facets companies/states/priorities; caller opcional; number exato; display_value.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  INCIDENT_ALLOWED_QUERY_KEYS,
  buildIncidentCompanyFacets,
  buildIncidentPriorityFacets,
  buildIncidentStateFacets,
  buildIncidentSysparmQuery,
  createIncidentsHandler,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";

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
};

test("SN-P0-30 parse: sem caller obrigatório; contact_type=monitoring base", () => {
  const filters = parseIncidentFilters(requestMock({}));
  assert.equal(filters.caller_id, null);
  assert.equal(filters.contact_type, "monitoring");
  const query = buildIncidentSysparmQuery(filters);
  assert.match(query, /^contact_type=monitoring\^/);
  assert.doesNotMatch(query, /caller_id=/);
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("assigned_to"));
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("number"));
});

test("SN-P0-30 search INC promove number exato", () => {
  const filters = parseIncidentFilters(requestMock({ search: "inc0054761" }));
  assert.equal(filters.number, "INC0054761");
  assert.equal(filters.search, null);
  assert.match(buildIncidentSysparmQuery(filters), /number=INC0054761/);
  assert.doesNotMatch(buildIncidentSysparmQuery(filters), /numberLIKE/);
});

test("SN-P0-30 facets builders: value + display_value", () => {
  const companies = buildIncidentCompanyFacets(
    { "co-1": 4 },
    { displayHints: { "co-1": "Cliente X" } },
  );
  assert.equal(companies[0].value, "co-1");
  assert.equal(companies[0].display_value, "Cliente X");

  const states = buildIncidentStateFacets({ 2: 9 });
  assert.equal(states[0].value, "2");
  assert.equal(states[0].display_value, "Em andamento");

  const priorities = buildIncidentPriorityFacets({ 3: 5 });
  assert.equal(priorities[0].value, "3");
  assert.equal(priorities[0].display_value, "3 - Moderada");
});

test("SN-P0-30 BFF response inclui facets companies/states/priorities", async () => {
  const groupCalls = [];
  const handler = createIncidentsHandler({
    featureFlagProvider: () => true,
    logger: () => undefined,
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: async (_table, options) => {
      if (options.sysparm_fields === "sys_id" && options.sysparm_limit === 1) {
        return { table: "incident", records: [{ sys_id: "x" }], count: 1, totalCount: 1 };
      }
      return {
        table: "incident",
        records: [{
          sys_id: "sys-1",
          number: "INC0001",
          short_description: "Host down",
          state: { value: "2", display_value: "Em andamento" },
          priority: { value: "3", display_value: "3 - Moderada" },
          caller_id: { value: "caller-1", display_value: "zabbix monitoring" },
          contact_type: { value: "monitoring", display_value: "Monitoramento" },
          assigned_to: { value: "user-1", display_value: "Operador" },
          company: { value: "co-1", display_value: "Cliente X" },
          opened_at: "2026-08-01 10:00:00",
          sys_updated_on: "2026-08-07 12:00:00",
        }],
        count: 1,
        totalCount: 1,
        options,
      };
    },
    getStats: async (_table, options) => {
      if (options.sysparm_group_by) groupCalls.push(options.sysparm_group_by);
      if (options.sysparm_group_by === "company") {
        return {
          rows: [{ stats: { count: "4" }, groupby_fields: [{ field: "company", value: "co-1" }] }],
        };
      }
      if (options.sysparm_group_by === "state") {
        return {
          rows: [{ stats: { count: "9" }, groupby_fields: [{ field: "state", value: "2" }] }],
        };
      }
      if (options.sysparm_group_by === "priority") {
        return {
          rows: [{ stats: { count: "5" }, groupby_fields: [{ field: "priority", value: "3" }] }],
        };
      }
      if (options.sysparm_group_by === "caller_id") {
        return {
          rows: [{ stats: { count: "2" }, groupby_fields: [{ field: "caller_id", value: "caller-1" }] }],
        };
      }
      if (options.sysparm_group_by === "assigned_to") {
        return {
          rows: [{ stats: { count: "3" }, groupby_fields: [{ field: "assigned_to", value: "user-1" }] }],
        };
      }
      return { rows: [{ stats: { count: "1" } }], total: 1 };
    },
  });

  const res = responseMock();
  await handler(requestMock({ page_size: "25" }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(groupCalls.includes("company"));
  assert.ok(groupCalls.includes("state"));
  assert.ok(groupCalls.includes("priority"));
  assert.ok(Array.isArray(res.body.facets.companies));
  assert.ok(Array.isArray(res.body.facets.states));
  assert.ok(Array.isArray(res.body.facets.priorities));
  assert.equal(res.body.facets.companies[0].value, "co-1");
  assert.equal(res.body.facets.companies[0].display_value, "Cliente X");
  assert.equal(res.body.facets.states[0].value, "2");
  assert.equal(res.body.facets.priorities[0].value, "3");
  assert.equal(res.body.items[0].assigned_to_display, "Operador");
  assert.equal(res.body.filters.caller_id, null);
});
