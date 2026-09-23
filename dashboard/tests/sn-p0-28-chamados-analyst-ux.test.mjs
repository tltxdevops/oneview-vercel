/**
 * SN-P0-28 — Chamados UX + filtro Analista (assigned_to).
 * Busca ^INC\d+$ → number exato; Caller em Mais filtros; facets assignees.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INCIDENT_ALLOWED_QUERY_KEYS,
  INCIDENT_EXACT_NUMBER_SEARCH_RE,
  buildIncidentAssigneeFacets,
  buildIncidentSysparmQuery,
  createIncidentsHandler,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
};

const ANALYST_ID = "analyst-sys-42";
const CALLER_ID = "aa62f29f47477610082e3d02e26d4358";

function sampleRecord(overrides = {}) {
  return {
    sys_id: "sys-1",
    number: "INC0067312",
    short_description: "Host down",
    description: "Host: host-a",
    state: { value: "2", display_value: "Em andamento" },
    priority: { value: "3", display_value: "3 - Moderada" },
    caller_id: { value: CALLER_ID, display_value: "zabbix monitoring" },
    contact_type: { value: "monitoring", display_value: "Monitoramento" },
    assignment_group: { value: "group-1", display_value: "NOC" },
    assigned_to: { value: ANALYST_ID, display_value: "Ana Operadora" },
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

test("SN-P0-28 allowlist inclui assigned_to", () => {
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("assigned_to"));
});

test("SN-P0-28 parse: search INC exato vira number (maiúsculo)", () => {
  assert.ok(INCIDENT_EXACT_NUMBER_SEARCH_RE.test("inc0067312"));
  assert.ok(INCIDENT_EXACT_NUMBER_SEARCH_RE.test("INC0067312"));
  assert.ok(!INCIDENT_EXACT_NUMBER_SEARCH_RE.test("INC 0067312"));
  assert.ok(!INCIDENT_EXACT_NUMBER_SEARCH_RE.test("host INC0067312"));

  const filters = parseIncidentFilters(requestMock({ search: "inc0067312" }));
  assert.equal(filters.number, "INC0067312");
  assert.equal(filters.search, null);

  const textual = parseIncidentFilters(requestMock({ search: "ICMP ping" }));
  assert.equal(textual.number, null);
  assert.equal(textual.search, "ICMP ping");
});

test("SN-P0-28 parse + query: assigned_to e caller_id opcionais; sem zabbix default", () => {
  const empty = parseIncidentFilters(requestMock({}));
  assert.equal(empty.assigned_to, null);
  assert.equal(empty.caller_id, null);
  assert.equal(empty.contact_type, "monitoring");

  const combined = parseIncidentFilters(requestMock({
    assigned_to: ANALYST_ID,
    caller_id: CALLER_ID,
    company: "SANEPAR",
    state: "2",
    priority: "3",
    search: "INC0099999",
  }));
  assert.equal(combined.assigned_to, ANALYST_ID);
  assert.equal(combined.caller_id, CALLER_ID);
  assert.equal(combined.number, "INC0099999");
  assert.equal(combined.search, null);

  const query = buildIncidentSysparmQuery(combined);
  assert.match(query, /^contact_type=monitoring\^/);
  assert.match(query, /assigned_to=analyst-sys-42/);
  assert.match(query, /caller_id=aa62f29f47477610082e3d02e26d4358/);
  assert.match(query, /number=INC0099999/);
  assert.match(query, /company\.nameLIKESANEPAR/);
  assert.match(query, /state=2/);
  assert.match(query, /priority=3/);
  assert.doesNotMatch(query, /short_descriptionLIKE|numberLIKE/);
});

test("SN-P0-28 unassigned anula assigned_to no parse", () => {
  const filters = parseIncidentFilters(requestMock({
    assigned_to: ANALYST_ID,
    unassigned: "true",
  }));
  assert.equal(filters.unassigned, true);
  assert.equal(filters.assigned_to, null);
});

test("SN-P0-28 buildIncidentAssigneeFacets: value + display_value", () => {
  const facets = buildIncidentAssigneeFacets(
    { [ANALYST_ID]: 7, "other-id": 2 },
    { displayHints: { [ANALYST_ID]: "Ana Operadora" } },
  );
  assert.equal(facets[0].value, ANALYST_ID);
  assert.equal(facets[0].label, "Ana Operadora");
  assert.equal(facets[0].display_value, "Ana Operadora");
  assert.equal(facets[0].count, 7);
  assert.equal(facets[1].value, "other-id");
  assert.equal(facets[1].display_value, "other-id");
});

test("SN-P0-28 BFF: number exato, analista, caller e facets.assignees", async () => {
  let listQuery = null;
  const groupByCalls = [];

  const handler = createIncidentsHandler({
    featureFlagProvider: () => true,
    logger: () => undefined,
    authorize: async () => ({ id: "u1", email: "ops@teletex.com.br" }),
    configProvider: () => snConfig,
    getPage: async (_table, options) => {
      const isCount = options.sysparm_fields === "sys_id" && options.sysparm_limit === 1;
      if (isCount) {
        return {
          table: "incident",
          records: [{ sys_id: "x" }],
          count: 1,
          totalCount: 1,
        };
      }
      listQuery = options.sysparm_query;
      return {
        table: "incident",
        records: [sampleRecord()],
        count: 1,
        offset: 0,
        limit: 25,
        totalCount: 1,
        options,
      };
    },
    getStats: async (_table, options) => {
      if (options.sysparm_group_by) groupByCalls.push(options.sysparm_group_by);
      if (options.sysparm_group_by === "assigned_to") {
        return {
          table: "incident",
          rows: [
            {
              stats: { count: "7" },
              groupby_fields: [{ field: "assigned_to", value: ANALYST_ID }],
            },
          ],
          count: 1,
          total: null,
          groupBy: "assigned_to",
        };
      }
      if (options.sysparm_group_by === "caller_id") {
        return {
          table: "incident",
          rows: [
            {
              stats: { count: "4" },
              groupby_fields: [{ field: "caller_id", value: CALLER_ID }],
            },
          ],
          count: 1,
          total: null,
          groupBy: "caller_id",
        };
      }
      if (options.sysparm_group_by === "state") {
        return {
          table: "incident",
          rows: [
            { stats: { count: "1" }, groupby_fields: [{ field: "state", value: "2" }] },
          ],
          count: 1,
          total: null,
          groupBy: "state",
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
  await handler(requestMock({
    search: "inc0067312",
    assigned_to: ANALYST_ID,
    caller_id: CALLER_ID,
    company: "Cliente",
    state: "2",
    priority: "3",
  }), res);

  assert.equal(res.statusCode, 200);
  assert.match(listQuery, /number=INC0067312/);
  assert.match(listQuery, /assigned_to=analyst-sys-42/);
  assert.match(listQuery, /caller_id=aa62f29f47477610082e3d02e26d4358/);
  assert.match(listQuery, /company\.nameLIKECliente/);
  assert.doesNotMatch(listQuery, /short_descriptionLIKEINC0067312/);

  assert.equal(res.body.filters.number, "INC0067312");
  assert.equal(res.body.filters.search, null);
  assert.equal(res.body.filters.assigned_to, ANALYST_ID);
  assert.equal(res.body.filters.caller_id, CALLER_ID);

  assert.ok(groupByCalls.includes("assigned_to"));
  assert.ok(groupByCalls.includes("caller_id"));
  assert.ok(Array.isArray(res.body.facets?.assignees));
  const ana = res.body.facets.assignees.find((item) => item.value === ANALYST_ID);
  assert.ok(ana);
  assert.equal(ana.display_value, "Ana Operadora");
  assert.equal(ana.label, "Ana Operadora");
  assert.equal(ana.count, 7);
});

test("SN-P0-28 FE: toolbar + Mais filtros + busca INC + assignedTo", async () => {
  const [chamados, api] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(chamados, /chamados-search/);
  assert.match(chamados, /chamados-client/);
  assert.match(chamados, /chamados-state/);
  assert.match(chamados, /chamados-priority/);
  assert.match(chamados, /chamados-analyst/);
  assert.match(chamados, /chamados-period/);
  assert.match(chamados, /Mais filtros/);
  assert.match(chamados, /chamados-caller/);
  assert.doesNotMatch(chamados, /chamados-number/);
  assert.match(chamados, /resolveIncidentSearch/);
  assert.match(chamados, /oneview-chamados-search/);
  assert.match(chamados, /assignedTo/);
  assert.match(chamados, /facets\?\.assignees/);
  assert.match(chamados, /callerId:\s*"all"/);
  assert.doesNotMatch(chamados, /callerId:\s*"aa62f29f47477610082e3d02e26d4358"/);

  assert.match(api, /if \(params\?\.assignedTo\) search\.set\("assigned_to"/);
  assert.match(api, /assignees\?:/);
  assert.match(api, /assigned_to: string \| null/);
});
