import { methodNotAllowed, sendJson } from "../_lib/http.js";
import { sessionUserFromRequest, sessionUserFromToken } from "../_lib/microsoft-sso.js";

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = sessionUserFromRequest(req) || sessionUserFromToken(bearerToken(req));
  if (!user) return sendJson(res, 401, { error: "authentication_required" });
  return sendJson(res, 200, { user });
}
