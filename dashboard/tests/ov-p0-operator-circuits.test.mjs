import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExclusiveOperatorCircuitOwnership,
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

test("Havan trigger 132532 has only the resolved Rondonopolis wan2 owner", () => {
  const current = meraki("132532", "059 - Rondonopolis", "wan2");
  const historicalWithoutItem = baseAlert({
    id: "historical-132532",
    source_host_id: "havan-aggregator",
    source_trigger_id: "132532",
    host_name: "HAVAN",
    customer_key: "havan",
    customer_name: "Havan",
    trigger_description: "Operator uplink history without stable identity",
  });
  const circuits = discoverOperatorCircuits([historicalWithoutItem, current]);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].strategy, "meraki");
  assert.equal(circuits[0].uplink_key, "wan2");
  assert.match(circuits[0].circuit_key, /059-rondonopolis:wan2$/);
  assert.deepEqual(circuits[0].trigger_ids, ["132532"]);
  assert.deepEqual(circuits[0].alert_ids, ["alert-132532", "historical-132532"]);
});

test("same-authority circuit identities for one trigger become one ambiguous owner", () => {
  const circuits = discoverOperatorCircuits([
    meraki("conflicting-uplink", "059 - Rondonopolis", "wan1"),
    { ...meraki("conflicting-uplink", "059 - Rondonopolis", "wan2"), id: "alert-conflicting-uplink-2" },
  ]);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].resolution_status, "ambiguous");
  assert.equal(circuits[0].uplink_key, null);
  assert.deepEqual(circuits[0].trigger_ids, ["conflicting-uplink"]);
  assert.equal(circuits[0].candidate_keys.length, 2);
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

test("Sanepar explicit public-internet item wins over historical LTE problem text", () => {
  const records = [
    sanepar("869223", "sdwan.tunel.classe[10.0.41.13,public-internet]", [{ tag: "site", value: "41013" }], {
      id: "current-869223",
      problem_name: "PUBLIC-INTERNET unavailable",
    }),
    sanepar("869223", "sdwan.tunel.classe[10.0.41.13,public-internet]", [{ tag: "site", value: "41013" }], {
      id: "historical-869223",
      problem_name: "Historical LTE wording",
    }),
  ];
  const circuits = discoverOperatorCircuits(records);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].resolution_status, "resolved");
  assert.equal(circuits[0].link_type, "public-internet");
  assert.match(circuits[0].circuit_key, /site-41013:public-internet:10\.0\.41\.13$/);
  assert.deepEqual(circuits[0].trigger_ids, ["869223"]);
});

