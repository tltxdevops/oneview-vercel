import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getOneViewConfig } from "../api/_lib/oneview-config.js";
import { createOneViewHandler, sanitizeOneViewPayload } from "../api/_lib/oneview-response.js";
import { fetchOneViewUpstream } from "../api/_lib/oneview-upstream.js";

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
const snapshotConfig = () => ({ liveEnabled: false, liveMode: "snapshot", snapshotFallbackEnabled: true });
const liveDbConfig = () => ({ liveEnabled: true, liveMode: "database", snapshotFallbackEnabled: true, dbConfig: {} });
const liveDbWithoutFallbackConfig = () => ({ liveEnabled: true, liveMode: "database", snapshotFallbackEnabled: false, dbConfig: {} });
const fallback = async () => ({ status: "snapshot-ok" });
const noLog = () => undefined;
const noCache = "no-store, no-cache, max-age=0, must-revalidate";
const routes = ["health", "dashboard-summary", "grafana-summary", "alerts", "clients-summary", "data-sources", "sync-logs"];

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

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} recebe 405`, async () => {
    const res = response();
    await createOneViewHandler("health", { authorize: authenticated })(request(method), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET");
  });
}

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
  assert.equal(res.body.data_source, "snapshot");
  assert.equal(res.headers["cache-control"], noCache);
  assert.match(res.body.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

for (const route of routes) {
  test(`${route}: database retorna metadados e cache no-store`, async () => {
    const res = response();
    const database = async () => ({ items: [{ id: "safe-row" }] });
    await createOneViewHandler(route, {
      authorize: authenticated,
      configProvider: liveDbConfig,
      database,
      fallback,
      logger: noLog,
    })(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-oneview-data-source"], "database");
    assert.equal(res.body.data_source, "database");
    assert.equal(res.headers["cache-control"], noCache);
    assert.match(res.body.checked_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
}

for (const route of routes) {
  test(`${route}: falha no database usa snapshot explicitamente`, async () => {
    const res = response();
    const database = async () => {
      const error = new Error("detalhe interno que nao pode sair");
      error.code = "database_unavailable";
      throw error;
    };
    await createOneViewHandler(route, {
      authorize: authenticated,
      configProvider: liveDbConfig,
      database,
      fallback: async () => ({ items: [] }),
      logger: noLog,
    })(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-oneview-data-source"], "snapshot");
    assert.equal(res.body.data_source, "snapshot");
    assert.match(res.body.checked_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
}

test("provider database com falha usa snapshot", async () => {
  const res = response();
  const database = async () => {
    const error = new Error("db_down");
    error.code = "db_down";
    throw error;
  };
  await createOneViewHandler("health", { authorize: authenticated, configProvider: liveDbConfig, database, fallback, logger: noLog })(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-oneview-data-source"], "snapshot");
  assert.equal(res.body.data_source, "snapshot");
  assert.equal(res.headers["cache-control"], noCache);
  assert.match(res.body.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("falha no database sem fallback retorna erro sanitizado", async () => {
  const res = response();
  const database = async () => {
    const error = new Error("password=nao-vazar host=interno SQL select segredo");
    error.code = "database_authentication_failed";
    throw error;
  };
  await createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: liveDbWithoutFallbackConfig,
    database,
    fallback,
    logger: noLog,
  })(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["x-oneview-data-source"], "database");
  assert.equal(res.body.data_source, "database");
  assert.equal(res.body.error, "database_authentication_failed");
  assert.doesNotMatch(JSON.stringify(res.body), /nao-vazar|interno|select segredo|password/i);
});

test("ONEVIEW_SNAPSHOT_MODE=false e LIVE_DB=true selecionam database em runtime", () => {
  const config = getOneViewConfig({
    ONEVIEW_SNAPSHOT_MODE: "false",
    ONEVIEW_LIVE_DB_ENABLED: "true",
    ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true",
    ONEVIEW_DB_HOST: "db.example.test",
    ONEVIEW_DB_PORT: "443",
    ONEVIEW_DB_NAME: "oneview",
    ONEVIEW_DB_USER: "readonly",
    POSTGRES_APP_PASSWORD: "test-only",
  });
  assert.equal(config.snapshotMode, false);
  assert.equal(config.liveEnabled, true);
  assert.equal(config.liveMode, "database");
});

test("fallback permanece desabilitado quando a env não está explicitamente true", () => {
  assert.equal(getOneViewConfig({}).snapshotFallbackEnabled, false);
  assert.equal(getOneViewConfig({ ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true" }).snapshotFallbackEnabled, true);
});

test("ONEVIEW_SNAPSHOT_MODE=true usa snapshot como fonte principal", async () => {
  const res = response();
  let databaseCalled = false;
  const database = async () => { databaseCalled = true; return {}; };
  await createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => ({ snapshotMode: true, liveEnabled: false, snapshotFallbackEnabled: false }),
    database,
    fallback,
    logger: noLog,
  })(request(), res);
  assert.equal(databaseCalled, false);
  assert.equal(res.body.data_source, "snapshot");
});

test("log oneview_request é estruturado e não contém detalhes sensíveis", async () => {
  const entries = [];
  const database = async () => {
    const error = new Error("password=nao-vazar host=interno");
    error.code = "database_timeout";
    throw error;
  };
  const res = response();
  await createOneViewHandler("alerts", {
    authorize: authenticated,
    configProvider: liveDbConfig,
    database,
    fallback: async () => ({ items: [{ id: "safe" }] }),
    logger: (entry) => entries.push(JSON.parse(entry)),
  })(request(), res);
  assert.deepEqual(entries, [{
    event: "oneview_request",
    route: "/api/oneview/alerts",
    data_source: "snapshot",
    duration_ms: entries[0].duration_ms,
    rows: 1,
    fallback_code: "database_timeout",
  }]);
  assert.equal(Number.isInteger(entries[0].duration_ms), true);
  assert.doesNotMatch(JSON.stringify(entries), /nao-vazar|interno|password/i);
});

test("response remove secrets e mantém host protegido", () => {
  const sanitized = sanitizeOneViewPayload({
    ok: true,
    host_name: "Host protegido 0001",
    api_url: "http://127.0.0.1:8001",
    nested: { password: "secret", note: "http://internal.example.local/path" },
  });
  assert.deepEqual(sanitized, { ok: true, host_name: "Host protegido 0001", nested: { note: "[redacted]" } });
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
