/** Read-model identity guard. Never resolves a sys_id from an INC number. */
import { withOneViewActionsQuery } from "./oneview-actions-db.js";

export const INCIDENT_IDENTITY_CONFLICT_ERROR = "INCIDENT_IDENTITY_CONFLICT";

function normalizeSysId(value) {
  const sysId = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(sysId) ? sysId : null;
}

/**
 * Returns a conflict only when the requested local identity belongs to a
 * number represented by another local sys_id. A missing local row is not a
 * fallback condition and remains the responsibility of the caller.
 */
export async function readIncidentIdentityGuard(client, sysId) {
  const normalized = normalizeSysId(sysId);
  if (!normalized) return { incident: null, identity_conflict: false };
  const result = await client.query({
    text: `
      select i.sys_id, i.number,
             exists (
               select 1
                 from servicenow_incidents duplicate
                where duplicate.number::text = i.number::text
                  and duplicate.sys_id::text <> i.sys_id::text
             ) as identity_conflict
        from servicenow_incidents i
       where lower(i.sys_id::text) = $1
       limit 1`,
    values: [normalized],
  });
  const incident = result.rows?.[0] || null;
  return { incident, identity_conflict: Boolean(incident?.identity_conflict) };
}

export async function assertIncidentIdentitySafe(sysId, {
  query = withOneViewActionsQuery,
} = {}) {
  const result = await query((client) => readIncidentIdentityGuard(client, sysId));
  if (result.identity_conflict) {
    const error = new Error(INCIDENT_IDENTITY_CONFLICT_ERROR);
    error.code = INCIDENT_IDENTITY_CONFLICT_ERROR;
    throw error;
  }
  return result.incident;
}
