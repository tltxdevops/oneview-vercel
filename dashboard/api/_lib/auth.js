import { createRemoteJWKSet, jwtVerify } from "jose";
import { sendJson } from "./http.js";
import { sessionUserFromRequest, sessionUserFromToken } from "./microsoft-sso.js";

let jwks;

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function authRequired() {
  // Dados operacionais nunca são expostos sem uma sessão SSO validada.
  return true;
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function tenantId() {
  return process.env.AZURE_TENANT_ID || process.env.VITE_AZURE_TENANT_ID || "";
}

function clientId() {
  return process.env.AZURE_CLIENT_ID || process.env.VITE_AZURE_CLIENT_ID || "";
}

function getJwks() {
  if (!jwks) {
    const tenant = tenantId();
    jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  }
  return jwks;
}

function emailFromPayload(payload) {
  return String(payload.preferred_username || payload.email || payload.upn || "").toLowerCase();
}

function isAllowedViewer(email) {
  const allowedEmails = splitCsv(process.env.ONEVIEW_ALLOWED_EMAILS);
  const allowedDomains = splitCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS);
  if (allowedEmails.length && allowedEmails.includes(email)) return true;
  const domain = email.split("@")[1] || "";
  if (allowedDomains.length && allowedDomains.includes(domain)) return true;
  return allowedEmails.length === 0 && allowedDomains.length === 0;
}

function rolesFor(email) {
  const adminEmails = splitCsv(process.env.ONEVIEW_ADMIN_EMAILS);
  const operatorEmails = splitCsv(process.env.ONEVIEW_OPERATOR_EMAILS);
  const roles = new Set(["viewer"]);
  if (adminEmails.includes(email)) {
    roles.add("operator");
    roles.add("admin");
  }
  if (operatorEmails.includes(email) || process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS === "true") {
    roles.add("operator");
  }
  return roles;
}

function hasRole(roles, requiredRole) {
  if (requiredRole === "viewer") return roles.has("viewer");
  if (requiredRole === "operator") return roles.has("operator") || roles.has("admin");
  if (requiredRole === "admin") return roles.has("admin");
  return false;
}

async function verifyAzureToken(token) {
  const tenant = tenantId();
  const audience = clientId();
  if (!tenant || !audience) {
    throw new Error("oneview_auth_not_configured");
  }

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    audience,
  });
  if (payload.tid && String(payload.tid).toLowerCase() !== tenant.toLowerCase()) {
    throw new Error("oneview_auth_invalid_tenant");
  }
  return payload;
}

export async function requireAuth(req, res, { role = "viewer" } = {}) {
  if (!authRequired()) {
    const localAuth = {
      id: "local-dev",
      email: "local-dev@oneview",
      name: "local-dev",
      roles: ["viewer", "operator", "admin"],
      disabled: true,
    };
    req.oneviewAuth = localAuth;
    return localAuth;
  }

  const token = bearerToken(req);
  const sessionUser = sessionUserFromRequest(req) || sessionUserFromToken(token);
  if (sessionUser?.email) {
    const email = String(sessionUser.email).toLowerCase();
    if (!isAllowedViewer(email)) {
      sendJson(res, 403, { error: "user_not_allowed" });
      return null;
    }

    const roles = rolesFor(email);
    for (const roleName of sessionUser.roles || []) roles.add(roleName);
    if (!hasRole(roles, role)) {
      sendJson(res, 403, { error: "insufficient_role" });
      return null;
    }

    const auth = {
      id: String(sessionUser.id || email),
      email,
      name: String(sessionUser.name || email),
      roles: [...roles],
      source: "session",
    };
    req.oneviewAuth = auth;
    return auth;
  }

  if (!token) {
    sendJson(res, 401, { error: "authentication_required" });
    return null;
  }

  try {
    const payload = await verifyAzureToken(token);
    const email = emailFromPayload(payload);
    if (!email || !isAllowedViewer(email)) {
      sendJson(res, 403, { error: "user_not_allowed" });
      return null;
    }

    const roles = rolesFor(email);
    if (!hasRole(roles, role)) {
      sendJson(res, 403, { error: "insufficient_role" });
      return null;
    }

    const auth = {
      id: String(payload.oid || payload.sub || ""),
      email,
      name: String(payload.name || email),
      roles: [...roles],
      tenant_id: String(payload.tid || ""),
    };
    req.oneviewAuth = auth;
    return auth;
  } catch (error) {
    console.error("[api-auth]", error?.message || "invalid_token");
    sendJson(res, 401, { error: "invalid_token" });
    return null;
  }
}
