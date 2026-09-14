import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attachOperationalRecurrence,
  buildOperationalRecurrenceReadModel,
} from "../api/_lib/oneview-operational-recurrence.js";
import { composeCircuitLevelLinks, parseLinkFilters, buildLinksPayload } from "../api/_lib/oneview-links.js";

const NOW = new Date("2026-09-14T18:00:00.000Z");
const escalation = [{ tag: "escalation", value: "operator" }];

function alert(partial) {
  return {
    id: "a1",
    data_source_id: "ds-1",
    datasource: "teletex-http",
    source_host_id: "host-1",
    source_trigger_id: "trig-1",
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
    is_active: !partial.resolved_at,
    first_seen_at: "2026-09-14T17:00:00.000Z",
    last_seen_at: "2026-09-14T17:30:00.000Z",
    ...partial,
  };
}

test("A: a single current DOWN is one occurrence and not recurrent", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [alert({ id: "down-now", resolved_at: null })],
    now: NOW,
  });
  assert.equal(model.occurrences_24h, 1);
  assert.equal(model.is_recurrent, false);
  assert.equal(model.last_failure_at, "2026-09-14T17:00:00.000Z");
  assert.equal(model.last_recovery_at, null);
});

test("B: DOWN then recovery then DOWN counts two occurrences in 24h", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [
      alert({ id: "first", first_seen_at: "2026-09-14T08:00:00.000Z", resolved_at: "2026-09-14T09:00:00.000Z" }),
      alert({ id: "second", first_seen_at: "2026-09-14T10:00:00.000Z", resolved_at: null }),
    ],
    now: NOW,
  });
  assert.equal(model.occurrences_24h, 2);
  assert.equal(model.is_recurrent, true);
  assert.equal(model.last_failure_at, "2026-09-14T10:00:00.000Z");
  assert.equal(model.last_recovery_at, "2026-09-14T09:00:00.000Z");
});

test("C: updates of the same unresolved event stay one occurrence", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [
      alert({ id: "same", first_seen_at: "2026-09-14T08:00:00.000Z", last_seen_at: "2026-09-14T09:00:00.000Z", resolved_at: null }),
      alert({ id: "same-refresh", first_seen_at: "2026-09-14T08:05:00.000Z", last_seen_at: "2026-09-14T17:00:00.000Z", resolved_at: null }),
    ],
    now: NOW,
  });
  assert.equal(model.occurrences_24h, 1);
  assert.equal(model.last_failure_at, "2026-09-14T08:00:00.000Z");
});

test("D: same host with different triggers keeps separate counts", () => {
  const cpu = [alert({ id: "cpu-1", source_trigger_id: "cpu", first_seen_at: "2026-09-14T10:00:00.000Z", resolved_at: null })];
  const disk = [
    alert({ id: "disk-1", source_trigger_id: "disk", first_seen_at: "2026-09-14T08:00:00.000Z", resolved_at: "2026-09-14T09:00:00.000Z" }),
    alert({ id: "disk-2", source_trigger_id: "disk", first_seen_at: "2026-09-14T11:00:00.000Z", resolved_at: null }),
  ];
  assert.equal(buildOperationalRecurrenceReadModel({ alerts: cpu, now: NOW }).occurrences_24h, 1);
  assert.equal(buildOperationalRecurrenceReadModel({ alerts: disk, now: NOW }).occurrences_24h, 2);
});

test("E: distinct members remain separate after composition", () => {
  const member = (trigger, n) => alert({
    id: `m-${n}`,
    source_host_id: "fortigate-1",
    source_trigger_id: trigger,
    host_name: "PROTEGE-FW",
    customer_key: "protege",
    customer_name: "Protege",
    item_key: `fgVWLHealthCheckLinkPacketLoss[PING_INTERNET.${n}]`,
    trigger_description: `Health Check State to PING_INTERNET on SD-WAN member ${n} - 1010`,
    first_seen_at: "2026-09-14T10:00:00.000Z",
    resolved_at: null,
  });
  const alerts = [member("t1", 1), member("t2", 2)];
  const rows = composeCircuitLevelLinks({ alertRows: alerts });
  attachOperationalRecurrence(rows, alerts, NOW);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.occurrences_24h === 1 && row.is_recurrent === false), true);
});

