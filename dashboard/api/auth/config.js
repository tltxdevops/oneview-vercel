import { methodNotAllowed, sendJson } from "../_lib/http.js";

const DEFAULT_TELETEX_TENANT_ID = "9c36f529-164f-47cd-bca0-ba7c0d710407";

const PLACEHOLDER_PATTERNS = [
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/i,
  /[<>]/,
  /application\s*\(client\)\s*id/i,
  /directory\s*\(tenant\)\s*id/i,
  /seu[_\s-]*(tenant|client|dominio|domínio|guid|id)/i,
  /(tenant|client)[_\s-]*guid/i,
  /^undefined$/i,
  /^null$/i,
];

function cleanAuthValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) return "";
  return normalized;
}

function firstAuthValue(...values) {
  for (const value of values) {
    const cleaned = cleanAuthValue(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function requestOrigin(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req.headers.host || "").trim();
  if (!host) return "";

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || "https";
  return `${proto}://${host}`;
}

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const tenantId = firstAuthValue(
    process.env.VITE_AZURE_TENANT_ID,
    process.env.AZURE_TENANT_ID,
    process.env.MICROSOFT_TENANT_ID,
    process.env.NEXT_PUBLIC_MICROSOFT_TENANT_ID,
    DEFAULT_TELETEX_TENANT_ID,
  );
  const clientId = firstAuthValue(
    process.env.VITE_AZURE_CLIENT_ID,
    process.env.AZURE_CLIENT_ID,
    process.env.MICROSOFT_CLIENT_ID,
    process.env.NEXT_PUBLIC_MICROSOFT_CLIENT_ID,
  );
  const origin = requestOrigin(req);
  const authority =
    firstAuthValue(process.env.VITE_AZURE_AUTHORITY, process.env.MICROSOFT_AUTHORITY) ||
    (tenantId ? `https://login.microsoftonline.com/${tenantId}` : "");
  const redirectUri = firstAuthValue(
    process.env.VITE_AZURE_REDIRECT_URI,
    process.env.MICROSOFT_REDIRECT_URI,
    origin ? `${origin}/sso/callback` : "",
  );
  const postLogoutUri = firstAuthValue(
    process.env.VITE_AZURE_POST_LOGOUT_URI,
    process.env.MICROSOFT_POST_LOGOUT_URI,
    origin ? `${origin}/login` : "",
  );
  const scopes = firstAuthValue(process.env.VITE_AZURE_SCOPES, process.env.MICROSOFT_SCOPE) ||
    "openid profile email offline_access User.Read";

  return sendJson(res, 200, {
    ONEVIEW_SNAPSHOT_MODE: firstAuthValue(process.env.ONEVIEW_SNAPSHOT_MODE, process.env.NEXT_PUBLIC_SNAPSHOT_MODE) || "true",
    NEXT_PUBLIC_DEMO_MODE: firstAuthValue(process.env.NEXT_PUBLIC_DEMO_MODE, process.env.VITE_DEMO_MODE) || "",
    VITE_AZURE_CLIENT_ID: clientId,
    VITE_AZURE_TENANT_ID: tenantId,
    VITE_AZURE_AUTHORITY: authority,
    VITE_AZURE_REDIRECT_URI: redirectUri,
    VITE_AZURE_POST_LOGOUT_URI: postLogoutUri,
    VITE_AZURE_SCOPES: scopes,
    VITE_MSAL_LOG_LEVEL: firstAuthValue(process.env.VITE_MSAL_LOG_LEVEL) || "warning",
  });
}
