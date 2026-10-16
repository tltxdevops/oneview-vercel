import { methodNotAllowed, sendJson } from "../_lib/http.js";
import { requireOneViewAuth } from "../_lib/oneview-auth.js";
import {
  authorizeMaintenanceCreate,
  maintenanceHistoryIntent,
  maintenanceWritesEnabled,
  planMaintenanceOperations,
  validateMaintenanceDraft,
  ZABBIX_MAINTENANCE_COMPATIBILITY,
} from "../_lib/oneview-maintenance.js";

const MAX_BODY_BYTES = 16_384;

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return sendJson(res, status, payload);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request_body_too_large");
      error.code = "request_body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
    return parsed;
  } catch (error) {
    if (error?.code === "request_body_too_large") throw error;
    const invalid = new Error("invalid_body");
    invalid.code = "invalid_query";
    throw invalid;
  }
}

function catalog() {
  return {
    writes_enabled: maintenanceWritesEnabled(),
    read_status: "not_loaded",
    read_reason: "maintenance.get não é chamado neste passo. A lista de janelas não foi inventada.",
    items: [],
    active: [],
    scheduled: [],
    closed: [],
    compatibility: Object.entries(ZABBIX_MAINTENANCE_COMPATIBILITY).map(([datasource, item]) => ({
      datasource,
      expected_version: item.expected_version,
      maintenance_get: item.maintenance_get,
      maintenance_create: item.maintenance_create,
      write_ready: false,
      note: "Versão esperada. A versão ao vivo deste Zabbix ainda não foi confirmada.",
    })),
  };
}

export default async function maintenances(req, res) {
  const actor = await requireOneViewAuth(req, res, "viewer");
  if (!actor) return undefined;
  if (req.method === "GET") return send(res, 200, catalog());
  if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  try {
    const body = await readBody(req);
    const action = String(body.action || "");
    if (action === "delete") return send(res, 403, { error: "maintenance_delete_not_approved" });
    if (action !== "preview" && action !== "create") return send(res, 400, { error: "invalid_query" });
    const draft = validateMaintenanceDraft(body);
    const decision = authorizeMaintenanceCreate({ email: actor.email });
    const operations = planMaintenanceOperations(draft, { writesEnabled: decision.allowed });
    const payload = {
      accepted: false,
      can_confirm: false,
      authorization: decision.reason,
      operations,
      history: maintenanceHistoryIntent(draft, actor.email),
      reminders: [],
      reminders_status: "waiting_for_maintenanceid",
    };
    if (action === "create") {
      return send(res, 403, { error: decision.reason || operations[0]?.blockers?.[0] || "maintenance_not_confirmed", ...payload });
    }
    return send(res, 200, payload);
  } catch (error) {
    const status = error?.code === "request_body_too_large" ? 413 : 400;
    return send(res, status, { error: error?.reason || error?.code || "invalid_query" });
  }
}
