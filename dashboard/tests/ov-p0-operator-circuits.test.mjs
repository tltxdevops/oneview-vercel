import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverOperatorCircuits,
  hasExactOperatorEscalation,
} from "../api/_lib/oneview-operator-circuits.js";
import {
  EXACT_OPERATOR_TAG_SQL,
  buildLinksPayload,
  composeCircuitLevelLinks,
  createLinksHandler,
  fetchCanonicalLinks,
} from "../api/_lib/oneview-links.js";

const escalation = [{ tag: " escalation ", value: " Operator " }];
const baseAlert = (overrides = {}) => ({
  id: "alert-1",
  data_source_id: "ds-1",
  datasource: "teletex-http",
  source_host_id: "host-1",
  source_trigger_id: "trigger-1",
  host_name: "HOST-1",
  customer_key: "cliente",
  customer_name: "Cliente",
  event_tags: escalation,
  trigger_tags: [],
  host_tags: [],
  template_tags: [],
  severity: "average",
  status_source: "active",
  status_internal: "new",
  acknowledged_source: false,
  is_active: true,
  ...overrides,
});

const fortigate = (trigger, member, overrides = {}) => baseAlert({
  id: `alert-${trigger}`,
  source_host_id: "fortigate-1",
  source_trigger_id: trigger,
  host_name: "PROTEGE-FW",
  customer_key: "protege",
  customer_name: "Protege",
  item_key: `fgVWLHealthCheckLinkPacketLoss[PING_INTERNET.${member}]`,
  trigger_description: `Health Check State to PING_INTERNET on SD-WAN member ${member} - 1010`,
  ...overrides,
});

const meraki = (trigger, site, uplink) => baseAlert({
  id: `alert-${trigger}`,
  source_host_id: "havan-aggregator",
  source_trigger_id: trigger,
  host_name: "HAVAN",
  customer_key: "havan",
  customer_name: "Havan",
  item_key: `meraki.uplink.status[${site}, ${uplink}, primary]`,
});

const sanepar = (trigger, itemKey, extraTags = [], overrides = {}) => baseAlert({
  id: `alert-${trigger}`,
  source_host_id: "sanepar-router-1",
  source_trigger_id: trigger,
  host_name: "SANEPAR-ROUTER",
  customer_key: "sanepar",
  customer_name: "Sanepar",
  item_key: itemKey,
  event_tags: [...escalation, ...extraTags],
  ...overrides,
});

const inventory = (host = "host-legacy") => ({
  id: `inventory-${host}`,
  data_source_id: "ds-1",
  datasource: "teletex-http",
  source_host_id: host,
  customer_key: "cliente",
  customer_name: "Cliente",
  service_name: "Link legado",
  classification: "wan_link",
  classification_source: "inventory",
  classification_confidence: "high",
  carrier_name: null,
  carrier_source: null,
  source_metadata: {},
  updated_at: "2026-09-04T10:00:00.000Z",
});

test("eligibility requires exact escalation=operator across all four tag bags", () => {
  assert.equal(hasExactOperatorEscalation({ template_tags: escalation }), true);
  assert.equal(hasExactOperatorEscalation({ host_tags: [{ tag: "ESCALATION", value: "OPERATOR" }] }), true);
  assert.equal(hasExactOperatorEscalation({ event_tags: [{ tag: "description", value: "operator" }] }), false);
  assert.equal(hasExactOperatorEscalation({ trigger_tags: [{ tag: "escalation", value: "operator-team" }] }), false);
  assert.match(EXACT_OPERATOR_TAG_SQL, /= 'escalation'/);
  assert.match(EXACT_OPERATOR_TAG_SQL, /= 'operator'/);
  assert.match(EXACT_OPERATOR_TAG_SQL, /template_tags/);
});

test("Protege packet loss and state for the same health-check/member become one circuit", () => {
  const circuits = discoverOperatorCircuits([
    fortigate("loss-37", 37),
    fortigate("state-37", 37, { item_key: "fgVWLHealthCheckLinkState[16]" }),
  ]);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].circuit_key, "operator:v1:fortigate:ds-1:fortigate-1:ping-internet:member-37");
  assert.deepEqual(circuits[0].trigger_ids, ["loss-37", "state-37"]);
});

