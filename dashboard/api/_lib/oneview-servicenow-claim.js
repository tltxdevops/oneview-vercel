/**
 * Direct, authenticated ServiceNow incident claim.
 *
 * This endpoint is the explicit write boundary for claim only. It never
 * accepts assignee/group/actor identity from the browser.
 */
import { getAuthenticatedActor } from "./auth.js";
import { insertAuditLog } from "./audit.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsQuery } from "./oneview-actions-db.js";
import { assertIncidentIdentitySafe, INCIDENT_IDENTITY_CONFLICT_ERROR } from "./oneview-incident-identity-guard.js";
import {
  SERVICENOW_IDENTITY_ERROR,
  createServiceNowIdentityResolver,
} from "./oneview-servicenow-identity.js";
import { serviceNowPatchIncidentClaim } from "./servicenow-actions-client.js";
import { getServiceNowConfig, normalizeServiceNowSysId, serviceNowGet } from "./servicenow-client.js";
import { extractServiceNowDisplay, extractServiceNowValue } from "./servicenow-normalize.js";

export const SERVICENOW_CLAIM_ERROR = Object.freeze({
  CLAIM_DISABLED: "SERVICENOW_CLAIM_DISABLED",
  INCIDENT_NOT_FOUND: "INCIDENT_NOT_FOUND",
  IDENTITY_CONFLICT: INCIDENT_IDENTITY_CONFLICT_ERROR,
  ASSIGNED_TO_OTHER: "INCIDENT_ASSIGNED_TO_OTHER",
  INVALID_REQUEST: "INVALID_CLAIM_REQUEST",
  UNAVAILABLE: "SERVICENOW_UNAVAILABLE",
});

const CLAIM_FIELDS = "sys_id,number,state,assignment_group,assigned_to,active,sys_updated_on";
const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function clean(value) {
  return String(value || "").trim();
}

