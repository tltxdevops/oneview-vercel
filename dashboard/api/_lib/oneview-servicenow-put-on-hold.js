/**
 * Direct ServiceNow incident hold (state 3 / hold_reason 4 / external vendor).
 * Does not mutate assignment, work notes, or priority.
 */
import { getAuthenticatedActor } from "./auth.js";
import { insertAuditLog } from "./audit.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsQuery } from "./oneview-actions-db.js";
import {
  getServiceNowExternalVendorsConfig,
  resolveExternalVendor,
} from "./oneview-servicenow-external-vendors.js";
import {
  SERVICENOW_PUT_ON_HOLD_REASON,
  SERVICENOW_PUT_ON_HOLD_STATE,
  serviceNowPatchIncidentPutOnHold,
} from "./servicenow-actions-client.js";
import { getServiceNowConfig, normalizeServiceNowSysId, serviceNowGet } from "./servicenow-client.js";
import { extractServiceNowDisplay, extractServiceNowValue } from "./servicenow-normalize.js";

export const PUT_ON_HOLD_ERROR = Object.freeze({
  INVALID: "INVALID_PUT_ON_HOLD_REQUEST",
  INCIDENT_NOT_FOUND: "INCIDENT_NOT_FOUND",
  RESULT_UNCERTAIN: "PUT_ON_HOLD_RESULT_UNCERTAIN",
  UNAVAILABLE: "SERVICENOW_UNAVAILABLE",
});

const HOLD_FIELDS = "sys_id,number,state,hold_reason,u_external_vendor,assignment_group,assigned_to,sys_updated_on";
const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

function clean(value) {
  return String(value || "").trim();
}

function reference(raw) {
  return {
    id: normalizeServiceNowSysId(extractServiceNowValue(raw)),
    name: clean(extractServiceNowDisplay(raw)),
  };
}

export function mapServiceNowPutOnHoldIncident(raw) {
  const assignmentGroup = reference(raw?.assignment_group);
  const assignedTo = reference(raw?.assigned_to);
  const holdReason = clean(extractServiceNowValue(raw?.hold_reason));
  const externalVendor = clean(extractServiceNowDisplay(raw?.u_external_vendor))
    || clean(extractServiceNowValue(raw?.u_external_vendor));
  return Object.freeze({
    sys_id: normalizeServiceNowSysId(extractServiceNowValue(raw?.sys_id)),
    number: clean(extractServiceNowValue(raw?.number)).toUpperCase(),
    state: clean(extractServiceNowValue(raw?.state)),
    hold_reason: holdReason,
    external_vendor: externalVendor,
    assignment_group_id: assignmentGroup.id,
    assignment_group_name: assignmentGroup.name,
    assigned_to_id: assignedTo.id,
    assigned_to_name: assignedTo.name,
    updated_on: clean(extractServiceNowValue(raw?.sys_updated_on)),
  });
}

export async function fetchServiceNowPutOnHoldIncident(incidentSysId, {
  getPage = serviceNowGet,
  config = getServiceNowConfig(),
} = {}) {
  const sysId = normalizeServiceNowSysId(incidentSysId);
  if (!sysId) return null;
  const result = await getPage("incident", {
    config,
    sysparm_query: `sys_id=${sysId}`,
    sysparm_fields: HOLD_FIELDS,
    sysparm_limit: 1,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });
  const raw = result?.records?.[0];
  return raw ? mapServiceNowPutOnHoldIncident(raw) : null;
}

function incidentSysIdFromRequest(req) {
  const value = Array.isArray(req?.query?.sysId) ? req.query.sysId[0] : req?.query?.sysId;
  return normalizeServiceNowSysId(value);
}

function parsePutOnHoldBody(req) {
  let body = req?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new Error(PUT_ON_HOLD_ERROR.INVALID); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(PUT_ON_HOLD_ERROR.INVALID);
  if (Object.keys(body).some((key) => key !== "external_vendor")) throw new Error(PUT_ON_HOLD_ERROR.INVALID);
  if (typeof body.external_vendor !== "string") throw new Error(PUT_ON_HOLD_ERROR.INVALID);
  return body.external_vendor;
}

