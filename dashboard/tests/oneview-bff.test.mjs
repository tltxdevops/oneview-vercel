import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOneViewHandler, sanitizeOneViewPayload } from "../api/_lib/oneview-response.js";
import { fetchOneViewUpstream, OneViewUpstreamError } from "../api/_lib/oneview-upstream.js";

function request(method = "GET", query = {}, headers = {}) {
  return { method, query, headers };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; return this; },
  };
}

const authenticated = async () => ({ roles: ["viewer"] });
const snapshotConfig = () => ({ liveEnabled: false, snapshotFallbackEnabled: true });
const liveConfig = () => ({ liveEnabled: true, snapshotFallbackEnabled: true });
const fallback = async () => ({ status: "snapshot-ok" });

test("usuário sem token recebe 401", async () => {
  const previous = process.env.ONEVIEW_API_AUTH_REQUIRED;
  process.env.ONEVIEW_API_AUTH_REQUIRED = "true";
  try {
    const res = response();
    await createOneViewHandler("health", { configProvider: snapshotConfig, fallback })(request(), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "authentication_required" });
  } finally {
    if (previous === undefined) delete process.env.ONEVIEW_API_AUTH_REQUIRED;
    else process.env.ONEVIEW_API_AUTH_REQUIRED = previous;
  }
});

test("usuário sem permissão recebe 403", async () => {
  const res = response();
  const authorize = async (_req, authRes) => {
    authRes.status(403).setHeader("Content-Type", "application/json").end(JSON.stringify({ error: "insufficient_role" }));
    return null;
  };
  await createOneViewHandler("health", { authorize, configProvider: snapshotConfig, fallback })(request(), res);
  assert.equal(res.statusCode, 403);
});

test("POST recebe 405", async () => {
  const res = response();
  await createOneViewHandler("health", { authorize: authenticated })(request("POST"), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET");
});

test("rota inexistente recebe 404", async () => {
  const res = response();
  await createOneViewHandler("missing", { authorize: authenticated })(request(), res);
  assert.equal(res.statusCode, 404);
});

test("live desligado retorna snapshot", async () => {
  const res = response();
  await createOneViewHandler("health", { authorize: authenticated, configProvider: snapshotConfig, fallback })(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-oneview-data-source"], "snapshot");
});

test("upstream 200 retorna live", async () => {
  const res = response();
  const upstream = async () => ({ status: "live-ok" });
  await createOneViewHandler("health", { authorize: authenticated, configProvider: liveConfig, upstream, fallback })(request(), res);
  assert.equal(res.body.status, "live-ok");
  assert.equal(res.headers["x-oneview-data-source"], "live");
});

test("upstream 503 retorna snapshot", async () => {
  const res = response();
  const upstream = async () => { throw new OneViewUpstreamError(503, "upstream_unavailable"); };
  await createOneViewHandler("health", { authorize: authenticated, configProvider: liveConfig, upstream, fallback })(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-oneview-data-source"], "snapshot");
});

for (const status of [401, 403]) {
  test(`upstream ${status} não faz fallback`, async () => {
    const res = response();
    let fallbackCalled = false;
    const upstream = async () => { throw new OneViewUpstreamError(status, `upstream_${status}`); };
    const trackedFallback = async () => { fallbackCalled = true; return {}; };
    await createOneViewHandler("health", {
      authorize: authenticated,
      configProvider: liveConfig,
      upstream,
      fallback: trackedFallback,
    })(request(), res);
    assert.equal(res.statusCode, status);
    assert.equal(fallbackCalled, false);
    assert.equal(res.headers["x-oneview-data-source"], undefined);
  });
}

test("response remove secrets e endpoints", () => {
  const sanitized = sanitizeOneViewPayload({
    ok: true,
    authorization: "Bearer secret",
    api_url: "http://127.0.0.1:8001",
    nested: { password: "secret", note: "http://internal.example.local/path" },
  });
  assert.deepEqual(sanitized, { ok: true, nested: { note: "[redacted]" } });
});

test("upstream encaminha somente headers controlados", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await fetchOneViewUpstream(
    { upstreamPath: "/health" },
    "",
    {
      apiBaseUrl: "https://oneview.example.test",
      accessClientId: "server-id",
      accessClientSecret: "server-secret",
      timeoutMs: 1000,
    },
    fetchImpl,
  );
  assert.deepEqual(captured.init.headers, {
    Accept: "application/json",
    "CF-Access-Client-Id": "server-id",
    "CF-Access-Client-Secret": "server-secret",
  });
});

test("snapshot seguro não contém campos ou endpoints internos", async () => {
  const snapshotUrl = new URL("../src/lib/oneview-real-snapshot.safe.json", import.meta.url);
  const text = await readFile(snapshotUrl, "utf8");
  const snapshot = JSON.parse(text);
  const forbiddenKeys = [];
  const visit = (value, path = "snapshot") => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(api_url|host_name|hostname|host_ip|payload_raw|payload_normalized)$/i.test(key)) forbiddenKeys.push(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(snapshot);
  assert.deepEqual(forbiddenKeys, []);
  assert.doesNotMatch(text, /https?:\/\/|\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i);
});
