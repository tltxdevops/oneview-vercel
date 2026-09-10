import crypto from "node:crypto";

const DEFAULT_COOKIE_NAME = "oneview_session";
const DEFAULT_TTL_SEC = 60 * 60 * 12;

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sessionSecret() {
  return process.env.APP_SESSION_SECRET || process.env.ONEVIEW_SESSION_SECRET || "";
}

function sessionTtlSec() {
  const hours = Number.parseInt(String(process.env.ONEVIEW_SESSION_TTL_HOURS || ""), 10);
  if (Number.isFinite(hours) && hours > 0 && hours <= 168) return hours * 60 * 60;
  // Compatibility only; new production config must use ONEVIEW_SESSION_TTL_HOURS.
  const legacySeconds = Number.parseInt(String(process.env.APP_SESSION_TTL_SEC || ""), 10);
  return Number.isFinite(legacySeconds) && legacySeconds > 0 ? legacySeconds : DEFAULT_TTL_SEC;
}

export function sessionCookieName() {
  return process.env.APP_SESSION_COOKIE_NAME || DEFAULT_COOKIE_NAME;
}

function sign(encodedHeader, encodedPayload) {
  const secret = sessionSecret();
  if (!secret) throw new Error("APP_SESSION_SECRET_not_configured");

  return base64url(
    crypto
      .createHmac("sha256", secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest(),
  );
}

export function createSessionToken(user) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + sessionTtlSec();
  const payload = {
    oid: String(user?.oid || user?.id || "").trim(),
    tid: String(user?.tid || "").trim(),
    sub: String(user?.sub || user?.oid || user?.id || "").trim(),
    email: String(user?.email || "").toLowerCase(),
    // OV-P0-16B: claim source only (mail|userPrincipalName|email|session.email). Never a secret.
    email_claim: String(user?.emailClaim || user?.email_claim || "session.email").slice(0, 64),
    name: String(user?.name || user?.nome || user?.email || ""),
    preferred_username: String(user?.preferred_username || user?.username || user?.email || "").trim(),
    roles: Array.isArray(user?.roles) ? user.roles : [],
    groups: Array.isArray(user?.groups)
      ? user.groups.map((group) => String(group || "").trim()).filter(Boolean).slice(0, 200)
      : [],
    iat: nowSec,
    exp: expSec,
  };

  const encodedHeader = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64url(JSON.stringify(payload));
  return {
    token: `${encodedHeader}.${encodedPayload}.${sign(encodedHeader, encodedPayload)}`,
    expires_at: new Date(expSec * 1000).toISOString(),
    expires_in_sec: sessionTtlSec(),
  };
}

export function verifySessionToken(token) {
  try {
    const [encodedHeader, encodedPayload, providedSignature] = String(token || "").split(".");
    if (!encodedHeader || !encodedPayload || !providedSignature) return null;
    const expectedSignature = sign(encodedHeader, encodedPayload);
    const expected = Buffer.from(expectedSignature);
    const provided = Buffer.from(providedSignature);
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;

    const payload = JSON.parse(fromBase64url(encodedPayload));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload?.oid || !payload?.sub || !payload?.exp || nowSec >= Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  String(cookieHeader || "")
    .split(";")
    .forEach((part) => {
      const [rawKey, ...rawValue] = part.split("=");
      const key = String(rawKey || "").trim();
      if (!key) return;
      cookies[key] = decodeURIComponent(rawValue.join("=").trim());
    });
  return cookies;
}

export function sessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie || "");
  return cookies[sessionCookieName()] || "";
}

function isSecureRequest(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return Boolean(req.socket?.encrypted) || proto === "https";
}

function mustUseSecureCookie(req) {
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production" || isSecureRequest(req);
}

export function buildSessionCookie(token, req) {
  const attrs = [
    `${sessionCookieName()}=${encodeURIComponent(String(token || ""))}`,
    "Path=/",
    `Max-Age=${sessionTtlSec()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mustUseSecureCookie(req)) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildClearSessionCookie(req) {
  const attrs = [
    `${sessionCookieName()}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mustUseSecureCookie(req)) attrs.push("Secure");
  return attrs.join("; ");
}
