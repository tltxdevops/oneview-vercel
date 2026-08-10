/**
 * SN-P0-08 — testes focados da correlação read-only incidente ↔ alerta.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelatedAlertHandler,
  parseZabbixEventId,
} from "../api/_lib/oneview-incident-relation.js";

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

function requestMock(query = {}, method = "GET") {
  return { method, query, headers: {} };
}

function enabledHandler(overrides = {}) {
  return createRelatedAlertHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    logger: () => undefined,
    configProvider: () => ({
      liveEnabled: true,
      snapshotMode: false,
      primaryDataSourceName: "teletex-http",
      dbConfig: { connectionString: "postgres://test" },
    }),
    ...overrides,
  });
}

test("parseZabbixEventId exige zabbix_event_id válido", () => {
  assert.equal(parseZabbixEventId(requestMock({ zabbix_event_id: "327191633" })), "327191633");
  assert.equal(parseZabbixEventId(requestMock({ source_event_id: "evt-1" })), "evt-1");
  assert.throws(() => parseZabbixEventId(requestMock({})), /invalid_query/);
  assert.throws(() => parseZabbixEventId(requestMock({ zabbix_event_id: "bad id" })), /invalid_query/);
});

test("related-alert retorna alerta quando source_event_id casa", async () => {
  const handler = enabledHandler({
    findAlert: async (eventId) => {
      assert.equal(eventId, "327191633");
      return {
        id: "alert-1",
        source_event_id: "327191633",
        host: "host-a",
        customer: "Cliente X",
        severity: "high",
        status: "active",
      };
    },
  });

  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "327191633" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.zabbix_event_id, "327191633");
  assert.equal(res.body.alert.id, "alert-1");
  assert.equal(res.body.alert.host, "host-a");
  assert.equal(res.body.alert.customer, "Cliente X");
  assert.equal(res.body.alert.severity, "high");
  assert.equal(res.body.alert.status, "active");
  assert.equal(res.body.data_source, "database");
  assert.equal(res.headers["x-oneview-data-source"], "database");
});

test("related-alert retorna matched=false sem inventar fallback", async () => {
  const handler = enabledHandler({
    findAlert: async () => null,
  });

  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "999" }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, false);
  assert.equal(res.body.alert, null);
  assert.equal(res.body.zabbix_event_id, "999");
});

test("related-alert rejeita método não-GET", async () => {
  const handler = enabledHandler({
    findAlert: async () => {
      throw new Error("should not query");
    },
  });
  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "1" }, "POST"), res);
  assert.equal(res.statusCode, 405);
});

test("related-alert retorna 400 sem zabbix_event_id", async () => {
  const handler = enabledHandler({
    findAlert: async () => {
      throw new Error("should not query");
    },
  });
  const res = responseMock();
  await handler(requestMock({}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_query");
  assert.equal(res.body.matched, false);
});

test("related-alert respeita feature flag desligada", async () => {
  const handler = createRelatedAlertHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => false,
    logger: () => undefined,
    findAlert: async () => {
      throw new Error("should not query");
    },
  });
  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "1" }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "servicenow_incidents_disabled");
});

test("related-alert em snapshot mode não consulta DB", async () => {
  let queried = false;
  const handler = enabledHandler({
    configProvider: () => ({
      liveEnabled: true,
      snapshotMode: true,
      primaryDataSourceName: "teletex-http",
    }),
    findAlert: async () => {
      queried = true;
      return { id: "x" };
    },
  });
  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "1" }), res);
  assert.equal(queried, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, false);
  assert.equal(res.body.data_source, "snapshot");
});

test("related-alert propaga database_unavailable", async () => {
  const handler = enabledHandler({
    findAlert: async () => {
      throw new Error("connection refused");
    },
  });
  const res = responseMock();
  await handler(requestMock({ zabbix_event_id: "1" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "database_unavailable");
  assert.equal(res.body.matched, false);
});

test("related-alert não grava relação (somente leitura)", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../api/_lib/oneview-incident-relation.js", import.meta.url), "utf8"),
  );
  const dbLookup = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8"),
  );

  assert.match(source, /read-only|sem gravar|SN-P0-08/i);
  assert.doesNotMatch(source, /\b(insert|update|delete|upsert)\b/i);
  assert.match(dbLookup, /findAlertBySourceEventId/);
  assert.match(dbLookup, /a\.source_event_id = \$1/);
  assert.doesNotMatch(
    dbLookup.slice(dbLookup.indexOf("findAlertBySourceEventId")),
    /\b(insert into|update alerts|delete from)\b/i,
  );
});
