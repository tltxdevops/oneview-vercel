/**
 * Explicit ServiceNow mutation boundary. This is intentionally separate from
 * servicenow-client.js, whose public operations remain GET-only.
 */
import {
  ServiceNowClientError,
  buildServiceNowAuthorizationHeader,
  errorCodeFromStatus,
  getServiceNowConfig,
  normalizeServiceNowSysId,
  readServiceNowJsonBody,
  sanitizeServiceNowError,
} from "./servicenow-client.js";

const CLAIM_FIELDS = "sys_id,number,state,assignment_group,assigned_to,active,sys_updated_on";
const WORK_NOTE_FIELDS = "sys_id,number,sys_updated_on";
const PUT_ON_HOLD_FIELDS = "sys_id,number,state,hold_reason,u_external_vendor,assignment_group,assigned_to,sys_updated_on";

export const SERVICENOW_PUT_ON_HOLD_STATE = "3";
export const SERVICENOW_PUT_ON_HOLD_REASON = "4";

function claimUrl(baseUrl, incidentSysId) {
  const url = new URL(`/api/now/table/incident/${encodeURIComponent(incidentSysId)}`, `${baseUrl}/`);
  url.searchParams.set("sysparm_fields", CLAIM_FIELDS);
  url.searchParams.set("sysparm_display_value", "all");
  url.searchParams.set("sysparm_exclude_reference_link", "true");
  return url;
}

function workNoteUrl(baseUrl, incidentSysId) {
  const url = new URL(`/api/now/table/incident/${encodeURIComponent(incidentSysId)}`, `${baseUrl}/`);
  url.searchParams.set("sysparm_fields", WORK_NOTE_FIELDS);
  url.searchParams.set("sysparm_display_value", "false");
  url.searchParams.set("sysparm_exclude_reference_link", "true");
  return url;
}

function putOnHoldUrl(baseUrl, incidentSysId) {
  const url = new URL(`/api/now/table/incident/${encodeURIComponent(incidentSysId)}`, `${baseUrl}/`);
  url.searchParams.set("sysparm_fields", PUT_ON_HOLD_FIELDS);
  url.searchParams.set("sysparm_display_value", "all");
  url.searchParams.set("sysparm_exclude_reference_link", "true");
  return url;
}

function cleanHoldText(value) {
  return String(value || "").trim();
}

function assertPutOnHoldPayload(incidentSysId, payload) {
  const id = normalizeServiceNowSysId(incidentSysId);
  const state = cleanHoldText(payload?.state);
  const holdReason = cleanHoldText(payload?.hold_reason);
  const externalVendor = cleanHoldText(payload?.u_external_vendor);
  if (!id || state !== SERVICENOW_PUT_ON_HOLD_STATE || holdReason !== SERVICENOW_PUT_ON_HOLD_REASON || !externalVendor) {
    throw new ServiceNowClientError("servicenow_invalid_hold_payload", { status: 400 });
  }
  return {
    incidentSysId: id,
    body: {
      state: SERVICENOW_PUT_ON_HOLD_STATE,
      hold_reason: SERVICENOW_PUT_ON_HOLD_REASON,
      u_external_vendor: externalVendor.slice(0, 120),
    },
  };
}

function assertClaimPayload(incidentSysId, payload) {
  const id = normalizeServiceNowSysId(incidentSysId);
  const assignmentGroup = normalizeServiceNowSysId(payload?.assignment_group);
  const assignedTo = normalizeServiceNowSysId(payload?.assigned_to);
  if (!id || !assignmentGroup || !assignedTo) {
    throw new ServiceNowClientError("servicenow_invalid_claim_payload", { status: 400 });
  }
  return { incidentSysId: id, assignmentGroup, assignedTo };
}

/**
 * One PATCH only. Retry policy belongs to the claim handler, which can re-read
 * the incident first and avoid a blind duplicate write after a timeout.
 */
