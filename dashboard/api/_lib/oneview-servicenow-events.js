/**
 * OV-P0-245 — authenticated ServiceNow push ingress.
 *
 * Polling remains the production reconciliation path. This handler only
 * accepts a future server-to-server push and writes the same PostgreSQL read
 * model. It never makes an HTTP request to ServiceNow and never exposes a
 * source payload in its response or logs.
 */
import { timingSafeEqual } from "node:crypto";

import { methodNotAllowed, sendJson } from "./http.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";
import {
  extractServiceNowDisplay,
  normalizeServiceNowIncident,
  SERVICENOW_INCIDENT_FIELDS,
} from "./servicenow-normalize.js";

const SYS_ID_PATTERN = /^[a-f0-9]{32}$/i;
const INCIDENT_NUMBER_PATTERN = /^INC\d{1,32}$/i;

const PERSISTED_INCIDENT_FIELDS = Object.freeze([
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "caller_id",
  "assigned_to",
  "assignment_group",
  "company",
  "contact_type",
  "opened_at",
  "resolved_at",
  "closed_at",
  "sys_created_on",
  "sys_updated_on",
  "correlation_id",
  "u_hostname_zabbix",
  "u_ip_zabbix",
]);

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function authorization(req) {
  const value = req?.headers?.authorization ?? req?.headers?.Authorization ?? "";
  return Array.isArray(value) ? String(value[0] || "") : String(value);
}

function fixedEquals(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bodyObject(req) {
  if (!req?.body) return null;
  if (typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try {
    const parsed = JSON.parse(String(req.body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sourceDate(value) {
  const raw = text(value);
  if (!raw) return null;
  // ServiceNow Table API commonly emits `YYYY-MM-DD HH:mm:ss` in UTC.
  const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(" ", "T")}Z`
    : raw;
  const timestamp = Date.parse(canonical);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function displayValues(raw) {
  const values = {};
  for (const field of SERVICENOW_INCIDENT_FIELDS) {
    const direct = text(raw?.[`${field}_display`]);
    const display = direct || extractServiceNowDisplay(raw?.[field]);
    if (display) values[field] = display;
  }
  return values;
}

export function getServiceNowEventsConfig(env = process.env) {
  return Object.freeze({
    secret: text(env.SERVICENOW_EVENTS_SECRET),
  });
}

export function internalServiceNowEventsAuthorized(req, config = getServiceNowEventsConfig()) {
  if (!config.secret) return false;
  return fixedEquals(authorization(req), `Bearer ${config.secret}`);
}

/**
 * Converts one exact ServiceNow incident record into the existing canonical
 * read-model columns. Raw source stays in raw_payload; unknown future fields
 * are deliberately not fabricated into columns.
 */
export function normalizeServiceNowEventPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error("invalid_payload");
    error.code = "invalid_payload";
    throw error;
  }

  const normalized = normalizeServiceNowIncident(raw);
  const sysId = text(normalized.sys_id)?.toLowerCase() || null;
  const number = text(normalized.number)?.toUpperCase() || null;
  const sysUpdatedOn = sourceDate(normalized.sys_updated_on);

  if (!sysId || !SYS_ID_PATTERN.test(sysId)) {
    const error = new Error("invalid_sys_id");
    error.code = "invalid_payload";
    throw error;
  }
  if (!number || !INCIDENT_NUMBER_PATTERN.test(number)) {
    const error = new Error("invalid_number");
    error.code = "invalid_payload";
    throw error;
  }
  if (!sysUpdatedOn) {
    const error = new Error("invalid_sys_updated_on");
    error.code = "invalid_payload";
    throw error;
  }

  const values = {
    ...normalized,
    sys_id: sysId,
    number,
    opened_at: sourceDate(normalized.opened_at),
    resolved_at: sourceDate(normalized.resolved_at),
    closed_at: sourceDate(normalized.closed_at),
    sys_created_on: sourceDate(normalized.sys_created_on),
    sys_updated_on: sysUpdatedOn,
    display_values: displayValues(raw),
    raw_payload: raw,
  };
  return values;
}

function incidentWriteValues(incident, now) {
  return [
    ...PERSISTED_INCIDENT_FIELDS.map((field) => incident[field] ?? null),
    JSON.stringify(incident.display_values || {}),
    JSON.stringify(incident.raw_payload),
    now,
    now,
    now,
  ];
}

export async function upsertServiceNowIncidentEvent(client, incident, now = new Date()) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [incident.sys_id]);
  const existingResult = await client.query(
    "select sys_id, sys_updated_on from servicenow_incidents where sys_id = $1 for update",
    [incident.sys_id],
  );
  const existing = existingResult.rows?.[0] || null;
  const incomingTimestamp = Date.parse(incident.sys_updated_on);
  const existingTimestamp = Date.parse(String(existing?.sys_updated_on || ""));

  if (existing && Number.isFinite(existingTimestamp)) {
    if (incomingTimestamp < existingTimestamp) return { status: "stale", sys_id: incident.sys_id };
    if (incomingTimestamp === existingTimestamp) return { status: "idempotent", sys_id: incident.sys_id };
  }

  const columns = [...PERSISTED_INCIDENT_FIELDS, "display_values", "raw_payload", "synced_at", "created_at", "updated_at"];
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const updates = [...PERSISTED_INCIDENT_FIELDS.filter((field) => field !== "sys_id"), "display_values", "raw_payload", "synced_at", "updated_at"]
    .map((field) => `${field} = excluded.${field}`)
    .join(", ");
  const result = await client.query(
    `insert into servicenow_incidents (${columns.join(", ")})
     values (${placeholders})
     on conflict (sys_id) do update set ${updates}
     where servicenow_incidents.sys_updated_on is null
        or excluded.sys_updated_on > servicenow_incidents.sys_updated_on
     returning sys_id`,
    incidentWriteValues(incident, now),
  );

  // Advisory + row lock above make this only reachable for a concurrent equal
  // version race; report it as idempotent instead of creating a second record.
  return {
    status: existing ? (result.rows?.length ? "updated" : "idempotent") : "created",
    sys_id: incident.sys_id,
  };
}

function publicDatabaseError(error) {
  return error?.code === "actions_database_not_configured"
    ? "actions_database_not_configured"
    : "database_unavailable";
}

export function createServiceNowEventsHandler({
  configProvider = getServiceNowEventsConfig,
  transaction = withOneViewActionsTransaction,
  now = () => new Date(),
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function serviceNowEventsHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

    const config = configProvider();
    if (!config.secret) return sendJson(res, 503, { error: "servicenow_events_not_configured" });
    if (!internalServiceNowEventsAuthorized(req, config)) {
      return sendJson(res, 401, { error: "authentication_required" });
    }

    let incident;
    try {
      incident = normalizeServiceNowEventPayload(bodyObject(req));
    } catch {
      return sendJson(res, 400, { error: "invalid_payload" });
    }

    try {
      const result = await transaction((client) => upsertServiceNowIncidentEvent(client, incident, now()));
      const status = result.status === "stale" ? 409 : 200;
      logger({
        event: "servicenow_event_ingested",
        route: "/api/internal/servicenow-events",
        outcome: result.status,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return sendJson(res, status, { status: result.status, sys_id: result.sys_id });
    } catch (error) {
      const code = publicDatabaseError(error);
      logger({
        event: "servicenow_event_ingested",
        route: "/api/internal/servicenow-events",
        outcome: "failed",
        code,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return sendJson(res, 503, { error: code });
    }
  };
}

export default createServiceNowEventsHandler();
