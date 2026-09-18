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
