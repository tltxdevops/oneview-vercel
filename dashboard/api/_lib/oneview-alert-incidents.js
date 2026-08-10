/**
 * SN-P0-16 — GET incidentes relacionados a um alerta (source_event_id).
 * ServiceNow read-only. Sem fallback por host. Aceita múltiplos INC.
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { parseZabbixEventId } from "./oneview-incident-relation.js";
import {
  fetchIncidentsBySourceEventId,
  isServiceNowIncidentsEnabled,
} from "./oneview-incidents.js";
import {
  getServiceNowConfig,
  mapServiceNowErrorToHttpStatus,
  mapServiceNowErrorToPublicCode,
  sanitizeServiceNowError,
  serviceNowGet,
} from "./servicenow-client.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

function sendRelatedJson(res, status, payload, dataSource = "servicenow") {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (dataSource) res.setHeader("X-OneView-Data-Source", dataSource);
  return sendJson(res, status, payload);
}

function mapStatus(error) {
  return mapServiceNowErrorToHttpStatus(error);
}

function publicError(error) {
  return mapServiceNowErrorToPublicCode(error);
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
    sys_updated_on: item.sys_updated_on,
    zabbix_event_id: item.zabbix_event_id ?? null,
    servicenow_url: item.servicenow_url ?? null,
  };
}

export function createRelatedIncidentsHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  configProvider = getServiceNowConfig,
  getPage = serviceNowGet,
  fetchImpl,
  lookup = fetchIncidentsBySourceEventId,
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
        incidents: [],
        source_event_id: null,
        data_source: "servicenow",
      });
    }

    let sourceEventId;
    try {
      sourceEventId = parseZabbixEventId(req);
    } catch {
      return sendRelatedJson(res, 400, {
        error: "invalid_query",
        matched: false,
        incidents: [],
        source_event_id: null,
        data_source: "servicenow",
      });
    }

    try {
      const config = configProvider();
      const result = await lookup(sourceEventId, { config, getPage, fetchImpl });
      const incidents = (result.incidents || []).map(toDrawerIncident);
      const payload = {
        matched: incidents.length > 0,
        source_event_id: sourceEventId,
        incidents,
        data_source: "servicenow",
        checked_at: result.checked_at || new Date().toISOString(),
      };

      logger({
        event: "oneview_request",
        route: "/api/oneview/alerts/related-incidents",
        data_source: "servicenow",
        matched: payload.matched,
        rows: incidents.length,
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });

      return sendRelatedJson(res, 200, payload);
    } catch (error) {
      const status = mapStatus(error);
      const code = publicError(error);
      logger({
        event: "oneview_related_incidents_error",
        route: "/api/oneview/alerts/related-incidents",
        error: code,
        detail: sanitizeServiceNowError(error),
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendRelatedJson(res, status, {
        error: code,
        matched: false,
        incidents: [],
        source_event_id: sourceEventId,
        data_source: "servicenow",
      });
    }
  };
}

export default createRelatedIncidentsHandler();
