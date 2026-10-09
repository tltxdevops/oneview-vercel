import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import { buildAlertListQuery, buildGlobalHistoryScopeClauses } from "../api/_lib/oneview-db.js";
import { buildLinksPayload, parseLinkFilters } from "../api/_lib/oneview-links.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("column contracts accept repeated and legacy CSV values", () => {
  const incidents = parseIncidentFilters({ query: {
    company: ["Ailos", "Sanepar"], state: ["1", "2"], priority: "1,2",
    assignment_group: ["N1", "N2"], number_search: "INC0094", description_search: "router",
  } });
  assert.deepEqual(incidents.companies, ["Ailos", "Sanepar"]);
  assert.deepEqual(incidents.states, ["1", "2"]);
  assert.deepEqual(incidents.priorities, ["1", "2"]);
  assert.deepEqual(incidents.assignment_groups, ["N1", "N2"]);
  assert.equal(incidents.number_search, "INC0094");
  assert.equal(incidents.description_search, "router");

  const links = parseLinkFilters({ query: {
    customer: ["Ailos", "Sanepar"], severity: "high,disaster",
    incident_state: ["1", "2"], link_search: "MPLS", incident_number: "INC0094",
  } });
  assert.deepEqual(links.customers, ["Ailos", "Sanepar"]);
  assert.deepEqual(links.severities, ["high", "disaster"]);
  assert.deepEqual(links.incident_states, ["1", "2"]);
  assert.equal(links.link_search, "MPLS");
  assert.equal(links.incident_number, "INC0094");
});

test("same-column values use OR while independent alert/history columns use AND", () => {
  const alerts = buildAlertListQuery({ query: {
    status: "active", oneview_ack_status: ["success", "failed"], incident_state: ["1", "2"],
    host_search: "router", problem_search: "icmp", incident_number: "INC0094",
  } }, ["teletex-http"]);
  assert.match(alerts.whereSql, /ack\.status[\s\S]*= any\(/);
  assert.match(alerts.whereSql, /i\.state::text = any\(/);
  assert.match(alerts.whereSql, /host_visible_name[\s\S]*ilike/);
  assert.match(alerts.whereSql, /problem_name[\s\S]*ilike/);
  assert.ok(alerts.params.some((value) => Array.isArray(value) && value.includes("success") && value.includes("failed")));

  const history = buildGlobalHistoryScopeClauses({ query: {
    actor: ["Ana", "Bruno"], severity: ["high", "disaster"], host_search: "router", comment_search: "ack",
  } }, ["teletex-http"]);
  assert.match(history.clauses.join(" "), /actor_name[\s\S]*= any/);
  assert.match(history.clauses.join(" "), /severity[\s\S]*= any/);
  assert.match(history.clauses.join(" "), /host_visible_name[\s\S]*ilike/);
  assert.match(history.clauses.join(" "), /h\.message[\s\S]*ilike/);
});

test("links combine category OR with field-specific AND", () => {
  const filters = parseLinkFilters({ query: { customer: ["Ailos", "Sanepar"], severity: ["high", "disaster"], link_search: "MPLS" } });
  const row = (id, customer_name, severity, service_name) => ({
    id, customer_name, customer_key: customer_name, datasource: "zabbix", classification: "wan_link",
    carrier_name: null, service_name, source_host_id: id, active_alerts: 1, unack_alerts: 1,
    disaster_alerts: severity === "disaster" ? 1 : 0, high_alerts: severity === "high" ? 1 : 0,
    average_alerts: 0, warning_alerts: 0, state: "alert", max_severity: severity,
    incident_count: 0, incidents: [], alerts: [], resolution_status: "resolved",
  });
  const payload = buildLinksPayload([
    row("a", "Ailos", "high", "MPLS Norte"),
    row("b", "Sanepar", "disaster", "MPLS Sul"),
    row("c", "Outro", "high", "MPLS Leste"),
    row("d", "Ailos", "warning", "MPLS Oeste"),
    row("e", "Ailos", "high", "Internet"),
  ], filters);
  assert.deepEqual(payload.items.map((item) => item.id).sort(), ["a", "b"]);
});

test("all operational tables expose independent compact column controls", async () => {
  const [tools, chamados, alerts, history, links, api] = await Promise.all([
    read("src/components/oneview/ConfigurableTableTools.tsx"), read("src/pages/Chamados.tsx"),
    read("src/pages/Alerts.tsx"), read("src/pages/Historico.tsx"), read("src/pages/Operadoras.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);
  assert.match(tools, /OneViewColumnFilterPopover/);
  for (const source of [chamados, alerts, history, links]) assert.match(source, /OneViewFilterableHeader/);
  assert.match(chamados, /Filtrar número do incidente/);
  assert.match(alerts, /Filtrar analista do ACK/);
  assert.match(history, /Filtrar atores/);
  assert.match(links, /Pesquisar link ou local/);
  assert.match(api, /search\.append\(key, item\)/);
});
