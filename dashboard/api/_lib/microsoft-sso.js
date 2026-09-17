import { buildClearSessionCookie, buildSessionCookie, createSessionToken, sessionTokenFromRequest, verifySessionToken } from "./session.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

const DEFAULT_TENANT_ID = "9c36f529-164f-47cd-bca0-ba7c0d710407";
const DEFAULT_SCOPE = "openid profile email User.Read";
const MICROSOFT_CALLBACK_PATH = "/api/auth/microsoft/callback";
const ONEVIEW_PRODUCTION_ORIGIN = "https://oneview.teletex.com.br";
const ONEVIEW_DEVELOPMENT_ORIGIN = "https://oneview.teletexdev.com.br";
const CANONICAL_PUBLIC_ORIGINS = new Set([ONEVIEW_PRODUCTION_ORIGIN, ONEVIEW_DEVELOPMENT_ORIGIN]);
const GRAPH_PROFILE_PHOTO_URL = "https://graph.microsoft.com/v1.0/me/photo/$value";
const MAX_PROFILE_PHOTO_BYTES = 512 * 1024;
const PROFILE_PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
let idTokenJwks;

function clean(value) {
  return String(value || "").trim();
}

function tenantId() {
  return clean(process.env.MICROSOFT_TENANT_ID || process.env.AZURE_TENANT_ID || process.env.VITE_AZURE_TENANT_ID || DEFAULT_TENANT_ID);
}

function clientId() {
  return clean(process.env.MICROSOFT_CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.VITE_AZURE_CLIENT_ID);
}

function clientSecret() {
  return clean(process.env.MICROSOFT_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET);
}

function getIdTokenJwks() {
  if (!idTokenJwks) {
    idTokenJwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId()}/discovery/v2.0/keys`));
  }
  return idTokenJwks;
}

function trustedStringArray(value, maximum = 200) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, maximum);
}

function hasOwnClaim(payload, claim) {
  return Boolean(payload && Object.prototype.hasOwnProperty.call(payload, claim));
}

function claimCount(value, maximum = 200) {
  return Array.isArray(value) ? Math.min(value.length, maximum) : 0;
}

function audienceMatches(value, expected) {
  const audiences = Array.isArray(value) ? value : [value];
  return audiences.some((item) => clean(item) === expected);
}

export function entraClaimDiagnostic(payload, { tenant, audience, issuer } = {}) {
  const expectedTenant = clean(tenant).toLowerCase();
  const tokenTenant = clean(payload?.tid).toLowerCase();
  return {
    has_roles_claim: hasOwnClaim(payload, "roles"),
    roles_count: claimCount(payload?.roles),
    has_groups_claim: hasOwnClaim(payload, "groups"),
    groups_count: claimCount(payload?.groups),
    aud_matches_expected: audienceMatches(payload?.aud, clean(audience)),
    // Preserve the existing acceptance rule: Entra normally sends tid, but
    // an absent tid is not a newly introduced authentication failure.
    tenant_matches_expected: !tokenTenant || tokenTenant === expectedTenant,
    issuer_matches_expected: clean(payload?.iss) === clean(issuer),
  };
}

function invalidIdToken(code, diagnostic) {
  const error = new Error(code);
  error.entra_claim_diagnostic = diagnostic;
  return error;
}

function scope() {
  return clean(process.env.MICROSOFT_SCOPE || process.env.VITE_AZURE_SCOPES || DEFAULT_SCOPE);
}

function normalizeOrigin(value) {
  const candidate = clean(value);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function isProductionDeployment() {
  return [process.env.VERCEL_ENV, process.env.ONEVIEW_RUNTIME_ENV]
    .some((value) => clean(value).toLowerCase() === "production");
}

function isLocalDevelopmentOrigin(origin) {
  if (isProductionDeployment()) return false;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isKnownPublicOrigin(origin) {
  return CANONICAL_PUBLIC_ORIGINS.has(origin) || isLocalDevelopmentOrigin(origin);
}

function isOriginAllowedInCurrentEnvironment(origin) {
  if (!isKnownPublicOrigin(origin)) return false;
  // Production never accepts a development hostname from Host or env config.
  return !isProductionDeployment() || origin === ONEVIEW_PRODUCTION_ORIGIN;
}

function configuredOrigin(value) {
  const origin = normalizeOrigin(value);
  return isOriginAllowedInCurrentEnvironment(origin) ? origin : "";
}

function configuredPrimaryOrigin() {
  const explicit = configuredOrigin(process.env.ONEVIEW_PUBLIC_ORIGIN || process.env.APP_PUBLIC_ORIGIN);
  if (explicit) return explicit;

  const redirectUri = clean(process.env.MICROSOFT_REDIRECT_URI);
  if (redirectUri) {
    try {
      return configuredOrigin(new URL(redirectUri).origin);
    } catch {
      // fallback below
    }
  }
  return "";
}

function allowedOrigins() {
  const configured = String(process.env.ONEVIEW_ALLOWED_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(isOriginAllowedInCurrentEnvironment);
  const primary = configuredPrimaryOrigin();
  return [...new Set([...configured, primary].filter(Boolean))];
}

// GETs same-origin normalmente nÃ£o enviam Origin. Quando ele existir, a
// comparaÃ§Ã£o Ã© estrita, evitando aceitar domÃ­nios por correspondÃªncia parcial.
export function isAllowedRequestOrigin(req) {
  const rawOrigin = clean(req.headers?.origin || req.headers?.Origin);
  if (!rawOrigin) return true;

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return false;

  const configured = allowedOrigins();
  return configured.length > 0 && configured.includes(origin);
}

export function requestOrigin(req) {
  const forwardedHost = clean(String(req.headers?.["x-forwarded-host"] || "").split(",")[0]);
  const host = forwardedHost || clean(req.headers?.host);
  const forwardedProto = clean(String(req.headers?.["x-forwarded-proto"] || "").split(",")[0]);
  const proto = forwardedProto || "http";
  const candidate = normalizeOrigin(host ? `${proto}://${host}` : "");
  if (isOriginAllowedInCurrentEnvironment(candidate)) return candidate;
  return configuredPrimaryOrigin();
}

