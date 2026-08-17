/**
 * SN-P0-27 — Correlação explícita INC Zabbix → ServiceNow (read-only).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RELATION_SOURCE,
  buildExactIncidentNumbersSysparmQuery,
  correlateAlertRelatedIncidents,
  extractServiceNowIncidentNumbers,
  extractServiceNowIncidentNumbersFromHistory,
  fetchIncidentsByExactNumbers,
} from "../api/_lib/oneview-inc-correlation.js";
import { createRelatedIncidentsHandler } from "../api/_lib/oneview-alert-incidents.js";

const FIXTURE_ZABBIX_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
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
  password: "secret",
  timeoutMs: 5000,
  defaultLimit: 100,
  zabbixMonitoringCallerId: FIXTURE_ZABBIX_CALLER_ID,
  callerFilterSeeds: [],
};

function sampleRaw(overrides = {}) {
  return {
    sys_id: "sys-a",
    number: "INC0067312",
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

test("SN-P0-27 extract: comentário INC0067312, meio do texto, duplicado, múltiplos, sem INC", () => {
  assert.deepEqual(extractServiceNowIncidentNumbers("INC0067312"), ["INC0067312"]);
  assert.deepEqual(
    extractServiceNowIncidentNumbers("ver chamado inc0067312 no SN"),
    ["INC0067312"],
  );
  assert.deepEqual(
    extractServiceNowIncidentNumbers("INC0067312 e de novo INC0067312"),
    ["INC0067312"],
  );
  assert.deepEqual(
    extractServiceNowIncidentNumbers("refs INC0067312 / INC0099999 e INC0067312"),
    ["INC0067312", "INC0099999"],
  );
  assert.deepEqual(extractServiceNowIncidentNumbers("sem incidente aqui"), []);
  assert.deepEqual(extractServiceNowIncidentNumbers("INCOMPLETE"), []);
  assert.deepEqual(
    extractServiceNowIncidentNumbersFromHistory(
      [{ comment: "ack inc001", description: "veja INC002" }],
      ["INC002 e INC003"],
    ),
    ["INC001", "INC002", "INC003"],
  );
});

test("SN-P0-27 query: number exato sem host/caller fallback", () => {
  assert.equal(
    buildExactIncidentNumbersSysparmQuery(["INC0067312"]),
    "number=INC0067312^ORDERBYDESCsys_updated_on^ORDERBYsys_id",
  );
  assert.equal(
    buildExactIncidentNumbersSysparmQuery(["inc0067312", "INC0099999", "INC0067312"]),
    "numberININC0067312,INC0099999^ORDERBYDESCsys_updated_on^ORDERBYsys_id",
  );
  assert.equal(buildExactIncidentNumbersSysparmQuery([]), null);
  assert.doesNotMatch(
    buildExactIncidentNumbersSysparmQuery(["INC0067312"]),
    /host|caller_id|eventid/i,
  );
});

test("SN-P0-27 fetchByExactNumbers: retorna INC pedido e deduplica", async () => {
  const result = await fetchIncidentsByExactNumbers(["INC0067312", "inc0067312"], {
    config: snConfig,
    getPage: async () => ({
      records: [
        sampleRaw({ sys_id: "sys-1", number: "INC0067312" }),
        sampleRaw({ sys_id: "sys-1", number: "INC0067312" }),
        sampleRaw({ sys_id: "sys-2", number: "INC0099999" }),
      ],
    }),
  });
  assert.equal(result.matched, true);
  assert.equal(result.incidents.length, 1);
  assert.equal(result.incidents[0].number, "INC0067312");
});

test("SN-P0-27 prioridade: INC explícito vence event id", async () => {
  const result = await correlateAlertRelatedIncidents({
    sourceEventId: "327191633",
    incidentNumbers: ["INC0067312"],
    lookupByNumber: async () => ({
      incidents: [sampleRaw({ number: "INC0067312" })].map((raw) => ({
        ...raw,
        number: "INC0067312",
        state_display: "Em andamento",
        priority_display: "3",
        assignment_group_display: "NOC",
        assigned_to_display: "Operador",
        zabbix_event_id: null,
        servicenow_url: "https://example.service-now.com/incident.do?sys_id=sys-a",
      })),
      checked_at: "2026-08-11T12:00:00.000Z",
    }),
    lookupByEventId: async () => ({
      incidents: [{ number: "INC0000001", sys_id: "other" }],
      checked_at: "2026-08-11T12:00:00.000Z",
    }),
  });
  assert.equal(result.relation_source, RELATION_SOURCE.ZABBIX_INC_REFERENCE);
  assert.equal(result.incidents[0].number, "INC0067312");
});

test("SN-P0-27 prioridade: sem INC → event id; sem ambos → none", async () => {
  const byEvent = await correlateAlertRelatedIncidents({
    sourceEventId: "327191633",
    incidentNumbers: [],
    lookupByNumber: async () => ({ incidents: [] }),
    lookupByEventId: async () => ({
      incidents: [{ number: "INC0001001", sys_id: "sys-e" }],
      checked_at: "2026-08-11T12:00:00.000Z",
    }),
  });
  assert.equal(byEvent.relation_source, RELATION_SOURCE.ZABBIX_EVENT_ID);

  const none = await correlateAlertRelatedIncidents({
    sourceEventId: "327191633",
    historyItems: [{ comment: "sem numero" }],
    lookupByNumber: async () => ({ incidents: [] }),
    lookupByEventId: async () => ({ incidents: [] }),
  });
  assert.equal(none.relation_source, RELATION_SOURCE.NONE);
  assert.equal(none.matched, false);
});

test("SN-P0-27 handler: ?inc= + relation_source; SN indisponível", async () => {
  const ok = createRelatedIncidentsHandler({
    authorize: async () => ({ role: "viewer" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    lookupByNumber: async () => ({
      incidents: [{
        sys_id: "sys-a",
        number: "INC0067312",
        state: "2",
        state_display: "Em andamento",
        priority: "3",
        priority_display: "3",
        assignment_group: "g1",
        assignment_group_display: "NOC",
        assigned_to: "u1",
        assigned_to_display: "Operador",
        sys_updated_on: "2026-08-07 12:00:00",
        zabbix_event_id: null,
        servicenow_url: "https://example.service-now.com/incident.do?sys_id=sys-a",
      }],
      checked_at: "2026-08-11T12:00:00.000Z",
    }),
    lookup: async () => ({ incidents: [] }),
    logger: () => undefined,
  });
  const res = responseMock();
  await ok(requestMock({ source_event_id: "327191633", inc: "INC0067312" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relation_source, "zabbix_inc_reference");
  assert.equal(res.body.matched, true);
  assert.equal(res.body.incidents[0].number, "INC0067312");

  const down = createRelatedIncidentsHandler({
    authorize: async () => ({ role: "viewer" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    correlate: async () => {
      const error = new Error("upstream");
      error.code = "servicenow_unavailable";
      throw error;
    },
    logger: () => undefined,
  });
  const resDown = responseMock();
  await down(requestMock({ source_event_id: "327191633", text: "INC0067312" }), resDown);
  assert.ok(resDown.statusCode >= 500 || resDown.statusCode === 502 || resDown.statusCode === 503 || resDown.statusCode === 504 || resDown.statusCode === 502);
  assert.equal(resDown.body.matched, false);
  assert.equal(resDown.body.relation_source, "none");
  assert.deepEqual(resDown.body.incidents, []);
});

test("SN-P0-27 FE wiring: drawer passa history; API envia inc; sem host fallback", async () => {
  const [section, drawer, api, corrJs, corrTs] = await Promise.all([
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-inc-correlation.js"),
    read("src/lib/oneview-inc-correlation.ts"),
  ]);

  assert.match(corrJs, /\\bINC\\d\+\\b/);
  assert.match(corrTs, /\\bINC\\d\+\\b/);
  assert.match(corrJs, /zabbix_inc_reference/);
  assert.match(corrJs, /zabbix_event_id/);
  assert.match(corrJs, /RELATION_SOURCE\.NONE|"none"/);
  assert.match(corrJs, /Sem fallback por host/);
  assert.doesNotMatch(corrJs, /u_hostname|cmdb_ci|sysparm_query.*host/i);

  assert.match(api, /relation_source/);
  assert.match(api, /incidentNumbers|inc_refs|append\("inc"/);
  assert.match(section, /extractServiceNowIncidentNumbersFromHistory/);
  assert.match(section, /historyItems/);
  assert.match(section, /relation_source|relationSource/);
  assert.match(drawer, /historyItems=\{historyItems\}/);
  assert.doesNotMatch(section, /fetch\(["'`]https?:\/\/.*service-now/i);
});
