import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createIncidentDetailHandler } from "../api/_lib/oneview-incident-detail.js";
import { fetchReadModelIncidentDetail } from "../api/_lib/oneview-incidents-read-model.js";
import { EXACT_OPERATOR_TAG_SQL, fetchCanonicalLinks, fetchCanonicalLinkDetail } from "../api/_lib/oneview-links.js";

const incidentRow = {
  sys_id: "abcdef0123456789abcdef0123456789",
  number: "INC0081075",
  state: "3",
  priority: "2",
  assigned_to: "analyst-id",
  assignment_group: "group-id",
  caller_id: "caller-id",
  company: "company-id",
  contact_type: "monitoring",
  short_description: "Indisponibilidade de link",
  description: "Resumo operacional persistido",
  opened_at: "2026-09-09T13:18:00Z",
  resolved_at: null,
  closed_at: null,
  sys_created_on: "2026-09-09T13:18:00Z",
  sys_updated_on: "2026-09-09T14:48:00Z",
  correlation_id: "event-1",
  u_hostname_zabbix: "host-1",
  u_ip_zabbix: "192.0.2.1",
  display_values: {
    state_display: "Em espera",
    assigned_to_display: "Ana Analista",
    assignment_group_display: "N1 - Serviços - NOC",
    caller_id_display: "Monitoramento",
    company_display: "Cliente Exemplo",
  },
  impact: "2",
  urgency: "2",
  category: "network",
  subcategory: "link",
  close_code: null,
  close_notes: "Restabelecido",
  contract: null,
};

function response() {
  return {
    statusCode: 0,
    body: null,
    setHeader() { return this; },
    status(value) { this.statusCode = value; return this; },
    end(value) { this.body = JSON.parse(value); return this; },
  };
}

const tags = (number) => [{ tag: "escalation", value: "operator" }, { tag: "__zbx_servicenow_number", value: number }];
const alert = (id, trigger, uplink, number, overrides = {}) => ({
  id, data_source_id: "ds-1", datasource: "teletex-http", source_host_id: "havan-host", source_trigger_id: trigger,
  host_name: "HAVAN", customer_key: "havan", customer_name: "Havan", item_key: `meraki.uplink.status[143 - Marilia, ${uplink}, primary]`,
  item_name: `Uplink ${uplink}`, trigger_description: `Uplink ${uplink}`, problem_name: `Falha ${uplink}`,
  event_tags: tags(number), trigger_tags: [], host_tags: [], template_tags: [], severity: "average", status_source: "active", status_internal: "new",
  acknowledged_source: false, is_active: true, first_seen_at: "2026-09-04T12:00:00Z", last_seen_at: "2026-09-04T12:10:00Z", updated_at: "2026-09-04T12:10:00Z", ...overrides,
});

test("OV-P0-292 incident detail reads one exact PostgreSQL read-model row", async () => {
  const queries = [];
  const pool = { async query(query) { queries.push(query); return { rows: [incidentRow] }; } };
  const detail = await fetchReadModelIncidentDetail(incidentRow.sys_id.toUpperCase(), { pool });
  assert.equal(detail.sys_id, incidentRow.sys_id);
  assert.equal(detail.number, "INC0081075");
  assert.equal(detail.description, "Resumo operacional persistido");
  assert.equal(detail.assignment_group_display, "N1 - Serviços - NOC");
  assert.equal(detail.close_notes, "Restabelecido");
  assert.equal(detail.resolved_at, null);
  assert.match(queries[0].text, /where lower\(sys_id::text\) = \$1[\s\S]*limit 1/i);
  assert.deepEqual(queries[0].values, [incidentRow.sys_id]);
  assert.doesNotMatch(queries[0].text, /select\s+raw_payload\b/i);
});

