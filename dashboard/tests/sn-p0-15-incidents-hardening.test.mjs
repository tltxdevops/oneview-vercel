/**
 * SN-P0-15 — Hardening da API de incidentes (filtros allowlisted, GET-only).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAllowlistedIncidentQuery,
  buildIncidentSysparmQuery,
  createIncidentsHandler,
  INCIDENT_ALLOWED_QUERY_KEYS,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

function requestMock(query = {}, method = "GET") {
  return { method, query, headers: {} };
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

const snConfig = {
  configured: true,
  baseUrl: "https://example.service-now.com",
  username: "integration",
  password: "secret-password",
  timeoutMs: 5000,
  defaultLimit: 100,
};

test("SN-P0-15 contact_type obrigatório monitoring (override rejeitado)", () => {
  assert.equal(parseIncidentFilters(requestMock({})).contact_type, "monitoring");
  assert.equal(parseIncidentFilters(requestMock({ contact_type: "monitoring" })).contact_type, "monitoring");
  assert.throws(
    () => parseIncidentFilters(requestMock({ contact_type: "email" })),
    (error) => error.code === "invalid_query",
  );
  assert.throws(
    () => parseIncidentFilters(requestMock({ contact_type: "phone" })),
    (error) => error.code === "invalid_query",
  );
});

test("SN-P0-15 rejeita sysparm_query cru e sysparm_*", () => {
  assert.throws(
    () => assertAllowlistedIncidentQuery(requestMock({
      sysparm_query: "contact_type=email^state=1",
    })),
    (error) => error.code === "invalid_query",
  );
  assert.throws(
    () => parseIncidentFilters(requestMock({
      page: "1",
      sysparm_query: "1=1",
    })),
    (error) => error.code === "invalid_query",
  );
  assert.throws(
    () => parseIncidentFilters(requestMock({
      sysparm_fields: "number,state",
      sysparm_limit: "500",
    })),
    (error) => error.code === "invalid_query",
  );
});

test("SN-P0-15 rejeita query params fora do allowlist", () => {
  assert.throws(
    () => parseIncidentFilters(requestMock({ foo: "bar" })),
    (error) => error.code === "invalid_query",
  );
  for (const key of INCIDENT_ALLOWED_QUERY_KEYS) {
    assert.equal(typeof key, "string");
  }
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("caller_id"));
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("assigned_to"));
  assert.ok(INCIDENT_ALLOWED_QUERY_KEYS.includes("opened_from"));
  assert.ok(!INCIDENT_ALLOWED_QUERY_KEYS.includes("sysparm_query"));
});

test("SN-P0-15 encoded query: base monitoring + filtros + ORDERBYDESCsys_updated_on", () => {
  const filters = parseIncidentFilters(requestMock({
    caller_id: "aa62f29f47477610082e3d02e26d4358",
    state: "1",
    priority: "3",
    company: "SANEPAR",
    opened_from: "2026-07-01",
    opened_to: "2026-07-31",
    search: "ICMP",
  }));
  const query = buildIncidentSysparmQuery(filters);
  assert.match(query, /^contact_type=monitoring\^/);
  assert.match(query, /caller_id=aa62f29f47477610082e3d02e26d4358/);
  assert.match(query, /state=1/);
  assert.match(query, /priority=3/);
  assert.match(query, /company\.nameLIKESANEPAR/);
  assert.match(query, /opened_at>=2026-07-01/);
  assert.match(query, /opened_at<=2026-07-31 23:59:59/);
  assert.match(query, /ORDERBYDESCsys_updated_on/);
  assert.doesNotMatch(query, /sysparm_query/);
});

test("SN-P0-15 page_size max 100 e offset=(page-1)*page_size", async () => {
  assert.equal(parseIncidentFilters(requestMock({ page_size: "999" })).page_size, 100);
  assert.equal(parseIncidentFilters(requestMock({ page: "3", page_size: "25" })).page, 3);

  let listOptions = null;
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    getStats: async () => ({ rows: [{ stats: { count: "0" } }], count: 1, total: 0, groupBy: null }),
    getPage: async (_table, options) => {
      listOptions = options;
      return {
        table: "incident",
        records: [],
        count: 0,
        offset: options.sysparm_offset,
        limit: options.sysparm_limit,
        totalCount: 0,
      };
    },
  });

  const res = responseMock();
  await handler(requestMock({ page: "4", page_size: "25" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(listOptions.sysparm_limit, 25);
  assert.equal(listOptions.sysparm_offset, 75); // (4-1)*25
  assert.match(listOptions.sysparm_query, /ORDERBYDESCsys_updated_on/);
  assert.match(listOptions.sysparm_query, /^contact_type=monitoring/);
});

test("SN-P0-15 BFF GET-only; POST/PATCH/DELETE rejeitados", async () => {
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    getPage: async () => {
      throw new Error("should_not_call_sn");
    },
  });

  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    const res = responseMock();
    await handler(requestMock({}, method), res);
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.body.error, "method_not_allowed");
  }
});

test("SN-P0-15 BFF rejeita sysparm_query no handler com 400", async () => {
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    getPage: async () => {
      throw new Error("should_not_call_sn");
    },
  });
  const res = responseMock();
  await handler(requestMock({ sysparm_query: "contact_type=email" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_query");
});

test("SN-P0-15 frontend nunca envia Basic Auth / raw SN query / SENHA SN", async () => {
  const [api, client, chamados] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("api/_lib/servicenow-client.js"),
    read("src/pages/Chamados.tsx"),
  ]);

  const start = api.indexOf("export async function fetchIncidents");
  const end = api.indexOf("export async function fetchIncidentRelatedAlert", start);
  assert.ok(start >= 0 && end > start);
  const fetchIncidentsFn = api.slice(start, end);

  assert.match(fetchIncidentsFn, /export async function fetchIncidents/);
  assert.doesNotMatch(fetchIncidentsFn, /sysparm_/);
  assert.doesNotMatch(fetchIncidentsFn, /Basic\s|SERVICENOW_PASSWORD|btoa\(/);
  assert.doesNotMatch(fetchIncidentsFn, /contactType|contact_type|search\.set\("contact/);
  assert.match(fetchIncidentsFn, /Math\.min\(Math\.max\(params\?\.pageSize \?\? 25, 1\), 100\)/);

  assert.match(client, /buildBasicAuthHeader/);
  assert.match(client, /Authorization.*Basic/);
  // Basic Auth só no client server-side, não no frontend.
  assert.doesNotMatch(chamados, /Basic |SERVICENOW_PASSWORD|sysparm_/);
  assert.doesNotMatch(chamados, /method:\s*["'](POST|PATCH|DELETE)["']/i);
});
test("SN-P0-15 priority inválida e response sem vazar senha", async () => {
  assert.throws(
    () => parseIncidentFilters(requestMock({ priority: "99" })),
    (error) => error.code === "invalid_query",
  );
  assert.throws(
    () => parseIncidentFilters(requestMock({ priority: "3^OR1=1" })),
    (error) => error.code === "invalid_query",
  );

  const logs = [];
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: (entry) => logs.push(entry),
    getStats: async () => ({
      rows: [{ stats: { count: "1" } }],
      count: 1,
      total: 1,
      groupBy: null,
    }),
    getPage: async () => ({
      table: "incident",
      records: [],
      count: 0,
      offset: 0,
      limit: 25,
      totalCount: 0,
    }),
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 200);
  const serialized = JSON.stringify({ body: res.body, logs });
  assert.equal(serialized.includes("secret-password"), false);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("Basic "), false);
});
