import { insertAuditLog } from "./audit.js";
import { getAuthenticatedActor } from "./auth.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { withOneViewActionsTransaction } from "./oneview-actions-db.js";
import {
  AILOS_TEAMS_DESTINATION_ID,
  clientShareAuditRecord,
  clientShareDestinationCatalog,
  clientShareIdempotencyKey,
  clientShareMessageContract,
  clientSharePreview,
  clientShareResultAuditRecord,
  clientShareSmokeAuditRecord,
  classifyClientShareOutcome,
  findEnabledClientShareDestination,
  isAilosTeamsLiveDestination,
  isAilosTeamsSmokeDestination,
  isClientSharingEnabled,
  publicClientShareDestination,
  resolveClientShareRoute,
  teamsWorkflowWebhookConfigError,
} from "./oneview-client-sharing.js";
import { sendTeamsClientShare, sendWebexClientShare, TEAMS_TRANSPORT_STRATEGY, teamsWorkflowAlertPayload, teamsWorkflowSmokePayload } from "./oneview-client-sharing-transports.js";

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
function isSmokeRequest(req) {
  return String(req.query?.smoke || "").trim() === "1";
}
function publicResolution(resolution) {
  return {
    selection: resolution.selection,
    selected_destination_id: resolution.selected?.destination_id || null,
    requires_selection: Boolean(resolution.requires_selection),
    reason: resolution.reason,
  };
}
function publicDelivery(delivery, { live = false } = {}) {
  const transport = delivery?.transport === "webex" ? "webex" : "teams";
  if (!live) {
    return {
      transport,
      strategy: transport === "teams" ? TEAMS_TRANSPORT_STRATEGY : null,
      status: "dry_run",
      destination_id: typeof delivery?.destination_id === "string" ? delivery.destination_id : null,
      external_called: false,
    };
  }
  const outcome = classifyClientShareOutcome(delivery, { live: true });
  return {
    transport,
    strategy: transport === "teams" ? TEAMS_TRANSPORT_STRATEGY : null,
    status: outcome.status,
    destination_id: typeof delivery?.destination_id === "string" ? delivery.destination_id : null,
    external_called: Boolean(delivery?.external_called),
    http_status: Number.isInteger(delivery?.http_status) ? delivery.http_status : null,
    ambiguous: outcome.ambiguous,
    teams_response: typeof delivery?.teams_response === "string" ? delivery.teams_response : null,
  };
}
function publicError(error) {
  return PUBLIC_ERRORS.has(error?.code) ? error.code : "client_share_unavailable";
}
function liveSendFor(resolution, env) {
  const id = resolution?.selectedInternal?.destination_id || resolution?.selected?.destination_id;
  return isAilosTeamsLiveDestination(id, env);
}

function auditLogInput(record, extra = {}) {
  return {
    ...record,
    actorName: record.actor_name,
    actorId: record.actor_id,
    entityType: record.entity_type,
    entityId: record.entity_id,
    ...extra,
  };
}

