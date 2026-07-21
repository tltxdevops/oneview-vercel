import { buildClearSessionCookie, buildSessionCookie, createSessionToken, sessionTokenFromRequest, verifySessionToken } from "./session.js";

const DEFAULT_TENANT_ID = "9c36f529-164f-47cd-bca0-ba7c0d710407";
const DEFAULT_SCOPE = "openid profile email User.Read";
const MICROSOFT_CALLBACK_PATH = "/api/auth/microsoft/callback";

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

function configuredPrimaryOrigin() {
  const explicit = normalizeOrigin(process.env.ONEVIEW_PUBLIC_ORIGIN || process.env.APP_PUBLIC_ORIGIN);
  if (explicit) return explicit;

  const redirectUri = clean(process.env.MICROSOFT_REDIRECT_URI);
  if (redirectUri) {
    try {
      return normalizeOrigin(new URL(redirectUri).origin);
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
    .filter(Boolean);
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
  const allowed = allowedOrigins();
  if (!allowed.length) return candidate;
  return allowed.includes(candidate) ? candidate : (configuredPrimaryOrigin() || candidate);
}

export function microsoftRedirectUri(req) {
  const origin = requestOrigin(req);
  return origin ? `${origin}${MICROSOFT_CALLBACK_PATH}` : clean(process.env.MICROSOFT_REDIRECT_URI);
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

export async function fetchMicrosoftProfile(accessToken) {
  const profile = await fetchJson("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const email = clean(profile.mail || profile.userPrincipalName || profile.email).toLowerCase();
  if (!email) throw new Error("microsoft_email_missing");

  return {
    id: clean(profile.id || email),
    name: clean(profile.displayName || email),
    email,
    firstName: clean(profile.givenName),
    lastName: clean(profile.surname),
    jobTitle: clean(profile.jobTitle),
    username: clean(profile.userPrincipalName || email),
    roles: ["viewer"],
  };
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
  if (!session) return null;
  return {
    id: session.sub || session.email,
    name: session.name || session.email,
    email: session.email,
    roles: Array.isArray(session.roles) ? session.roles : ["viewer"],
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
