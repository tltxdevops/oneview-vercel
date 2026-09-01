/**
 * SN-P0-02 / SN-P0-07 — testes focados do BFF GET /api/oneview/incidents.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIncidentSysparmQuery,
  createIncidentsHandler,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";
import { ServiceNowClientError } from "../api/_lib/servicenow-client.js";

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
  zabbixMonitoringCallerId: "",
  callerFilterSeeds: [],
};

function enabledHandler(overrides = {}) {
  return createIncidentsHandler({
    featureFlagProvider: () => true,
    logger: () => undefined,
    ...overrides,
  });
}

function sampleRecord(overrides = {}) {
  return {
    sys_id: "sys-1",
    number: "INC0001",
    short_description: "Host down",
    description: "Host: host-a\nID original do problema: 123",
    state: { value: "2", display_value: "Em andamento" },
    priority: { value: "3", display_value: "3 - Moderada" },
    caller_id: { value: "caller-zabbix", display_value: "zabbix monitoring" },
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

function mockGetPage(listTotal = 42) {
  return async (table, options) => {
    const isCount = options.sysparm_fields === "sys_id" && options.sysparm_limit === 1;
    if (isCount) {
      return {
        table,
        records: [{ sys_id: "x" }],
        count: 1,
        offset: 0,
        limit: 1,
        totalCount: options.sysparm_query?.includes("state=1")
          ? 10
          : options.sysparm_query?.includes("state=2")
            ? 5
            : options.sysparm_query?.includes("state=6")
              ? 20
              : options.sysparm_query?.includes("state=7")
                ? 15
                : options.sysparm_query?.includes("assigned_toISEMPTY")
                  ? 3
                  : 42,
      };
    }
    return {
      table,
      records: [sampleRecord()],
      count: 1,
      offset: options.sysparm_offset || 0,
      limit: options.sysparm_limit || 25,
      totalCount: listTotal,
      nextLink: null,
      options,
    };
  };
}

/** SN-P0-12B — Aggregate API mock (/api/now/stats/incident). */
function mockGetStats() {
  return async (_table, options) => {
    if (options.sysparm_group_by === "state") {
      return {
        table: "incident",
        rows: [
          { stats: { count: "10" }, groupby_fields: [{ field: "state", value: "1" }] },
          { stats: { count: "5" }, groupby_fields: [{ field: "state", value: "2" }] },
          { stats: { count: "20" }, groupby_fields: [{ field: "state", value: "6" }] },
          { stats: { count: "15" }, groupby_fields: [{ field: "state", value: "7" }] },
        ],
        count: 4,
        total: null,
        groupBy: "state",
      };
    }
    if (options.sysparm_group_by === "caller_id") {
      return {
        table: "incident",
        rows: [
          {
            stats: { count: "42" },
            groupby_fields: [{ field: "caller_id", value: "caller-zabbix" }],
          },
        ],
        count: 1,
        total: null,
        groupBy: "caller_id",
      };
    }
    if (String(options.sysparm_query || "").includes("assigned_toISEMPTY")) {
      return {
        table: "incident",
        rows: [{ stats: { count: "3" } }],
        count: 1,
        total: 3,
        groupBy: null,
      };
    }
    return {
      table: "incident",
      rows: [{ stats: { count: "42" } }],
      count: 1,
      total: 42,
      groupBy: null,
    };
  };
}

test("incidents filters: contact_type is optional by default", () => {
  const filters = parseIncidentFilters(requestMock({}));
  assert.equal(filters.contact_type, null);
  assert.equal(filters.page, 1);
  assert.equal(filters.page_size, 25);
  assert.equal(filters.unassigned, false);
});

test("incidents filters: aceita company periodo unassigned", () => {
  const filters = parseIncidentFilters(requestMock({
    company: "SANEPAR",
    opened_from: "2026-07-01",
    opened_to: "2026-07-31",
    unassigned: "true",
    state: "6,7",
  }));
  assert.equal(filters.company, "SANEPAR");
  assert.equal(filters.opened_from, "2026-07-01");
  assert.equal(filters.opened_to, "2026-07-31");
  assert.equal(filters.unassigned, true);
  assert.equal(filters.state, "6,7");
});

test("incidents filters: page_size capped em 100", () => {
  const filters = parseIncidentFilters(requestMock({ page_size: "5000" }));
  assert.equal(filters.page_size, 100);
});

