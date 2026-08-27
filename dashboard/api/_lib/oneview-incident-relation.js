/**
 * SN-P0-08 — GET related alert por zabbix_event_id (read-only).
 * Match estrito com alerts.source_event_id. Sem gravação / sem fallback por host.
 */

import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { getOneViewConfig } from "./oneview-config.js";
import {
  findAlertByExplicitServiceNowReference,
  findAlertBySourceEventId,
  getOneViewDbConfig,
} from "./oneview-db.js";
import { isServiceNowIncidentsEnabled } from "./oneview-incidents.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const SAFE_INCIDENT_NUMBER = /^INC\d{1,32}$/i;

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

/** OV-P0-137 — referências canônicas do incidente para lookup reverso. */
export function parseIncidentAlertReference(req) {
  const sysIdRaw = String(oneQuery(req, "sys_id") || "").trim();
  const numberRaw = String(oneQuery(req, "number") || "").trim();
  const eventRaw = String(
    oneQuery(req, "zabbix_event_id") ?? oneQuery(req, "source_event_id") ?? "",
  ).trim();

  if (sysIdRaw && !SAFE_SYS_ID.test(sysIdRaw)) throw new Error("invalid_query");
  if (numberRaw && !SAFE_INCIDENT_NUMBER.test(numberRaw)) throw new Error("invalid_query");
  if (eventRaw && !SAFE_EVENT_ID.test(eventRaw)) throw new Error("invalid_query");
  if (!sysIdRaw && !numberRaw && !eventRaw) throw new Error("invalid_query");

  return {
    sys_id: sysIdRaw ? sysIdRaw.toLowerCase() : null,
    number: numberRaw ? numberRaw.toUpperCase() : null,
    zabbix_event_id: eventRaw || null,
  };
}

export function createRelatedAlertHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  configProvider = getOneViewConfig,
  findAlertByReference = findAlertByExplicitServiceNowReference,
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

    let reference;
    try {
      reference = parseIncidentAlertReference(req);
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
          sys_id: reference.sys_id,
          number: reference.number,
          zabbix_event_id: reference.zabbix_event_id,
          relation_source: "none",
          alert: null,
          data_source: "snapshot",
          checked_at: new Date().toISOString(),
        }, "snapshot");
      }

      const dbConfig = config.dbConfig || getOneViewDbConfig();
      let result = reference.sys_id || reference.number
        ? await findAlertByReference({
          sysId: reference.sys_id,
          number: reference.number,
        }, dbConfig)
        : {
          relation_source: "event_id",
          alert: await findAlert(reference.zabbix_event_id, dbConfig),
        };
      if (!result.alert && reference.zabbix_event_id) {
        result = {
          relation_source: "event_id",
          alert: await findAlert(reference.zabbix_event_id, dbConfig),
        };
      }
      const alert = result.alert;

      const payload = {
        matched: Boolean(alert),
        sys_id: reference.sys_id,
        number: reference.number,
        zabbix_event_id: reference.zabbix_event_id,
        relation_source: alert ? result.relation_source : "none",
        alert: alert
          ? {
            id: alert.id,
            data_source_id: alert.data_source_id,
            host: alert.host,
            customer: alert.customer,
            problem: alert.problem,
            severity: alert.severity,
            status: alert.status,
            source_event_id: alert.source_event_id,
            first_seen_at: alert.first_seen_at,
            created_at: alert.created_at || alert.first_seen_at,
            resolved_at: alert.resolved_at,
            oneview_link: `/alertas?alert=${encodeURIComponent(alert.id)}`,
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
        relation_source: payload.relation_source,
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });

      return sendRelationJson(res, 200, payload, "database");
    } catch (error) {
      if (error?.code === "invalid_query") {
        return sendRelationJson(
          res,
          400,
          { error: "invalid_query", matched: false, alert: null, ...reference },
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
          ...reference,
          data_source: "database",
        },
        "database",
      );
    }
  };
}

export default createRelatedAlertHandler();
