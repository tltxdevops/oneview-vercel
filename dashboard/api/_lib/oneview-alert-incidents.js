/**
 * SN-P0-16 / SN-P0-27 / OV-P0-108 — GET incidentes relacionados a um alerta.
 * Prioridade: __zbx_servicenow_sys_id → __zbx_servicenow_number → INC histórico → event_id → none.
 * Read model PostgreSQL. Sem fallback por host. Aceita múltiplos INC.
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { parseZabbixEventId } from "./oneview-incident-relation.js";
import { isServiceNowIncidentsEnabled } from "./oneview-incidents.js";
import { findReadModelRelatedIncidents } from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const SAFE_MAPS_HOST = /^[A-Za-z0-9._:-]{1,253}$/;
const SAFE_MAPS_PROBLEM = /^[\s\S]{1,240}$/;
// Correlation timestamps are instants, never browser/local-time strings.
const SAFE_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function manyQuery(req, key) {
  const value = req?.query?.[key];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sendRelatedJson(res, status, payload, dataSource = "postgresql") {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (dataSource) res.setHeader("X-OneView-Data-Source", dataSource);
  return sendJson(res, status, payload);
}

function normalizeSysId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

function extractServiceNowIncidentNumbers(values) {
  const found = new Set();
  for (const value of values || []) {
    for (const match of String(value || "").matchAll(/\bINC\d+\b/gi)) {
      found.add(match[0].toUpperCase());
    }
  }
  return [...found];
}

function toDrawerIncident(item) {
  return {
    sys_id: item.sys_id,
    number: item.number,
    state: item.state,
    state_display: item.state_display ?? null,
    priority: item.priority,
    priority_display: item.priority_display ?? null,
    assignment_group: item.assignment_group,
    assignment_group_display: item.assignment_group_display ?? null,
    assigned_to: item.assigned_to,
    assigned_to_display: item.assigned_to_display ?? null,
    identity_conflict: Boolean(item.identity_conflict),
    sys_updated_on: item.sys_updated_on,
    zabbix_event_id: item.zabbix_event_id ?? null,
    servicenow_url: item.servicenow_url ?? null,
    short_description: item.short_description ?? item.shortDescription ?? null,
    company: item.company ?? item.customer ?? null,
    company_display: item.company_display ?? null,
  };
}

/** source_event_id opcional quando há INC/sys_id explícito (SN-P0-27 / OV-P0-108). */
export function parseOptionalZabbixEventId(req) {
  const raw = oneQuery(req, "zabbix_event_id") ?? oneQuery(req, "source_event_id");
  const eventId = String(raw || "").trim();
  if (!eventId) return null;
  if (!SAFE_EVENT_ID.test(eventId)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  return eventId;
}

/** Início do episódio do alerta, normalizado para ISO-8601 UTC no BFF. */
export function parseAlertEpisodeStartedAt(req) {
  const raw = String(oneQuery(req, "alert_episode_started_at") || "").trim();
  if (!raw) return null;
  if (!SAFE_UTC_INSTANT.test(raw)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  return new Date(timestamp).toISOString();
}

/** Números INC do histórico/comentário (?inc= / ?inc_refs= / ?text=). */
export function parseIncidentCorrelationInputs(req) {
  const fromInc = extractServiceNowIncidentNumbers([
    ...manyQuery(req, "inc"),
    ...manyQuery(req, "inc_refs"),
  ]);
  const fromText = extractServiceNowIncidentNumbers(manyQuery(req, "text"));
  return extractServiceNowIncidentNumbers([...fromInc, ...fromText]);
}

/** OV-P0-108 — números de __zbx_servicenow_number (?sn_number=). */
export function parseTagIncidentNumberInputs(req) {
  return extractServiceNowIncidentNumbers(manyQuery(req, "sn_number"));
}

/** OV-P0-108 — sys_ids explícitos das tags (__zbx_servicenow_sys_id). */
/** Ponte MAPS read-only: host/problema do alerta Zabbix dedicado. */
export function parseMapsOperationalCorrelationInputs(req) {
  const mapsDatasource = String(oneQuery(req, "maps_datasource") || oneQuery(req, "datasource") || "").trim().toLowerCase();
  const mapsHost = String(oneQuery(req, "maps_host") || oneQuery(req, "host_name") || "").trim();
  const mapsProblemName = String(oneQuery(req, "maps_problem") || oneQuery(req, "problem_name") || "").trim();
  if (mapsHost && !SAFE_MAPS_HOST.test(mapsHost)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  if (mapsProblemName && !SAFE_MAPS_PROBLEM.test(mapsProblemName)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  if (!mapsHost && !mapsProblemName && !mapsDatasource) {
    return { mapsDatasource: null, mapsHost: null, mapsProblemName: null };
  }
  return {
    mapsDatasource: mapsDatasource || "maps",
    mapsHost: mapsHost || null,
    mapsProblemName: mapsProblemName || null,
  };
}

export function parseIncidentSysIdInputs(req) {
  const out = [];
  const seen = new Set();
  for (const raw of [
    ...manyQuery(req, "sys_id"),
    ...manyQuery(req, "sn_sys_id"),
  ]) {
    const id = normalizeSysId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function createRelatedIncidentsHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  lookup = findReadModelRelatedIncidents,
  lookupOptions,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function relatedIncidentsHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    if (!featureFlagProvider()) {
      return sendRelatedJson(res, 403, {
        error: "servicenow_incidents_disabled",
        matched: false,
        relation_source: "none",
        incidents: [],
        source_event_id: null,
        incident_numbers: [],
        incident_sys_ids: [],
        data_source: "postgresql",
      });
    }

    let sourceEventId = null;
    let alertEpisodeStartedAt = null;
    let incidentNumbers = [];
    let tagIncidentNumbers = [];
    let incidentSysIds = [];
    let mapsOperational = { mapsDatasource: null, mapsHost: null, mapsProblemName: null };
    try {
      sourceEventId = parseOptionalZabbixEventId(req);
      alertEpisodeStartedAt = parseAlertEpisodeStartedAt(req);
      incidentNumbers = parseIncidentCorrelationInputs(req);
      tagIncidentNumbers = parseTagIncidentNumberInputs(req);
      incidentSysIds = parseIncidentSysIdInputs(req);
      mapsOperational = parseMapsOperationalCorrelationInputs(req);
      if (
        !sourceEventId
        && !incidentNumbers.length
        && !tagIncidentNumbers.length
        && !incidentSysIds.length
        && !mapsOperational.mapsHost
      ) {
        // Compat SN-P0-16: exige source_event_id quando não há referência explícita.
        parseZabbixEventId(req);
      }
    } catch {
      return sendRelatedJson(res, 400, {
        error: "invalid_query",
        matched: false,
        relation_source: "none",
        incidents: [],
        source_event_id: null,
        incident_numbers: [],
        incident_sys_ids: [],
        data_source: "postgresql",
      });
    }

    try {
      const result = await lookup({
        sourceEventId,
        alertEpisodeStartedAt,
        incidentNumbers,
        tagIncidentNumbers,
        incidentSysIds,
        mapsDatasource: mapsOperational.mapsDatasource,
        mapsHost: mapsOperational.mapsHost,
        mapsProblemName: mapsOperational.mapsProblemName,
      }, lookupOptions);
      const incidents = (result.incidents || []).map(toDrawerIncident);
      const payload = {
        matched: incidents.length > 0,
        relation_source: result.relation_source || "none",
        source_event_id: sourceEventId,
        alert_episode_started_at: alertEpisodeStartedAt,
        incident_numbers: result.incident_numbers || [...tagIncidentNumbers, ...incidentNumbers],
        incident_sys_ids: result.incident_sys_ids || incidentSysIds,
        incidents,
        data_source: "postgresql",
        checked_at: result.checked_at || new Date().toISOString(),
      };

      logger({
        event: "oneview_request",
        route: "/api/oneview/alerts/related-incidents",
        data_source: "postgresql",
        matched: payload.matched,
        relation_source: payload.relation_source,
        rows: incidents.length,
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });

      return sendRelatedJson(res, 200, payload);
    } catch (error) {
      const status = 503;
      const code = "database_unavailable";
      logger({
        event: "oneview_related_incidents_error",
        route: "/api/oneview/alerts/related-incidents",
        error: code,
        detail: String(error?.message || "database_unavailable").slice(0, 160),
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendRelatedJson(res, status, {
        error: code,
        matched: false,
        relation_source: "none",
        incidents: [],
        source_event_id: sourceEventId,
        alert_episode_started_at: alertEpisodeStartedAt,
        incident_numbers: incidentNumbers,
        incident_sys_ids: incidentSysIds,
        data_source: "postgresql",
      });
    }
  };
}

export default createRelatedIncidentsHandler();
