import { methodNotAllowed, sendJson } from "../_lib/http.js";
import { clearSessionCookie } from "../_lib/microsoft-sso.js";

export default function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  clearSessionCookie(res, req);
  return sendJson(res, 200, { ok: true });
}
