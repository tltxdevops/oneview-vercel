/**
 * ServiceNow incident attachment (PNG alert artifact).
 * Browser sends PNG to BFF only; ServiceNow is called from backend.
 */
import { getAuthenticatedActor } from "./auth.js";
import { insertAuditLog } from "./audit.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsQuery } from "./oneview-actions-db.js";
import { assertIncidentIdentitySafe, INCIDENT_IDENTITY_CONFLICT_ERROR } from "./oneview-incident-identity-guard.js";
import { fetchServiceNowWorkNoteIncident } from "./oneview-servicenow-work-note.js";
import { serviceNowPostIncidentAttachment } from "./servicenow-actions-client.js";
import { getServiceNowConfig, normalizeServiceNowSysId } from "./servicenow-client.js";

export const ATTACHMENT_ERROR = Object.freeze({
  INVALID: "INVALID_ATTACHMENT",
  INCIDENT_NOT_FOUND: "INCIDENT_NOT_FOUND",
  IDENTITY_CONFLICT: INCIDENT_IDENTITY_CONFLICT_ERROR,
  RESULT_UNCERTAIN: "ATTACHMENT_RESULT_UNCERTAIN",
  TOO_LARGE: "ATTACHMENT_TOO_LARGE",
  UNAVAILABLE: "SERVICENOW_UNAVAILABLE",
});

/** Aligned with typical Vercel request body limits (leave headroom). */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";

function clean(value) {
  return String(value || "").trim();
}

function incidentSysIdFromRequest(req) {
  const value = Array.isArray(req?.query?.sysId) ? req.query.sysId[0] : req?.query?.sysId;
  return normalizeServiceNowSysId(value);
}

function fileNameFromRequest(req) {
  const value = Array.isArray(req?.query?.file_name) ? req.query.file_name[0] : req?.query?.file_name;
  return clean(value);
}

export function sanitizeAttachmentFileName(rawName, incidentNumber) {
  const candidate = clean(rawName).toLowerCase();
  const stripped = candidate.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (stripped && /^[a-z0-9][a-z0-9._-]*\.png$/i.test(stripped)) return stripped.slice(0, 120);
  const number = clean(incidentNumber).replace(/[^a-z0-9]+/gi, "").slice(0, 32) || "incident";
  return `oneview-alerta-${number.toLowerCase()}.png`;
}

export function isPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) return false;
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export function contentTypeIsPng(req) {
  const value = clean(req?.headers?.["content-type"]).split(";")[0].toLowerCase();
  return value === "image/png";
}