test("incidents filters: search inválido lança invalid_query", () => {
  assert.throws(
    () => parseIncidentFilters(requestMock({ search: "bad^OR1=1" })),
    (error) => error.code === "invalid_query",
  );
});

test("incidents query: company e periodo", () => {
  const query = buildIncidentSysparmQuery(parseIncidentFilters(requestMock({
    company: "SANEPAR",
    opened_from: "2026-07-01",
    opened_to: "2026-07-31",
  })));
  assert.match(query, /company\.nameLIKESANEPAR/);
  assert.match(query, /opened_at>=2026-07-01/);
  assert.match(query, /opened_at<=2026-07-31 23:59:59/);
});

test("incidents query: combina caller_id e search com NQ sem canal implícito", () => {
  const query = buildIncidentSysparmQuery(parseIncidentFilters(requestMock({
    caller_id: "caller-zabbix",
    search: "ICMP",
  })));
  assert.equal(
    query,
    "caller_id=caller-zabbix^numberLIKEICMP"
      + "^NQcaller_id=caller-zabbix^short_descriptionLIKEICMP"
      + "^ORDERBYDESCsys_updated_on^ORDERBYsys_id",
  );
});

test("incidents BFF: rejeita métodos diferentes de GET", async () => {
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
  });
  const res = responseMock();
  await handler(requestMock({}, "POST"), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, "method_not_allowed");
});

test("incidents BFF: feature flag desligada retorna 403", async () => {
  let called = false;
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => false,
    getPage: async () => {
      called = true;
      return { records: [], count: 0, totalCount: 0 };
    },
    logger: () => undefined,
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "servicenow_incidents_disabled");
  assert.equal(called, false);
});

test("incidents BFF: 401 antes de chamar ServiceNow", async () => {
  let called = false;
  const handler = enabledHandler({
    authorize: async (_req, res) => {
      res.status(401).end(JSON.stringify({ error: "authentication_required" }));
      return null;
    },
    getPage: async () => {
      called = true;
      return { records: [], count: 0, totalCount: 0, offset: 0, limit: 25 };
    },
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test("incidents BFF: 503 quando ServiceNow não configurado", async () => {
  let called = false;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => ({ ...snConfig, configured: false }),
    getPage: async () => {
      called = true;
      return { records: [], count: 0, totalCount: 0 };
    },
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "servicenow_not_configured");
  assert.equal(called, false);
});

test("incidents BFF: lista normalizada com pagination filters counts e data_source", async () => {
  let listOptions = null;
  let statsCalls = 0;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1", email: "ops@teletex.com.br" }),
    configProvider: () => snConfig,
    getPage: async (table, options) => {
      const result = await mockGetPage(42)(table, options);
      if (options.sysparm_fields !== "sys_id") listOptions = options;
      return result;
    },
    getStats: async (table, options) => {
      statsCalls += 1;
      return mockGetStats()(table, options);
    },
  });

  const res = responseMock();
  await handler(requestMock({ page: "1", page_size: "25" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-oneview-data-source"], "servicenow");
  assert.equal(res.body.data_source, "servicenow");
  assert.equal(listOptions.sysparm_display_value, "all");
  assert.equal(listOptions.sysparm_limit, 25);
  assert.equal(listOptions.sysparm_offset, 0);
  assert.match(listOptions.sysparm_query, /^contact_type=monitoring\^/);
  assert.doesNotMatch(listOptions.sysparm_query, /caller_id=/);
  // SN-P0-12B counts (3) + callers + assignees + companies + states + priorities
  assert.equal(statsCalls, 8);
  assert.ok(Array.isArray(res.body.facets?.callers));
  assert.ok(res.body.facets.callers.some((item) => item.label === "zabbix monitoring"));
  assert.ok(Array.isArray(res.body.facets?.assignees));
  assert.ok(Array.isArray(res.body.facets?.companies));
  assert.ok(Array.isArray(res.body.facets?.states));
  assert.ok(Array.isArray(res.body.facets?.priorities));
  assert.equal(res.body.filters.assigned_to, null);

  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].number, "INC0001");
  assert.equal(res.body.items[0].zabbix_event_id, "123");
  assert.equal(res.body.items[0].zabbix_host, "host-a");
  assert.equal(
    res.body.items[0].servicenow_url,
    "https://example.service-now.com/incident.do?sys_id=sys-1",
  );
  assert.deepEqual(res.body.counts, {
    total: 42,
    open: 10,
    in_progress: 5,
    resolved: 20,
    closed: 15,
    unassigned: 3,
  });
  assert.deepEqual(res.body.pagination, {
    page: 1,
    page_size: 25,
    total_items: 42,
    total_pages: 2,
    has_next: true,
    has_previous: false,
  });
  assert.equal(res.body.filters.contact_type, "monitoring");
  assert.equal(res.body.filters.company, null);
  assert.equal(res.body.filters.unassigned, false);
});

test("SN-P0-12B incidents BFF: Aggregate 403 faz fallback para Table API counts", async () => {
  let tableCountCalls = 0;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: async (table, options) => {
      if (options.sysparm_fields === "sys_id" && options.sysparm_limit === 1) {
        tableCountCalls += 1;
      }
      return mockGetPage(42)(table, options);
    },
    getStats: async () => {
      throw new ServiceNowClientError("servicenow_access_forbidden", { status: 403 });
    },
  });

  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 200);
  assert.equal(tableCountCalls, 6);
  assert.deepEqual(res.body.counts, {
    total: 42,
    open: 10,
    in_progress: 5,
    resolved: 20,
    closed: 15,
    unassigned: 3,
  });
});

