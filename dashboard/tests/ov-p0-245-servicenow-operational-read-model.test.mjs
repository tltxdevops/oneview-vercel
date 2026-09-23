import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchReadModelIncidentsPage,
  mapReadModelIncident,
} from "../api/_lib/oneview-incidents-read-model.js";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import {
  createServiceNowEventsHandler,
  normalizeServiceNowEventPayload,
} from "../api/_lib/oneview-servicenow-events.js";

const SYS_ID = "4475122733b2871064bca4989d5c7b2f";

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; },
  };
}

function requestMock(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer events-secret" },
    body: sourceIncident(),
    ...overrides,
  };
}

function sourceIncident(overrides = {}) {
  return {
    sys_id: SYS_ID,
    number: "INC0074734",
    state: { value: "2", display_value: "Em andamento" },
    priority: { value: "2", display_value: "2 - Alta" },
    assignment_group: { value: "group-sys-id", display_value: "NOC" },
    assigned_to: { value: "analyst-sys-id", display_value: "Analista real" },
    caller_id: { value: "caller-sys-id", display_value: "zabbix monitoring" },
    company: { value: "company-sys-id", display_value: "Cliente real" },
    contact_type: { value: "monitoring", display_value: "Monitoramento" },
    short_description: "Falha real",
    description: "Host: host-real\nID original do problema: 338976923",
    opened_at: "2026-08-28 10:00:00",
    sys_created_on: "2026-08-28 10:00:00",
    sys_updated_on: "2026-08-28 10:01:00",
    impact: { value: "1", display_value: "1 - Alto" },
    urgency: { value: "2", display_value: "2 - Média" },
    ...overrides,
  };
}

function filters() {
  return {
    page: 1,
    page_size: 25,
    caller_id: null,
    assigned_to: null,
    contact_type: "monitoring",
    number: null,
    sys_id: null,
    state: null,
    priority: null,
    company: null,
    opened_from: null,
    opened_to: null,
    updated_from: null,
    updated_to: null,
    unassigned: false,
    assignment_group: null,
    search: null,
  };
}

test("OV-P0-245 maps canonical contract from persisted read-model values without inference", () => {
  const item = mapReadModelIncident({
    ...normalizeServiceNowEventPayload(sourceIncident()),
    display_values: {
      state: "Em andamento",
      priority: "2 - Alta",
      assigned_to: "Analista real",
      assignment_group: "NOC",
      company: "Cliente real",
      contact_type: "Monitoramento",
    },
    impact: "1",
    urgency: "2",
  }, {
    relatedAlert: {
      id: "alert-1",
      severity: "high",
      host: "host-real",
      datasource: "rhp",
      customer: "Cliente real",
      problem: "Falha real",
      status: "active",
      source_event_id: "338976923",
      relation_source: "sys_id",
    },
  });

  assert.equal(item.id, SYS_ID);
  assert.equal(item.assignedTo, "Analista real");
  assert.equal(item.assignedToId, "analyst-sys-id");
  assert.equal(item.assignmentGroup, "NOC");
  assert.equal(item.customer, "Cliente real");
  assert.equal(item.channel, "Monitoramento");
  assert.equal(item.impact, "1");
  assert.equal(item.urgency, "2");
  assert.deepEqual(item.relatedAlert, {
    alertId: "alert-1",
    severity: "high",
    host: "host-real",
    datasource: "rhp",
    link: "/alertas?alert=alert-1",
    relationSource: "sys_id",
    customer: "Cliente real",
    problem: "Falha real",
    status: "active",
    sourceEventId: "338976923",
  });
});

test("OV-P0-245 accepts updated_at queue filters and limits inline relation resolution to exact lookups", () => {
  const parsed = parseIncidentFilters({ query: {
    updated_from: "2026-08-01",
    updated_to: "2026-08-28",
    include_related_alert: "true",
    number: "INC0074734",
  } });
  assert.equal(parsed.updated_from, "2026-08-01");
  assert.equal(parsed.updated_to, "2026-08-28");
  assert.equal(parsed.include_related_alert, true);
  assert.equal(parsed.number, "INC0074734");
});

test("OV-P0-245 default recent queue is sys_updated_on DESC without tag scans", async () => {
  const queries = [];
  const row = {
    ...normalizeServiceNowEventPayload(sourceIncident()),
    display_values: {},
  };
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("select count(*)::int as total") && !sql.includes("filter")) return { rows: [{ total: 1 }] };
      if (sql.includes("count(*) filter")) return { rows: [{ total: 1, open: 1, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 }] };
      if (sql.includes("servicenow_sync_state")) return { rows: [] };
      if (sql.includes("group by")) return { rows: [] };
      if (sql.includes("from servicenow_incidents")) return { rows: [row] };
      throw new Error("unexpected query");
    },
  };
  const page = await fetchReadModelIncidentsPage(filters(), {
    pool,
    relatedAlertResolver: async () => { throw new Error("tag relation must stay lazy"); },
  });

  const listSql = queries.find((sql) => sql.includes("limit $") && sql.includes("from servicenow_incidents"));
  assert.match(listSql, /order by sys_updated_on desc nulls last, sys_id asc/i);
  assert.equal(page.items[0].relatedAlert, null);
});

