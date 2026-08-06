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

function deny(res, error, details = {}) {
  // OV-P0-16B temporary safe diagnostic: never log email, token, cookie or secrets.
  console.warn(JSON.stringify({
    event: "oneview_auth_denied",
    reason: error,
    claim: details.claim || null,
    received_domain: details.received_domain || null,
    allowed_domains: details.allowed_domains || null,
    auth_source: details.auth_source || null,
  }));
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
  // Precedência Azure ID token (Bearer MSAL/Azure): preferred_username → email → upn.
  // unique_name e name NÃO são usados para autorização de domínio.
  if (payload?.preferred_username) return { email: normalizeEmail(payload.preferred_username), claim: "preferred_username" };
  if (payload?.email) return { email: normalizeEmail(payload.email), claim: "email" };
  if (payload?.upn) return { email: normalizeEmail(payload.upn), claim: "upn" };
  return { email: "", claim: "none" };
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
  const claim = identity?.emailClaim || identity?.email_claim || (source === "session" ? "session.email" : "unknown");
  const allowed = allowedEmailDomains();
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";

  if (!email) {
    return deny(res, "email_not_allowed", {
      claim,
      received_domain: null,
      allowed_domains: allowed,
      auth_source: source,
    });
  }

  if (!domain || !allowed.includes(domain)) {
    return deny(res, "domain_not_allowed", {
      claim,
      received_domain: domain || null,
      allowed_domains: allowed,
      auth_source: source,
    });
  }

  // A sessão server-side só é emitida depois do SSO no tenant configurado;
  // o Microsoft Entra aplica a atribuição ao aplicativo durante esse login.
  if (!isAllowedRequestOrigin(req)) {
    return deny(res, "origin_not_allowed", {
      claim,
      received_domain: domain,
      allowed_domains: allowed,
      auth_source: source,
    });
  }

  // Cookies antigos não concedem permissão operacional. A liberação
  // de ações vem exclusivamente da flag geral server-side.
  const roles = rolesFor();
  if (!hasRole(roles, role)) {
    return deny(res, role === "operator" || role === "admin" ? "operator_required" : "email_not_allowed", {
      claim,
      received_domain: domain,
      allowed_domains: allowed,
      auth_source: source,
    });
  }

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
    const { email, claim } = emailFromPayload(payload);
    return authorizeIdentity(req, res, {
      id: String(payload.oid || payload.sub || ""),
      email,
      emailClaim: claim,
      name: String(payload.name || email),
      roles: [],
    }, role, "bearer");
  } catch (error) {
    console.error("[api-auth]", error?.message || "invalid_token");
    sendJson(res, 401, { error: "invalid_token" });
    return null;
  }
}
