/**
 * OV-P0-100 — Production Fallback Gate.
 * Em produção não servir snapshot antigo/multi-datasource; falhar fechado.
 * Artefatos de snapshot permanecem para local/dev.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getOneViewConfig,
  isOneViewProductionRuntime,
} from "../api/_lib/oneview-config.js";
import { createOneViewHandler } from "../api/_lib/oneview-response.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(value) {
      this.body = value ? JSON.parse(value) : undefined;
    },
  };
}

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

const authenticated = async () => ({ id: "u1", role: "viewer" });
const noLog = () => undefined;

test("OV-P0-100 isOneViewProductionRuntime: VERCEL_ENV e ONEVIEW_RUNTIME_ENV", () => {
  assert.equal(isOneViewProductionRuntime({}), false);
  assert.equal(isOneViewProductionRuntime({ VERCEL_ENV: "preview" }), false);
  assert.equal(isOneViewProductionRuntime({ VERCEL_ENV: "development" }), false);
  assert.equal(isOneViewProductionRuntime({ VERCEL_ENV: "production" }), true);
  assert.equal(isOneViewProductionRuntime({ ONEVIEW_RUNTIME_ENV: "production" }), true);
  assert.equal(isOneViewProductionRuntime({ ONEVIEW_RUNTIME_ENV: "local" }), false);
});

test("OV-P0-100 config: produção força snapshotMode/fallback off mesmo com env true", () => {
  const local = getOneViewConfig({
    ONEVIEW_SNAPSHOT_MODE: "true",
    ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true",
    ONEVIEW_LIVE_DB_ENABLED: "false",
  });
  assert.equal(local.productionRuntime, false);
  assert.equal(local.snapshotMode, true);
  assert.equal(local.snapshotFallbackEnabled, true);
  assert.equal(local.snapshotModeRequested, true);
  assert.equal(local.snapshotFallbackRequested, true);

  const prod = getOneViewConfig({
    VERCEL_ENV: "production",
    ONEVIEW_SNAPSHOT_MODE: "true",
    ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true",
    ONEVIEW_LIVE_DB_ENABLED: "true",
  });
  assert.equal(prod.productionRuntime, true);
  assert.equal(prod.snapshotMode, false);
  assert.equal(prod.snapshotFallbackEnabled, false);
  assert.equal(prod.snapshotModeRequested, true);
  assert.equal(prod.snapshotFallbackRequested, true);
  assert.equal(prod.liveEnabled, true);
});

test("OV-P0-100 handler produção: DB down não serve snapshot (503)", async () => {
  let fallbackCalls = 0;
  const handler = createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => ({
      productionRuntime: true,
      snapshotMode: false,
      liveEnabled: true,
      liveMode: "database",
      snapshotFallbackEnabled: false,
      snapshotFallbackRequested: true,
      dbConfig: {},
      alertStaleMinutes: 15,
    }),
    database: async () => {
      const error = new Error("down");
      error.code = "database_unavailable";
      throw error;
    },
    fallback: async () => {
      fallbackCalls += 1;
      return { status: "should-not-serve" };
    },
    logger: noLog,
  });

  const res = responseMock();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "database_unavailable");
  assert.equal(res.headers["x-oneview-data-source"], "database");
  assert.equal(fallbackCalls, 0);
});

test("OV-P0-100 handler produção: SNAPSHOT_MODE pedido não ativa snapshot", async () => {
  let fallbackCalls = 0;
  const handler = createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => getOneViewConfig({
      VERCEL_ENV: "production",
      ONEVIEW_SNAPSHOT_MODE: "true",
      ONEVIEW_LIVE_DB_ENABLED: "true",
      ONEVIEW_SNAPSHOT_FALLBACK_ENABLED: "true",
    }),
    database: async () => ({ status: "db-ok" }),
    fallback: async () => {
      fallbackCalls += 1;
      return { status: "snapshot-leak" };
    },
    logger: noLog,
  });

  const res = responseMock();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "db-ok");
  assert.equal(res.headers["x-oneview-data-source"], "database");
  assert.equal(fallbackCalls, 0);
});

test("OV-P0-100 local: fallback continua disponível quando habilitado", async () => {
  const handler = createOneViewHandler("health", {
    authorize: authenticated,
    configProvider: () => ({
      productionRuntime: false,
      snapshotMode: false,
      liveEnabled: true,
      liveMode: "database",
      snapshotFallbackEnabled: true,
      dbConfig: {},
      alertStaleMinutes: 15,
    }),
    database: async () => {
      const error = new Error("down");
      error.code = "database_unavailable";
      throw error;
    },
    fallback: async () => ({ status: "snapshot-ok" }),
    logger: noLog,
  });

  const res = responseMock();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "snapshot-ok");
  assert.equal(res.headers["x-oneview-data-source"], "snapshot");
  assert.equal(res.body.fallback_code, "database_unavailable");
});

test("OV-P0-100 inventário: snapshot safe existe, é antigo e multi-datasource", async () => {
  const raw = await read("src/lib/oneview-real-snapshot.safe.json");
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.generated_at, "2026-07-07T02:39:42.223Z");
  assert.ok(Array.isArray(snapshot.data_sources));
  assert.ok(snapshot.data_sources.length >= 2, "snapshot multi-datasource");
  const names = snapshot.data_sources.map((item) => item.name).sort();
  assert.ok(names.includes("teletex-http"));
  assert.ok(names.includes("zurich") || names.includes("castrolanda"));
  assert.ok(Array.isArray(snapshot.alerts));
  assert.equal(snapshot.alerts.length, 3000);
});

test("OV-P0-100 FE + docs: mensagem operacional e gate documentado", async () => {
  const [api, configSrc, responseSrc, docs, envRoot] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-response.js"),
    read("docs/OV-P0-100_PRODUCTION_FALLBACK_GATE.md"),
    read("../.env.example"),
  ]);

  assert.match(api, /Dados temporariamente indisponíveis/);
  assert.match(api, /database_unavailable:\s*"Dados temporariamente indisponíveis"/);
  assert.match(configSrc, /isOneViewProductionRuntime/);
  assert.match(configSrc, /productionRuntime \? false : snapshotFallbackRequested/);
  assert.match(responseSrc, /snapshotFallbackEnabled/);
  assert.match(docs, /OV-P0-100/);
  assert.match(docs, /oneview-real-snapshot\.safe\.json/);
  assert.match(docs, /2026-07-07/);
  assert.match(envRoot, /OV-P0-100/);
  // Não removemos o caminho de fallback — só o gate de produção.
  assert.match(responseSrc, /getOneViewSnapshotPayload/);
});
