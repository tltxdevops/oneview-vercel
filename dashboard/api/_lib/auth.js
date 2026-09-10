import { createRemoteJWKSet, jwtVerify } from "jose";
import { sendJson } from "./http.js";
import { isAllowedRequestOrigin, sessionUserFromRequest } from "./microsoft-sso.js";

let jwks;
const ENTRA_APP_ROLES = Object.freeze({
  viewer: "OneView.Viewer",
  operator: "OneView.Operator",
  admin: "OneView.Admin",
});

function clean(value) {
  return String(value || "").trim();
}

function normalizedValues(value) {
  return (Array.isArray(value) ? value : []).map(clean).filter(Boolean);
}

function deny(res, error, details = {}) {
  console.warn(JSON.stringify({
    event: "oneview_auth_denied",
    reason: error,
    auth_source: details.auth_source || null,
  }));
  sendJson(res, 403, { error });
  return null;
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  return String(header).match(/^Bearer\s+(.+)$/i)?.[1] || "";
}

function tenantId() {
  return clean(process.env.MICROSOFT_TENANT_ID || process.env.AZURE_TENANT_ID || process.env.VITE_AZURE_TENANT_ID);
}

function clientId() {
  return clean(process.env.MICROSOFT_CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.VITE_AZURE_CLIENT_ID);
}

function getJwks() {
  if (!jwks) {
    const tenant = tenantId();
    jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  }
  return jwks;
}

function rolesFor(identity) {
  const entraRoles = new Set(normalizedValues(identity?.roles));
  // Production policy: every cryptographically validated Entra identity is
  // operational. App Roles remain trusted metadata; only Admin elevates.
  const roles = new Set(["viewer", "operator"]);
  const matchedAdminAppRole = entraRoles.has(ENTRA_APP_ROLES.admin);
  const matchedOperatorAppRole = entraRoles.has(ENTRA_APP_ROLES.operator);
  const matchedViewerAppRole = entraRoles.has(ENTRA_APP_ROLES.viewer);

  if (matchedAdminAppRole) roles.add("admin");
  return { roles, matchedAdminAppRole, matchedOperatorAppRole, matchedViewerAppRole };
}

function resolvedRole(roles) {
  if (roles.has("admin")) return "admin";
  if (roles.has("operator")) return "operator";
  return "viewer";
}

function requestRoute(req) {
  try { return new URL(String(req?.url || req?.originalUrl || "/"), "http://oneview.local").pathname; } catch { return "/"; }
}

function logRoleResolution(req, resolution) {
  console.info(JSON.stringify({
    event: "auth_role_resolution",
    authenticated: true,
    resolved_role: resolvedRole(resolution.roles),
    matched_app_role: resolution.matchedAdminAppRole || resolution.matchedOperatorAppRole,
    route: requestRoute(req),
    action: String(req?.method || "UNKNOWN").toUpperCase(),
  }));
}

function hasRole(roles, requiredRole) {
  if (requiredRole === "viewer") return roles.has("viewer");
  if (requiredRole === "operator") return roles.has("operator") || roles.has("admin");
  return requiredRole === "admin" && roles.has("admin");
}

async function verifyAzureToken(token) {
  const tenant = tenantId();
  const audience = clientId();
  if (!tenant || !audience) throw new Error("oneview_auth_not_configured");
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience,
  });
  if (clean(payload.tid).toLowerCase() !== tenant.toLowerCase()) throw new Error("oneview_auth_invalid_tenant");
  return payload;
}

function authorizeIdentity(req, res, identity, role, source) {
  const oid = clean(identity?.oid);
  if (!oid) return deny(res, "identity_not_allowed", { auth_source: source });
  if (!isAllowedRequestOrigin(req)) return deny(res, "origin_not_allowed", { auth_source: source });

  const resolution = rolesFor(identity);
  logRoleResolution(req, resolution);
  if (!hasRole(resolution.roles, role)) {
    return deny(res, role === "viewer" ? "authentication_required" : "operator_required", { auth_source: source });
  }
  const auth = {
    id: oid,
    oid,
    tid: clean(identity?.tid),
    sub: clean(identity?.sub),
    name: clean(identity?.name) || oid,
    preferred_username: clean(identity?.preferred_username || identity?.username || identity?.email),
    email: clean(identity?.email).toLowerCase(),
    roles: [...resolution.roles],
    source,
  };
  req.oneviewAuth = auth;
  return auth;
}

/** Canonical server-side actor for future human mutations/audit trails. */
export function getAuthenticatedActor(req) {
  const auth = req?.oneviewAuth;
  if (!auth?.oid) return null;
  return Object.freeze({
    actor_id: auth.oid,
    actor_name: auth.name || auth.oid,
    actor_username: auth.preferred_username || auth.email || "",
    actor_role: auth.roles?.includes("admin") ? "admin" : auth.roles?.includes("operator") ? "operator" : "viewer",
  });
}

export async function requireAuth(req, res, { role = "viewer" } = {}) {
  const token = bearerToken(req);
  const sessionUser = sessionUserFromRequest(req);
  if (sessionUser?.oid) return authorizeIdentity(req, res, sessionUser, role, "session");
  if (!token) { sendJson(res, 401, { error: "authentication_required" }); return null; }
  try {
    const payload = await verifyAzureToken(token);
    return authorizeIdentity(req, res, {
      oid: clean(payload.oid), tid: clean(payload.tid), sub: clean(payload.sub),
      name: clean(payload.name), preferred_username: clean(payload.preferred_username),
      email: normalizeEmail(payload.preferred_username || payload.email || payload.upn),
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      groups: Array.isArray(payload.groups) ? payload.groups : [],
    }, role, "bearer");
  } catch (error) {
    console.error("[api-auth]", error?.message || "invalid_token");
    sendJson(res, 401, { error: "invalid_token" });
    return null;
  }
}
