import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getOneViewActionsDbConfig } from "../api/_lib/oneview-actions-db.js";
import { getOneViewDbConfig, logOneViewDbPoolMetric } from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const readonlyEnv = {
  ONEVIEW_DB_HOST: "db.example.test",
  ONEVIEW_DB_PORT: "443",
  ONEVIEW_DB_NAME: "oneview",
  ONEVIEW_DB_USER: "oneview_vercel_readonly",
  POSTGRES_READONLY_PASSWORD: "test-only-password",
};

const actionsEnv = {
  ONEVIEW_DB_HOST: "db.example.test",
  ONEVIEW_DB_PORT: "443",
  ONEVIEW_DB_NAME: "oneview",
  ONEVIEW_ACTIONS_PASSWORD: "test-only-password",
};

test("OV-P0-329 readonly pool has bounded serverless lifecycle and server-side transaction guards", () => {
  const config = getOneViewDbConfig({
    ...readonlyEnv,
    ONEVIEW_DB_IDLE_TIMEOUT_MS: "1",
    ONEVIEW_DB_MAX_LIFETIME_SECONDS: "99999",
    ONEVIEW_DB_STATEMENT_TIMEOUT_MS: "99999",
    ONEVIEW_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "99999",
  });
  assert.deepEqual(
    [config.idleTimeoutMs, config.maxLifetimeSeconds, config.statementTimeoutMs, config.idleInTransactionTimeoutMs],
    [1000, 3600, 30000, 60000],
  );
});

test("OV-P0-329 actions pool uses the same bounded timeout policy", () => {
  const config = getOneViewActionsDbConfig({
    ...actionsEnv,
    ONEVIEW_DB_IDLE_TIMEOUT_MS: "2000",
    ONEVIEW_DB_MAX_LIFETIME_SECONDS: "120",
    ONEVIEW_DB_STATEMENT_TIMEOUT_MS: "9000",
    ONEVIEW_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "11000",
  });
  assert.deepEqual(
    [config.poolMax, config.idleTimeoutMs, config.maxLifetimeSeconds, config.statementTimeoutMs, config.idleInTransactionTimeoutMs],
    [1, 2000, 120, 9000, 11000],
  );
});

test("OV-P0-329 pool telemetry exposes counts and classes without secret or SQL", () => {
  const entries = [];
  logOneViewDbPoolMetric({
    logger: (entry) => entries.push(JSON.parse(entry)),
    event: "oneview_database_read_retry",
    operation: "/api/oneview/alerts",
    retry: 1,
    attempt: 2,
    durationMs: 42,
    error: { code: "28P01", message: "password=must-never-appear select private" },
    poolInstance: { options: { max: 2 }, totalCount: 2, idleCount: 1, waitingCount: 1 },
  });
  assert.deepEqual(entries, [{
    event: "oneview_database_read_retry",
    operation: "/api/oneview/alerts",
    retry: 1,
    attempt: 2,
    duration_ms: 42,
    error_class: "database_authentication_failed",
    code: "database_authentication_failed",
    db_pool_max: 2,
    db_pool_total: 2,
    db_pool_idle: 1,
    db_pool_waiting: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(entries), /must-never-appear|password=|select private/i);
});

test("OV-P0-329 manual transactions rollback safely, evict a failed client and avoid PgBouncer startup parameters", async () => {
  const [legacy, actions, readonly] = await Promise.all([
    read("api/_lib/db.js"),
    read("api/_lib/oneview-actions-db.js"),
    read("api/_lib/oneview-db.js"),
  ]);
  for (const source of [legacy, actions]) {
    assert.match(source, /await client\.query\("rollback"\)\.catch\(\(\) => undefined\)/i);
    assert.match(source, /client\.release\(failure\)/);
    assert.match(source, /set_config\('statement_timeout'/);
    assert.match(source, /set_config\('idle_in_transaction_session_timeout'/);
    assert.match(source, /finally/);
  }
  for (const source of [readonly, actions]) {
    assert.doesNotMatch(source, /statement_timeout:\s*config\.statementTimeoutMs/);
    assert.doesNotMatch(source, /idle_in_transaction_session_timeout:\s*config\.idleInTransactionTimeoutMs/);
  }
});