test("Protege member 1 and member 2 remain distinct", () => {
  const circuits = discoverOperatorCircuits([fortigate("member-1", 1), fortigate("member-2", 2)]);
  assert.equal(circuits.length, 2);
  assert.deepEqual(circuits.map((item) => item.member_key), ["1", "2"]);
});

test("Fortigate interfaceid alone is not treated as a circuit member", () => {
  const [circuit] = discoverOperatorCircuits([
    fortigate("state-interface-only", 37, {
      item_key: "fgVWLHealthCheckLinkState[16]",
      trigger_description: "Health Check State unavailable",
    }),
  ]);
  assert.equal(circuit.resolution_status, "unresolved");
  assert.equal(circuit.member_key, null);
});

test("Havan wan1, wan2 and cellular are three circuits and stores do not collide", () => {
  const circuits = discoverOperatorCircuits([
    meraki("m1", "226 - Tramandaí", "wan1"),
    meraki("m2", "226 - Tramandaí", "wan2"),
    meraki("m3", "226 - Tramandaí", "cellular"),
    meraki("m4", "143 - Marília", "wan1"),
  ]);
  assert.equal(circuits.length, 4);
  assert.equal(new Set(circuits.map((item) => item.circuit_key)).size, 4);
  assert.deepEqual(new Set(circuits.map((item) => item.uplink_key)), new Set(["wan1", "wan2", "cellular"]));
});

test("Sanepar classe and auxiliary reachability on same host/IP consolidate", () => {
  const circuits = discoverOperatorCircuits([
    sanepar("class", "sdwan.tunel.classe[10.20.30.40,MPLS]", [{ tag: "site_id", value: "42" }]),
    sanepar("reach", "sdwan.reachability[10.20.30.40]"),
  ]);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].resolution_status, "resolved");
  assert.equal(circuits[0].link_type, "mpls");
  assert.deepEqual(circuits[0].trigger_ids, ["class", "reach"]);
});

test("Sanepar MPLS and LTE at same site remain distinct", () => {
  const circuits = discoverOperatorCircuits([
    sanepar("mpls", "sdwan.tunel.classe[10.0.0.1,MPLS]", [{ tag: "site", value: "77" }]),
    sanepar("lte", "sdwan.tunel.classe[10.0.0.2,LTE]", [{ tag: "site", value: "77" }]),
  ]);
  assert.equal(circuits.length, 2);
  assert.deepEqual(new Set(circuits.map((item) => item.link_type)), new Set(["mpls", "lte"]));
});

test("Sanepar without safe type stays visible and does not invent link_type", () => {
  const [circuit] = discoverOperatorCircuits([
    sanepar("unknown", "sdwan.tunel.reachability[10.0.0.9]", [{ tag: "site", value: "88" }]),
  ]);
  assert.equal(circuit.resolution_status, "unresolved");
  assert.equal(circuit.link_type, null);
  assert.match(circuit.circuit_key, /^operator:v1:sanepar-unresolved:/);
});

test("generic explicit circuit may resolve carrier, while operator tag alone stays unresolved", () => {
  const circuits = discoverOperatorCircuits([
    baseAlert({
      id: "vivo-alert",
      source_trigger_id: "vivo-trigger",
      trigger_description: "Link MPLS circuito: VIVO-123 INOPERANTE",
      trigger_tags: [{ tag: "carrier", value: "Vivo" }],
    }),
    baseAlert({ id: "cpu-alert", source_trigger_id: "cpu-trigger", trigger_description: "CPU high" }),
  ]);
  const vivo = circuits.find((circuit) => circuit.carrier_name === "Vivo");
  const unresolved = circuits.find((circuit) => circuit.resolution_status === "unresolved");
  assert.equal(vivo.link_type, "mpls");
  assert.match(vivo.circuit_key, /vivo-123/);
  assert.equal(unresolved.link_type, null);
});

