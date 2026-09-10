import { methodNotAllowed, sendJson } from "../_lib/http.js";
import { sessionUserFromRequest } from "../_lib/microsoft-sso.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = sessionUserFromRequest(req);
  if (!user) return sendJson(res, 401, { error: "authentication_required" });
  return sendJson(res, 200, { user });
}