function auditRequestContext(req) {
  return {
    headers: req?.headers || {},
    socket: { remoteAddress: req?.socket?.remoteAddress || null },
  };
}

export function incidentMatchesPutOnHold(incident, externalVendor) {
  if (!incident) return false;
  const vendorNeedle = clean(externalVendor).toLowerCase();
  const vendorActual = clean(incident.external_vendor).toLowerCase();
  return incident.state === SERVICENOW_PUT_ON_HOLD_STATE
    && String(incident.hold_reason) === SERVICENOW_PUT_ON_HOLD_REASON
    && vendorNeedle.length > 0
    && vendorActual === vendorNeedle;
}

export function ownershipMatches(before, after) {
  if (!before || !after) return false;
  return before.assigned_to_id === after.assigned_to_id
    && before.assignment_group_id === after.assignment_group_id;
}

function publicIncident(incident) {
  return {
    incident_number: incident.number || null,
    state: incident.state || null,
    hold_reason: incident.hold_reason || null,
    external_vendor: incident.external_vendor || null,
    assigned_to_name: incident.assigned_to_name || null,
    assignment_group_name: incident.assignment_group_name || null,
    updated_on: incident.updated_on || null,
  };
}

async function persistPutOnHoldAudit({
  req,
  actor,
  incident,
  previousState,
  externalVendor,
  result,
  auditQuery = withOneViewActionsQuery,
  now = () => new Date(),
}) {
  const timestamp = now().toISOString();
  await auditQuery(async (client) => insertAuditLog(client, {
    req,
    actorName: actor.actor_name,
    actorType: "sso_user",
    actorId: actor.actor_id,
    action: "SERVICENOW_INCIDENT_PUT_ON_HOLD",
    actionSource: "vercel_api",
    entityType: "incident",
    entityId: incident.sys_id,
    beforeData: { state: previousState || null },
    afterData: {
      incident_number: incident.number || null,
      state: incident.state || null,
      hold_reason: incident.hold_reason || null,
      external_vendor: incident.external_vendor || null,
    },
    metadata: {
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      incident_number: incident.number,
      previous_state: previousState || null,
      new_state: incident.state || null,
      hold_reason: SERVICENOW_PUT_ON_HOLD_REASON,
      external_vendor: externalVendor,
      timestamp,
      result,
    },
  }));
}

function publicStatus(code) {
  if (code === PUT_ON_HOLD_ERROR.INVALID) return 400;
  if (code === PUT_ON_HOLD_ERROR.INCIDENT_NOT_FOUND) return 404;
  if (code === PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN) return 504;
  return 503;
}

export function createServiceNowPutOnHoldHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  actorProvider = getAuthenticatedActor,
  configProvider = getServiceNowConfig,
  vendorConfigProvider = getServiceNowExternalVendorsConfig,
  readIncident = fetchServiceNowPutOnHoldIncident,
  patchIncident = serviceNowPatchIncidentPutOnHold,
  audit = persistPutOnHoldAudit,
  invalidateIncidentCache = async () => undefined,
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  return async function serviceNowPutOnHoldHandler(req, res) {
    const startedAt = now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!await authorize(req, res)) return;

    let actor = null;
    let incident = null;
    let externalVendor = "";
    let previousState = null;
    try {
      actor = actorProvider(req);
      if (!actor?.actor_id || !actor?.actor_name || !actor?.actor_username) {
        return sendJson(res, 401, { error: "authentication_required" });
      }
      const rawVendor = parsePutOnHoldBody(req);
      const vendorConfig = vendorConfigProvider();
      externalVendor = resolveExternalVendor(rawVendor, vendorConfig);
      if (!externalVendor) throw new Error(PUT_ON_HOLD_ERROR.INVALID);

      const incidentSysId = incidentSysIdFromRequest(req);
      if (!incidentSysId) throw new Error(PUT_ON_HOLD_ERROR.INVALID);

      const config = configProvider();
      if (!config.configured) throw new Error(PUT_ON_HOLD_ERROR.UNAVAILABLE);
      incident = await readIncident(incidentSysId, { config });
      if (!incident?.sys_id || !incident?.number) throw new Error(PUT_ON_HOLD_ERROR.INCIDENT_NOT_FOUND);
      previousState = incident.state;

      if (incidentMatchesPutOnHold(incident, externalVendor)) {
        await invalidateIncidentCache(incident.sys_id);
        try {
          await audit({
            req: auditRequestContext(req),
            actor,
            incident,
            previousState,
            externalVendor,
            result: "already_on_hold",
          });
        } catch {
          logger({ event: "oneview_servicenow_put_on_hold_audit_failed", result: "already_on_hold" });
        }
        return sendJson(res, 200, {
          success: true,
          already_on_hold: true,
          incident: publicIncident(incident),
        });
      }

      const patchPayload = {
        state: SERVICENOW_PUT_ON_HOLD_STATE,
        hold_reason: SERVICENOW_PUT_ON_HOLD_REASON,
        u_external_vendor: externalVendor,
      };
      const ownershipBefore = {
        assigned_to_id: incident.assigned_to_id,
        assignment_group_id: incident.assignment_group_id,
      };

      try {
        await patchIncident(incident.sys_id, patchPayload, { config });
      } catch (error) {
        if (error?.code !== "PUT_ON_HOLD_RESULT_UNCERTAIN" && error?.code !== "servicenow_timeout") throw error;
        const afterTimeout = await readIncident(incident.sys_id, { config });
        if (incidentMatchesPutOnHold(afterTimeout, externalVendor) && ownershipMatches(ownershipBefore, afterTimeout)) {
          await invalidateIncidentCache(incident.sys_id);
          try {
            await audit({
              req: auditRequestContext(req),
              actor,
              incident: afterTimeout,
              previousState,
              externalVendor,
              result: "success_timeout_confirmed",
            });
          } catch {
            logger({ event: "oneview_servicenow_put_on_hold_audit_failed", result: "success_timeout_confirmed" });
          }
          logger({
            event: "oneview_servicenow_put_on_hold",
            status: 200,
            result: "timeout_confirmed",
            incident_number: afterTimeout.number,
            latency_ms: Math.max(0, now() - startedAt),
          });
          return sendJson(res, 200, { success: true, already_on_hold: false, incident: publicIncident(afterTimeout) });
        }
        throw new Error(PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN);
      }

      const confirmed = await readIncident(incident.sys_id, { config });
      if (!incidentMatchesPutOnHold(confirmed, externalVendor) || !ownershipMatches(ownershipBefore, confirmed)) {
        throw new Error(PUT_ON_HOLD_ERROR.UNAVAILABLE);
      }
      await invalidateIncidentCache(incident.sys_id);
      try {
        await audit({
          req: auditRequestContext(req),
          actor,
          incident: confirmed,
          previousState,
          externalVendor,
          result: "success",
        });
      } catch {
        logger({ event: "oneview_servicenow_put_on_hold_audit_failed", result: "success" });
      }
      logger({
        event: "oneview_servicenow_put_on_hold",
        status: 200,
        result: "success",
        incident_number: confirmed.number,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, 200, { success: true, already_on_hold: false, incident: publicIncident(confirmed) });
    } catch (error) {
      const rawCode = error?.code || error?.message;
      const code = rawCode === PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN
        ? PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN
        : Object.values(PUT_ON_HOLD_ERROR).includes(rawCode)
          ? rawCode
          : PUT_ON_HOLD_ERROR.UNAVAILABLE;
      if (actor && incident) {
        try {
          await audit({
            req: auditRequestContext(req),
            actor,
            incident,
            previousState,
            externalVendor,
            result: code === PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN ? "uncertain" : "failed",
          });
        } catch {
          logger({ event: "oneview_servicenow_put_on_hold_audit_failed", result: code });
        }
      }
      logger({
        event: "oneview_servicenow_put_on_hold",
        status: publicStatus(code),
        result: code,
        incident_number: incident?.number || null,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, publicStatus(code), { error: code });
    }
  };
}

export default createServiceNowPutOnHoldHandler();
