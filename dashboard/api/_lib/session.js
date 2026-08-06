import crypto from "node:crypto";

const DEFAULT_COOKIE_NAME = "oneview_session";
const DEFAULT_TTL_SEC = 60 * 60 * 24 * 30;

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
  const parsed = Number.parseInt(String(process.env.APP_SESSION_TTL_SEC || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SEC;
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
    sub: String(user?.id || user?.email || ""),
    email: String(user?.email || "").toLowerCase(),
    // OV-P0-16B: claim source only (mail|userPrincipalName|email|session.email). Never a secret.
    email_claim: String(user?.emailClaim || user?.email_claim || "session.email").slice(0, 64),
    name: String(user?.name || user?.nome || user?.email || ""),
    roles: Array.isArray(user?.roles) ? user.roles : ["viewer"],
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
    if (sign(encodedHeader, encodedPayload) !== providedSignature) return null;

    const payload = JSON.parse(fromBase64url(encodedPayload));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload?.email || !payload?.exp || nowSec >= Number(payload.exp)) return null;
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

export function buildSessionCookie(token, req) {
  const attrs = [
    `${sessionCookieName()}=${encodeURIComponent(String(token || ""))}`,
    "Path=/",
    `Max-Age=${sessionTtlSec()}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
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
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}
