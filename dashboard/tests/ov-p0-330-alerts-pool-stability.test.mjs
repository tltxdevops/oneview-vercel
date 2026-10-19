import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildAlertListQuery, classifyOneViewDatabaseError, readRequestDbTelemetry, withOneViewReadonlyTransaction } from "../api/_lib/oneview-db.js";
import { createOneViewHandler } from "../api/_lib/oneview-response.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const config = {
  statementTimeoutMs: 10000,
  idleInTransactionTimeoutMs: 15000,
};

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

function createFakePool(max = 2) {
  let inUse = 0;
  let waiting = 0;
  let peakInUse = 0;
  const waiters = [];
  const clients = [];
  return {
    clients,
    stats() { return { inUse, waiting, peakInUse }; },
    get totalCount() { return inUse; },
    get idleCount() { return Math.max(0, max - inUse); },
    get waitingCount() { return waiting; },
    get options() { return { max }; },
    async connect() {
      if (inUse >= max) {
        waiting += 1;
        await new Promise((resolve) => waiters.push(resolve));
        waiting -= 1;
      }
      inUse += 1;
      peakInUse = Math.max(peakInUse, inUse);
      let released = false;
      let activeQueries = 0;
      const client = {
        queries: [],
        overlapped: false,
        releasedWith: undefined,
        async query(payload) {
          const sql = typeof payload === "string" ? payload : payload?.text;
          activeQueries += 1;
          if (activeQueries > 1) client.overlapped = true;
          client.queries.push(String(sql));
          await new Promise((resolve) => setTimeout(resolve, 4));
          activeQueries -= 1;
          if (String(sql).includes("FORCE_TIMEOUT")) {
            const error = new Error("canceling statement due to statement timeout password=secret select private");
            error.code = "57014";
            throw error;
          }
          return { rows: [{ total: 4, active: 3, resolved: 1 }] };
        },
        release(error) {
          if (released) throw new Error("client released twice");
          released = true;
          client.releasedWith = error || null;
          inUse -= 1;
          const next = waiters.shift();
          if (next) next();
        },
      };
      clients.push(client);
      return client;
    },
  };
}

test("alerts list uses one client and keeps filters, pagination, ack and resolved semantics", async () => {
  const source = await read("api/_lib/oneview-db.js");
  const body = source.slice(source.indexOf("async function fetchAlertList"), source.indexOf("function attentionThresholdPayload"));
  assert.match(body, /withOneViewReadonlyTransaction/);
  assert.doesNotMatch(body, /Promise\.all/);
  assert.match(body, /RESOLVED_ALERT_SQL/);
  assert.match(body, /ACTIVE_ALERT_SQL/);
  assert.match(body, /oneview_ack/);
  assert.match(body, /limit \$\$\{params\.length \+ 1\}/);
  assert.match(body, /offset \$\$\{params\.length \+ 2\}/);
  assert.match(source, /set_config\('statement_timeout', \$1, true\)/);
  assert.match(source, /set_config\('idle_in_transaction_session_timeout', \$2, true\)/);
  assert.match(source, /client\.release\(failure\)/);
  assert.doesNotMatch(source, /statement_timeout:\s*config\.statementTimeoutMs/);

  const filtered = buildAlertListQuery({
    query: { status: "resolved", customer: "Ailos", page: "2", page_size: "25", sort: "severity", order: "asc", oneview_ack_status: "success" },
  }, ["teletex-http"]);
  assert.equal(filtered.page, 2);
  assert.equal(filtered.pageSize, 25);
  assert.match(filtered.whereSql, /status_source/);
  assert.match(filtered.whereSql, /'resolved'/);
  assert.match(filtered.orderSql, /ASC/);
});

test("pool max=2 serves one alerts read with a single checkout and no leftover waiters", async () => {
  const pool = createFakePool(2);
  const req = {};
  await withOneViewReadonlyTransaction(config, async (query) => {
    await query("select summary");
    await query("select temporal");
    await query("select items");
  }, { pool, req, operation: "alerts_list" });
  const client = pool.clients[0];
  assert.equal(pool.clients.length, 1);
  assert.equal(client.overlapped, false);
  assert.equal(client.releasedWith, null);
  assert.deepEqual(pool.stats(), { inUse: 0, waiting: 0, peakInUse: 1 });
  assert.deepEqual(client.queries.slice(0, 2), [
    "BEGIN",
    "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
  ]);
  assert.equal(client.queries.at(-1), "COMMIT");
  assert.deepEqual(readRequestDbTelemetry(req), {
    pool_wait_ms: readRequestDbTelemetry(req).pool_wait_ms,
    db_query_count: 3,
    db_query_total_ms: readRequestDbTelemetry(req).db_query_total_ms,
    route_duration_ms: readRequestDbTelemetry(req).route_duration_ms,
    pool_total: 0,
    pool_idle: 2,
    pool_waiting: 0,
  });
  assert.equal(readRequestDbTelemetry(req).pool_waiting, 0);
  assert.ok(readRequestDbTelemetry(req).db_query_total_ms >= 0);
});