export function createClientSharingHandler({
  authorize = (req, res, role) => requireOneViewAuth(req, res, role),
  env = process.env,
  enabled = () => isClientSharingEnabled(env),
  catalog = () => clientShareDestinationCatalog(env),
  resolve = resolveClientShareRoute,
  transaction = withOneViewActionsTransaction,
  audit = insertAuditLog,
  teams = sendTeamsClientShare,
  webex = sendWebexClientShare,
} = {}) {
  return async function clientSharingHandler(req, res) {
    const mode = String(req.query?.mode || "").toLowerCase();
    const method = String(req.method || "").toUpperCase();
    const smoke = isSmokeRequest(req);
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
        const liveSend = liveSendFor(resolution, env);
        return sendJson(res, 200, { destinations: resolution.destinations, resolution: publicResolution(resolution), external_enabled: enabled() || liveSend, live_send: liveSend });
      }

      const request = body(req);
      if (smoke) {
        const idempotencyKey = clientShareIdempotencyKey(request.idempotency_key);
        if (!isAilosTeamsSmokeDestination(request.destination_id)) {
          return sendJson(res, 403, { error: "smoke_destination_not_allowed", dry_run: true });
        }
        const destination = findEnabledClientShareDestination(AILOS_TEAMS_DESTINATION_ID, items);
        const webhookError = teamsWorkflowWebhookConfigError(destination.destination_id, env, items);
        if (webhookError) {
          return sendJson(res, 422, { error: webhookError, dry_run: true, destination_id: destination.destination_id });
        }
        const reserved = await transaction(async (client) => {
          await client.query("select pg_advisory_xact_lock(hashtext($1))", [`client-share-smoke:${idempotencyKey}`]);
          const previous = await client.query(
            "select id from audit_logs where action = $1 and metadata->>'idempotency_key' = $2 limit 1",
            ["client_share_smoke", idempotencyKey],
          );
          if (previous.rowCount) return { duplicate: true };
          await audit(client, auditLogInput(clientShareSmokeAuditRecord({
            actor: actor(auth, req),
            destination,
            idempotencyKey,
            delivery: { status: "reserved", http_status: null, external_called: false, ambiguous: false },
          }), { req, actorType: "user", actionSource: "oneview_client_sharing_smoke" }));
          return { duplicate: false };
        });
        if (reserved.duplicate) {
          return sendJson(res, 200, { dry_run: false, smoke: true, duplicate: true, deliveries: [], idempotency_key: idempotencyKey });
        }
        let delivery;
        try {
          delivery = await teams({
            destination,
            live: true,
            payload: teamsWorkflowSmokePayload(),
            env,
          });
        } catch {
          delivery = {
            transport: "teams",
            status: "definite_failure",
            destination_id: destination.destination_id,
            external_called: false,
            ambiguous: false,
          };
        }
        const outcome = classifyClientShareOutcome(delivery, { live: true });
        try {
          await transaction(async (client) => {
            await audit(client, auditLogInput(clientShareResultAuditRecord({
              actor: actor(auth, req),
              destination,
              idempotencyKey,
              status: outcome.status,
              error: outcome.status === "sent" ? null : (delivery?.status || outcome.status),
              delivery,
              action: outcome.resultAction,
            }), { req, actorType: "user", actionSource: "oneview_client_sharing_smoke" }));
          });
        } catch {
          /* reservation already committed */
        }
        return sendJson(res, 200, {
          dry_run: false,
          smoke: true,
          duplicate: false,
          deliveries: [publicDelivery(delivery, { live: true })],
          idempotency_key: idempotencyKey,
        });
      }

      const message = clientShareMessageContract(request.message);
      if (mode === "preview") {
        const resolution = resolve({
          clientKey: message.client_key,
          routeKey: message.route_key,
          destinationId: request.destination_id,
          catalog: items,
        });
        const liveSend = liveSendFor(resolution, env);
        return sendJson(res, 200, {
          message,
          destinations: resolution.destinations,
          resolution: publicResolution(resolution),
          destination: resolution.selected,
          preview: clientSharePreview(message, resolution.selected),
          external_enabled: enabled() || liveSend,
          live_send: liveSend,
        });
      }

      const idempotencyKey = clientShareIdempotencyKey(request.idempotency_key);
      const resolution = resolve({
        clientKey: message.client_key,
        routeKey: message.route_key,
        destinationId: request.destination_id,
        catalog: items,
      });
      const destination = resolution.selectedInternal;
      const ailosPilot = isAilosTeamsSmokeDestination(destination?.destination_id);
      const live = ailosPilot && isAilosTeamsLiveDestination(destination?.destination_id, env);
      if (!enabled() && !ailosPilot) return sendJson(res, 403, { error: "client_sharing_disabled", dry_run: true });
      if (ailosPilot) {
        const webhookError = teamsWorkflowWebhookConfigError(destination.destination_id, env, items);
        if (webhookError) return sendJson(res, 422, { error: webhookError, dry_run: true, destination_id: destination.destination_id });
      }
      if (resolution.reason === "no_destination") return sendJson(res, 422, { error: "client_destination_not_configured", dry_run: true });
      if (resolution.requires_selection || !destination) return sendJson(res, 422, { error: "destination_selection_required", dry_run: true });

      const currentActor = actor(auth, req);
      const reserved = await transaction(async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`client-share:${idempotencyKey}`]);
        const previous = await client.query(
          "select id from audit_logs where action = $1 and metadata->>'idempotency_key' = $2 limit 1",
          ["client_share_requested", idempotencyKey],
        );
        if (previous.rowCount) return { duplicate: true };
        await audit(client, auditLogInput(clientShareAuditRecord({
          actor: currentActor,
          message,
          destination: publicClientShareDestination(destination),
          idempotencyKey,
          status: "reserved",
          live,
        }), { req, actorType: "user", actionSource: "oneview_client_sharing" }));
        return { duplicate: false };
      });
      if (reserved.duplicate) {
        return sendJson(res, 200, { dry_run: !live, live_send: live, duplicate: true, deliveries: [], idempotency_key: idempotencyKey });
      }

      let delivery = null;
      try {
        if (destination.channel_type === "teams") {
          delivery = await teams({
            message,
            destination,
            live,
            payload: live ? teamsWorkflowAlertPayload(message) : undefined,
            env,
          });
        }
        if (destination.channel_type === "webex") delivery = await webex({ message, destination });
      } catch {
        delivery = {
          transport: destination.channel_type === "webex" ? "webex" : "teams",
          status: "definite_failure",
          destination_id: destination.destination_id,
          external_called: false,
          ambiguous: false,
        };
      }

      const outcome = classifyClientShareOutcome(delivery, { live });
      try {
        await transaction(async (client) => {
          await audit(client, auditLogInput(clientShareResultAuditRecord({
            actor: currentActor,
            message,
            destination: publicClientShareDestination(destination),
            idempotencyKey,
            status: outcome.status,
            error: outcome.status === "sent" || outcome.status === "dry_run" ? null : (delivery?.status || outcome.status),
            delivery: live ? delivery : null,
            action: outcome.resultAction,
          }), { req, actorType: "user", actionSource: "oneview_client_sharing" }));
        });
      } catch {
        /* reservation already committed — do not release the key */
      }

      return sendJson(res, 200, {
        dry_run: !live,
        live_send: live,
        duplicate: false,
        deliveries: delivery ? [publicDelivery(delivery, { live })] : [],
        idempotency_key: idempotencyKey,
      });
    } catch (error) {
      return sendJson(res, 400, { error: publicError(error), dry_run: true });
    }
  };
}