test("OV-P0-292 incident detail BFF is viewer GET-only and sanitizes failures", async () => {
  const roles = [];
  const handler = createIncidentDetailHandler({
    authorize: async (_req, _res) => { roles.push("viewer"); return { roles: ["viewer"] }; },
    findIncident: async (id) => id === incidentRow.sys_id ? { sys_id: id, number: "INC0081075" } : null,
    logger: () => undefined,
  });
  const ok = response();
  await handler({ method: "GET", query: { id: incidentRow.sys_id } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.item.number, "INC0081075");
  assert.deepEqual(roles, ["viewer"]);

  const missing = response();
  await handler({ method: "GET", query: { id: "00000000000000000000000000000000" } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, "incident_not_found");

  const post = response();
  await handler({ method: "POST", query: { id: incidentRow.sys_id } }, post);
  assert.equal(post.statusCode, 405);
});

test("OV-P0-292 list starts independent inventory and alert reads concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const queries = [];
  const pool = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    queries.push(sql);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    if (/from zabbix_link_inventory l join data_sources/i.test(sql)) return { rows: [] };
    if (/from alerts a join data_sources/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const rows = await fetchCanonicalLinks({ pool });
  assert.equal(rows.length, 0);
  assert.equal(maxActive, 3);
  const alertsSql = queries.filter((sql) => /from alerts a join data_sources/i.test(sql)).join("\n");
  assert.match(alertsSql, /interval '7 days'/i);
  assert.match(alertsSql, /__zbx_servicenow_sys_id/);
  assert.doesNotMatch(alertsSql, /payload_raw|payload_normalized/);
  assert.match(EXACT_OPERATOR_TAG_SQL, /template_tags|payload_normalized/);
});

test("OV-P0-292 all links keeps every canonical inventory host; seven days scopes alerts only", async () => {
  const inventoryRows = [
    { id: "inventory-havan", data_source_id: "ds-1", datasource: "teletex-http", source_host_id: "havan-host", customer_key: "havan", customer_name: "Havan", service_name: "Host agregador", classification: "wan_link", classification_confidence: "high", source_metadata: {} },
    { id: "inventory-legacy", data_source_id: "ds-1", datasource: "teletex-http", source_host_id: "legacy-host", customer_key: "legacy", customer_name: "Legacy", service_name: "Link inventariado", classification: "wan_link", classification_confidence: "high", source_metadata: {} },
  ];
  const queries = [];
  const pool = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    queries.push(sql);
    if (/from zabbix_link_inventory l join data_sources/i.test(sql)) return { rows: inventoryRows };
    if (/from alerts a join data_sources/i.test(sql)) return { rows: [alert("wan1", "trigger-wan1", "wan1", "")] };
    if (/from servicenow_incidents/i.test(sql)) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const rows = await fetchCanonicalLinks({ pool });
  assert.deepEqual(new Set(rows.map((row) => `${row.data_source_id}:${row.source_host_id}`)), new Set(["ds-1:havan-host", "ds-1:legacy-host"]));
  assert.equal(rows.find((row) => row.source_host_id === "legacy-host")?.strategy, "inventory_host");
  assert.equal(rows.find((row) => row.source_host_id === "havan-host")?.strategy, "meraki");
  const inventorySql = queries.find((sql) => /from zabbix_link_inventory l join data_sources/i.test(sql));
  assert.doesNotMatch(inventorySql, /interval '7 days'/i);
  assert.match(queries.filter((sql) => /from alerts a join data_sources/i.test(sql)).join("\n"), /interval '7 days'/i);
});

test("OV-P0-292 list remains summary and circuit A never inherits circuit B incident", async () => {
  const alerts = [
    alert("wan1", "trigger-wan1", "wan1", "INC001"),
    alert("wan2", "trigger-wan2", "wan2", "INC002", { severity: "disaster" }),
  ];
  const incidents = [
    { sys_id: "a", number: "INC001", state: "1", opened_at: "2026-09-04T10:00:00Z", sys_updated_on: "2026-09-04T12:00:00Z", display_values: {} },
    { sys_id: "b", number: "INC002", state: "2", opened_at: "2026-09-04T09:00:00Z", sys_updated_on: "2026-09-04T12:30:00Z", display_values: {} },
  ];
  const pool = { async query(input) {
    const sql = typeof input === "string" ? input : input.text;
    if (/from alerts a join data_sources/.test(sql)) return { rows: alerts };
    if (/from zabbix_link_inventory/.test(sql)) return { rows: [] };
    if (/from servicenow_incidents/.test(sql)) return { rows: incidents };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const rows = await fetchCanonicalLinks({ pool });
  const wan1 = rows.find((row) => String(row.service_name || "").includes("wan1") || row.uplink_key === "wan1");
  const wan2 = rows.find((row) => String(row.service_name || "").includes("wan2") || row.uplink_key === "wan2");
  assert.ok(wan1 && wan2);
  assert.equal(wan1.current_incident?.number, "INC001");
  assert.equal(wan2.current_incident?.number, "INC002");
  for (const key of ["incidents", "alerts", "active_alerts_detail", "trigger_ids", "source_metadata"]) {
    assert.equal(key in wan1, false);
  }

  const detail = await fetchCanonicalLinkDetail({
    id: wan1.id, dataSourceId: wan1.data_source_id, sourceHostId: wan1.source_host_id, pool,
  });
  assert.equal(detail.current_incident?.number, "INC001");
  assert.equal(detail.incident_history.some((item) => item.number === "INC002"), false);
});

test("OV-P0-292 drawer expands current/history INC in place with session cache and no navigation", async () => {
  const [page, api, route, incidentDetail, links, runner] = await Promise.all([
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/oneview/incidents/detail/[id].js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-incident-detail.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-links.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev-oneview-bff.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Detalhes do chamado/);
  assert.match(page, /current:\$\{currentIncident\.sys_id/);
  assert.match(page, /history:\$\{incident\.sys_id/);
  assert.match(page, /expandedIncidentKey/);
  assert.match(page, /fetchIncidentDetail\(String\(incident\.sys_id\)\)/);
  assert.match(page, /OperationalErrorBanner message=\{error\}/);
  assert.match(page, /startTransition/);
  assert.match(page, /document\.hidden/);
  assert.match(page, /visibilitychange/);
  assert.match(page, /Não foi possível identificar este alerta de forma estável\./);
  assert.match(page, /hasOperationalSubject/);
  assert.doesNotMatch(page, /Abrir no ServiceNow/);
  assert.doesNotMatch(page, /navigate\([^)]*incident|window\.open\([^)]*incident/i);
  assert.match(api, /incidentDetailCache/);
  assert.match(api, /incidentDetailInFlight/);
  assert.match(route, /oneview-incident-detail/);
  assert.doesNotMatch(incidentDetail, /servicenow-client/i);
  assert.match(links, /interval '7 days'/);
  assert.match(links, /LIST_OPERATOR_TAG_SQL|includeTemplateTags: false/);
  assert.match(links, /alerts_residual_query_ms|SERVICENOW_TAG_EXISTS_SQL|__zbx_servicenow_sys_id/);
  assert.match(runner, /routeName === "link-detail"/);
  assert.match(runner, /routeName === "link-reminders"/);
  assert.match(runner, /routeName === "incident-detail"/);
  assert.match(runner, /const linkReminders = pathname\.match/);
  assert.match(runner, /\["POST", "PATCH", "DELETE"\]/);
});

test("OV-P0-292 incident detail cache avoids duplicate in-flight fetches", async () => {
  const api = await readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8");
  assert.match(api, /const incidentDetailCache = new Map/);
  assert.match(api, /const incidentDetailInFlight = new Map/);
  assert.match(api, /incidentDetailCache\.get\(key\)/);
  assert.match(api, /incidentDetailInFlight\.get\(key\)/);
  assert.match(api, /incidentDetailCache\.set\(key, item\)/);
  assert.match(api, /finally \{\s*incidentDetailInFlight\.delete\(key\);/s);
});
