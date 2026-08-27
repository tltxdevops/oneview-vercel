import test from "node:test";
import assert from "node:assert/strict";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import {
  fetchReadModelIncidentsPage,
  findReadModelRelatedIncidents,
} from "../api/_lib/oneview-incidents-read-model.js";

const row = {
  sys_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  number: "INC0068905",
  state: "1",
  priority: "2",
  assigned_to: "user-1",
  assignment_group: "group-1",
  caller_id: "caller-1",
  company: "company-1",
  contact_type: "monitoring",
  short_description: "Banco indisponível",
  description: "ID original do problema: 335113766",
  opened_at: "2026-08-14T20:00:00.000Z",
  sys_updated_on: "2026-08-14T21:00:00.000Z",
  zabbix_event_id: "335113766",
  correlation_id: null,
  u_hostname_zabbix: "host-1",
  u_ip_zabbix: null,
  display_values: {
    state_display: "Novo",
    priority_display: "2 - Alta",
    assigned_to_display: "Ana",
    assignment_group_display: "NOC",
  },
};

function fakePool(calls) {
  return {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("servicenow_sync_state")) return { rows: [{ last_success_at: "2026-08-14T21:23:54.265Z", watermark_sys_updated_on: "2026-08-14T21:22:29.000Z" }] };
      if (sql.includes("count(*) filter")) return { rows: [{ total: 1, open: 1, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 }] };
      if (sql.includes("group by")) return { rows: [] };
      if (sql.includes("count(*)::int as total")) return { rows: [{ total: 1 }] };
      if (sql.includes("from servicenow_incidents")) return { rows: [row] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

test("SN-P0-39 filters suporta sys_id, assignment_group e lookup exato", () => {
  const filters = parseIncidentFilters({ query: {
    page: "3", page_size: "25", sys_id: row.sys_id.toUpperCase(), number: row.number,
    assignment_group: "group-1", state: "1,2", priority: "2", unassigned: "true",
  } });
  assert.equal(filters.sys_id, row.sys_id);
  assert.equal(filters.assignment_group, "group-1");
  assert.equal(filters.number, row.number);
  assert.equal(filters.unassigned, true);
});

test("SN-P0-39 page PostgreSQL usa labels, filtro/período e lookup exato sem offset", async () => {
  const calls = [];
  const filters = parseIncidentFilters({ query: {
    page: "3", page_size: "25", number: row.number, state: "1", priority: "2",
    opened_from: "2026-08-01", opened_to: "2026-08-31", unassigned: "true",
  } });
  const result = await fetchReadModelIncidentsPage(filters, { pool: fakePool(calls) });
  assert.equal(result.data_source, "postgresql");
  assert.equal(result.pagination.page, 1);
  assert.equal(result.items[0].state_display, "Novo");
  assert.equal(result.items[0].assignment_group_display, "NOC");
  assert.equal(result.items[0].zabbix_event_id, "335113766");
  assert.equal(result.items[0].servicenow_url, `https://teletexprod.service-now.com/incident.do?sys_id=${row.sys_id}`);
  assert.equal(result.items[0].raw_payload, undefined);
  const pageCall = calls.find((call) => call.sql.includes("order by sys_updated_on desc"));
  assert.equal(pageCall.values.at(-1), 0);
  assert.match(pageCall.sql, /opened_at >=/);
  assert.match(pageCall.sql, /assigned_to::text/);
});

test("SN-P0-39 paginação normal aplica offset server-side", async () => {
  const calls = [];
  const filters = parseIncidentFilters({ query: { page: "2", page_size: "25" } });
  await fetchReadModelIncidentsPage(filters, { pool: fakePool(calls) });
  const pageCall = calls.find((call) => call.sql.includes("order by sys_updated_on desc"));
  assert.equal(pageCall.values.at(-1), 25);
});

test("SN-P0-39 drawer prioriza sys_id explícito e não usa host", async () => {
  const calls = [];
  const result = await findReadModelRelatedIncidents({
    incidentSysIds: [row.sys_id], tagIncidentNumbers: [row.number], sourceEventId: "335113766",
  }, { pool: fakePool(calls) });
  assert.equal(result.matched, true);
  assert.equal(result.relation_source, "zabbix_servicenow_sys_id");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql.slice(calls[0].sql.indexOf("where")), /host/i);
});