test("Sanepar auxiliary with two exact circuit candidates remains ambiguous", () => {
  const circuits = discoverOperatorCircuits([
    sanepar("lte", "sdwan.tunel.classe[10.0.41.13,lte]", [{ tag: "site", value: "41013" }]),
    sanepar("public", "sdwan.tunel.classe[10.0.41.13,public-internet]", [{ tag: "site", value: "41013" }]),
    sanepar("reach", "sdwan.reachability[10.0.41.13]", [{ tag: "site", value: "41013" }]),
  ]);
  assert.equal(circuits.length, 3);
  const auxiliary = circuits.find((circuit) => circuit.trigger_ids.includes("reach"));
  assert.equal(auxiliary.resolution_status, "ambiguous");
  assert.equal(auxiliary.link_type, null);
  assert.equal(auxiliary.unresolved_reason, "sanepar_auxiliary_ambiguous_match");
  assert.equal(circuits.filter((circuit) => circuit.trigger_ids.includes("reach")).length, 1);
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

test("Protege technical item evidence owns conflicting historical problem text", () => {
  const technical = fortigate("campinas", 2, {
    id: "campinas-current",
    item_key: "fgVWLHealthCheckLinkState[24]",
    item_name: "Health Check State to PING_AZ_Telecom on SD-WAN member 2 - 1100",
    trigger_description: "Health Check State to PING_AZ_Telecom",
    problem_name: "Health Check State Failed to PING_TEAMS on member 20 - 1200",
  });
  const historical = { ...technical, id: "campinas-history" };
  const circuits = discoverOperatorCircuits([historical, technical]);
  assert.equal(circuits.length, 1);
  assert.equal(circuits[0].resolution_status, "resolved");
  assert.equal(circuits[0].member_key, "2");
  assert.match(circuits[0].circuit_key, /ping-az-telecom:member-2$/);
  assert.doesNotMatch(circuits[0].circuit_key, /member-20/);
  assert.equal(circuits[0].evidence_conflicts.length > 0, true);
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

test("same datasource and trigger id on different hosts do not share alerts", () => {
  const first = fortigate("same-trigger", 1, { id: "host-a-alert", source_host_id: "host-a" });
  const second = fortigate("same-trigger", 2, { id: "host-b-alert", source_host_id: "host-b" });
  const links = composeCircuitLevelLinks({ alertRows: [first, second] });
  assert.equal(links.length, 2);
  assert.deepEqual(links.find((link) => link.source_host_id === "host-a").alert_ids, ["host-a-alert"]);
  assert.deepEqual(links.find((link) => link.source_host_id === "host-b").alert_ids, ["host-b-alert"]);
});

test("final circuit model enforces exclusive trigger and alert ownership", () => {
  const alerts = [
    fortigate("loss-37", 37),
    fortigate("state-37", 37, { item_key: "fgVWLHealthCheckLinkState[16]" }),
    meraki("132532", "059 - Rondonopolis", "wan2"),
    sanepar("869223", "sdwan.tunel.classe[10.0.41.13,public-internet]", [{ tag: "site", value: "41013" }]),
  ];
  const circuits = discoverOperatorCircuits(alerts);
  const ownership = assertExclusiveOperatorCircuitOwnership(circuits);
  assert.equal(ownership.triggerOwner.size, 4);
  assert.equal(ownership.alertOwner.size, 4);
  const links = composeCircuitLevelLinks({ alertRows: alerts });
  const alertOwners = new Map();
  for (const link of links.filter((item) => item.circuit_key)) {
    for (const alertId of link.alert_ids) {
      assert.equal(alertOwners.has(alertId), false, `duplicate alert owner: ${alertId}`);
      alertOwners.set(alertId, link.circuit_key);
    }
  }
});

test("ownership validation fails loudly on a second trigger owner", () => {
  assert.throws(
    () => assertExclusiveOperatorCircuitOwnership([
      { circuit_key: "circuit-a", data_source_id: "ds", source_host_id: "host", trigger_ids: ["trigger"], alert_ids: ["alert-a"] },
      { circuit_key: "circuit-b", data_source_id: "ds", source_host_id: "host", trigger_ids: ["trigger"], alert_ids: ["alert-b"] },
    ]),
    (error) => error.code === "operator_trigger_owner_conflict",
  );
});

test("same incident may be referenced by distinct exclusive alerts without trigger contamination", () => {
  const sysId = "cccccccccccccccccccccccccccccccc";
  const first = fortigate("member-1", 1, { id: "member-1-alert", event_tags: [...escalation, { tag: "__zbx_servicenow_sys_id", value: sysId }] });
  const second = fortigate("member-2", 2, { id: "member-2-alert", event_tags: [...escalation, { tag: "__zbx_servicenow_sys_id", value: sysId }] });
  const links = composeCircuitLevelLinks({
    alertRows: [first, second],
    incidents: [{ sys_id: sysId, number: "INC-SHARED" }],
  });
  assert.equal(links.length, 2);
  assert.deepEqual(new Set(links.flatMap((link) => link.alert_ids)), new Set(["member-1-alert", "member-2-alert"]));
  assert.equal(links.every((link) => link.incidents[0].number === "INC-SHARED"), true);
});

test("ambiguous circuits remain counted as pending classification", () => {
  const alerts = [
    sanepar("lte", "sdwan.tunel.classe[10.0.41.13,lte]", [{ tag: "site", value: "41013" }]),
    sanepar("public", "sdwan.tunel.classe[10.0.41.13,public-internet]", [{ tag: "site", value: "41013" }]),
    sanepar("reach", "sdwan.reachability[10.0.41.13]", [{ tag: "site", value: "41013" }]),
  ];
  const rows = composeCircuitLevelLinks({ alertRows: alerts });
  const filters = { customer:null,datasource:null,classification:null,state:null,ack:null,severity:null,incident:null,carrier:null,search:null,tab:"all",resolved_window:"today",divergence:null,sort:"recent",page:1,page_size:100 };
  const payload = buildLinksPayload(rows, filters, 0);
  assert.equal(payload.totals.pending_classification, 1);
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

function genericOperatorAlert(overrides = {}) {
  return baseAlert({
    problem_name: "Unavailable by ICMP ping",
    trigger_description: "ICMP ping unavailable",
    item_key: "icmpping",
    ...overrides,
  });
}

test("Castrolanda inventory host plus equivalent alert_subject collapses to one circuit-level row", () => {
  const host = "CASTRO_CD_UBS_Mottanet";
  const alert = genericOperatorAlert({
    id: "castrolanda-icmp",
    source_host_id: host,
    source_trigger_id: "icmp-trigger",
    host_name: host,
    customer_key: "castrolanda",
    customer_name: "Castrolanda",
  });
  const links = composeCircuitLevelLinks({
    inventoryRows: [{
      ...inventory(host),
      customer_key: "castrolanda",
      customer_name: "Castrolanda",
      service_name: host,
    }],
    alertRows: [alert],
  });
  assert.equal(links.length, 1);
  assert.notEqual(links[0].strategy, "inventory_host");
  assert.equal(links[0].resolution_status, "unresolved");
  assert.doesNotMatch(links[0].service_name, /Circuito pendente de classificação/i);
  assert.match(links[0].service_name, /ICMP|Unavailable/i);
  assert.deepEqual(links[0].alert_ids, ["castrolanda-icmp"]);
  assert.deepEqual(links[0].trigger_ids, ["icmp-trigger"]);
});

test("Tuper inventory plus equivalent unresolved fallback collapses to one row", () => {
  const host = "TUPER-MATRIZ-RTR";
  const alert = genericOperatorAlert({
    id: "tuper-icmp",
    source_host_id: host,
    source_trigger_id: "tuper-trigger",
    host_name: host,
    customer_key: "tuper",
    customer_name: "Tuper",
    problem_name: "Interface down",
  });
  const links = composeCircuitLevelLinks({
    inventoryRows: [{ ...inventory(host), customer_key: "tuper", customer_name: "Tuper", service_name: host }],
    alertRows: [alert],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].customer_name, "Tuper");
  assert.notEqual(links[0].strategy, "inventory_host");
  assert.doesNotMatch(links[0].service_name, /Circuito pendente de classificação/i);
});

test("alert_subject without a resolved circuit remains one functional row", () => {
  const alert = genericOperatorAlert({
    id: "orphan-icmp",
    source_trigger_id: "orphan-trigger",
    problem_name: "ICMP ping unavailable",
  });
  const links = composeCircuitLevelLinks({ alertRows: [alert] });
  assert.equal(links.length, 1);
  assert.equal(links[0].resolution_status, "unresolved");
  assert.equal(links[0].circuit_key != null, true);
  assert.deepEqual(links[0].alert_ids, ["orphan-icmp"]);
  assert.doesNotMatch(links[0].service_name, /Circuito pendente de classificação/i);
});

test("host with two really different triggers keeps two rows", () => {
  const links = composeCircuitLevelLinks({
    alertRows: [
      genericOperatorAlert({ id: "cpu", source_trigger_id: "cpu-trigger", problem_name: "CPU high" }),
      genericOperatorAlert({ id: "disk", source_trigger_id: "disk-trigger", problem_name: "Disk full" }),
    ],
  });
  assert.equal(links.length, 2);
  assert.deepEqual(new Set(links.map((link) => link.trigger_ids.join(","))), new Set(["cpu-trigger", "disk-trigger"]));
});

test("canonical circuit appearing after fallback absorbs the equivalent alert_subject", async () => {
  const host = "CASTRO_CD_UBS_Mottanet";
  const fallback = {
    circuit_key: "operator:v1:generic-unresolved:ds-1:castro:icmp-trigger",
    resolution_status: "unresolved",
    data_source_id: "ds-1",
    datasource: "castrolanda",
    source_host_id: host,
    host_name: host,
    customer_name: "Castrolanda",
    customer_key: "castrolanda",
    service_name: "Circuito pendente de classificação",
    trigger_ids: ["icmp-trigger"],
    alert_ids: ["fallback-alert"],
    strategy: "generic",
  };
  const canonical = {
    ...fallback,
    circuit_key: "operator:v1:generic:ds-1:castro:mpls:mottanet",
    resolution_status: "resolved",
    service_name: "Link MPLS · Mottanet",
    strategy: "generic",
    alert_ids: ["canonical-alert"],
  };
  const fallbackAlert = genericOperatorAlert({
    id: "fallback-alert",
    source_host_id: host,
    source_trigger_id: "icmp-trigger",
    host_name: host,
    customer_name: "Castrolanda",
    customer_key: "castrolanda",
    last_seen_at: "2026-09-14T12:00:00.000Z",
    first_seen_at: "2026-09-14T08:00:00.000Z",
  });
  const canonicalAlert = genericOperatorAlert({
    id: "canonical-alert",
    source_host_id: host,
    source_trigger_id: "icmp-trigger",
    host_name: host,
    customer_name: "Castrolanda",
    customer_key: "castrolanda",
    item_key: "link mpls circuito: MOTTANET",
    trigger_description: "Link MPLS circuito: MOTTANET",
    last_seen_at: "2026-09-14T11:00:00.000Z",
  });
  const links = composeCircuitLevelLinks({
    inventoryRows: [{ ...inventory(host), customer_name: "Castrolanda", service_name: host }],
    alertRows: [fallbackAlert, canonicalAlert],
    circuits: [canonical, fallback],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].resolution_status, "resolved");
  assert.equal(links[0].circuit_key, canonical.circuit_key);
  assert.ok(links[0].alert_ids.includes("fallback-alert"));
  assert.ok(links[0].alert_ids.includes("canonical-alert"));
  assert.equal(links[0].latest_alert?.id, "fallback-alert");
  assert.equal(links[0].latest_alert?.last_seen_at, "2026-09-14T12:00:00.000Z");
  const { buildOperationalSubject, equivalentOperationalSubjects } = await import("../api/_lib/oneview-operational-subject.js");
  const subject = buildOperationalSubject(links[0]);
  assert.equal(subject.subject_type, "circuit");
  assert.ok(equivalentOperationalSubjects(subject).some((item) => item.subject_key === `alert:${host}:icmp-trigger`));
});

test("equivalent fallback INC is kept on the canonical circuit", () => {
  const host = "CASTRO_CD_UBS_Mottanet";
  const sysId = "dddddddddddddddddddddddddddddddd";
  const fallback = genericOperatorAlert({
    id: "fallback-with-inc",
    source_host_id: host,
    source_trigger_id: "icmp-trigger",
    host_name: host,
    customer_name: "Castrolanda",
    customer_key: "castrolanda",
    last_seen_at: "2026-09-14T16:00:00.000Z",
    event_tags: [...escalation, { tag: "__zbx_servicenow_sys_id", value: sysId }, { tag: "__zbx_servicenow_number", value: "INC0099991" }],
  });
  const canonical = genericOperatorAlert({
    id: "canonical-older",
    source_host_id: host,
    source_trigger_id: "icmp-trigger",
    host_name: host,
    customer_name: "Castrolanda",
    customer_key: "castrolanda",
    item_key: "link mpls circuito: MOTTANET",
    trigger_description: "Link MPLS circuito: MOTTANET",
    last_seen_at: "2026-09-14T10:00:00.000Z",
    severity: "high",
  });
  const links = composeCircuitLevelLinks({
    inventoryRows: [{ ...inventory(host), customer_name: "Castrolanda", service_name: host }],
    alertRows: [fallback, canonical],
    incidents: [{ sys_id: sysId, number: "INC0099991", state: "2" }],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].resolution_status, "resolved");
  assert.equal(links[0].circuit_key && links[0].resolution_status === "resolved", true);
  assert.deepEqual(links[0].incidents.map((item) => item.number), ["INC0099991"]);
  assert.equal(links[0].latest_alert?.id, "fallback-with-inc");
  assert.equal(links[0].max_severity, "high");
});

test("same host with two Meraki uplinks does not collapse into one row", () => {
  const links = composeCircuitLevelLinks({
    inventoryRows: [inventory("havan-aggregator")],
    alertRows: [
      meraki("wan1", "226 - Tramandaí", "wan1"),
      meraki("wan2", "226 - Tramandaí", "wan2"),
    ],
  });
  assert.equal(links.length, 2);
  assert.deepEqual(new Set(links.map((link) => link.uplink_key)), new Set(["wan1", "wan2"]));
  assert.equal(links.some((link) => link.strategy === "inventory_host"), false);
});

test("reminder fallback aliases survive on the resulting canonical circuit", async () => {
  const { buildOperationalSubject, equivalentOperationalSubjects } = await import("../api/_lib/oneview-operational-subject.js");
  const alert = meraki("wan2", "226 - Tramandaí", "wan2");
  const [link] = composeCircuitLevelLinks({
    inventoryRows: [inventory("havan-aggregator")],
    alertRows: [alert],
  });
  const subject = buildOperationalSubject(link);
  assert.equal(subject.subject_type, "circuit");
  assert.ok(equivalentOperationalSubjects(subject).some((item) => item.subject_type === "alert_subject" && item.subject_key === "alert:havan-aggregator:wan2"));
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
  assert.equal(links[0].operational_subject.subject_type, "circuit");
  assert.equal(links[0].operational_subject.subject_key, `circuit:${links[0].circuit_key}`);
  assert.equal(links[0].operational_subject.data_source_id, operatorAlert.data_source_id);
  assert.equal(queries.filter((sql) => /from alerts a join data_sources/.test(sql)).length, 2);
  assert.equal(queries.filter((sql) => /from zabbix_link_inventory l join data_sources/.test(sql)).length, 1);
  const alertsSql = queries.filter((sql) => /from alerts a join data_sources/.test(sql)).join("\n");
  assert.match(alertsSql, /source_trigger_id/);
  assert.match(alertsSql, /zabbix_link_inventory/);
  assert.match(alertsSql, /interval '7 days'/);
  assert.match(alertsSql, /__zbx_servicenow_sys_id/);
  assert.doesNotMatch(alertsSql, /payload_raw|payload_normalized/);
  assert.match(EXACT_OPERATOR_TAG_SQL, /payload_normalized->'template_tags'/);
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
  assert.equal(Object.values(payload.totals).filter((value) => typeof value === "number").every(Number.isFinite), true);
  assert.equal(Object.values(payload.totals.operational).every(Number.isFinite), true);
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