export function microsoftRedirectUri(req) {
  const origin = requestOrigin(req);
  return origin ? `${origin}${MICROSOFT_CALLBACK_PATH}` : "";
}

export function publicAppOrigin(req) {
  return requestOrigin(req) || configuredPrimaryOrigin();
}

export function buildMicrosoftAuthorizeUrl(req, state = "") {
  const appClientId = clientId();
  if (!appClientId) throw new Error("MICROSOFT_CLIENT_ID_not_configured");

  const params = new URLSearchParams({
    client_id: appClientId,
    response_type: "code",
    redirect_uri: microsoftRedirectUri(req),
    response_mode: "query",
    scope: scope(),
    state,
  });

  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/authorize?${params.toString()}`;
}

export function buildMicrosoftLogoutUrl(req) {
  const origin = publicAppOrigin(req);
  if (!origin) return "";
  const params = new URLSearchParams({ post_logout_redirect_uri: `${origin}/login` });
  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/logout?${params.toString()}`;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error_description || payload.error || response.statusText;
    throw new Error(String(detail || "microsoft_request_failed"));
  }
  return payload;
}

export async function exchangeMicrosoftCode(req, code) {
  const appClientId = clientId();
  const secret = clientSecret();
  if (!appClientId || !secret) throw new Error("MICROSOFT_CLIENT_ID_or_SECRET_not_configured");

  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`;
  const tokenPayload = await fetchJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: appClientId,
      client_secret: secret,
      grant_type: "authorization_code",
      code,
      redirect_uri: microsoftRedirectUri(req),
      scope: scope(),
    }).toString(),
  });

  if (!tokenPayload.access_token) throw new Error("microsoft_access_token_missing");
  return tokenPayload;
}

export async function trustedMicrosoftIdTokenClaims(idToken) {
  const token = clean(idToken);
  if (!token) return { roles: [], groups: [] };
  const tenant = tenantId();
  const audience = clientId();
  if (!tenant || !audience) throw new Error("microsoft_id_token_config_incomplete");

  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;

  // jwtVerify validates the signature/JWKS, temporal claims and issuer.
  // Audience remains fail-closed below so the callback can log aggregate,
  // non-sensitive diagnostic flags for a signed token from the wrong app.
  const { payload } = await jwtVerify(token, getIdTokenJwks(), {
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
  });
  const diagnostic = entraClaimDiagnostic(payload, { tenant, audience, issuer });
  if (!diagnostic.issuer_matches_expected) throw invalidIdToken("microsoft_id_token_invalid_issuer", diagnostic);
  if (!diagnostic.aud_matches_expected) throw invalidIdToken("microsoft_id_token_invalid_audience", diagnostic);
  if (!diagnostic.tenant_matches_expected) throw invalidIdToken("microsoft_id_token_invalid_tenant", diagnostic);
  return {
    oid: clean(payload.oid),
    tid: clean(payload.tid),
    sub: clean(payload.sub),
    name: clean(payload.name),
    preferred_username: clean(payload.preferred_username),
    roles: trustedStringArray(payload.roles),
    groups: trustedStringArray(payload.groups),
    diagnostic,
  };
}

export async function fetchMicrosoftProfile(accessToken, trustedClaims = {}) {
  if (!clean(trustedClaims.oid) || !clean(trustedClaims.sub) || !clean(trustedClaims.tid)) {
    throw new Error("microsoft_identity_claims_missing");
  }
  const profile = await fetchJson("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Precedência Graph (SSO server-side): mail → userPrincipalName → email.
  // unique_name / preferred_username / name NÃO entram neste caminho.
  let emailClaim = "none";
  let emailRaw = "";
  if (clean(profile.mail)) {
    emailClaim = "mail";
    emailRaw = profile.mail;
  } else if (clean(profile.userPrincipalName)) {
    emailClaim = "userPrincipalName";
    emailRaw = profile.userPrincipalName;
  } else if (clean(profile.email)) {
    emailClaim = "email";
    emailRaw = profile.email;
  }

  const email = clean(emailRaw || trustedClaims.preferred_username).toLowerCase();

  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : "";
  // OV-P0-16B temporary safe diagnostic: claim + domain only (never email/token).
  console.warn(JSON.stringify({
    event: "oneview_sso_identity",
    claim: emailClaim,
    domain,
  }));

  return {
    id: clean(trustedClaims.oid),
    oid: clean(trustedClaims.oid),
    tid: clean(trustedClaims.tid),
    sub: clean(trustedClaims.sub),
    name: clean(trustedClaims.name || profile.displayName || email),
    email,
    emailClaim,
    firstName: clean(profile.givenName),
    lastName: clean(profile.surname),
    jobTitle: clean(profile.jobTitle),
    username: clean(trustedClaims.preferred_username || profile.userPrincipalName || email),
    preferred_username: clean(trustedClaims.preferred_username || profile.userPrincipalName || email),
    roles: trustedStringArray(trustedClaims.roles),
    // User.Read + /me does not return memberships. These are verified ID-token
    // claims when the tenant is configured to emit them.
    groups: trustedStringArray(trustedClaims.groups),
  };
}

// A foto é buscada somente no backend, enquanto o access token obtido no callback
// ainda está disponível. Nunca a gravamos no cookie/token de sessão.
export async function fetchMicrosoftProfilePhoto(accessToken) {
  const response = await fetch(GRAPH_PROFILE_PHOTO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "image/*",
    },
  });

  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`microsoft_profile_photo_failed:${response.status}`);

  const contentType = String(response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!PROFILE_PHOTO_CONTENT_TYPES.has(contentType)) {
    throw new Error("microsoft_profile_photo_invalid_content_type");
  }

  const photo = Buffer.from(await response.arrayBuffer());
  if (!photo.length || photo.length > MAX_PROFILE_PHOTO_BYTES) {
    throw new Error("microsoft_profile_photo_invalid_size");
  }

  return `data:${contentType};base64,${photo.toString("base64")}`;
}

export function sessionUserFromRequest(req) {
  const session = verifySessionToken(sessionTokenFromRequest(req));
  return sessionUserFromPayload(session);
}

export function sessionUserFromToken(token) {
  const session = verifySessionToken(token);
  return sessionUserFromPayload(session);
}

function sessionUserFromPayload(session) {
  if (!session?.oid) return null;
  return {
    id: session.oid,
    oid: session.oid,
    tid: session.tid || "",
    sub: session.sub || session.oid,
    name: session.name || session.oid,
    email: session.email,
    emailClaim: session.email_claim || "session.email",
    username: session.preferred_username || session.email || "",
    preferred_username: session.preferred_username || session.email || "",
    roles: Array.isArray(session.roles) ? session.roles : [],
    groups: Array.isArray(session.groups) ? session.groups : [],
  };
}

export function setSessionCookie(res, req, user) {
  const session = createSessionToken(user);
  res.setHeader("Set-Cookie", buildSessionCookie(session.token, req));
  return session;
}

export function clearSessionCookie(res, req) {
  res.setHeader("Set-Cookie", buildClearSessionCookie(req));
}