function claimRequestBody(req) {
  let body = req?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new Error(SERVICENOW_CLAIM_ERROR.INVALID_REQUEST); }
  }
  if (body == null) return { confirm_reassign: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "confirm_reassign")) throw new Error(SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
  if (body.confirm_reassign === undefined) return { confirm_reassign: false };
  if (typeof body.confirm_reassign !== "boolean") throw new Error(SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
  return { confirm_reassign: body.confirm_reassign };
}

function incidentSysIdFromRequest(req) {
  const value = Array.isArray(req?.query?.sysId) ? req.query.sysId[0] : req?.query?.sysId;
  return normalizeServiceNowSysId(value);
}

function reference(raw) {
  return {
    id: normalizeServiceNowSysId(extractServiceNowValue(raw)),
    name: clean(extractServiceNowDisplay(raw)),
  };
}

export function mapServiceNowClaimIncident(raw) {
  const assignmentGroup = reference(raw?.assignment_group);
  const assignedTo = reference(raw?.assigned_to);
  return Object.freeze({
    sys_id: normalizeServiceNowSysId(extractServiceNowValue(raw?.sys_id)),
    number: clean(extractServiceNowValue(raw?.number)),
    state: clean(extractServiceNowValue(raw?.state)),
    assignment_group_id: assignmentGroup.id,
    assignment_group_name: assignmentGroup.name,
    assigned_to_id: assignedTo.id,
    assigned_to_name: assignedTo.name,
    active: ["true", "1", "yes"].includes(clean(extractServiceNowValue(raw?.active)).toLowerCase()),
    updated_on: clean(extractServiceNowValue(raw?.sys_updated_on)),
  });
}

export async function fetchServiceNowClaimIncident(incidentSysId, {
  getPage = serviceNowGet,
  config = getServiceNowConfig(),
} = {}) {
  const sysId = normalizeServiceNowSysId(incidentSysId);
  if (!sysId) return null;
  const result = await getPage("incident", {
    config,
    sysparm_query: `sys_id=${sysId}`,
    sysparm_fields: CLAIM_FIELDS,
    sysparm_limit: 1,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });
  const raw = result?.records?.[0];
  return raw ? mapServiceNowClaimIncident(raw) : null;
}

export function getServiceNowClaimConfig(env = process.env) {
  return Object.freeze({
    enabled: booleanValue(env.ONEVIEW_SERVICENOW_CLAIM_ENABLED, false),
    nocAssignmentGroupSysId: normalizeServiceNowSysId(env.SERVICENOW_NOC_ASSIGNMENT_GROUP_SYS_ID),
  });
}

function publicClaimError(error) {
  const code = error?.code || error?.message;
  if (Object.values(SERVICENOW_IDENTITY_ERROR).includes(code)) return code;
  if (Object.values(SERVICENOW_CLAIM_ERROR).includes(code)) return code;
  return SERVICENOW_CLAIM_ERROR.UNAVAILABLE;
}

function publicClaimStatus(code) {
  if (code === SERVICENOW_CLAIM_ERROR.CLAIM_DISABLED) return 403;
  if (code === SERVICENOW_CLAIM_ERROR.INCIDENT_NOT_FOUND) return 404;
  if (code === SERVICENOW_CLAIM_ERROR.IDENTITY_CONFLICT) return 409;
  if (code === SERVICENOW_CLAIM_ERROR.ASSIGNED_TO_OTHER) return 409;
  if (code === SERVICENOW_CLAIM_ERROR.INVALID_REQUEST) return 400;
  if (code === SERVICENOW_IDENTITY_ERROR.NOC_MEMBERSHIP_REQUIRED || code === SERVICENOW_IDENTITY_ERROR.USER_INACTIVE) return 403;
  if (code === SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND) return 404;
  if (code === SERVICENOW_IDENTITY_ERROR.USER_AMBIGUOUS) return 409;
  return 503;
}

function incidentMatchesClaim(incident, { userSysId, groupSysId }) {
  return incident?.assigned_to_id === userSysId && incident?.assignment_group_id === groupSysId;
}

function publicIncident(incident) {
  return {
    incident_number: incident.number || null,
    state: incident.state || null,
    assigned_to_name: incident.assigned_to_name || null,
    assignment_group_name: incident.assignment_group_name || null,
    updated_on: incident.updated_on || null,
  };
}

async function persistClaimAudit({ req, actor, incident, previousAssigneeName, auditQuery = withOneViewActionsQuery }) {
  await auditQuery(async (client) => insertAuditLog(client, {
    req,
    actorName: actor.actor_name,
    actorType: "sso_user",
    actorId: actor.actor_id,
    action: "SERVICENOW_INCIDENT_CLAIMED",
    actionSource: "vercel_api",
    entityType: "incident",
    entityId: incident.sys_id,
    beforeData: { assigned_to_name: previousAssigneeName || null },
    afterData: {
      incident_number: incident.number || null,
      assigned_to_name: incident.assigned_to_name || null,
      assignment_group_name: incident.assignment_group_name || null,
    },
    metadata: { source: "servicenow_direct_claim" },
  }));
}

export function createServiceNowClaimHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  actorProvider = getAuthenticatedActor,
  identityResolver = createServiceNowIdentityResolver(),
  claimConfigProvider = getServiceNowClaimConfig,
  readIncident = fetchServiceNowClaimIncident,
  patchIncident = serviceNowPatchIncidentClaim,
  audit = persistClaimAudit,
  invalidateIncidentCache = async () => undefined,
  identityGuard = assertIncidentIdentitySafe,
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  return async function serviceNowClaimHandler(req, res) {
    const startedAt = now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!await authorize(req, res)) return;

    let action = "claim";
    try {
      const claimConfig = claimConfigProvider();
      if (!claimConfig.enabled) throw new Error(SERVICENOW_CLAIM_ERROR.CLAIM_DISABLED);
      const nocGroupSysId = normalizeServiceNowSysId(claimConfig.nocAssignmentGroupSysId);
      if (!nocGroupSysId) throw new Error(SERVICENOW_CLAIM_ERROR.UNAVAILABLE);
      const body = claimRequestBody(req);
      const incidentSysId = incidentSysIdFromRequest(req);
      if (!incidentSysId) throw new Error(SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
      await identityGuard(incidentSysId);
      const actor = actorProvider(req);
      if (!actor?.actor_id || !actor?.actor_username) throw new Error("authentication_required");

      const identity = await identityResolver.resolveOperationalServiceNowIdentity(actor);
      if (!identity.noc_member) throw new Error(SERVICENOW_IDENTITY_ERROR.NOC_MEMBERSHIP_REQUIRED);
      const userSysId = normalizeServiceNowSysId(identity.user.sys_id);
      if (!userSysId) throw new Error(SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND);

      const initial = await readIncident(incidentSysId);
      if (!initial) throw new Error(SERVICENOW_CLAIM_ERROR.INCIDENT_NOT_FOUND);

      if (initial.assigned_to_id === userSysId) {
        const payload = { success: true, already_assigned: true, incident: publicIncident(initial) };
        logger({ event: "oneview_servicenow_claim", action, status: 200, result: "already_assigned", latency_ms: Math.max(0, now() - startedAt) });
        return sendJson(res, 200, payload);
      }
      if (initial.assigned_to_id && !body.confirm_reassign) {
        return sendJson(res, 409, {
          error: SERVICENOW_CLAIM_ERROR.ASSIGNED_TO_OTHER,
          current_assignee_name: initial.assigned_to_name || "Outro analista",
          requires_confirmation: true,
        });
      }

      const patchPayload = { assignment_group: nocGroupSysId, assigned_to: userSysId };
      const previousAssigneeName = initial.assigned_to_name;
      try {
        await patchIncident(incidentSysId, patchPayload);
      } catch (error) {
        if (error?.code !== "servicenow_timeout") throw error;
        const afterTimeout = await readIncident(incidentSysId);
        if (incidentMatchesClaim(afterTimeout, { userSysId, groupSysId: nocGroupSysId })) {
          await invalidateIncidentCache(incidentSysId);
          try { await audit({ req, actor, incident: afterTimeout, previousAssigneeName }); } catch { logger({ event: "oneview_servicenow_claim_audit_failed", action, status: 200, result: "timeout_confirmed" }); }
          return sendJson(res, 200, { success: true, already_assigned: false, incident: publicIncident(afterTimeout) });
        }
        // One bounded retry only after the mandatory confirmation read.
        await patchIncident(incidentSysId, patchPayload);
      }

      const confirmed = await readIncident(incidentSysId);
      if (!incidentMatchesClaim(confirmed, { userSysId, groupSysId: nocGroupSysId })) {
        throw new Error(SERVICENOW_CLAIM_ERROR.UNAVAILABLE);
      }
      await invalidateIncidentCache(incidentSysId);
      try {
        await audit({ req, actor, incident: confirmed, previousAssigneeName });
      } catch {
        logger({ event: "oneview_servicenow_claim_audit_failed", action, status: 200, result: "claim_succeeded" });
      }
      logger({ event: "oneview_servicenow_claim", action, status: 200, result: "claimed", latency_ms: Math.max(0, now() - startedAt) });
      return sendJson(res, 200, { success: true, already_assigned: false, incident: publicIncident(confirmed) });
    } catch (error) {
      const code = publicClaimError(error);
      const status = code === "authentication_required" ? 401 : publicClaimStatus(code);
      logger({ event: "oneview_servicenow_claim", action, status, result: code, latency_ms: Math.max(0, now() - startedAt) });
      return sendJson(res, status, { error: code });
    }
  };
}

export default createServiceNowClaimHandler();
