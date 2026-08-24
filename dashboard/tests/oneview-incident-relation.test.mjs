/**
 * SN-P0-08 — testes focados da correlação read-only incidente ↔ alerta.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelatedAlertHandler,
  parseIncidentAlertReference,
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

test("OV-P0-137 prioriza sys_id e aceita number explícito", () => {
  const ref = parseIncidentAlertReference(requestMock({
    sys_id: "536247C097F24750E580F137F053AF8D",
    number: "inc0068879",
  }));
  assert.equal(ref.sys_id, "536247c097f24750e580f137f053af8d");
  assert.equal(ref.number, "INC0068879");
  assert.equal(ref.zabbix_event_id, null);
  assert.throws(() => parseIncidentAlertReference(requestMock({ sys_id: "invalid" })), /invalid_query/);
});

test("OV-P0-137 lookup reverso usa sys_id antes de number e inclui alerta resolvido", async () => {
  const handler = enabledHandler({
    findAlertByReference: async (reference) => {
      assert.equal(reference.sysId, "536247c097f24750e580f137f053af8d");
      assert.equal(reference.number, "INC0068879");
      return {
        relation_source: "sys_id",
        alert: {
          id: "alert-resolved", source_event_id: "335089530", host: "host-a", customer: "Cliente X",
          problem: "Falha de serviço", severity: "high", status: "resolved",
          first_seen_at: "2026-08-14T20:09:24.000Z", resolved_at: "2026-08-14T21:00:00.000Z",
        },
      };
    },
    findAlert: async () => { throw new Error("event fallback must not run"); },
  });
  const res = responseMock();
  await handler(requestMock({ sys_id: "536247c097f24750e580f137f053af8d", number: "INC0068879" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.relation_source, "sys_id");
  assert.equal(res.body.alert.status, "resolved");
  assert.equal(res.body.alert.problem, "Falha de serviço");
});

test("OV-P0-137 lookup reverso por number quando sys_id não existe", async () => {
  const handler = enabledHandler({
    findAlertByReference: async (reference) => {
      assert.equal(reference.sysId, null);
      assert.equal(reference.number, "INC0068879");
      return { relation_source: "number", alert: { id: "alert-1", host: "h", customer: "c", problem: "p", severity: "average", status: "active" } };
    },
  });
  const res = responseMock();
  await handler(requestMock({ number: "INC0068879" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relation_source, "number");
});

test("OV-P0-190 resolves INC0074397 and INC0074460 by sys_id", async () => {
  const cases = [
    {
      sys_id: "6050da139736c31030f7f796f053af49",
      number: "INC0074397",
      alert_id: "e7b3edf7-7d6d-4613-bb80-2ac0a02e4bbd",
      source_event_id: "112099002",
    },
    {
      sys_id: "14a1621b97b6c31030f7f796f053af3f",
      number: "INC0074460",
      alert_id: "6f321fc5-e376-48bf-aa2a-4205286272a1",
      source_event_id: "112124137",
    },
  ];

  for (const expected of cases) {
    const handler = enabledHandler({
      findAlertByReference: async ({ sysId, number }) => {
        assert.equal(sysId, expected.sys_id);
        assert.equal(number, expected.number);
        return {
          relation_source: "sys_id",
          alert: {
            id: expected.alert_id,
            source_event_id: expected.source_event_id,
            host: "host", customer: "customer", problem: "problem", severity: "high", status: "active",
          },
        };
      },
      findAlert: async () => { throw new Error("event fallback must not run"); },
    });
    const res = responseMock();
    await handler(requestMock({ sys_id: expected.sys_id, number: expected.number }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.matched, true);
    assert.equal(res.body.relation_source, "sys_id");
    assert.equal(res.body.alert.id, expected.alert_id);
    assert.equal(res.body.alert.source_event_id, expected.source_event_id);
  }
});

test("OV-P0-190 uses number after sys_id miss and never hostname", async () => {
  const handler = enabledHandler({
    findAlertByReference: async (reference) => {
      assert.deepEqual(reference, {
        sysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: "INC0074397",
      });
      return {
        relation_source: "number",
        alert: {
          id: "e7b3edf7-7d6d-4613-bb80-2ac0a02e4bbd",
          source_event_id: "112099002",
          host: "host", customer: "customer", problem: "problem", severity: "high", status: "active",
        },
      };
    },
  });
  const res = responseMock();
  await handler(requestMock({
    sys_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    number: "INC0074397",
    hostname: "must-not-be-used",
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.relation_source, "number");
  assert.equal(res.body.alert.id, "e7b3edf7-7d6d-4613-bb80-2ac0a02e4bbd");
});

test("OV-P0-190 returns no match without hostname fallback", async () => {
  const handler = enabledHandler({
    findAlertByReference: async (reference) => {
      assert.deepEqual(reference, {
        sysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        number: "INC9999999",
      });
      return { relation_source: "none", alert: null };
    },
  });
  const res = responseMock();
  await handler(requestMock({
    sys_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    number: "INC9999999",
    hostname: "must-not-be-used",
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.matched, false);
  assert.equal(res.body.alert, null);
  assert.equal(res.body.relation_source, "none");
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

test("OV-P0-137 lookup reverso só consulta tags explícitas, sem paginação ou host fallback", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../api/_lib/oneview-db.js", import.meta.url), "utf8"),
  );
  const reverseLookup = source.slice(source.indexOf("const EXPLICIT_SERVICENOW_TAG_SQL"));
  assert.match(reverseLookup, /__zbx_servicenow_sys_id/);
  assert.match(reverseLookup, /__zbx_servicenow_number/);
  assert.match(reverseLookup, /event_tags|trigger_tags|host_tags/);
  assert.doesNotMatch(reverseLookup, /offset|page_size|host_name\s*=/i);
  assert.doesNotMatch(reverseLookup, /status_source\s*=/i);
});