test("circuits on same host receive only their trigger alerts and incidents", () => {
  const sys1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sys2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const first = fortigate("member-1", 1, { event_tags: [...escalation, { tag: "__zbx_servicenow_sys_id", value: sys1 }] });
  const second = fortigate("member-2", 2, { event_tags: [...escalation, { tag: "__zbx_servicenow_sys_id", value: sys2 }] });
  const links = composeCircuitLevelLinks({
    inventoryRows: [inventory("fortigate-1")],
    alertRows: [first, second],
    incidents: [{ sys_id: sys1, number: "INC0001" }, { sys_id: sys2, number: "INC0002" }],
  });
  assert.equal(links.length, 2);
  const member1 = links.find((link) => link.member_key === "1");
  const member2 = links.find((link) => link.member_key === "2");
  assert.deepEqual(member1.alert_ids, [first.id]);
  assert.deepEqual(member2.alert_ids, [second.id]);
  assert.deepEqual(member1.incidents.map((item) => item.number), ["INC0001"]);
  assert.deepEqual(member2.incidents.map((item) => item.number), ["INC0002"]);
  assert.equal(links.some((link) => link.strategy === "inventory_host"), false);
});

test("legacy inventory without operator circuit remains host-level", () => {
  const legacyAlert = baseAlert({
    id: "legacy-alert",
    source_host_id: "host-legacy",
    source_trigger_id: "legacy-trigger",
    event_tags: [],
  });
  const links = composeCircuitLevelLinks({ inventoryRows: [inventory()], alertRows: [legacyAlert] });
  assert.equal(links.length, 1);
  assert.equal(links[0].strategy, "inventory_host");
  assert.equal(links[0].active_alerts, 1);
});

test("BFF reads inventory plus PostgreSQL operator evidence without persistence", async () => {
  const queries = [];
  const operatorAlert = meraki("wan2", "226 - Tramandaí", "wan2");
  const pool = {
    async query(input) {
      const sql = typeof input === "string" ? input : input.text;
      queries.push(sql);
      if (/from zabbix_link_inventory l join data_sources/.test(sql)) return { rows: [inventory("havan-aggregator")] };
      if (/from alerts a join data_sources/.test(sql)) return { rows: [operatorAlert] };
      throw new Error("unexpected query");
    },
  };
  const links = await fetchCanonicalLinks({ pool });
  assert.equal(links.length, 1);
  assert.equal(links[0].strategy, "meraki");
  assert.equal(queries.length, 2);
  assert.match(queries[1], /source_trigger_id/);
  assert.match(queries[1], /zabbix_link_inventory/);
  assert.match(queries[1], /payload_normalized->'template_tags'/);
});

test("keys and metrics are deterministic, unique and finite", () => {
  const records = [fortigate("same", 37), fortigate("same", 37), meraki("wan", "143 - Marília", "wan1")];
  const first = discoverOperatorCircuits(records);
  const second = discoverOperatorCircuits([...records].reverse());
  assert.deepEqual(first.map((item) => item.circuit_key).sort(), second.map((item) => item.circuit_key).sort());
  assert.equal(new Set(first.map((item) => item.circuit_key)).size, first.length);
  const rows = composeCircuitLevelLinks({ alertRows: records });
  const filters = { customer:null,datasource:null,classification:null,state:null,ack:null,severity:null,incident:null,carrier:null,search:null,page:1,page_size:100 };
  const payload = buildLinksPayload(rows, filters, 0);
  assert.equal(payload.totals.links, 2);
  assert.equal(payload.totals.pending_classification, 0);
  assert.equal(Object.values(payload.totals).every(Number.isFinite), true);
});

test("database failure returns an error contract without zero-valued totals", async () => {
  const response = {
    statusCode: 0,
    body: null,
    setHeader() { return this; },
    status(value) { this.statusCode = value; return this; },
    end(value) { this.body = JSON.parse(value); },
  };
  const handler = createLinksHandler({ authorize: async () => true, list: async () => { throw new Error("offline"); } });
  await handler({ method: "GET", query: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "database_unavailable");
  assert.equal("totals" in response.body, false);
});
