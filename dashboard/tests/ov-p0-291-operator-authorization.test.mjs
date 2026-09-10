import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { getAuthenticatedActor, requireAuth } from "../api/_lib/auth.js";
import { createSessionToken } from "../api/_lib/session.js";

function response() {
  return { statusCode: 200, body: undefined, status(value) { this.statusCode = value; return this; }, setHeader() { return this; }, end(value) { this.body = value ? JSON.parse(value) : undefined; return this; } };
}

function request(method, { oid = "oid-user", email = "user@example.com", roles = [], body } = {}) {
  const token = createSessionToken({ oid, id: oid, tid: "tenant-1", sub: `sub-${oid}`, email, name: "Test User", preferred_username: email, roles }).token;
  return { method, body, url: "/api/oneview/links/circuit-1/reminders?data_source_id=ds-1", headers: { cookie: `oneview_session=${encodeURIComponent(token)}` } };
}

async function authorize(method, identity, role = method === "GET" ? "viewer" : "operator") {
  const res = response();
  const req = request(method, identity);
  const auth = await requireAuth(req, res, { role });
  return { auth, req, res };
}

test("OV-P0-291 every validated Entra session is operator; only App Role Admin elevates", async () => {
  const previousSecret = process.env.APP_SESSION_SECRET;
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const logs = [];
  try {
    process.env.APP_SESSION_SECRET = "operator-auth-unit-test-secret";
    console.info = (line) => logs.push(JSON.parse(line));
    console.warn = () => undefined;

    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const result = await authorize(method);
      assert.equal(result.res.statusCode, 200);
      assert.equal(result.auth?.roles.includes("operator"), true);
    }
    assert.equal((await authorize("POST", { roles: ["OneView.Viewer"] })).auth?.roles.includes("operator"), true);
    assert.equal((await authorize("POST", { roles: ["OneView.Operator.Other"] })).auth?.roles.includes("operator"), true);
    assert.equal((await authorize("POST", { roles: ["OneView.Admin"] })).auth?.roles.includes("admin"), true);

    const forged = await authorize("POST", { oid: "oid-real", body: { oid: "oid-forged", roles: ["OneView.Admin"] } });
    assert.equal(forged.auth?.oid, "oid-real");
    assert.equal(forged.auth?.roles.includes("admin"), false);
    assert.deepEqual(getAuthenticatedActor(forged.req), {
      actor_id: "oid-real", actor_name: "Test User", actor_username: "user@example.com", actor_role: "operator",
    });

    const missing = response();
    assert.equal(await requireAuth({ method: "POST", url: "/api/oneview/links/x/reminders", headers: {} }, missing, { role: "operator" }), null);
    assert.equal(missing.statusCode, 401);
    assert.ok(logs.some((entry) => entry.event === "auth_role_resolution" && entry.resolved_role === "operator" && entry.matched_app_role === false));
    assert.ok(logs.every((entry) => !JSON.stringify(entry).match(/user@example\.com|oid-real|unit-test-secret/i)));
  } finally {
    console.info = previousInfo; console.warn = previousWarn;
    previousSecret === undefined ? delete process.env.APP_SESSION_SECRET : process.env.APP_SESSION_SECRET = previousSecret;
  }
});

test("OV-P0-291 server session never returns or stores browser bearer token", async () => {
  const [callback, serverAuth, api] = await Promise.all([
    readFile(new URL("../api/auth/microsoft/callback.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/server-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(callback, /session\s*:/);
  assert.doesNotMatch(serverAuth, /localStorage.*session_token|oneview_session_token/);
  assert.doesNotMatch(api, /getServerAuthToken/);
  assert.match(api, /credentials: "include"/);
});
