import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildLinksPayload, createLinkDetailHandler, fetchCanonicalLinkDetail, fetchCanonicalLinks, parseLinkFilters } from "../api/_lib/oneview-links.js";

const tags = (number) => [{ tag: "escalation", value: "operator" }, { tag: "__zbx_servicenow_number", value: number }];
const alert = (id, trigger, uplink, number, overrides = {}) => ({
  id, data_source_id: "ds-1", datasource: "teletex-http", source_host_id: "havan-host", source_trigger_id: trigger,
  host_name: "HAVAN", customer_key: "havan", customer_name: "Havan", item_key: `meraki.uplink.status[143 - Marilia, ${uplink}, primary]`,
  item_name: `Uplink ${uplink}`, trigger_description: `Uplink ${uplink}`, problem_name: `Falha ${uplink}`,
  event_tags: tags(number), trigger_tags: [], host_tags: [], template_tags: [], severity: "average", status_source: "active", status_internal: "new",
  acknowledged_source: false, is_active: true, first_seen_at: "2026-09-04T12:00:00Z", last_seen_at: "2026-09-04T12:10:00Z", updated_at: "2026-09-04T12:10:00Z", ...overrides,
});
const alerts = [
  alert("wan1-average", "trigger-wan1", "wan1", "INC001", { severity: "average" }),
  alert("wan1-high", "trigger-wan1", "wan1", "INC002", { severity: "high", last_seen_at: "2026-09-04T12:05:00Z" }),
  alert("wan2", "trigger-wan2", "wan2", "INC003", { severity: "disaster" }),
];
const incidents = [
  { sys_id: "a", number: "INC001", state: "1", opened_at: "2026-09-04T10:00:00Z", sys_updated_on: "2026-09-04T12:00:00Z" },
  { sys_id: "b", number: "INC002", state: "2", opened_at: "2026-09-04T09:00:00Z", sys_updated_on: "2026-09-04T12:30:00Z" },
  { sys_id: "c", number: "INC003", state: "6", opened_at: "2026-09-04T08:00:00Z", sys_updated_on: "2026-09-04T13:00:00Z" },
];
const pool = (queries = []) => ({ async query(input) {
  queries.push(input);
  const sql = typeof input === "string" ? input : input.text;
  if (/from alerts a join data_sources/.test(sql)) return { rows: alerts };
  if (/from zabbix_link_inventory/.test(sql)) return { rows: [] };
  if (/from servicenow_incidents/.test(sql)) return { rows: incidents };
  throw new Error(`unexpected query: ${sql}`);
} });
const filters = parseLinkFilters({ query: { tab: "all", page_size: "100" } });

test("OV-P0-288 list is queue-only and detail isolates one circuit in a shared host", async () => {
  const rows = await fetchCanonicalLinks({ pool: pool() });
  const wan1 = rows.find((row) => row.uplink_key === "wan1" || row.service_name?.includes("wan1"));
  assert.ok(wan1);
  for (const key of ["incidents", "alerts", "active_alerts_detail", "trigger_ids", "source_metadata"]) assert.equal(key in wan1, false);
  const payload = buildLinksPayload(rows, filters);
  for (const key of ["incidents", "alerts", "active_alerts_detail", "trigger_ids", "source_metadata"]) assert.equal(key in payload.items[0], false);

  const detailQueries = [];
  const detail = await fetchCanonicalLinkDetail({ id: wan1.id, dataSourceId: wan1.data_source_id, sourceHostId: wan1.source_host_id, pool: pool(detailQueries) });
  assert.ok(detail);
  assert.equal(detail.current_alert?.id, "wan1-high");
  assert.equal(detail.current_incident?.number, "INC002");
  assert.deepEqual(detail.technical.trigger_ids, ["trigger-wan1"]);
  assert.deepEqual(detail.incident_history.map((item) => item.number).sort(), ["INC001", "INC002"]);
  assert.equal(detail.active_alerts_detail.some((item) => item.id === "wan2"), false);
  const incidentQuery = detailQueries.find((query) => /from servicenow_incidents/.test(query.text));
  assert.deepEqual(incidentQuery.values[1].sort(), ["INC001", "INC002"]);
});

test("OV-P0-288 detail handler validates stable circuit identity and returns one detail payload", async () => {
  const response = { statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } };
  const handler = createLinkDetailHandler({ authorize: async () => true, detail: async (query) => ({ id: query.id, source_host_id: query.sourceHostId, data_source_id: query.dataSourceId }) });
  await handler({ method: "GET", query: { id: "ds-1:havan-host:meraki:143-marilia:wan1", data_source_id: "ds-1", source_host_id: "havan-host" } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, "ds-1:havan-host:meraki:143-marilia:wan1");
  const invalid = { ...response, statusCode: 0, body: null };
  await handler({ method: "GET", query: { id: "x".repeat(241), data_source_id: "ds-1", source_host_id: "havan-host" } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test("OV-P0-288 drawer caches demand detail and never restores alert navigation", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  assert.match(page, /detailCache/);
  assert.match(page, /detailRequests/);
  assert.match(page, /fetchCanonicalLinkDetail/);
  assert.match(page, /Skeleton/);
  assert.doesNotMatch(page, /<LinkDrawer/);
});
