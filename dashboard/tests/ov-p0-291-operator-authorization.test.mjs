import assert from "node:assert/strict";
import test from "node:test";

import { requireAuth } from "../api/_lib/auth.js";
import { createSessionToken } from "../api/_lib/session.js";

const ENV_NAMES = [
  "APP_SESSION_SECRET",
  "ONEVIEW_ALLOWED_EMAIL_DOMAINS",
  "ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS",
  "ONEVIEW_OPERATOR_EMAILS",
  "ONEVIEW_OPERATOR_GROUP_IDS",
];

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    setHeader() { return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; return this; },
  };
}

function request(method, { email = "viewer@example.com", roles = ["viewer"], groups = [], body = undefined } = {}) {
  const token = createSessionToken({ id: email, email, name: "Test User", roles, groups }).token;
  return {
    method,
    body,
    url: "/api/oneview/links/circuit-1/reminders?data_source_id=ds-1",
    headers: { cookie: `oneview_session=${encodeURIComponent(token)}` },
  };
}

async function authorize(method, identity, role = method === "GET" ? "viewer" : "operator") {
  const res = response();
  const auth = await requireAuth(request(method, identity), res, { role });
  return { auth, res };
}

test("OV-P0-291 resolves explicit operator authorization and remains fail-closed", async () => {
  const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const logs = [];

  try {
    process.env.APP_SESSION_SECRET = "operator-auth-unit-test-secret";
    process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS = "example.com";
    process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS = "false";
    process.env.ONEVIEW_OPERATOR_EMAILS = "";
    process.env.ONEVIEW_OPERATOR_GROUP_IDS = "";
    console.info = (line) => logs.push(JSON.parse(line));
    console.warn = () => undefined;

    const viewerRead = await authorize("GET");
    assert.equal(viewerRead.res.statusCode, 200);
    assert.deepEqual(viewerRead.auth?.roles, ["viewer"]);

    for (const method of ["POST", "PATCH", "DELETE"]) {
      const denied = await authorize(method);
      assert.equal(denied.auth, null);
      assert.equal(denied.res.statusCode, 403);
      assert.deepEqual(denied.res.body, { error: "operator_required" });
    }

    for (const method of ["POST", "PATCH", "DELETE"]) {
      const appRole = await authorize(method, { email: "external@not-allowlisted.invalid", roles: ["OneView.Operator"] });
      assert.equal(appRole.res.statusCode, 200);
      assert.equal(appRole.auth?.roles.includes("operator"), true);
    }
    const missingAppRole = await authorize("POST", { email: "viewer@example.com", roles: [] });
    assert.equal(missingAppRole.res.statusCode, 403);
    const similarAppRole = await authorize("POST", { email: "viewer@example.com", roles: ["OneView.Operator.Other"] });
    assert.equal(similarAppRole.res.statusCode, 403);
    const bodyRole = await authorize("POST", { email: "viewer@example.com", roles: ["viewer"], body: { roles: ["OneView.Operator"] } });
    assert.equal(bodyRole.res.statusCode, 403);

    process.env.ONEVIEW_OPERATOR_EMAILS = "  Operator.One@Example.COM  ";
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const allowed = await authorize(method, { email: "operator.one@example.com" });
      assert.equal(allowed.res.statusCode, 200);
      assert.equal(allowed.auth?.roles.includes("operator"), true);
    }

    const differentEmail = await authorize("POST", { email: "different@example.com" });
    assert.equal(differentEmail.res.statusCode, 403);
    assert.deepEqual(differentEmail.auth, null);
    const differentViewer = await authorize("GET", { email: "different@example.com" });
    assert.deepEqual(differentViewer.auth?.roles, ["viewer"]);

    process.env.ONEVIEW_OPERATOR_EMAILS = "";
    process.env.ONEVIEW_OPERATOR_GROUP_IDS = " Group-ABC,group-def ";
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const allowed = await authorize(method, { email: "group.member@example.com", groups: [" group-abc "] });
      assert.equal(allowed.res.statusCode, 200);
      assert.equal(allowed.auth?.roles.includes("operator"), true);
    }

    process.env.ONEVIEW_OPERATOR_GROUP_IDS = "";
    const noConfiguration = await authorize("POST", { email: "group.member@example.com", groups: ["group-abc"] });
    assert.equal(noConfiguration.res.statusCode, 403);
    assert.deepEqual(noConfiguration.auth, null);

    process.env.ONEVIEW_OPERATOR_EMAILS = "*@example.com,operator.one";
    const noWildcardOrSubstring = await authorize("POST", { email: "operator.one@example.com" });
    assert.equal(noWildcardOrSubstring.res.statusCode, 403);

    process.env.ONEVIEW_OPERATOR_EMAILS = "operator.one@example.com";
    const explicitWithGlobalFalse = await authorize("POST", { email: "OPERATOR.ONE@EXAMPLE.COM" });
    assert.equal(explicitWithGlobalFalse.res.statusCode, 200);
    assert.equal(explicitWithGlobalFalse.auth?.roles.includes("operator"), true);

    process.env.ONEVIEW_OPERATOR_EMAILS = "";
    const admin = await authorize("POST", { email: "admin@example.com", roles: ["viewer", "ADMIN"] });
    assert.equal(admin.res.statusCode, 200);
    assert.equal(admin.auth?.roles.includes("admin"), true);

    process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS = "true";
    const broadFlagDoesNotGrant = await authorize("POST", { email: "viewer@example.com", roles: ["viewer"] });
    assert.equal(broadFlagDoesNotGrant.res.statusCode, 403);
    process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS = "false";

    const roleLogs = logs.filter((entry) => entry.event === "auth_role_resolution");
    assert.ok(roleLogs.some((entry) => entry.resolved_role === "operator" && entry.matched_operator_email === true));
    assert.ok(roleLogs.some((entry) => entry.resolved_role === "operator" && entry.matched_operator_group === true));
    assert.ok(roleLogs.some((entry) => entry.resolved_role === "operator" && entry.matched_app_role === true));
    assert.ok(roleLogs.some((entry) => entry.resolved_role === "viewer"));
    assert.ok(roleLogs.every((entry) => entry.authenticated === true && entry.route === "/api/oneview/links/circuit-1/reminders"));
    assert.doesNotMatch(JSON.stringify(roleLogs), /operator\.one@example\.com|group-abc|unit-test-secret/i);
  } finally {
    console.info = previousInfo;
    console.warn = previousWarn;
    for (const name of ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("OV-P0-291 reminder UI distinguishes mutation 403 from consultation errors", async () => {
  const page = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"));
  const api = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8"));
  const { readFile } = await import("node:fs/promises");
  const [callback, sso, session] = await Promise.all([
    readFile(new URL("../api/auth/microsoft/callback.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/microsoft-sso.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/session.js", import.meta.url), "utf8"),
  ]);
  assert.match(callback, /trustedMicrosoftIdTokenClaims\(tokenPayload\.id_token\)/);
  assert.match(callback, /fetchMicrosoftProfile\(tokenPayload\.access_token, trustedClaims\)/);
  assert.match(sso, /jwtVerify\(token, getIdTokenJwks\(\)/);
  assert.match(sso, /issuer: `https:\/\/login\.microsoftonline\.com\/\$\{tenant\}\/v2\.0`/);
  assert.match(session, /roles: Array\.isArray\(user\?\.roles\)/);
  assert.doesNotMatch(sso, /memberOf|GroupMember\.Read\.All|Directory\.Read\.All/);
  assert.match(api, /class OneViewApiError/);
  assert.match(page, /Você não possui permissão operacional para \$\{action\} lembretes\./);
  assert.match(page, /fetchOperatorReminders[\s\S]*Não foi possível carregar o lembrete\./);
});
