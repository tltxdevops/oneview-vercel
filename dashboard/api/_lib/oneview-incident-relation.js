/**
 * SN-P0-08 — GET related alert por zabbix_event_id (read-only).
 * Match estrito com alerts.source_event_id. Sem gravação / sem fallback por host.
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewConfig } from "./oneview-config.js";
import { findAlertBySourceEventId, getOneViewDbConfig } from "./oneview-db.js";
import { isServiceNowIncidentsEnabled } from "./oneview-incidents.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]{1,80}$/;

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendRelationJson(res, status, payload, dataSource = null) {
  res.setHeader("Cache-Control", NO_CACHE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (dataSource) res.setHeader("X-OneView-Data-Source", dataSource);
  return sendJson(res, status, payload);
}

export function parseZabbixEventId(req) {
  const raw = oneQuery(req, "zabbix_event_id") ?? oneQuery(req, "source_event_id");
  const eventId = String(raw || "").trim();
  if (!eventId || !SAFE_EVENT_ID.test(eventId)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  return eventId;
}

export function createRelatedAlertHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  configProvider = getOneViewConfig,
  findAlert = findAlertBySourceEventId,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function relatedAlertHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    if (!featureFlagProvider()) {
      return sendRelationJson(
        res,
        403,
        { error: "servicenow_incidents_disabled", matched: false, alert: null },
        "database",
      );
    }

    let zabbixEventId;
    try {
      zabbixEventId = parseZabbixEventId(req);
    } catch {
      return sendRelationJson(
        res,
        400,
        { error: "invalid_query", matched: false, alert: null },
        "database",
      );
    }

    try {
      const config = configProvider();
      if (!config.liveEnabled || config.snapshotMode) {
        return sendRelationJson(res, 200, {
          matched: false,
          zabbix_event_id: zabbixEventId,
          alert: null,
          data_source: "snapshot",
          checked_at: new Date().toISOString(),
        }, "snapshot");
      }

      const dbConfig = config.dbConfig || getOneViewDbConfig();
      const alert = await findAlert(
        zabbixEventId,
        dbConfig,
        config.primaryDataSourceName,
      );

      const payload = {
        matched: Boolean(alert),
        zabbix_event_id: zabbixEventId,
        alert: alert
          ? {
            id: alert.id,
            host: alert.host,
            customer: alert.customer,
            severity: alert.severity,
            status: alert.status,
            source_event_id: alert.source_event_id,
          }
          : null,
        data_source: "database",
        checked_at: new Date().toISOString(),
      };

      logger({
        event: "oneview_request",
        route: "/api/oneview/incidents/related-alert",
        data_source: "database",
        matched: payload.matched,
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });

      return sendRelationJson(res, 200, payload, "database");
    } catch (error) {
      if (error?.code === "invalid_query") {
        return sendRelationJson(
          res,
          400,
          { error: "invalid_query", matched: false, alert: null, zabbix_event_id: zabbixEventId },
          "database",
        );
      }
      logger({
        event: "oneview_incident_relation_error",
        route: "/api/oneview/incidents/related-alert",
        error: "database_unavailable",
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendRelationJson(
        res,
        503,
        {
          error: "database_unavailable",
          matched: false,
          alert: null,
          zabbix_event_id: zabbixEventId,
          data_source: "database",
        },
        "database",
      );
    }
  };
}

export default createRelatedAlertHandler();
