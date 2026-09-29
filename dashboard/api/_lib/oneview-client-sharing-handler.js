import { insertAuditLog } from "./audit.js";
import { getAuthenticatedActor } from "./auth.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";
import {
  clientShareAuditRecord,
  clientShareDestinationCatalog,
  clientShareIdempotencyKey,
  clientShareMessageContract,
  clientSharePreview,
  isClientSharingEnabled,
  publicClientShareDestination,
  resolveClientShareRoute,
} from "./oneview-client-sharing.js";
import { sendTeamsClientShare, sendWebexClientShare, TEAMS_TRANSPORT_STRATEGY } from "./oneview-client-sharing-transports.js";

const PUBLIC_ERRORS = new Set(["invalid_idempotency_key", "invalid_client_share_message", "invalid_destination_id"]);

function body(req) {
  if (req?.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try { return JSON.parse(String(req?.body || "{}")); } catch { return {}; }
}
function value(req, key) { const raw = req?.query?.[key]; return typeof (Array.isArray(raw) ? raw[0] : raw) === "string" ? (Array.isArray(raw) ? raw[0] : raw).trim() : ""; }
function actor(auth, req) {
  const source = getAuthenticatedActor(req) || auth || {};
  return { id: String(source.id || source.oid || "").trim(), name: String(source.name || source.email || "OneView operator").trim() };
}
function publicResolution(resolution) {
  return {
    selection: resolution.selection,
    selected_destination_id: resolution.selected?.destination_id || null,
    requires_selection: Boolean(resolution.requires_selection),
    reason: resolution.reason,
  };
}
function publicDelivery(delivery) {
  const transport = delivery?.transport === "webex" ? "webex" : "teams";
  return {
    transport,
    strategy: transport === "teams" ? TEAMS_TRANSPORT_STRATEGY : null,
    status: "dry_run",
    destination_id: typeof delivery?.destination_id === "string" ? delivery.destination_id : null,
    external_called: false,
  };
}
function publicError(error) {
  return PUBLIC_ERRORS.has(error?.code) ? error.code : "client_share_unavailable";
}

export function createClientSharingHandler({
  authorize = (req, res, role) => requireOneViewAuth(req, res, role),
  enabled = () => isClientSharingEnabled(),
  catalog = clientShareDestinationCatalog,
  resolve = resolveClientShareRoute,
  transaction = withOneViewActionsTransaction,
  audit = insertAuditLog,
  teams = sendTeamsClientShare,
  webex = sendWebexClientShare,
} = {}) {
  return async function clientSharingHandler(req, res) {
    const mode = String(req.query?.mode || "").toLowerCase();
    const method = String(req.method || "").toUpperCase();
    const requiredRole = mode === "destinations" ? "viewer" : "operator";
    if ((mode === "destinations" && method !== "GET") || (mode !== "destinations" && method !== "POST")) {
      return methodNotAllowed(res, [mode === "destinations" ? "GET" : "POST"]);
    }
    const auth = await authorize(req, res, requiredRole);
    if (!auth) return;

    try {
      const items = typeof catalog === "function" ? catalog() : [];
      if (mode === "destinations") {
        const resolution = resolve({ clientKey: value(req, "client_key"), routeKey: value(req, "route_key"), catalog: items });
        return sendJson(res, 200, { destinations: resolution.destinations, resolution: publicResolution(resolution), external_enabled: enabled() });
      }

      const request = body(req);
      const message = clientShareMessageContract(request.message);
      if (mode === "preview") {
        const resolution = resolve({
          clientKey: message.client_key,
          routeKey: message.route_key,
          destinationId: request.destination_id,
          catalog: items,
        });
        return sendJson(res, 200, {
          message,
          destinations: resolution.destinations,
          resolution: publicResolution(resolution),
          destination: resolution.selected,
          preview: clientSharePreview(message, resolution.selected),
          external_enabled: enabled(),
        });
      }

      const idempotencyKey = clientShareIdempotencyKey(request.idempotency_key);
      if (!enabled()) return sendJson(res, 403, { error: "client_sharing_disabled", dry_run: true });

      const resolution = resolve({
        clientKey: message.client_key,
        routeKey: message.route_key,
        destinationId: request.destination_id,
        catalog: items,
      });
      if (resolution.reason === "no_destination") return sendJson(res, 422, { error: "client_destination_not_configured", dry_run: true });
      if (resolution.requires_selection || !resolution.selectedInternal) return sendJson(res, 422, { error: "destination_selection_required", dry_run: true });

      const destination = resolution.selectedInternal;
      const result = await transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`client-share:${idempotencyKey}`]);
        const previous = await client.query(
          "select id from audit_logs where action = $1 and metadata->>'idempotency_key' = $2 limit 1",
          ["client_share_requested", idempotencyKey],
        );
        if (previous.rowCount) return { duplicate: true, deliveries: [] };
        const auditRecord = clientShareAuditRecord({
          actor: actor(auth, req),
          message,
          destination: publicClientShareDestination(destination),
          idempotencyKey,
          status: "dry_run",
        });
        await audit(client, { ...auditRecord, req, actorType: "user", actionSource: "oneview_client_sharing" });
        const deliveries = [];
        if (destination.channel_type === "teams") deliveries.push(publicDelivery(await teams({ message, destination })));
        if (destination.channel_type === "webex") deliveries.push(publicDelivery(await webex({ message, destination })));
        return { duplicate: false, deliveries };
      });
      return sendJson(res, 200, { dry_run: true, ...result, idempotency_key: idempotencyKey });
    } catch (error) {
      return sendJson(res, 400, { error: publicError(error), dry_run: true });
    }
  };
}
