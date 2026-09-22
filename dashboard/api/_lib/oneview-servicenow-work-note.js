/**
 * Work Notes V1: the ServiceNow request uses the technical account, while the
 * authenticated OneView actor is preserved in a backend-generated prefix.
 */
import { getAuthenticatedActor } from "./auth.js";
import { insertAuditLog } from "./audit.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsQuery } from "./oneview-actions-db.js";
import { serviceNowPatchIncidentWorkNote } from "./servicenow-actions-client.js";
import { getServiceNowConfig, normalizeServiceNowSysId, serviceNowGet } from "./servicenow-client.js";

export const WORK_NOTE_ERROR = Object.freeze({
  INVALID: "INVALID_WORK_NOTE",
  INCIDENT_NOT_FOUND: "INCIDENT_NOT_FOUND",
  RESULT_UNCERTAIN: "WORK_NOTE_RESULT_UNCERTAIN",
  UNAVAILABLE: "SERVICENOW_UNAVAILABLE",
});

export const MAX_WORK_NOTE_LENGTH = 2_000;
const INCIDENT_FIELDS = "sys_id,number";
const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

function clean(value) {
  return String(value || "").trim();
}

function actorLabel(value, fallback) {
  const normalized = clean(value).replace(/[\u0000-\u001f\u007f•\[\]]+/g, " ").replace(/\s+/g, " ");
  return normalized.slice(0, 254) || fallback;
}

export function buildOneViewWorkNote(actor, workNote) {
  const name = actorLabel(actor?.actor_name, "Usuário OneView");
  return `[OneView • ${name}]\n${workNote}`;
}

function parseWorkNoteBody(req) {
  let body = req?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new Error(WORK_NOTE_ERROR.INVALID); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(WORK_NOTE_ERROR.INVALID);
  if (Object.keys(body).some((key) => key !== "work_note")) throw new Error(WORK_NOTE_ERROR.INVALID);
  if (typeof body.work_note !== "string") throw new Error(WORK_NOTE_ERROR.INVALID);
  const workNote = body.work_note.trim();
  if (!workNote || workNote.length > MAX_WORK_NOTE_LENGTH) throw new Error(WORK_NOTE_ERROR.INVALID);
  return workNote;
}

function incidentSysIdFromRequest(req) {
  const value = Array.isArray(req?.query?.sysId) ? req.query.sysId[0] : req?.query?.sysId;
  return normalizeServiceNowSysId(value);
}

function auditRequestContext(req) {
  return {
    headers: req?.headers || {},
    socket: { remoteAddress: req?.socket?.remoteAddress || null },
  };
}

export async function fetchServiceNowWorkNoteIncident(incidentSysId, {
  getPage = serviceNowGet,
  config = getServiceNowConfig(),
} = {}) {
  const sysId = normalizeServiceNowSysId(incidentSysId);
  if (!sysId) return null;
  const result = await getPage("incident", {
    config,
    sysparm_query: `sys_id=${sysId}`,
    sysparm_fields: INCIDENT_FIELDS,
    sysparm_limit: 1,
    sysparm_display_value: "false",
    sysparm_exclude_reference_link: "true",
  });
  const record = result?.records?.[0];
  if (!record) return null;
  return {
    sys_id: normalizeServiceNowSysId(record.sys_id),
    number: clean(record.number).toUpperCase(),
  };
}

async function persistWorkNoteAudit({
  req,
  actor,
  incident,
  workNoteLength,
  result,
  auditQuery = withOneViewActionsQuery,
}) {
  await auditQuery(async (client) => insertAuditLog(client, {
    req,
    actorName: actor.actor_name,
    actorType: "sso_user",
    actorId: actor.actor_id,
    action: "SERVICENOW_WORK_NOTE_ADDED",
    actionSource: "vercel_api",
    entityType: "incident",
    entityId: incident.sys_id,
    afterData: { result },
    metadata: {
      actor_username: actor.actor_username,
      incident_number: incident.number,
      work_note_length: workNoteLength,
      result,
    },
  }));
}

function publicStatus(code) {
  if (code === WORK_NOTE_ERROR.INVALID) return 400;
  if (code === WORK_NOTE_ERROR.INCIDENT_NOT_FOUND) return 404;
  if (code === WORK_NOTE_ERROR.RESULT_UNCERTAIN) return 504;
  return 503;
}

export function createServiceNowWorkNoteHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  actorProvider = getAuthenticatedActor,
  configProvider = getServiceNowConfig,
  readIncident = fetchServiceNowWorkNoteIncident,
  patchIncident = serviceNowPatchIncidentWorkNote,
  audit = persistWorkNoteAudit,
  invalidateIncidentCache = async () => undefined,
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  return async function serviceNowWorkNoteHandler(req, res) {
    const startedAt = now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!await authorize(req, res)) return;

    let actor = null;
    let incident = null;
    let workNoteLength = 0;
    try {
      actor = actorProvider(req);
      if (!actor?.actor_id || !actor?.actor_name || !actor?.actor_username) {
        return sendJson(res, 401, { error: "authentication_required" });
      }
      const workNote = parseWorkNoteBody(req);
      workNoteLength = workNote.length;
      const incidentSysId = incidentSysIdFromRequest(req);
      if (!incidentSysId) throw new Error(WORK_NOTE_ERROR.INVALID);

      const config = configProvider();
      if (!config.configured) throw new Error(WORK_NOTE_ERROR.UNAVAILABLE);
      incident = await readIncident(incidentSysId, { config });
      if (!incident?.sys_id || !incident?.number) throw new Error(WORK_NOTE_ERROR.INCIDENT_NOT_FOUND);

      const prefixedWorkNote = buildOneViewWorkNote(actor, workNote);
      await patchIncident(incident.sys_id, prefixedWorkNote, { config });
      await invalidateIncidentCache(incident.sys_id);
      try {
        await audit({ req: auditRequestContext(req), actor, incident, workNoteLength, result: "success" });
      } catch {
        logger({ event: "oneview_servicenow_work_note_audit_failed", result: "success" });
      }
      logger({
        event: "oneview_servicenow_work_note",
        status: 200,
        result: "success",
        incident_number: incident.number,
        work_note_length: workNoteLength,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, 200, {
        success: true,
        incident_number: incident.number,
        result: "added",
      });
    } catch (error) {
      const rawCode = error?.code || error?.message;
      const code = rawCode === WORK_NOTE_ERROR.RESULT_UNCERTAIN
        ? WORK_NOTE_ERROR.RESULT_UNCERTAIN
        : Object.values(WORK_NOTE_ERROR).includes(rawCode)
          ? rawCode
          : WORK_NOTE_ERROR.UNAVAILABLE;
      if (actor && incident && workNoteLength > 0) {
        try {
          await audit({
            req: auditRequestContext(req),
            actor,
            incident,
            workNoteLength,
            result: code === WORK_NOTE_ERROR.RESULT_UNCERTAIN ? "uncertain" : "failed",
          });
        } catch {
          logger({ event: "oneview_servicenow_work_note_audit_failed", result: code });
        }
      }
      logger({
        event: "oneview_servicenow_work_note",
        status: publicStatus(code),
        result: code,
        incident_number: incident?.number || null,
        work_note_length: workNoteLength,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, publicStatus(code), { error: code });
    }
  };
}

export default createServiceNowWorkNoteHandler();
