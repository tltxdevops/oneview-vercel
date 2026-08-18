/**
 * SN-P0-16 — incidente(s) no drawer do alerta (GET-only, sem host fallback).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildRelatedIncidentsSysparmQuery,
  fetchIncidentsBySourceEventId,
} from "../api/_lib/oneview-incidents.js";
import { createRelatedIncidentsHandler } from "../api/_lib/oneview-alert-incidents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ZABBIX_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";

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
  password: "secret",
  timeoutMs: 5000,
  defaultLimit: 100,
  zabbixMonitoringCallerId: FIXTURE_ZABBIX_CALLER_ID,
  callerFilterSeeds: [],
};

function sampleRaw(overrides = {}) {
  return {
    sys_id: "sys-a",
    number: "INC0001001",
    short_description: "[PROBLEM] Host down",
    description: "Host: host-a\nID original do problema: 327191633\nhttp://zabbix/?eventid=327191633",
    state: { value: "2", display_value: "Em andamento" },
    priority: { value: "3", display_value: "3 - Moderada" },
    caller_id: { value: FIXTURE_ZABBIX_CALLER_ID, display_value: "zabbix monitoring" },
    contact_type: { value: "monitoring", display_value: "Monitoramento" },
    assignment_group: { value: "g1", display_value: "NOC" },
    assigned_to: { value: "u1", display_value: "Operador" },
    company: { value: "c1", display_value: "Cliente" },
    opened_at: "2026-08-01 10:00:00",
    sys_updated_on: "2026-08-07 12:00:00",
    ...overrides,
  };
}

test("SN-P0-16 query: monitoring + caller zabbix + descriptionLIKEeventid", () => {
  const query = buildRelatedIncidentsSysparmQuery("327191633", {
    callerId: FIXTURE_ZABBIX_CALLER_ID,
  });
  assert.match(query, /^contact_type=monitoring\^/);
  assert.match(query, new RegExp(`caller_id=${FIXTURE_ZABBIX_CALLER_ID}`));
  assert.match(query, /descriptionLIKEeventid=327191633/);
  assert.match(query, /ORDERBYDESCsys_updated_on/);
  assert.doesNotMatch(query, /host|u_hostname|cmdb/i);
});

test("SN-P0-16 pós-filtro: só mantém parser.zabbix_event_id === source_event_id", async () => {
  const result = await fetchIncidentsBySourceEventId("327191633", {
    config: snConfig,
    getPage: async (_table, options) => {
      assert.match(options.sysparm_query, /descriptionLIKEeventid=327191633/);
      return {
        records: [
          sampleRaw({ sys_id: "ok", number: "INC1" }),
          sampleRaw({
            sys_id: "false-positive",
            number: "INC2",
            description: "Host: other\nID original do problema: 999\nhttp://zabbix/?eventid=999&ref=327191633",
          }),
          sampleRaw({
            sys_id: "ok2",
            number: "INC3",
            short_description: "[RESOLVED] Host down",
            description: "eventid=327191633\nHost: host-a",
          }),
        ],
        count: 3,
        totalCount: 3,
      };
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.candidates_returned, 3);
  assert.equal(result.incidents.length, 2);
  assert.deepEqual(result.incidents.map((item) => item.number).sort(), ["INC1", "INC3"]);
  for (const item of result.incidents) {
    assert.equal(item.zabbix_event_id, "327191633");
  }
});

test("SN-P0-16 handler: múltiplos incidentes no payload do drawer", async () => {
  const handler = createRelatedIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    lookup: async () => ({
      relation_source: "zabbix_event_id",
      incidents: [
        { sys_id: "a", number: "INC_A", state: "2", priority: "3", assignment_group: "g1", assigned_to: "u1", sys_updated_on: "2026-08-07T12:00:00.000Z", servicenow_url: "https://teletexprod.service-now.com/incident.do?sys_id=a" },
        { sys_id: "b", number: "INC_B", state: "2", priority: "3", assignment_group: "g1", assigned_to: "u1", sys_updated_on: "2026-08-07T12:00:00.000Z", servicenow_url: "https://teletexprod.service-now.com/incident.do?sys_id=b" },
      ],
    }),
  });

  const res = responseMock();
  await handler(requestMock({ source_event_id: "327191633" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.incidents.length, 2);
  assert.equal(res.body.source_event_id, "327191633");
  for (const item of res.body.incidents) {
    assert.ok(item.number);
    assert.ok("state" in item);
    assert.ok("priority" in item);
    assert.ok("assignment_group_display" in item || "assignment_group" in item);
    assert.ok("assigned_to_display" in item || "assigned_to" in item);
    assert.ok("sys_updated_on" in item);
    assert.ok("servicenow_url" in item);
    assert.match(item.servicenow_url, /incident\.do\?sys_id=/);
  }
});

test("SN-P0-16 handler: GET-only e sem host fallback", async () => {
  const handler = createRelatedIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    lookup: async () => ({ relation_source: "none", incidents: [] }),
  });

  for (const method of ["POST", "PATCH", "DELETE"]) {
    const res = responseMock();
    await handler(requestMock({ source_event_id: "1" }, method), res);
    assert.equal(res.statusCode, 405);
  }

  const empty = responseMock();
  await handler(requestMock({ source_event_id: "404404" }), empty);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.matched, false);
  assert.deepEqual(empty.body.incidents, []);
});

test("SN-P0-16 handler: flag off e query inválida", async () => {
  const disabled = createRelatedIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => false,
    logger: () => undefined,
  });
  const resOff = responseMock();
  await disabled(requestMock({ source_event_id: "1" }), resOff);
  assert.equal(resOff.statusCode, 403);

  const enabled = createRelatedIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    logger: () => undefined,
  });
  const resBad = responseMock();
  await enabled(requestMock({ source_event_id: "bad id" }), resBad);
  assert.equal(resBad.statusCode, 400);
});

test("SN-P0-16 frontend drawer + API + BFF route", async () => {
  const [api, drawer, section, bff, route] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("scripts/dev-oneview-bff.mjs"),
    read("api/oneview/alerts/related-incidents.js"),
  ]);

  assert.match(api, /export async function fetchAlertRelatedIncidents/);
  assert.match(api, /\/oneview\/alerts\/related-incidents/);
  assert.doesNotMatch(api.slice(api.indexOf("fetchAlertRelatedIncidents")), /sysparm_|host_name|host fallback/i);

  assert.match(section, /ServiceNowDevLink|Abrir no ServiceNow/);
  assert.doesNotMatch(section, /Abrir no ServiceNow DEV/);
  assert.match(section, /Grupo/);
  assert.match(section, /Responsável/);
  assert.match(section, /Última atualização|Atualização/);
  assert.match(section, /fetchAlertRelatedIncidents/);
  assert.doesNotMatch(section, /host_name|method:\s*["']POST["']/i);
  assert.doesNotMatch(section, /u_hostname_zabbix|cmdb_ci/);

  assert.match(drawer, /AlertRelatedIncidentsSection/);
  assert.match(drawer, /sourceEventId=\{alert\.source_event_id\}/);
  assert.match(drawer, /severity=\{alert\.severity\}/);
  assert.match(drawer, /historyItems=\{historyItems\}/);
  assert.match(section, /Nenhum incidente relacionado localizado/);
  assert.match(section, /isIncidentEligibleSeverity/);

  assert.match(bff, /alerts\/related-incidents/);
  assert.match(route, /oneview-alert-incidents/);
});
