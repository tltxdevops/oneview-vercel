import { methodNotAllowed, sendJson } from "../../_lib/http.js";
import { exchangeMicrosoftCode, fetchMicrosoftProfile, fetchMicrosoftProfilePhoto, publicAppOrigin, setSessionCookie, trustedMicrosoftIdTokenClaims } from "../../_lib/microsoft-sso.js";

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function cleanCallbackUrl(req) {
  const origin = publicAppOrigin(req);
  const code = Array.isArray(req.query?.code) ? req.query.code[0] : req.query?.code || "";
  const state = Array.isArray(req.query?.state) ? req.query.state[0] : req.query?.state || "";
  const error = Array.isArray(req.query?.error) ? req.query.error[0] : req.query?.error || "";
  const params = new URLSearchParams();
  if (code) params.set("code", code);
  if (state) params.set("state", state);
  if (error) params.set("sso_error", error);
  return `${origin}/sso/callback?${params.toString()}`;
}

function logEntraClaimDiagnostic(diagnostic) {
  if (!diagnostic) return;
  console.info(JSON.stringify({ event: "entra_claim_diagnostic", ...diagnostic }));
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);

  if (req.method === "GET") {
    return redirect(res, cleanCallbackUrl(req));
  }

  const body = await readJsonBody(req);
  const code = typeof body?.code === "string" ? body.code : "";

  if (!code) return sendJson(res, 400, { error: "missing_code" });

  try {
    const tokenPayload = await exchangeMicrosoftCode(req, code);
    const trustedClaims = await trustedMicrosoftIdTokenClaims(tokenPayload.id_token);
    logEntraClaimDiagnostic(trustedClaims.diagnostic);
    const user = await fetchMicrosoftProfile(tokenPayload.access_token, trustedClaims);
    const photo = await fetchMicrosoftProfilePhoto(tokenPayload.access_token).catch((error) => {
      // Ausência/indisponibilidade de avatar não pode impedir o login SSO.
      console.warn("[sso-profile-photo]", error instanceof Error ? error.message : "unavailable");
      return undefined;
    });
    setSessionCookie(res, req, user);
    // Session credential stays HttpOnly in the cookie; never return it to JS.
    return sendJson(res, 200, { user: photo ? { ...user, photo } : user });
  } catch (err) {
    logEntraClaimDiagnostic(err?.entra_claim_diagnostic);
    console.error("[sso-callback]", err?.message || err);
    return sendJson(res, 401, { error: "callback_failed", message: "Falha ao concluir SSO Microsoft." });
  }
}