test("OV-P0-245 exact incident lookup may resolve related alert in one batch", async () => {
  const row = { ...normalizeServiceNowEventPayload(sourceIncident()), display_values: {} };
  const pool = {
    async query(sql) {
      if (sql.includes("select count(*)::int as total") && !sql.includes("filter")) return { rows: [{ total: 1 }] };
      if (sql.includes("count(*) filter")) return { rows: [{ total: 1, open: 1, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 }] };
      if (sql.includes("servicenow_sync_state") || sql.includes("group by")) return { rows: [] };
      if (sql.includes("from servicenow_incidents")) return { rows: [row] };
      throw new Error("unexpected query");
    },
  };
  let calls = 0;
  const exactFilters = { ...filters(), number: "INC0074734", include_related_alert: true };
  const page = await fetchReadModelIncidentsPage(exactFilters, {
    pool,
    relatedAlertResolver: async (rows) => {
      calls += 1;
      assert.equal(rows.length, 1);
      return new Map([[SYS_ID, { id: "alert-1", severity: "high", host: "host", datasource: "rhp" }]]);
    },
  });
  assert.equal(calls, 1);
  assert.equal(page.items[0].relatedAlert.alertId, "alert-1");
});

function eventDatabase({ existingUpdatedAt = null } = {}) {
  const state = { writes: 0, queries: [], existingUpdatedAt };
  return {
    state,
    transaction: async (work) => work({
      async query(sql, values = []) {
        state.queries.push({ sql, values });
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (normalized.startsWith("select sys_id, number from servicenow_incidents where number::text")) return { rows: [] };
        if (normalized.startsWith("select sys_id, sys_updated_on")) {
          return { rows: state.existingUpdatedAt ? [{ sys_id: SYS_ID, sys_updated_on: state.existingUpdatedAt }] : [] };
        }
        if (normalized.startsWith("insert into servicenow_incidents")) {
          state.writes += 1;
          return { rows: [{ sys_id: SYS_ID }] };
        }
        throw new Error("unexpected query");
      },
    }),
  };
}

function handler(database, logs = []) {
  return createServiceNowEventsHandler({
    configProvider: () => ({ secret: "events-secret" }),
    transaction: database.transaction,
    now: () => new Date("2026-08-28T10:02:00.000Z"),
    logger: (entry) => logs.push(entry),
  });
}

test("OV-P0-245 accepts only the dedicated ServiceNow events secret and persists exact raw source once", async () => {
  const database = eventDatabase();
  const logs = [];
  const res = responseMock();
  await handler(database, logs)(requestMock(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: "created", sys_id: SYS_ID });
  assert.equal(database.state.writes, 1);
  const write = database.state.queries.find(({ sql }) => sql.includes("insert into servicenow_incidents"));
  assert.equal(write.values.includes(SYS_ID), true);
  assert.equal(write.values.some((value) => String(value).includes("Falha real")), true);
  assert.equal(JSON.stringify({ res: res.body, logs }).includes("events-secret"), false);
  assert.equal(JSON.stringify({ res: res.body, logs }).includes("CRON_SECRET"), false);
});

test("OV-P0-245 rejects absent or wrong event secret before transaction", async () => {
  for (const authorization of [undefined, "Bearer wrong-secret"]) {
    const database = eventDatabase();
    const res = responseMock();
    await handler(database)(requestMock({ headers: authorization ? { authorization } : {} }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(database.state.queries.length, 0);
  }
});

test("OV-P0-245 rejects stale source version and treats equal version as idempotent", async () => {
  const staleDatabase = eventDatabase({ existingUpdatedAt: "2026-08-28T10:03:00.000Z" });
  const staleResponse = responseMock();
  await handler(staleDatabase)(requestMock(), staleResponse);
  assert.equal(staleResponse.statusCode, 409);
  assert.deepEqual(staleResponse.body, { status: "stale", sys_id: SYS_ID });
  assert.equal(staleDatabase.state.writes, 0);

  const duplicateDatabase = eventDatabase({ existingUpdatedAt: "2026-08-28T10:01:00.000Z" });
  const duplicateResponse = responseMock();
  await handler(duplicateDatabase)(requestMock(), duplicateResponse);
  assert.equal(duplicateResponse.statusCode, 200);
  assert.deepEqual(duplicateResponse.body, { status: "idempotent", sys_id: SYS_ID });
  assert.equal(duplicateDatabase.state.writes, 0);
});

test("OV-P0-245 rejects malformed source contracts and never allows GET", async () => {
  const database = eventDatabase();
  const invalidResponse = responseMock();
  await handler(database)(requestMock({ body: { sys_id: SYS_ID, number: "INC0074734" } }), invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(database.state.queries.length, 0);

  const methodResponse = responseMock();
  await handler(database)(requestMock({ method: "GET" }), methodResponse);
  assert.equal(methodResponse.statusCode, 405);
});
