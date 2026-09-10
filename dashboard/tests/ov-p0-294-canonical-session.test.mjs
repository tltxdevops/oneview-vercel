import assert from "node:assert/strict";
import test from "node:test";

import { buildClearSessionCookie, buildSessionCookie, createSessionToken, verifySessionToken } from "../api/_lib/session.js";
import { sessionUserFromToken } from "../api/_lib/microsoft-sso.js";
import logoutHandler from "../api/auth/logout.js";

const ENV = ["APP_SESSION_SECRET", "ONEVIEW_SESSION_TTL_HOURS", "NODE_ENV"];

test("OV-P0-294 signed canonical session preserves Entra identity and expires", () => {
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  const originalNow = Date.now;
  try {
    process.env.APP_SESSION_SECRET = "canonical-session-test-secret";
    process.env.ONEVIEW_SESSION_TTL_HOURS = "12";
    const start = 1_700_000_000_000;
    Date.now = () => start;
    const { token, expires_in_sec } = createSessionToken({
      oid: "oid-stable", tid: "tid-stable", sub: "sub-stable", name: "Display Name",
      preferred_username: "user@example.com", email: "user@example.com", roles: ["OneView.Operator"],
    });
    assert.equal(expires_in_sec, 43_200);
    assert.deepEqual(sessionUserFromToken(token), {
      id: "oid-stable", oid: "oid-stable", tid: "tid-stable", sub: "sub-stable", name: "Display Name",
      email: "user@example.com", emailClaim: "session.email", username: "user@example.com",
      preferred_username: "user@example.com", roles: ["OneView.Operator"], groups: [],
    });
    assert.equal(verifySessionToken(`${token}x`), null);
    Date.now = () => start + 43_200_000;
    assert.equal(verifySessionToken(token), null);
  } finally {
    Date.now = originalNow;
    for (const key of ENV) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

test("OV-P0-294 cookie is persistent HttpOnly and Secure in production", () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const cookie = buildSessionCookie("signed-token", { headers: {}, socket: {} });
    const clear = buildClearSessionCookie({ headers: {}, socket: {} });
    for (const value of [cookie, clear]) {
      assert.match(value, /HttpOnly/);
      assert.match(value, /SameSite=Lax/);
      assert.match(value, /Secure/);
    }
    assert.match(cookie, /Max-Age=43200/);
    assert.match(clear, /Max-Age=0/);
  } finally {
    previous === undefined ? delete process.env.NODE_ENV : process.env.NODE_ENV = previous;
  }
});

test("OV-P0-294 logout clears OneView session and returns Entra logout endpoint", () => {
  const headers = {};
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(raw) { this.body = JSON.parse(raw); },
  };
  logoutHandler({ method: "POST", headers: { host: "oneview.example.test", "x-forwarded-proto": "https" }, socket: {} }, res);
  assert.match(headers["set-cookie"], /Max-Age=0/);
  assert.match(headers["set-cookie"], /HttpOnly/);
  assert.match(headers["set-cookie"], /Secure/);
  assert.equal(res.body.ok, true);
  assert.match(res.body.logout_url, /^https:\/\/login\.microsoftonline\.com\//);
});
