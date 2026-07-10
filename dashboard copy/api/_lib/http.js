const SECRET_PATTERNS = [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, /token[^,\s}]*/gi];

export function sendJson(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  return sendJson(res, 405, { error: "method_not_allowed" });
}

export function getId(req, key = "id") {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

export function publicError(error) {
  const message = String(error?.message || "unexpected_error");
  if (/(ONEVIEW_DB_|POSTGRES_APP_PASSWORD|oneview_db_config)/i.test(message)) return "database_not_configured";
  if (message.includes("PostgreSQL")) return "invalid_database_backend";
  return "request_failed";
}

export function sanitizeError(error) {
  let message = String(error?.message || error || "request_failed");
  for (const pattern of SECRET_PATTERNS) {
    message = message.replace(pattern, "[redacted]");
  }
  return message;
}

export function handleError(res, error) {
  console.error("[api]", sanitizeError(error));
  return sendJson(res, 500, { error: publicError(error) });
}

export function asInt(value, fallback, { min = 0, max = 1000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function operatorFrom(req, body = {}) {
  return (
    req.oneviewAuth?.name ||
    req.oneviewAuth?.email ||
    body.operator_name ||
    req.headers["x-user-name"] ||
    req.headers["x-vercel-user-email"] ||
    "oneview"
  );
}
