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

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (!domain || domain.startsWith("@") || domain.includes("/") || domain.includes(":") || domain.includes("@")) {
    return "";
  }
  return domain;
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
  return normalizeEmail(payload.preferred_username || payload.email || payload.upn);
}

function viewerAccess(email) {
  const allowedEmails = splitCsv(process.env.ONEVIEW_ALLOWED_EMAILS);
  const operatorEmails = splitCsv(process.env.ONEVIEW_OPERATOR_EMAILS);
  const adminEmails = splitCsv(process.env.ONEVIEW_ADMIN_EMAILS);
  const configuredDomainValues = splitCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS);
  const configuredDomains = configuredDomainValues.map(normalizeDomain).filter(Boolean);
  const normalizedEmail = normalizeEmail(email);
  const directlyAllowed = new Set([...allowedEmails, ...operatorEmails, ...adminEmails]);

  if (directlyAllowed.has(normalizedEmail)) return { allowed: true, reason: null };
  const domain = normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1);
  if (configuredDomains.includes(domain)) return { allowed: true, reason: null };

  // Lista vazia nunca libera acesso por acidente. Uma lista vazia isolada nÃ£o
  // bloqueia outra regra vÃ¡lida, como o domÃ­nio corporativo configurado.
  return {
    allowed: false,
    reason: configuredDomains.length > 0 ? "domain_not_allowed" : "email_not_allowed",
  };
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

function authorizeIdentity(req, res, identity, role, source) {
  const email = normalizeEmail(identity?.email);
  if (!email) return deny(res, "email_not_allowed");

  const viewer = viewerAccess(email);
  if (!viewer.allowed) return deny(res, viewer.reason);
  if (!isAllowedRequestOrigin(req)) return deny(res, "origin_not_allowed");

  const roles = rolesFor(email);
  for (const roleName of identity?.roles || []) roles.add(roleName);
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
