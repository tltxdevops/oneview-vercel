import { methodNotAllowed, sendJson } from "../../_lib/http.js";
import { buildMicrosoftAuthorizeUrl } from "../../_lib/microsoft-sso.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  try {
    const state = Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state || "";
    return sendJson(res, 200, { authUrl: buildMicrosoftAuthorizeUrl(req, state) });
  } catch (error) {
    console.error("[sso-login]", error?.message || error);
    return sendJson(res, 500, { error: "microsoft_sso_not_configured" });
  }
}
