import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOperatorReminderHandler } from "../api/_lib/oneview-operator-reminders.js";
import {
  actionsPasswordSource,
  classifyActionsFailure,
  getOneViewActionsDbConfig,
} from "../api/_lib/oneview-actions-db.js";
import { getOneViewDbConfig } from "../api/_lib/oneview-db.js";

const SHARED = {
  ONEVIEW_DB_HOST: "bancos.example.invalid",
  ONEVIEW_DB_PORT: "443",
  ONEVIEW_DB_NAME: "oneview",
  ONEVIEW_DB_SSLMODE: "require",
  ONEVIEW_DB_SSL_REJECT_UNAUTHORIZED: "false",
  ONEVIEW_DB_USER: "oneview_vercel_readonly",
  POSTGRES_READONLY_PASSWORD: "readonly-test-value",
  ONEVIEW_ACTIONS_PASSWORD: "actions-test-value",
};

test("OV-P0-296 actions reuses the same PgBouncer transport as the readonly BFF", () => {
  const read = getOneViewDbConfig(SHARED);
  const actions = getOneViewActionsDbConfig(SHARED);
  assert.equal(read.host, actions.host);
  assert.equal(read.port, actions.port);
  assert.equal(read.database, actions.database);
  assert.equal(read.sslMode, actions.sslMode);
  assert.equal(read.rejectUnauthorized, actions.rejectUnauthorized);
  assert.equal(read.port, 443);
  assert.equal(read.user, "oneview_vercel_readonly");
  assert.equal(actions.user, "oneview_actions");
  assert.equal(actionsPasswordSource(SHARED), "ONEVIEW_ACTIONS_PASSWORD");
  assert.equal(actionsPasswordSource({ ...SHARED, POSTGRES_ACTIONS_PASSWORD: "legacy-actions" }), "POSTGRES_ACTIONS_PASSWORD");
});

test("OV-P0-296 actions ignores DATABASE_URL and never targets localhost:5432 by default", () => {
  const actions = getOneViewActionsDbConfig({
    ...SHARED,
    DATABASE_URL: "postgres://oneview_owner@localhost:5432/oneview",
    POSTGRES_URL: "postgres://oneview_owner@127.0.0.1:5432/oneview",
    ONEVIEW_ACTIONS_DATABASE_URL: "postgres://oneview_owner@10.0.0.8:5432/oneview",
  });
  assert.equal(actions.host, "bancos.example.invalid");
  assert.equal(actions.port, 443);
  assert.equal(actions.user, "oneview_actions");
  assert.notEqual(actions.host, "localhost");
  assert.notEqual(actions.port, 5432);
});

test("OV-P0-296 classifies actions failures without leaking secrets", () => {
  const cases = [
    [{ code: "actions_database_not_configured" }, "missing_env"],
    [{ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND secret-host" }, "dns_error"],
    [{ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" }, "connection_refused"],
    [{ code: "ETIMEDOUT", message: "timeout after 10000" }, "timeout"],
    [{ code: "28P01", message: "password authentication failed for user oneview_actions" }, "authentication_failed"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self signed certificate" }, "ssl_error"],
    [{ code: "42501", message: "permission denied for table operator_reminders" }, "permission_denied"],
    [{ code: "42P01", message: "relation operator_reminders does not exist" }, "query_error"],
    [{ message: "unsupported startup parameter query_timeout" }, "pool_error"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyActionsFailure(error), expected);
  }
  assert.doesNotMatch(classifyActionsFailure({ message: "password authentication failed for user secret" }), /secret|password authentication failed/);
});

test("OV-P0-296 local actions probe uses SELECT only when credentials exist", async () => {
  const { loadLocalEnv } = await import("../scripts/_lib/local-env.mjs");
  const { resetOneViewActionsPoolForTests, withOneViewActionsQuery, withOneViewActionsTransaction } = await import("../api/_lib/oneview-actions-db.js");
  const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));
  loadLocalEnv(envPath);
  const passwordSource = actionsPasswordSource();
  if (passwordSource === "missing" || !process.env.ONEVIEW_DB_HOST || !process.env.ONEVIEW_DB_NAME) {
    assert.ok(true);
    return;
  }
  const config = getOneViewActionsDbConfig();
  assert.equal(config.user, "oneview_actions");
  assert.equal(config.port, Number.parseInt(process.env.ONEVIEW_DB_PORT || "443", 10));
  try {
    const result = await withOneViewActionsQuery(async (client) => {
      const ping = await client.query("select 1 as ok");
      const count = await client.query("select count(*)::int as total from operator_reminders");
      return { ok: ping.rows[0].ok, total: count.rows[0].total };
    });
    const transactional = await withOneViewActionsTransaction(async (client) => {
      const ping = await client.query("select 1 as ok");
      return ping.rows[0].ok;
    });
    assert.equal(result.ok, 1);
    assert.equal(transactional, 1);
    assert.equal(Number.isInteger(result.total), true);
  } catch (error) {
    assert.fail(`actions_probe_failed:${classifyActionsFailure(error)}`);
  } finally {
    await resetOneViewActionsPoolForTests();
  }
});

test("OV-P0-296 GET reminders does not open a write transaction", async () => {
  let queryCalls = 0;
  let transactionCalls = 0;
  const res = { statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } };
  const route = createOperatorReminderHandler({
    authorize: async () => ({ id: "oid-1", name: "Operador" }),
    query: async (work) => {
      queryCalls += 1;
      return work({ query: async (sql) => ({ sql, rows: [] }) });
    },
    transaction: async () => {
      transactionCalls += 1;
      throw new Error("transaction_must_not_run_on_get");
    },
    logger: () => undefined,
  });
  await route({ method: "GET", query: { id: "circuit-1", data_source_id: "ds-1", source_host_id: "host-1" }, headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(queryCalls, 1);
  assert.equal(transactionCalls, 0);
});