async function readAttachmentBody(req, maxBytes = MAX_ATTACHMENT_BYTES) {
  if (Buffer.isBuffer(req?.body)) {
    if (req.body.length > maxBytes) throw new Error(ATTACHMENT_ERROR.TOO_LARGE);
    return req.body;
  }
  if (req?.body instanceof Uint8Array) {
    const buf = Buffer.from(req.body);
    if (buf.length > maxBytes) throw new Error(ATTACHMENT_ERROR.TOO_LARGE);
    return buf;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > maxBytes) throw new Error(ATTACHMENT_ERROR.TOO_LARGE);
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function auditRequestContext(req) {
  return {
    headers: req?.headers || {},
    socket: { remoteAddress: req?.socket?.remoteAddress || null },
  };
}

async function persistAttachmentAudit({
  req,
  actor,
  incident,
  fileName,
  contentType,
  sizeBytes,
  result,
  auditQuery = withOneViewActionsQuery,
}) {
  await auditQuery(async (client) => insertAuditLog(client, {
    req,
    actorName: actor.actor_name,
    actorType: "sso_user",
    actorId: actor.actor_id,
    action: "SERVICENOW_ALERT_ATTACHMENT_ADDED",
    actionSource: "vercel_api",
    entityType: "incident",
    entityId: incident.sys_id,
    afterData: { result },
    metadata: {
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      incident_number: incident.number,
      file_name: fileName,
      content_type: contentType,
      size_bytes: sizeBytes,
      result,
      timestamp: new Date().toISOString(),
    },
  }));
}

function publicStatus(code) {
  if (code === ATTACHMENT_ERROR.INVALID) return 400;
  if (code === ATTACHMENT_ERROR.TOO_LARGE) return 413;
  if (code === ATTACHMENT_ERROR.INCIDENT_NOT_FOUND) return 404;
  if (code === ATTACHMENT_ERROR.IDENTITY_CONFLICT) return 409;
  if (code === ATTACHMENT_ERROR.RESULT_UNCERTAIN) return 504;
  return 503;
}

export function createServiceNowAttachmentHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  actorProvider = getAuthenticatedActor,
  configProvider = getServiceNowConfig,
  readIncident = fetchServiceNowWorkNoteIncident,
  postAttachment = serviceNowPostIncidentAttachment,
  audit = persistAttachmentAudit,
  identityGuard = assertIncidentIdentitySafe,
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  return async function serviceNowAttachmentHandler(req, res) {
    const startedAt = now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    if (!await authorize(req, res)) return;

    let actor = null;
    let incident = null;
    let fileName = "";
    let sizeBytes = 0;
    try {
      actor = actorProvider(req);
      if (!actor?.actor_id || !actor?.actor_name || !actor?.actor_username) {
        return sendJson(res, 401, { error: "authentication_required" });
      }
      if (!contentTypeIsPng(req)) throw new Error(ATTACHMENT_ERROR.INVALID);
      const incidentSysId = incidentSysIdFromRequest(req);
      if (!incidentSysId) throw new Error(ATTACHMENT_ERROR.INVALID);
      await identityGuard(incidentSysId);

      const config = configProvider();
      if (!config.configured) throw new Error(ATTACHMENT_ERROR.UNAVAILABLE);
      incident = await readIncident(incidentSysId, { config });
      if (!incident?.sys_id || !incident?.number) throw new Error(ATTACHMENT_ERROR.INCIDENT_NOT_FOUND);

      const pngBody = await readAttachmentBody(req);
      sizeBytes = pngBody.length;
      if (!sizeBytes || !isPngBuffer(pngBody)) throw new Error(ATTACHMENT_ERROR.INVALID);
      fileName = sanitizeAttachmentFileName(fileNameFromRequest(req), incident.number);

      await postAttachment(incident.sys_id, fileName, pngBody, { config });
      try {
        await audit({
          req: auditRequestContext(req),
          actor,
          incident,
          fileName,
          contentType: "image/png",
          sizeBytes,
          result: "success",
        });
      } catch {
        logger({ event: "oneview_servicenow_attachment_audit_failed", result: "success" });
      }
      logger({
        event: "oneview_servicenow_attachment",
        status: 200,
        result: "success",
        incident_number: incident.number,
        file_name: fileName,
        size_bytes: sizeBytes,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, 200, {
        success: true,
        incident_number: incident.number,
        file_name: fileName,
        result: "attached",
      });
    } catch (error) {
      const rawCode = error?.code || error?.message;
      const code = rawCode === ATTACHMENT_ERROR.RESULT_UNCERTAIN
        ? ATTACHMENT_ERROR.RESULT_UNCERTAIN
        : Object.values(ATTACHMENT_ERROR).includes(rawCode)
          ? rawCode
          : ATTACHMENT_ERROR.UNAVAILABLE;
      if (actor && incident && fileName && sizeBytes > 0) {
        try {
          await audit({
            req: auditRequestContext(req),
            actor,
            incident,
            fileName,
            contentType: "image/png",
            sizeBytes,
            result: code === ATTACHMENT_ERROR.RESULT_UNCERTAIN ? "uncertain" : "failed",
          });
        } catch {
          logger({ event: "oneview_servicenow_attachment_audit_failed", result: code });
        }
      }
      logger({
        event: "oneview_servicenow_attachment",
        status: publicStatus(code),
        result: code,
        incident_number: incident?.number || null,
        file_name: fileName || null,
        size_bytes: sizeBytes || 0,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, publicStatus(code), { error: code });
    }
  };
}

export default createServiceNowAttachmentHandler();