export async function serviceNowPatchIncidentClaim(incidentSysId, payload, {
  config = getServiceNowConfig(),
  fetchImpl = fetch,
} = {}) {
  if (!config.configured) throw new ServiceNowClientError("servicenow_not_configured");
  const claim = assertClaimPayload(incidentSysId, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(claimUrl(config.baseUrl, claim.incidentSysId), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: buildServiceNowAuthorizationHeader(config),
      },
      body: JSON.stringify({ assignment_group: claim.assignmentGroup, assigned_to: claim.assignedTo }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ServiceNowClientError(errorCodeFromStatus(response.status), { status: response.status });
    }
    const body = await readServiceNowJsonBody(response);
    if (!body?.result || typeof body.result !== "object" || Array.isArray(body.result)) {
      throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
    }
    return body.result;
  } catch (error) {
    if (error instanceof ServiceNowClientError) throw error;
    if (error?.name === "AbortError") throw new ServiceNowClientError("servicenow_timeout", { status: 504 });
    throw new ServiceNowClientError("servicenow_unavailable", {
      status: 502,
      details: sanitizeServiceNowError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Appends one journal entry using the technical ServiceNow account.
 * This operation is deliberately single-attempt: an aborted/network-uncertain
 * request may already have committed the journal entry.
 */
export async function serviceNowPatchIncidentWorkNote(incidentSysId, workNote, {
  config = getServiceNowConfig(),
  fetchImpl = fetch,
} = {}) {
  if (!config.configured) throw new ServiceNowClientError("servicenow_not_configured");
  const id = normalizeServiceNowSysId(incidentSysId);
  if (!id || typeof workNote !== "string" || !workNote.trim()) {
    throw new ServiceNowClientError("invalid_work_note", { status: 400 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(workNoteUrl(config.baseUrl, id), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: buildServiceNowAuthorizationHeader(config),
      },
      body: JSON.stringify({ work_notes: workNote }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ServiceNowClientError(errorCodeFromStatus(response.status), { status: response.status });
    }
    const body = await readServiceNowJsonBody(response);
    if (!body?.result || typeof body.result !== "object" || Array.isArray(body.result)) {
      throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
    }
    return body.result;
  } catch (error) {
    if (error instanceof ServiceNowClientError) throw error;
    if (error?.name === "AbortError") {
      throw new ServiceNowClientError("WORK_NOTE_RESULT_UNCERTAIN", { status: 504 });
    }
    // A network failure after dispatch is also uncertain; never retry.
    throw new ServiceNowClientError("WORK_NOTE_RESULT_UNCERTAIN", {
      status: 502,
      details: sanitizeServiceNowError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

function incidentAttachmentUrl(baseUrl, incidentSysId, fileName) {
  const url = new URL("/api/now/attachment/file", `${baseUrl}/`);
  url.searchParams.set("table_name", "incident");
  url.searchParams.set("table_sys_id", incidentSysId);
  url.searchParams.set("file_name", fileName);
  return url;
}

/**
 * Uploads one PNG attachment. Single attempt only — uncertain outcomes must not retry.
 */
/**
 * One PATCH only for on-hold. Must not include assignment or journal fields.
 */
export async function serviceNowPatchIncidentPutOnHold(incidentSysId, payload, {
  config = getServiceNowConfig(),
  fetchImpl = fetch,
} = {}) {
  if (!config.configured) throw new ServiceNowClientError("servicenow_not_configured");
  const hold = assertPutOnHoldPayload(incidentSysId, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(putOnHoldUrl(config.baseUrl, hold.incidentSysId), {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: buildServiceNowAuthorizationHeader(config),
      },
      body: JSON.stringify(hold.body),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ServiceNowClientError(errorCodeFromStatus(response.status), { status: response.status });
    }
    const body = await readServiceNowJsonBody(response);
    if (!body?.result || typeof body.result !== "object" || Array.isArray(body.result)) {
      throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
    }
    return body.result;
  } catch (error) {
    if (error instanceof ServiceNowClientError) throw error;
    if (error?.name === "AbortError") {
      throw new ServiceNowClientError("PUT_ON_HOLD_RESULT_UNCERTAIN", { status: 504 });
    }
    throw new ServiceNowClientError("PUT_ON_HOLD_RESULT_UNCERTAIN", {
      status: 502,
      details: sanitizeServiceNowError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function serviceNowPostIncidentAttachment(incidentSysId, fileName, pngBody, {
  config = getServiceNowConfig(),
  fetchImpl = fetch,
} = {}) {
  if (!config.configured) throw new ServiceNowClientError("servicenow_not_configured");
  const id = normalizeServiceNowSysId(incidentSysId);
  const name = String(fileName || "").trim();
  if (!id || !name) throw new ServiceNowClientError("invalid_attachment_payload", { status: 400 });
  if (!Buffer.isBuffer(pngBody) && !(pngBody instanceof Uint8Array)) {
    throw new ServiceNowClientError("invalid_attachment_payload", { status: 400 });
  }
  const body = Buffer.isBuffer(pngBody) ? pngBody : Buffer.from(pngBody);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(incidentAttachmentUrl(config.baseUrl, id, name), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "image/png",
        Authorization: buildServiceNowAuthorizationHeader(config),
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ServiceNowClientError(errorCodeFromStatus(response.status), { status: response.status });
    }
    const payload = await readServiceNowJsonBody(response);
    if (!payload?.result) {
      throw new ServiceNowClientError("servicenow_invalid_response", { status: 502 });
    }
    return payload.result;
  } catch (error) {
    if (error instanceof ServiceNowClientError) throw error;
    if (error?.name === "AbortError") {
      throw new ServiceNowClientError("ATTACHMENT_RESULT_UNCERTAIN", { status: 504 });
    }
    throw new ServiceNowClientError("ATTACHMENT_RESULT_UNCERTAIN", {
      status: 502,
      details: sanitizeServiceNowError(error),
    });
  } finally {
    clearTimeout(timer);
  }
}
