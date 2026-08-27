/** OV-P0-236 — preserve `/alertas?alert=<uuid>` through the complete SSO return. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const alertId = "0e205a7e-d969-4909-b819-e736b9017f06";
const deepLink = `/alertas?alert=${alertId}`;

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function importReturnUrlModule() {
  const source = await read("src/lib/auth/return-url.ts");
  const output = await transform(source, { loader: "ts", format: "esm", target: "es2020" });
  return import(`data:text/javascript;base64,${Buffer.from(output.code).toString("base64")}`);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test("OV-P0-236 keeps exact alert pathname + query through a safe SSO return", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { sessionStorage: memoryStorage() };
  try {
    const authReturn = await importReturnUrlModule();
    assert.equal(authReturn.authReturnToFromLocation({ pathname: "/alertas", search: `?alert=${alertId}` }), deepLink);
    assert.equal(authReturn.rememberAuthReturnTo(deepLink), deepLink);
    assert.equal(authReturn.consumeAuthReturnTo("/"), deepLink);
    assert.equal(authReturn.normalizeAuthReturnTo("https://evil.example/alertas"), null);
    assert.equal(authReturn.normalizeAuthReturnTo("//evil.example/alertas"), null);
    assert.equal(authReturn.normalizeAuthReturnTo("/login"), null);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("OV-P0-236 wires the protected route, callback and drawer to the preserved deep link", async () => {
  const [protectedRoute, login, callback, serverCallback, alerts] = await Promise.all([
    read("src/components/auth/ProtectedRoute.tsx"),
    read("src/pages/Login.tsx"),
    read("src/pages/SsoCallback.tsx"),
    read("api/auth/microsoft/callback.js"),
    read("src/pages/Alerts.tsx"),
  ]);

  assert.match(protectedRoute, /authReturnToFromLocation\(location\)/);
  assert.match(login, /rememberAuthReturnTo\(redirectTo\)/);
  assert.match(login, /consumeAuthReturnTo\(redirectTo\)/);
  assert.match(callback, /consumeAuthReturnTo\(returnToRef\.current\)/);
  assert.match(serverCallback, /\/sso\/callback\?\$\{params\.toString\(\)\}/);
  assert.match(alerts, /searchParams\.get\("alert"\)/);
  assert.match(alerts, /setSelectedAlertId\(requestedAlertId\)/);
  assert.match(alerts, /void loadSelectedAlert\(requestedAlertId\)/);
  assert.match(alerts, /nextSearchParams\.delete\("alert"\)/);
});
