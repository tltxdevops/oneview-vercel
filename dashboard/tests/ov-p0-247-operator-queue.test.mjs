/**
 * OV-P0-247 — Operator follow-up queue: tag-only selection, read-only actions, no SLA.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OPERATOR_TAG_KEYS,
  OPERATOR_TAG_VALUES,
  UNASSIGNED_ANALYST_LABEL,
  RECENT_WINDOW_MS,
  SLA_RULES_IMPLEMENTED,
  alertHasOperatorTag,
  analystFromIncident,
  buildOperatorQueuePayload,
  createOperatorQueueHandler,
  formatUpdatedAgoLabel,
  pickCorrelatedIncident,
  buildIncidentIndexes,
} from "../api/_lib/oneview-operator-queue.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Date.parse("2026-08-28T18:00:00.000Z");
const analystId = "aa62f29f47477610082e3d02e26d4358";
const incidentSysId = "bb73f29f47477610082e3d02e26d4358";

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function request(query = {}, method = "GET") {
  return { method, query };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; return this; },
  };
}

function operatorAlert(overrides = {}) {
  return {
    id: "alert-operator-1",
    customer_name: "Havan",
    customer_key: "havan",
    host_name: "edge-01",
    host_visible_name: "edge-01",
    problem_name: "Link indisponível",
    severity: "high",
    source_event_id: "101",
    last_seen_at: "2026-08-28T17:50:00.000Z",
    event_tags: [{ tag: "description", value: "OPERADORA-4G" }],
    trigger_tags: [],
    host_tags: [],
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    sys_id: incidentSysId,
    number: "INC0075001",
    state: "2",
    state_display: "Em andamento",
    assigned_to: analystId,
    assigned_to_display: "Ana Operadora",
    assignment_group: "g1",
    assignment_group_display: "NOC Operadoras",
    sys_updated_on: "2026-08-28T17:40:00.000Z",
    correlation_id: "101",
    u_hostname_zabbix: "edge-01",
    ...overrides,
  };
}

const emptyFilters = {
  tab: "all",
  operator_tag: null,
  customer: null,
  assigned_to: null,
  state: null,
  severity: null,
  alert_status: "all",
  page: 1,
  page_size: 50,
};

test("OV-P0-247 audit constants match persisted operator tags", () => {
  assert.deepEqual([...OPERATOR_TAG_KEYS], ["description"]);
  assert.ok(OPERATOR_TAG_VALUES.includes("OPERADORA-4G"));
  assert.ok(OPERATOR_TAG_VALUES.includes("NET-BLC-120MB | Operadora | SOC/IP/06137"));
  assert.ok(OPERATOR_TAG_VALUES.includes("OPERADORA-BLC-XXXMB-abordagem-operadora"));
  assert.equal(SLA_RULES_IMPLEMENTED, false);
  assert.equal(UNASSIGNED_ANALYST_LABEL, "Sem responsável");
  assert.equal(RECENT_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("OV-P0-247 tag operadora entra; alerta sem tag não entra", () => {
  assert.equal(alertHasOperatorTag(operatorAlert()), true);
  assert.equal(alertHasOperatorTag(operatorAlert({
    event_tags: [{ tag: "description", value: "NET-BLC-120MB | Operadora | STS/IP/17573" }],
  })), true);
  assert.equal(alertHasOperatorTag({
    event_tags: [{ tag: "Operadora", value: "Embratel" }],
  }), true);
  assert.equal(alertHasOperatorTag({
    event_tags: [],
    trigger_tags: [],
    host_tags: [],
    problem_name: "queda operadora Embratel",
    host_name: "operadora-gw",
    customer_name: "Operadora Cliente",
    trigger_description: "escalonamento operadora",
  }), false);

  const payload = buildOperatorQueuePayload([
    operatorAlert(),
    operatorAlert({
      id: "alert-plain",
      event_tags: [{ tag: "description", value: "LAN-CORE" }],
      problem_name: "queda operadora",
    }),
  ], [], emptyFilters, now);

  assert.deepEqual(payload.items.map((item) => item.alert_id), ["alert-operator-1"]);
});

test("OV-P0-247 assigned_to aparece; sem assigned_to = Sem responsável", () => {
  const assigned = analystFromIncident(incident());
  assert.equal(assigned.assigned_to, analystId);
  assert.equal(assigned.assigned_to_display, "Ana Operadora");
  assert.equal(assigned.analyst_label, "Ana Operadora");
  assert.equal(assigned.unassigned, false);

  const open = analystFromIncident(incident({ assigned_to: null, assigned_to_display: null }));
  assert.equal(open.assigned_to, null);
  assert.equal(open.analyst_label, "Sem responsável");
  assert.equal(open.unassigned, true);

  const payload = buildOperatorQueuePayload(
    [operatorAlert(), operatorAlert({ id: "alert-open" })],
    [incident(), incident({ sys_id: "cc84f29f47477610082e3d02e26d4358", assigned_to: null, assigned_to_display: null, number: "INC0075002" })],
    emptyFilters,
    now,
  );
  const labels = payload.items.map((item) => item.analyst_label).sort();
  assert.ok(labels.includes("Ana Operadora"));
});

test("OV-P0-247 unassigned, analyst and recent filters", () => {
  const tagged = [
    operatorAlert({
      id: "assigned-recent",
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_sys_id", value: incidentSysId },
      ],
    }),
    operatorAlert({
      id: "unassigned-old",
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_sys_id", value: "dd95f29f47477610082e3d02e26d4358" },
      ],
      last_seen_at: "2026-08-20T12:00:00.000Z",
    }),
  ];
  const incidents = [
    incident(),
    incident({
      sys_id: "dd95f29f47477610082e3d02e26d4358",
      number: "INC0075003",
      assigned_to: null,
      assigned_to_display: null,
      sys_updated_on: "2026-08-20T12:00:00.000Z",
    }),
  ];

  const unassigned = buildOperatorQueuePayload(tagged, incidents, { ...emptyFilters, tab: "unassigned" }, now);
  assert.deepEqual(unassigned.items.map((item) => item.alert_id), ["unassigned-old"]);
  assert.equal(unassigned.counts.unassigned, 1);
  assert.equal(unassigned.counts.following, 1);

  const following = buildOperatorQueuePayload(tagged, incidents, { ...emptyFilters, tab: "following" }, now);
  assert.deepEqual(following.items.map((item) => item.alert_id), ["assigned-recent"]);

  const analyst = buildOperatorQueuePayload(tagged, incidents, { ...emptyFilters, assigned_to: analystId }, now);
  assert.deepEqual(analyst.items.map((item) => item.alert_id), ["assigned-recent"]);

  const recent = buildOperatorQueuePayload(tagged, incidents, { ...emptyFilters, tab: "recent" }, now);
  assert.deepEqual(recent.items.map((item) => item.alert_id), ["assigned-recent"]);
});

test("OV-P0-247 INC correlaciona sys_id → number → source event; sem host fallback", () => {
  const bySysId = pickCorrelatedIncident(
    operatorAlert({
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_sys_id", value: incidentSysId },
        { tag: "__zbx_servicenow_number", value: "INC0000001" },
      ],
    }),
    buildIncidentIndexes([incident(), incident({ sys_id: "ee00f29f47477610082e3d02e26d4358", number: "INC0000001" })]),
  );
  assert.equal(bySysId.relation_source, "zabbix_servicenow_sys_id");
  assert.equal(bySysId.incident.number, "INC0075001");

  const byNumber = pickCorrelatedIncident(
    operatorAlert({
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_number", value: "INC0075001" },
      ],
    }),
    buildIncidentIndexes([incident()]),
  );
  assert.equal(byNumber.relation_source, "zabbix_servicenow_number");

  const byEvent = pickCorrelatedIncident(
    operatorAlert({ event_tags: [{ tag: "description", value: "OPERADORA-4G" }] }),
    buildIncidentIndexes([incident()]),
  );
  assert.equal(byEvent.relation_source, "zabbix_event_id");

  const hostOnly = pickCorrelatedIncident(
    operatorAlert({
      id: "host-only",
      source_event_id: "999",
      event_tags: [{ tag: "description", value: "OPERADORA-4G" }],
    }),
    buildIncidentIndexes([incident({ correlation_id: "not-this", u_hostname_zabbix: "edge-01" })]),
  );
  assert.equal(hostOnly.incident, null);
  assert.equal(hostOnly.relation_source, "none");
});

test("OV-P0-247 SLA is a stub: Atualizado há X min, no delay class", () => {
  assert.equal(formatUpdatedAgoLabel("2026-08-28T17:50:00.000Z", now), "Atualizado há 10 min");
  const payload = buildOperatorQueuePayload(
    [operatorAlert({
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_sys_id", value: incidentSysId },
      ],
    })],
    [incident()],
    emptyFilters,
    now,
  );
  assert.equal(payload.sla_rules_implemented, false);
  assert.equal(payload.sla_awaiting_business_rules, true);
  assert.equal(payload.items[0].sla_status, null);
  assert.equal(payload.items[0].next_followup_at, null);
  assert.equal(payload.items[0].updated_ago_label, "Atualizado há 20 min");
  assert.doesNotMatch(JSON.stringify(payload), /atraso|overdue|breach/i);
});

test("OV-P0-247 handler returns INC link and keeps read-only contract", async () => {
  let receivedAlertStatus = null;
  const handler = createOperatorQueueHandler({
    authorize: async () => ({ roles: ["viewer"] }),
    listAlerts: async ({ alertStatus }) => {
      receivedAlertStatus = alertStatus;
      return [operatorAlert({
      event_tags: [
        { tag: "description", value: "OPERADORA-4G" },
        { tag: "__zbx_servicenow_sys_id", value: incidentSysId },
      ],
      })];
    },
    listIncidents: async () => [incident()],
    now: () => now,
    logger: () => undefined,
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].incident_number, "INC0075001");
  assert.equal(
    res.body.items[0].servicenow_url,
    `https://teletexprod.service-now.com/incident.do?sys_id=${incidentSysId}`,
  );
  assert.equal(res.body.items[0].oneview_link, "/operadoras?alert=alert-operator-1");
  assert.equal(res.body.items[0].analyst_label, "Ana Operadora");
  assert.equal(receivedAlertStatus, "all");

  const active = response();
  await handler(request({ alert_status: "active" }), active);
  assert.equal(active.statusCode, 200);
  assert.equal(receivedAlertStatus, "active");

  const denied = response();
  await handler(request({}, "POST"), denied);
  assert.equal(denied.statusCode, 405);
});

test("OV-P0-247 legacy route remains; Links presents circuit-level entities", async () => {
  const [page, app, sidebar, index, api, lib] = await Promise.all([
    read("src/pages/Operadoras.tsx"),
    read("src/App.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-operator-queue.js"),
  ]);

  assert.match(app, /path="\/operadoras"/);
  assert.match(app, /OperadorasPage/);
  assert.match(sidebar, /name: "Links"/);
  assert.match(sidebar, /href: "\/operadoras"/);
  assert.match(page, /ov-typography-page-title text-foreground">Links</);
  assert.match(page, /fetchCanonicalLinks/);
  assert.match(page, /isAbortError/);
  assert.match(page, /request\.current === controller/);
  assert.match(page, /request\.current = null/);
  assert.match(page, /Todos/);
  assert.match(page, /Não informada na origem/);
  assert.match(page, /Link \/ local/);
  assert.match(page, /Pendente de classificação/);
  assert.match(api, /export async function fetchOperatorQueue/);
  assert.match(api, /\/oneview\/operator-queue/);
  assert.doesNotMatch(page, /Assumir|Transferir|Hold|Comentar no chamado/);
  assert.match(index, /fetchOperatorQueue/);
  assert.match(index, /alertStatus: "active"/);
  assert.match(index, /Ver conectividade/);
  assert.doesNotMatch(lib, /problem_name\s*[=~].*operad|host_name\s*[=~].*operad|customer_name\s*[=~].*operad/i);
  assert.match(lib, /event_tags/);
  assert.match(lib, /extractServiceNowRefsFromAlertTags/);
  assert.doesNotMatch(lib, /u_hostname_zabbix/);
});
