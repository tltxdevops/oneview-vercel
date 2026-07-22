import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireAuth } from "../api/_lib/auth.js";
import { buildMicrosoftAuthorizeUrl, microsoftRedirectUri, publicAppOrigin } from "../api/_lib/microsoft-sso.js";
import { getOneViewConfig } from "../api/_lib/oneview-config.js";
import { getOneViewDbConfig } from "../api/_lib/oneview-db.js";
import { createOneViewHandler, sanitizeOneViewPayload } from "../api/_lib/oneview-response.js";
import { invalidateOneViewSummaryCache, resetOneViewRuntimeCacheForTests, withOneViewSummaryCache } from "../api/_lib/oneview-runtime-cache.js";
import { fetchOneViewUpstream } from "../api/_lib/oneview-upstream.js";
import { createSessionToken } from "../api/_lib/session.js";
import authMeHandler from "../api/auth/me.js";

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

function authenticatedSessionRequest(email, headers = {}) {
  const token = createSessionToken({ id: email, email, name: email, roles: ["viewer"] }).token;
  return request("GET", {}, { cookie: `oneview_session=${encodeURIComponent(token)}`, ...headers });
}

const authenticated = async () => ({ roles: ["viewer"] });
const snapshotConfig = () => ({ liveEnabled: false, liveMode: "snapshot", snapshotFallbackEnabled: true });
const liveDbConfig = () => ({ liveEnabled: true, liveMode: "database", snapshotFallbackEnabled: true, dbConfig: {} });
const liveDbWithoutFallbackConfig = () => ({ liveEnabled: true, liveMode: "database", snapshotFallbackEnabled: false, dbConfig: {} });
const fallback = async () => ({ status: "snapshot-ok" });
const noLog = () => undefined;
const noCache = "no-store, no-cache, max-age=0, must-revalidate";
const routes = [
  "health",
  "dashboard-summary",
  "grafana-summary",
  "alerts",
  "attention-required",
  "alert-detail",
  "alert-history",
  "operations-health",
  "clients-summary",
  "data-sources",
  "sync-logs",
];
const validDbEnv = (overrides = {}) => ({
  ONEVIEW_SNAPSHOT_MODE: "false",
  ONEVIEW_LIVE_DB_ENABLED: "true",
  ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true",
  ONEVIEW_READ_ONLY_MODE: "true",
  ONEVIEW_DB_HOST: "db.example.test",
  ONEVIEW_DB_PORT: "443",
  ONEVIEW_DB_NAME: "oneview",
  ONEVIEW_DB_USER: "oneview_vercel_readonly",
  POSTGRES_READONLY_PASSWORD: "primary-test-value",
  ...overrides,
});

test("auth cannot be disabled by env", async () => {
  const previous = process.env.ONEVIEW_API_AUTH_REQUIRED;
  process.env.ONEVIEW_API_AUTH_REQUIRED = "false";
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
  assert.equal(res.body.fallback_code, "live_database_disabled");
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
    assert.equal(res.body.fallback_code, null);
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
    assert.equal(res.body.fallback_code, "database_unavailable");
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
  assert.equal(res.body.fallback_code, "database_unavailable");
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
  assert.equal(res.body.fallback_code, null);
  assert.equal(res.body.error, "database_authentication_failed");
  assert.doesNotMatch(JSON.stringify(res.body), /nao-vazar|interno|select segredo|password/i);
});

test("ONEVIEW_SNAPSHOT_MODE=false e LIVE_DB=true selecionam database em runtime", () => {
  const config = getOneViewConfig(validDbEnv());
  assert.equal(config.snapshotMode, false);
  assert.equal(config.liveEnabled, true);
  assert.equal(config.liveMode, "database");
});

test("cache do resumo é invalidado sem cachear falhas", async () => {
  resetOneViewRuntimeCacheForTests();
  let calls = 0;
  const loader = async () => ({ version: ++calls });
  assert.equal((await withOneViewSummaryCache(loader)).version, 1);
  assert.equal((await withOneViewSummaryCache(loader)).version, 1);
  invalidateOneViewSummaryCache();
  assert.equal((await withOneViewSummaryCache(loader)).version, 2);
  invalidateOneViewSummaryCache();
  await assert.rejects(() => withOneViewSummaryCache(async () => { throw new Error("expected"); }));
  assert.equal((await withOneViewSummaryCache(loader)).version, 3);
  resetOneViewRuntimeCacheForTests();
});

