import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findReadModelRelatedIncidents } from "../api/_lib/oneview-incidents-read-model.js";
import { extractServiceNowIncidentNumbersForAlertEpisode } from "../src/lib/oneview-inc-correlation.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYS_ID = "3482e8e197e7cf1030f7f796f053af48";

function incident(overrides = {}) {
  return {
    sys_id: SYS_ID,
    number: "INC0088323",
    state: "2",
    priority: "3",
    assigned_to: null,
    assignment_group: null,
    caller_id: null,
    company: "MAPS",
    contact_type: null,
    short_description: "Módulo INDISPONÍVEL",
    description: "eventid=2544274",
    opened_at: "2026-10-14T23:26:00.000Z",
    resolved_at: null,
    closed_at: null,
    sys_created_on: "2026-10-14T23:26:00.000Z",
    sys_updated_on: "2026-10-14T23:27:00.000Z",
    correlation_id: "2544274",
    u_hostname_zabbix: "mapssro-consumidor.ecs.acceptance.sro.mapsregistradora.intranet",
    u_ip_zabbix: null,
    display_values: {},
    identity_conflict: false,
    ...overrides,
  };
}

function poolWith(rows) {
  return { query: async () => ({ rows }) };
}

test("A: mesmo source_event_id encontra o INC correto", async () => {
  const result = await findReadModelRelatedIncidents({
    sourceEventId: "2544274",
    alertEpisodeStartedAt: "2026-10-14T23:25:41.000Z",
  }, { pool: poolWith([incident()]) });
  assert.equal(result.matched, true);
  assert.equal(result.relation_source, "zabbix_event_id");
  assert.equal(result.incidents[0].number, "INC0088323");
});

test("B/C: mesmo problema em outro host ou ambiente não cria correlação", async () => {
  let queried = false;
  const result = await findReadModelRelatedIncidents({
    mapsDatasource: "maps",
    mapsHost: "mapssro-operacional.ecs.production.sro.mapsregistradora.intranet",
    mapsProblemName: "Módulo INDISPONÍVEL",
    alertEpisodeStartedAt: "2026-10-14T23:25:41.000Z",
  }, { pool: { query: async () => { queried = true; return { rows: [incident()] }; } } });
  assert.equal(queried, false);
  assert.deepEqual(result, { matched: false, relation_source: "none", incidents: [] });
});

test("D/E: INC terminal fica no episódio antigo e não migra para episódio novo", async () => {
  const old = incident({
    state: "7",
    opened_at: "2026-09-25T07:13:43.000Z",
    resolved_at: "2026-09-27T07:39:49.000Z",
    closed_at: "2026-10-02T22:04:09.000Z",
  });
  const oldEpisode = await findReadModelRelatedIncidents({
    incidentSysIds: [SYS_ID],
    alertEpisodeStartedAt: "2026-09-25T06:00:00.000Z",
  }, { pool: poolWith([old]) });
  const newEpisode = await findReadModelRelatedIncidents({
    incidentSysIds: [SYS_ID],
    alertEpisodeStartedAt: "2026-10-14T23:25:41.000Z",
  }, { pool: poolWith([old]) });
  assert.equal(oldEpisode.matched, true);
  assert.equal(oldEpisode.relation_source, "zabbix_servicenow_sys_id");
  assert.equal(newEpisode.matched, false);
});

test("E: referência histórica exige mesmo evento e janela do episódio", () => {
  const items = [
    { source_event_id: "old", occurred_at: "2026-09-25T08:00:00.000Z", message: "INC0088323" },
    { source_event_id: "2544274", occurred_at: "2026-10-14T22:00:00.000Z", message: "INC0088323" },
    { source_event_id: "2544274", occurred_at: "2026-10-14T23:30:00.000Z", message: "INC0099999" },
  ];
  assert.deepEqual(extractServiceNowIncidentNumbersForAlertEpisode(items, {
    sourceEventId: "2544274",
    episodeStartedAt: "2026-10-14T23:25:41.000Z",
  }), ["INC0099999"]);
  assert.deepEqual(extractServiceNowIncidentNumbersForAlertEpisode(items, {
    sourceEventId: "old",
    episodeStartedAt: "2026-09-25T07:00:00.000Z",
  }), ["INC0088323"]);
});

test("F: lista, drawer e Chamados usam somente evidência explícita", async () => {
  const [db, readModel, alertRoute, alertSection, incidentSection] = await Promise.all([
    readFile(path.join(root, "api/_lib/oneview-db.js"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-incidents-read-model.js"), "utf8"),
    readFile(path.join(root, "api/_lib/oneview-alert-incidents.js"), "utf8"),
    readFile(path.join(root, "src/components/oneview/AlertRelatedIncidentsSection.tsx"), "utf8"),
    readFile(path.join(root, "src/components/oneview/IncidentRelatedAlertSection.tsx"), "utf8"),
  ]);

  assert.doesNotMatch(db, /enrichMapsServiceNowReferences|findAlertByOperationalDatasourceHost/);
  assert.doesNotMatch(readModel, /operational_host|zabbix_host|bridge_datasource/);
  assert.doesNotMatch(alertRoute, /maps_host|maps_problem|maps_datasource/);
  assert.doesNotMatch(alertSection, /operational_host|mapsHost|mapsProblem/);
  assert.match(db, /findAlertByExplicitServiceNowReference/);
  assert.match(db, /findAlertBySourceEventId/);
  assert.match(incidentSection, /Alerta relacionado indisponível/);
  assert.match(incidentSection, /Não foi possível verificar a correlação/);
});