test("incidents BFF: page 2 calcula sysparm_offset", async () => {
  let listOffset = null;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: async (_table, options) => {
      if (options.sysparm_fields !== "sys_id") listOffset = options.sysparm_offset;
      return mockGetPage(100)(_table, options);
    },
    getStats: mockGetStats(),
  });
  const res = responseMock();
  await handler(requestMock({ page: "3", page_size: "25" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(listOffset, 50);
  assert.equal(res.body.pagination.page, 3);
  assert.equal(res.body.pagination.has_previous, true);
});

test("incidents BFF: erro ServiceNow sanitizado sem senha", async () => {
  const logs = [];
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: async () => {
      throw new ServiceNowClientError("servicenow_authentication_failed", { status: 401 });
    },
    getStats: mockGetStats(),
    logger: (entry) => logs.push(entry),
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "servicenow_authentication_failed");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("password"), false);
});

test("incidents BFF: nunca passa method diferente de GET ao client", async () => {
  let methodSeen = null;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: async (_table, options) => {
      methodSeen = options.method || "GET";
      assert.equal(methodSeen, "GET");
      return mockGetPage(0)(_table, options);
    },
    getStats: async (_table, options) => {
      assert.equal(options.method || "GET", "GET");
      return mockGetStats()(_table, options);
    },
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 200);
  assert.equal(methodSeen, "GET");
});

test("SN-P0-26 KPI unassigned: query Aggregate inclui search em ambos os ramos NQ", async () => {
  let unassignedQuery = null;
  const handler = enabledHandler({
    authorize: async () => ({ id: "u1" }),
    configProvider: () => snConfig,
    getPage: mockGetPage(13),
    getStats: async (_table, options) => {
      const q = String(options.sysparm_query || "");
      if (q.includes("assigned_toISEMPTY")) unassignedQuery = q;
      return mockGetStats()(_table, options);
    },
  });

  const res = responseMock();
  // SN-P0-28: "INC006" sozinho vira number= exato; usar texto parcial para cobrir NQ LIKE.
  await handler(requestMock({ search: "INC006 host" }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(unassignedQuery, "esperava stats de unassigned");
  assert.match(unassignedQuery, /assigned_toISEMPTY/);
  assert.match(unassignedQuery, /stateNOT IN6,7/);
  assert.match(unassignedQuery, /numberLIKEINC006 host/);
  assert.match(unassignedQuery, /short_descriptionLIKEINC006 host/);
  assert.match(unassignedQuery, /\^NQ/);
  // Ambos os ramos NQ precisam do stateNOT IN (não só append no final).
  const [left, right] = unassignedQuery.split("^NQ");
  assert.match(left, /stateNOT IN6,7/);
  assert.match(right, /stateNOT IN6,7/);
  assert.match(left, /assigned_toISEMPTY/);
  assert.match(right, /assigned_toISEMPTY/);
});
