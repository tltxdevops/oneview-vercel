import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAlertEpisodeStartedAt } from "../api/_lib/oneview-alert-incidents.js";
import {
  findReadModelRelatedIncidents,
  isIncidentCurrentForAlertEpisode,
  utcEpochMilliseconds,
} from "../api/_lib/oneview-incidents-read-model.js";

const EPISODE_START = "2026-09-24T12:00:00.000Z";
const SYS_ID = "0123456789abcdef0123456789abcdef";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function incident(overrides = {}) {
  return {
    sys_id: SYS_ID,
    number: "INC0084362",
    state: "2",
    priority: "3",
    assigned_to: null,
    assignment_group: null,
    caller_id: null,
    company: "Congás",
    contact_type: null,
    short_description: "Regressão temporal",
    description: "eventid=episode-4362",
    opened_at: "2026-09-24T12:01:00.000Z",
    resolved_at: null,
    closed_at: null,
    sys_created_on: "2026-09-24T12:01:00.000Z",
    sys_updated_on: "2026-09-24T12:02:00.000Z",
    correlation_id: "episode-4362",
    u_hostname_zabbix: "maps-host-1",
    u_ip_zabbix: null,
    display_values: {},
    identity_conflict: false,
    ...overrides,
  };
}

function poolWith(rows) {
  return { query: async () => ({ rows }) };
}

test("A/B: incidente aberto no episódio ou aberto antes e ainda ativo permanece elegível", () => {
  assert.equal(isIncidentCurrentForAlertEpisode(incident(), EPISODE_START), true);
  assert.equal(isIncidentCurrentForAlertEpisode(incident({ opened_at: "2026-09-23T00:00:00.000Z" }), EPISODE_START), true);
});

test("C/D/F: INC0084362 terminal antes do novo episódio não é reutilizado", () => {
  const closedBefore = incident({
    state: "7",
    resolved_at: "2026-09-23T20:00:00.000Z",
    closed_at: "2026-09-23T21:00:00.000Z",
  });
  const resolvedFifteenHoursBefore = incident({
    state: "6",
    resolved_at: "2026-09-23T21:00:00.000Z",
  });
  const oldTerminalWithoutExplicitReopen = incident({
    state: "7",
    opened_at: "2026-09-23T08:00:00.000Z",
    closed_at: "2026-09-24T12:02:00.000Z",
  });
  assert.equal(isIncidentCurrentForAlertEpisode(closedBefore, EPISODE_START), false);
  assert.equal(isIncidentCurrentForAlertEpisode(resolvedFifteenHoursBefore, EPISODE_START), false);
  assert.equal(isIncidentCurrentForAlertEpisode(oldTerminalWithoutExplicitReopen, EPISODE_START), false);
});

test("E: comparação UTC e America/Sao_Paulo representa o mesmo instante", () => {
  const utc = "2026-09-24T12:00:00.000Z";
  const saoPaulo = "2026-09-24T09:00:00.000-03:00";
  assert.equal(utcEpochMilliseconds(utc), utcEpochMilliseconds(saoPaulo));
  assert.equal(parseAlertEpisodeStartedAt({ query: { alert_episode_started_at: saoPaulo } }), utc);
  assert.equal(isIncidentCurrentForAlertEpisode(incident({ state: "7", closed_at: "2026-09-24T12:02:00.000Z" }), saoPaulo), true);
  assert.throws(() => parseAlertEpisodeStartedAt({ query: { alert_episode_started_at: "2026-09-24T09:00:00" } }));
});

test("G: referência explícita válida continua relacionando incidente ativo", async () => {
  const result = await findReadModelRelatedIncidents({
    incidentSysIds: [SYS_ID],
    alertEpisodeStartedAt: EPISODE_START,
  }, { pool: poolWith([incident()]) });
  assert.equal(result.matched, true);
  assert.equal(result.relation_source, "zabbix_servicenow_sys_id");
  assert.equal(result.incidents[0].number, "INC0084362");
});

test("F: episódio recorrente não herda correlation_id de INC0084362 terminal", async () => {
  const result = await findReadModelRelatedIncidents({
    sourceEventId: "episode-4362",
    alertEpisodeStartedAt: EPISODE_START,
  }, { pool: poolWith([incident({ state: "6", resolved_at: "2026-09-23T21:00:00.000Z" })]) });
  assert.deepEqual(result, { matched: false, relation_source: "none", incidents: [] });
});

test("H: MAPS e Congás passam pela mesma guarda terminal", async () => {
  const terminal = incident({ state: "8", closed_at: "2026-09-23T20:00:00.000Z" });
  const maps = await findReadModelRelatedIncidents({
    mapsDatasource: "maps",
    mapsHost: "maps-host-1",
    mapsProblemName: "Regressão temporal",
    alertEpisodeStartedAt: EPISODE_START,
  }, { pool: poolWith([terminal]) });
  const congas = await findReadModelRelatedIncidents({
    sourceEventId: "episode-4362",
    alertEpisodeStartedAt: EPISODE_START,
  }, { pool: poolWith([terminal]) });
  assert.equal(maps.matched, false);
  assert.equal(congas.matched, false);
});

test("cache: correlação usa request abortável, sem cache e identifica resposta anterior", async () => {
  const [api, section] = await Promise.all([
    fs.readFile(path.join(root, "src/lib/oneview-api.ts"), "utf8"),
    fs.readFile(path.join(root, "src/components/oneview/AlertRelatedIncidentsSection.tsx"), "utf8"),
  ]);
  assert.match(api, /oneViewFresh/);
  assert.match(api, /isRead && !oneViewFresh \? readCache\.get/);
  assert.match(api, /oneViewFresh: true/);
  assert.match(section, /const controller = new AbortController\(\)/);
  assert.match(section, /controller\.signal/);
  assert.match(section, /Dados de correlação desatualizados/);
});
