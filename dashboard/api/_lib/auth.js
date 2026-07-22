import { createRemoteJWKSet, jwtVerify } from "jose";
import { sendJson } from "./http.js";
import { isAllowedRequestOrigin, sessionUserFromRequest, sessionUserFromToken } from "./microsoft-sso.js";

let jwks;

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function deny(res, error) {
  // Runtime diagnostic intentionally contains only a stable reason.
  console.warn(JSON.stringify({ event: "oneview_auth_denied", reason: error }));
  sendJson(res, 403, { error });
  return null;
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
  return process.env.MICROSOFT_TENANT_ID || process.env.AZURE_TENANT_ID || process.env.VITE_AZURE_TENANT_ID || "";
}

function clientId() {
  return process.env.MICROSOFT_CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.VITE_AZURE_CLIENT_ID || "";
}

function getJwks() {
  if (!jwks) {
    const tenant = tenantId();
    jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  }
  return jwks;
}

function emailFromPayload(payload) {
  return normalizeEmail(payload.preferred_username || payload.email || payload.upn);
}

function allowedEmailDomains() {
  return splitCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS)
    .map((domain) => domain.replace(/^@+/, ""))
    .filter(Boolean);
}

function rolesFor() {
  const roles = new Set(["viewer"]);
  if (String(process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS || "").trim().toLowerCase() === "true") {
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

function authorizeIdentity(req, res, identity, role, source) {
  const email = normalizeEmail(identity?.email);
  if (!email) return deny(res, "email_not_allowed");

  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
  if (!domain || !allowedEmailDomains().includes(domain)) return deny(res, "domain_not_allowed");

  // A sessão server-side só é emitida depois do SSO no tenant configurado;
  // o Microsoft Entra aplica a atribuição ao aplicativo durante esse login.
  if (!isAllowedRequestOrigin(req)) return deny(res, "origin_not_allowed");

  // Cookies antigos não concedem permissão operacional. A liberação
  // de ações vem exclusivamente da flag geral server-side.
  const roles = rolesFor();
  if (!hasRole(roles, role)) return deny(res, role === "operator" || role === "admin" ? "operator_required" : "email_not_allowed");

  const auth = {
    id: String(identity?.id || email),
    email,
    name: String(identity?.name || email),
    roles: [...roles],
    source,
  };
  req.oneviewAuth = auth;
  return auth;
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
    return authorizeIdentity(req, res, sessionUser, role, "session");
  }

  if (!token) {
    sendJson(res, 401, { error: "authentication_required" });
    return null;
  }

  try {
    const payload = await verifyAzureToken(token);
    const email = emailFromPayload(payload);
    return authorizeIdentity(req, res, {
      id: String(payload.oid || payload.sub || ""),
      email,
      name: String(payload.name || email),
      roles: [],
    }, role, "bearer");
  } catch (error) {
    console.error("[api-auth]", error?.message || "invalid_token");
    sendJson(res, 401, { error: "invalid_token" });
    return null;
  }
}