test("sessão do tenant e domínio permitido autoriza leitura sem lista individual", async () => {
  const names = [
    "APP_SESSION_SECRET",
    "ONEVIEW_ALLOWED_EMAIL_DOMAINS",
    "ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS",
    "ONEVIEW_PUBLIC_ORIGIN",
    "ONEVIEW_ALLOWED_ORIGINS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousWarn = console.warn;

  try {
    process.env.APP_SESSION_SECRET = "unit-test-session-secret";
    process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS = " @TELETEX.COM.BR, teletex.com ";
    process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS = "false";
    process.env.ONEVIEW_PUBLIC_ORIGIN = "https://oneview.teletexdev.com.br/";
    process.env.ONEVIEW_ALLOWED_ORIGINS = "https://oneview.teletexdev.com.br/, https://oneview-vercel.vercel.app";
    console.warn = () => undefined;

    let databaseCalls = 0;
    const handler = createOneViewHandler("health", {
      configProvider: liveDbConfig,
      database: async () => { databaseCalls += 1; return { status: "ok" }; },
      fallback,
      logger: noLog,
    });

    const domainRequest = authenticatedSessionRequest("leitura@TELETEX.COM.BR", { origin: "https://oneview.teletexdev.com.br/" });
    const me = response();
    authMeHandler(domainRequest, me);
    assert.equal(me.statusCode, 200);
    assert.equal(me.body.user.email, "leitura@teletex.com.br");

    for (const email of ["leitura@TELETEX.COM.BR", "guilherme.franco@teletex.com"]) {
      const res = response();
      await handler(authenticatedSessionRequest(email, { origin: "https://oneview.teletexdev.com.br/" }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["x-oneview-data-source"], "database");
    }

    const actionRole = response();
    const actionAuth = await requireAuth(authenticatedSessionRequest("leitura@teletex.com.br"), actionRole, { role: "operator" });
    assert.equal(actionAuth, null);
    assert.equal(actionRole.statusCode, 403);
    assert.deepEqual(actionRole.body, { error: "operator_required" });

    const foreignOrigin = response();
    await handler(authenticatedSessionRequest("leitura@teletex.com.br", { origin: "https://oneview.teletexdev.com.br.attacker.invalid" }), foreignOrigin);
    assert.equal(foreignOrigin.statusCode, 403);
    assert.deepEqual(foreignOrigin.body, { error: "origin_not_allowed" });

    const external = response();
    await handler(authenticatedSessionRequest("externo@example.invalid", { origin: "https://oneview.teletexdev.com.br" }), external);
    assert.equal(external.statusCode, 403);
    assert.deepEqual(external.body, { error: "domain_not_allowed" });
    assert.equal(databaseCalls, 2);
  } finally {
    console.warn = previousWarn;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("domínio permitido ausente falha fechado", async () => {
  const names = ["APP_SESSION_SECRET", "ONEVIEW_ALLOWED_EMAIL_DOMAINS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousWarn = console.warn;
  try {
    process.env.APP_SESSION_SECRET = "unit-test-session-secret";
    process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS = "";
    console.warn = () => undefined;
    const res = response();
    const auth = await requireAuth(authenticatedSessionRequest("usuario@teletex.com.br"), res, { role: "viewer" });
    assert.equal(auth, null);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "domain_not_allowed" });
  } finally {
    console.warn = previousWarn;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("flag geral concede ação ao usuário autenticado sem lista individual", async () => {
  const names = ["APP_SESSION_SECRET", "ONEVIEW_ALLOWED_EMAIL_DOMAINS", "ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.APP_SESSION_SECRET = "unit-test-session-secret";
    process.env.ONEVIEW_ALLOWED_EMAIL_DOMAINS = "teletex.com.br";
    process.env.ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS = "true";
    const res = response();
    const auth = await requireAuth(authenticatedSessionRequest("qualquer.usuario@teletex.com.br"), res, { role: "operator" });
    assert.equal(auth?.email, "qualquer.usuario@teletex.com.br");
    assert.equal(auth?.roles.includes("operator"), true);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("SSO mantém o host atual nas origens permitidas", () => {
  const names = [
    "ONEVIEW_PUBLIC_ORIGIN",
    "ONEVIEW_ALLOWED_ORIGINS",
    "MICROSOFT_REDIRECT_URI",
    "MICROSOFT_TENANT_ID",
    "MICROSOFT_CLIENT_ID",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    process.env.ONEVIEW_PUBLIC_ORIGIN = "https://oneview-vercel.vercel.app";
    process.env.ONEVIEW_ALLOWED_ORIGINS = [
      "https://oneview-vercel.vercel.app",
      "https://oneview.teletexdev.com.br",
      "https://oneview.teletex.com.br",
    ].join(",");
    process.env.MICROSOFT_REDIRECT_URI = "https://oneview-vercel.vercel.app/api/auth/microsoft/callback";
    process.env.MICROSOFT_TENANT_ID = "tenant-test";
    process.env.MICROSOFT_CLIENT_ID = "client-test";

    for (const host of [
      "oneview-vercel.vercel.app",
      "oneview.teletexdev.com.br",
      "oneview.teletex.com.br",
    ]) {
      const request = {
        headers: {
          host,
          "x-forwarded-proto": "https",
        },
      };
      const expectedOrigin = `https://${host}`;
      assert.equal(microsoftRedirectUri(request), `${expectedOrigin}/api/auth/microsoft/callback`);
      assert.equal(publicAppOrigin(request), expectedOrigin);

      const authorizeUrl = new URL(buildMicrosoftAuthorizeUrl(request, "state-test"));
      assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${expectedOrigin}/api/auth/microsoft/callback`);
    }

    const unknownHost = {
      headers: {
        host: "unknown.invalid",
        "x-forwarded-proto": "https",
      },
    };
    assert.equal(publicAppOrigin(unknownHost), "https://oneview-vercel.vercel.app");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("capacidade de ACK só é exposta quando solicitação está habilitada e execução permanece bloqueada", () => {
  const disabled = getOneViewConfig(validDbEnv({
    ONEVIEW_ACK_REQUEST_ENABLED: "false",
    ONEVIEW_ACK_EXECUTION_ENABLED: "false",
  }));
  assert.equal(disabled.ackRequestEnabled, false);
  assert.equal(disabled.ackExecutionEnabled, false);
  assert.equal(disabled.ackEnabled, false);

  const presentationSafe = getOneViewConfig(validDbEnv({
    ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS: "true",
    ONEVIEW_ACK_REQUEST_ENABLED: "true",
    ONEVIEW_ACK_EXECUTION_ENABLED: "false",
    POSTGRES_ACTIONS_PASSWORD: "actions-test-value",
  }));
  assert.equal(presentationSafe.ackEnabled, true);

  const executionEnabled = getOneViewConfig(validDbEnv({
    ONEVIEW_ALLOW_ALL_AUTHENTICATED_ACTIONS: "true",
    ONEVIEW_ACK_REQUEST_ENABLED: "true",
    ONEVIEW_ACK_EXECUTION_ENABLED: "true",
    POSTGRES_ACTIONS_PASSWORD: "actions-test-value",
  }));
  assert.equal(executionEnabled.ackEnabled, false);
});

test("somente POSTGRES_READONLY_PASSWORD e selecionado", () => {
  const configured = getOneViewDbConfig(validDbEnv({ POSTGRES_APP_PASSWORD: "legacy-test-value" }));
  assert.equal(configured.password, "primary-test-value");

  assert.throws(
    () => getOneViewDbConfig(validDbEnv({ POSTGRES_READONLY_PASSWORD: undefined, POSTGRES_APP_PASSWORD: "legacy-test-value" })),
    /oneview_db_config_incomplete/,
  );
});

test("oneview_vercel_readonly em modo read-only permite a consulta database", async () => {
  const config = getOneViewConfig(validDbEnv());
  let databaseCalled = false;
  const res = response();

  await createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => config,
    database: async (_route, _req, runtimeConfig) => {
      databaseCalled = true;
      assert.equal(runtimeConfig.dbConfig.user, "oneview_vercel_readonly");
      return { status: "ok" };
    },
    fallback,
    logger: noLog,
  })(request(), res);

  assert.equal(databaseCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data_source, "database");
});

for (const unsafeUser of ["oneview_readonly", "oneview_app", "oneview_owner", "oneview_worker", "postgres", "outro_usuario"]) {
  test(`${unsafeUser} e recusado antes da query em modo read-only`, () => {
    assert.throws(
      () => getOneViewDbConfig(validDbEnv({ ONEVIEW_DB_USER: unsafeUser })),
      (error) => error?.code === "unsafe_database_user" && error?.message === "unsafe_database_user",
    );
  });
}

test("usuario inseguro usa snapshot sem chamar database e sem vazar dados", async () => {
  const passwordValue = "unsafe-user-test-value";
  const config = getOneViewConfig(validDbEnv({
    ONEVIEW_DB_USER: "oneview_app",
    POSTGRES_READONLY_PASSWORD: passwordValue,
  }));
  let databaseCalled = false;
  const entries = [];
  const res = response();

  await createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => config,
    database: async () => { databaseCalled = true; return { status: "unexpected" }; },
    fallback: async () => ({ status: "snapshot-ok" }),
    logger: (entry) => entries.push(entry),
  })(request(), res);

  assert.equal(config.dbConfig, null);
  assert.equal(config.dbConfigErrorCode, "unsafe_database_user");
  assert.equal(databaseCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-oneview-data-source"], "snapshot");
  assert.equal(res.body.fallback_code, "unsafe_database_user");
  assert.doesNotMatch(`${JSON.stringify(res.body)}\n${entries.join("\n")}`, /oneview_app|unsafe-user-test-value/i);
});

test("usuario inseguro sem fallback retorna erro seguro antes da query", async () => {
  const config = getOneViewConfig(validDbEnv({
    ONEVIEW_DB_USER: "oneview_app",
    ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "false",
  }));
  let databaseCalled = false;
  const res = response();

  await createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => config,
    database: async () => { databaseCalled = true; return {}; },
    fallback,
    logger: noLog,
  })(request(), res);

  assert.equal(databaseCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "unsafe_database_user");
  assert.equal(res.body.fallback_code, "unsafe_database_user");
  assert.doesNotMatch(JSON.stringify(res.body), /oneview_app|primary-test-value/i);
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
  assert.equal(res.body.fallback_code, "snapshot_mode");
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
