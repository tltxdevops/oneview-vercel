/** Backend-only ServiceNow identity capability endpoint. No incident mutation. */
import { getAuthenticatedActor } from "./auth.js";
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  SERVICENOW_IDENTITY_ERROR,
  createServiceNowIdentityResolver,
  publicServiceNowIdentityError,
} from "./oneview-servicenow-identity.js";

function responseStatus(errorCode) {
  if (errorCode === SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND) return 404;
  if (errorCode === SERVICENOW_IDENTITY_ERROR.USER_AMBIGUOUS) return 409;
  if (errorCode === SERVICENOW_IDENTITY_ERROR.USER_INACTIVE) return 403;
  return 503;
}

export function createServiceNowMeHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  actorProvider = getAuthenticatedActor,
  resolver = createServiceNowIdentityResolver(),
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  return async function serviceNowMeHandler(req, res) {
    const startedAt = now();
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res)) return;

    const actor = actorProvider(req);
    if (!actor?.actor_id || !actor?.actor_username) {
      return sendJson(res, 401, { available: false, error: "authentication_required" });
    }

    try {
      const identity = await resolver.resolveOperationalServiceNowIdentity(actor);
      const payload = {
        available: true,
        service_now_user: {
          name: identity.user.name || identity.user.email,
          email: identity.user.email,
        },
        noc_member: identity.noc_member,
        ...(identity.noc_member ? {} : { error: SERVICENOW_IDENTITY_ERROR.NOC_MEMBERSHIP_REQUIRED }),
      };
      logger({
        event: "oneview_servicenow_identity",
        action: "resolve_me",
        status: 200,
        cache_hit: Boolean(identity.cache.user.cacheHit && identity.cache.membership.cacheHit),
        result: identity.noc_member ? "noc_member" : "noc_membership_required",
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, 200, payload);
    } catch (error) {
      const errorCode = publicServiceNowIdentityError(error);
      const status = responseStatus(errorCode);
      logger({
        event: "oneview_servicenow_identity",
        action: "resolve_me",
        status,
        cache_hit: false,
        result: errorCode,
        latency_ms: Math.max(0, now() - startedAt),
      });
      return sendJson(res, status, { available: false, error: errorCode });
    }
  };
}

export default createServiceNowMeHandler();
