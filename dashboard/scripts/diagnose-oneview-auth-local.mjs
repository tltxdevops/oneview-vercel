/**
 * OV-P0-16B — diagnóstico seguro de domain_not_allowed local.
 * Nunca imprime e-mail completo, token, cookie ou client secret.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionToken, verifySessionToken } from "../api/_lib/session.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env.local");
const inspection = loadLocalEnv(envPath);

function fingerprint(value) {
  const text = String(value || "");
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^@+/, ""))
    .filter(Boolean);
}

function firstDomain() {
  return splitCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS)[0] || "teletex.com.br";
}

const allowedDomains = splitCsv(process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS);
const controlledDomain = firstDomain();
const controlledEmail = `oneview-local-readonly-check@${controlledDomain}`;
const controlledSession = createSessionToken({
  id: "oneview-local-readonly-check",
  email: controlledEmail,
  name: "OneView Local Read-only Check",
  emailClaim: "controlled_test",
  roles: ["viewer"],
});
const verified = verifySessionToken(controlledSession.token);

const report = {
  event: "oneview_auth_diagnose_ov_p0_16b",
  env_file: ".env.local",
  env_exists: inspection.exists,
  env_issues: inspection.issues.map((item) => `${item.key}:${item.problem}`),
  auth_mode: process.env.VITE_AUTH_MODE || null,
  api_auth_required: process.env.ONEVIEW_API_AUTH_REQUIRED || null,
  public_origin: process.env.ONEVIEW_PUBLIC_ORIGIN || null,
  allowed_origins_configured: Boolean(process.env.ONEVIEW_ALLOWED_ORIGINS),
  allowed_email_domains: allowedDomains,
  session_secret_fingerprint: fingerprint(process.env.APP_SESSION_SECRET || process.env.ONEVIEW_SESSION_SECRET),
  session_secret_source: process.env.APP_SESSION_SECRET
    ? "APP_SESSION_SECRET"
    : (process.env.ONEVIEW_SESSION_SECRET ? "ONEVIEW_SESSION_SECRET" : null),
  microsoft_client_configured: Boolean(process.env.MICROSOFT_CLIENT_ID),
  microsoft_secret_configured: Boolean(process.env.MICROSOFT_CLIENT_SECRET),
  claim_precedence: {
    sso_graph_profile: ["mail", "userPrincipalName", "email"],
    azure_bearer_token: ["preferred_username", "email", "upn"],
    unused_for_domain: ["unique_name", "name"],
  },
  auth_me_checks_domain: false,
  bff_requireAuth_checks_domain: true,
  test_local_live: {
    token_mode: "controlled_session",
    uses_first_allowed_domain: true,
    controlled_domain: controlledDomain,
    controlled_email_local_part: "oneview-local-readonly-check",
    session_roundtrip_ok: Boolean(verified?.email),
    session_email_claim: verified?.email_claim || null,
  },
  why_browser_can_fail_while_test_passes: [
    "test:local-live sintetiza e-mail @<primeiro domínio permitido>",
    "/api/auth/me valida só a assinatura da sessão (não checa domínio)",
    "BFF requireAuth checa domínio do e-mail real gravado no oneview_session",
    "SSO Graph usa mail || userPrincipalName; convidados #EXT#/@*.onmicrosoft.com falham na allowlist",
  ],
  next_step: "Reinicie npm run dev:bff e npm run dev; faça logout/login; leia oneview_auth_denied.received_domain no terminal do BFF",
};

console.log(JSON.stringify(report, null, 2));
