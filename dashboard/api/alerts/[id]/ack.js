import { requireAuth } from "../../_lib/auth.js";
import { methodNotAllowed, sendJson } from "../../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!(await requireAuth(req, res, { role: "operator" }))) return;

  return sendJson(res, 403, {
    error: "real_ack_blocked",
    detail: "Real Zabbix ACK is blocked until formal approval. Use internal status acknowledged instead.",
  });
}