test("dashboard summary serializes its fourteen reads on one readonly checkout", async () => {
  const source = await read("api/_lib/oneview-db.js");
  const body = source.slice(source.indexOf("async function fetchDashboardSummaryPayload"), source.indexOf("async function fetchGrafanaSummaryPayload"));
  assert.match(body, /withOneViewReadonlyTransaction\(config/);
  assert.match(body, /let queuedQuery = Promise\.resolve\(\)/);
  assert.match(body, /const serialQuery = \(text, values = \[\]\)/);
  assert.match(body, /queuedQuery = pending/);
  assert.match(body, /operation: "dashboard_summary"/);
  assert.doesNotMatch(body, /getOneViewDbPool\(config\)\.query/);
});

test("dashboard summary failure is localized and does not replace the live alert list", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const body = alerts.slice(alerts.indexOf("const loadSummaryResources"), alerts.indexOf("const loadSelectedAlert"));
  assert.match(body, /Promise\.allSettled/);
  assert.match(body, /results\[0\]\.status === "rejected"/);
  assert.match(body, /A tabela de alertas continua usando sua própria resposta em tempo real\./);
  assert.doesNotMatch(body, /setAlertsError\(/);
});

test("ten concurrent alerts reads do not starve a pool of two", async () => {
  const pool = createFakePool(2);
  await Promise.all(Array.from({ length: 10 }, () => (
    withOneViewReadonlyTransaction(config, async (query) => {
      await query("select summary");
      await query("select temporal");
      await query("select items");
    }, { pool, operation: "alerts_list" })
  )));
  assert.equal(pool.clients.length, 10);
  assert.equal(pool.clients.every((client) => client.releasedWith === null && client.overlapped === false), true);
  assert.equal(pool.stats().inUse, 0);
  assert.equal(pool.stats().waiting, 0);
  assert.ok(pool.stats().peakInUse <= 2);
  assert.ok(pool.stats().peakInUse >= 1);
});

test("a failed alerts read always releases the client", async () => {
  const pool = createFakePool(2);
  await assert.rejects(
    () => withOneViewReadonlyTransaction(config, async (query) => {
      await query("select summary");
      throw Object.assign(new Error("connection terminated unexpectedly"), { code: "ECONNRESET" });
    }, { pool, operation: "alerts_list" }),
    (error) => error.code === "ECONNRESET",
  );
  const client = pool.clients[0];
  assert.equal(pool.stats().inUse, 0);
  assert.equal(pool.stats().waiting, 0);
  assert.equal(client.releasedWith?.code, "ECONNRESET");
  assert.match(client.queries.at(-1), /ROLLBACK/i);
});

test("database errors retry once only for a transient connection failure", async () => {
  const cases = [
    ["database_unavailable", 2],
    ["database_timeout", 1],
    ["database_deadlock", 1],
    ["database_permission_denied", 1],
    ["database_authentication_failed", 1],
    ["database_query_rejected", 1],
  ];
  for (const [code, expectedCalls] of cases) {
    let calls = 0;
    const res = response();
    await createOneViewHandler("alerts", {
      authorize: async () => ({ roles: ["viewer"] }),
      configProvider: () => ({ liveEnabled: true, snapshotFallbackEnabled: true }),
      database: async () => {
        calls += 1;
        if (calls === 1 || code !== "database_unavailable") {
          const error = new Error("secret-sql-must-not-leak");
          error.code = code;
          throw error;
        }
        return { items: [{ id: "live" }] };
      },
      fallback: async () => ({ items: [], generated_at: "2026-10-09T12:00:00.000Z" }),
      logger: () => undefined,
    })({ method: "GET", query: {}, headers: {} }, res);
    assert.equal(calls, expectedCalls, code);
    if (code === "database_unavailable") {
      assert.equal(res.body.data_source, "database");
    } else {
      assert.equal(res.body.data_source, "snapshot");
      assert.equal(res.body.generated_at, "2026-10-09T12:00:00.000Z");
      assert.equal(res.body.fallback_code, code);
    }
  }
});

test("statement timeout stays a controlled error and the log omits SQL", async () => {
  const pool = createFakePool(2);
  const logs = [];
  const original = console.error;
  console.error = (entry) => logs.push(entry);
  try {
    await assert.rejects(
      () => withOneViewReadonlyTransaction(config, async (query) => {
        await query("FORCE_TIMEOUT select password=secret");
      }, { pool, operation: "alerts_list" }),
      (error) => error.code === "57014",
    );
  } finally {
    console.error = original;
  }
  assert.equal(classifyOneViewDatabaseError({ code: "57014", message: "canceling statement due to statement timeout" }), "database_timeout");
  assert.equal(classifyOneViewDatabaseError({ code: "40P01" }), "database_deadlock");
  assert.equal(classifyOneViewDatabaseError({ code: "42501" }), "database_permission_denied");
  assert.equal(classifyOneViewDatabaseError({ code: "42601" }), "database_query_rejected");
  assert.equal(classifyOneViewDatabaseError({ code: "ECONNRESET", message: "connection terminated" }), "database_unavailable");
  const entry = logs.map((line) => JSON.parse(line)).find((item) => item.event === "oneview_database_error");
  assert.deepEqual(entry, {
    event: "oneview_database_error",
    operation: "alerts_list",
    pg_code: "57014",
    database_timeout: true,
    database_unavailable: false,
  });
  assert.doesNotMatch(JSON.stringify(logs), /password=secret|FORCE_TIMEOUT|select private/i);
  assert.equal(pool.stats().inUse, 0);
  assert.match(pool.clients[0].queries.at(-1), /ROLLBACK/i);
});

test("alerts contingency labels the snapshot copy and does not treat it as live metrics", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /formatSnapshotCopyClock\(snapshotCopyAt \|\| lastCheckedAt\)/);
  assert.match(alerts, /não o estado operacional atual/);
  assert.match(alerts, /const alertsAreCopy = alertsMeta\.source === "snapshot"/);
  assert.match(alerts, /alertsAreCopy \|\| hasActiveListFilters \? null/);
  assert.match(alerts, /safeResponse\.data_source !== "snapshot"/);
});