test("F: canonical circuit reuses fallback trigger history without duplicating", () => {
  const historical = alert({
    id: "fallback-old",
    first_seen_at: "2026-09-14T08:00:00.000Z",
    resolved_at: "2026-09-14T09:00:00.000Z",
    item_key: "icmpping",
  });
  const canonical = alert({
    id: "canonical-now",
    first_seen_at: "2026-09-14T10:00:00.000Z",
    resolved_at: null,
    item_key: "link mpls circuito: MOTTANET",
    trigger_description: "Link MPLS circuito: MOTTANET",
  });
  const rows = composeCircuitLevelLinks({ alertRows: [historical, canonical] });
  attachOperationalRecurrence(rows, [historical, canonical], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrences_24h, 2);
  assert.equal(rows[0].is_recurrent, true);
});

test("G: a failure older than 24h expires from the 24h window", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [
      alert({ id: "old", first_seen_at: "2026-09-13T16:00:00.000Z", resolved_at: "2026-09-13T17:00:00.000Z" }),
      alert({ id: "now", first_seen_at: "2026-09-14T17:00:00.000Z", resolved_at: null }),
    ],
    now: NOW,
  });
  assert.equal(model.occurrences_24h, 1);
  assert.equal(model.is_recurrent, false);
  assert.equal(model.occurrences_7d, 2);
});

test("H: 7d keeps the larger history that 24h drops", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [
      alert({ id: "mid", first_seen_at: "2026-09-11T12:00:00.000Z", resolved_at: "2026-09-11T13:00:00.000Z" }),
      alert({ id: "now", first_seen_at: "2026-09-14T17:00:00.000Z", resolved_at: null }),
    ],
    now: NOW,
  });
  assert.equal(model.occurrences_24h, 1);
  assert.equal(model.occurrences_7d, 2);
});

test("I/J: last_recovery_at and last_failure_at follow the latest episode", () => {
  const model = buildOperationalRecurrenceReadModel({
    alerts: [
      alert({ id: "a", first_seen_at: "2026-09-14T08:00:00.000Z", resolved_at: "2026-09-14T08:30:00.000Z" }),
      alert({ id: "b", first_seen_at: "2026-09-14T09:00:00.000Z", resolved_at: "2026-09-14T09:20:00.000Z" }),
      alert({ id: "c", first_seen_at: "2026-09-14T10:15:00.000Z", resolved_at: null }),
    ],
    now: NOW,
    recentLimit: 5,
  });
  assert.equal(model.last_recovery_at, "2026-09-14T09:20:00.000Z");
  assert.equal(model.last_failure_at, "2026-09-14T10:15:00.000Z");
  assert.equal(model.recent_occurrences.length, 3);
  assert.equal(model.recent_occurrences[0].started_at, "2026-09-14T10:15:00.000Z");
});

test("recurrent filter keeps only 24h >= 2", () => {
  const filters = parseLinkFilters({ query: { tab: "all", recurrence: "recurrent", page_size: "100" } });
  const payload = buildLinksPayload([
    { id: "once", customer_name: "A", customer_key: "a", datasource: "ds", source_host_id: "h", service_name: "once", classification: "uplink", resolution_status: "resolved", active_alerts: 1, state: "alert", is_recurrent: false, occurrences_24h: 1, alerts: [], incidents: [], incident_count: 0, incident_correlation_status: "available" },
    { id: "again", customer_name: "B", customer_key: "b", datasource: "ds", source_host_id: "h2", service_name: "again", classification: "uplink", resolution_status: "resolved", active_alerts: 1, state: "alert", is_recurrent: true, occurrences_24h: 3, alerts: [], incidents: [], incident_count: 0, incident_correlation_status: "available" },
  ], filters, Date.parse(NOW.toISOString()));
  assert.deepEqual(payload.items.map((item) => item.id), ["again"]);
});

test("Operadoras exposes compact recurrence badge, filter and drawer block", async () => {
  const page = await readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8");
  assert.match(page, /Recorrentes/);
  assert.match(page, /Recorrência/);
  assert.match(page, /ocorrências \/ 24h/);
  assert.match(page, /Última recuperação/);
  assert.match(page, /Última nova falha/);
  const links = await readFile(new URL("../api/_lib/oneview-links.js", import.meta.url), "utf8");
  const recurrence = await readFile(new URL("../api/_lib/oneview-operational-recurrence.js", import.meta.url), "utf8");
  assert.match(links, /attachOperationalRecurrence/);
  assert.doesNotMatch(recurrence, /getOneViewDbPool|pool\.query/);
});
