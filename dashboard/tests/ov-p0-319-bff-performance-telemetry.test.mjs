import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bffPerformanceErrorClass,
  withBffPerformanceTelemetry,
} from "../api/_lib/oneview-bff-performance.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-319 registra somente métricas agregáveis do GET sem alterar retorno", async () => {
  const logs = [];
  const req = {
    method: "GET",
    query: { sys_id: "sensitive-sys-id" },
    headers: { authorization: "Bearer secret-token", cookie: "session=secret" },
    body: { password: "secret-password" },
  };
  const res = { statusCode: 200, payload: { untouched: true } };
  const expected = { ok: true };
  const times = [100, 112.4];
  const wrapped = withBffPerformanceTelemetry(async () => expected, {
    route: "/api/oneview/incidents/related-alert",
    logger: (entry) => logs.push(entry),
    now: () => times.shift(),
  });

  assert.equal(await wrapped(req, res), expected);
  assert.deepEqual(res.payload, { untouched: true });
  assert.deepEqual(logs, [{
    event: "oneview_bff_performance",
    route: "/api/oneview/incidents/related-alert",
    status: 200,
    duration_ms: 12,
    error_class: "none",
  }]);
  assert.deepEqual(Object.keys(logs[0]), ["event", "route", "status", "duration_ms", "error_class"]);
  assert.doesNotMatch(JSON.stringify(logs), /sensitive-sys-id|secret-token|session=|secret-password|authorization|cookie|password/i);
});

test("OV-P0-319 classifica HTTP e exception sem registrar detalhes do erro", async () => {
  assert.equal(bffPerformanceErrorClass(200), "none");
  assert.equal(bffPerformanceErrorClass(404), "http_4xx");
  assert.equal(bffPerformanceErrorClass(503), "http_5xx");
  assert.equal(bffPerformanceErrorClass(200, true), "exception");

  const httpLogs = [];
  const http = withBffPerformanceTelemetry(async (_req, res) => {
    res.statusCode = 503;
    return "same-response";
  }, {
    route: "/api/oneview/links",
    logger: (entry) => httpLogs.push(entry),
    now: (() => { const values = [10, 15]; return () => values.shift(); })(),
  });
  assert.equal(await http({ method: "GET" }, { statusCode: 200 }), "same-response");
  assert.equal(httpLogs[0].status, 503);
  assert.equal(httpLogs[0].error_class, "http_5xx");

  const thrownLogs = [];
  const thrown = withBffPerformanceTelemetry(async () => {
    throw new Error("token=must-never-be-logged");
  }, {
    route: "/api/oneview/alerts",
    logger: (entry) => thrownLogs.push(entry),
    now: (() => { const values = [20, 23]; return () => values.shift(); })(),
  });
  await assert.rejects(() => thrown({ method: "GET" }, { statusCode: 200 }), /must-never-be-logged/);
  assert.equal(thrownLogs[0].status, 500);
  assert.equal(thrownLogs[0].error_class, "exception");
  assert.doesNotMatch(JSON.stringify(thrownLogs), /token|must-never/i);
});

test("OV-P0-319 telemetria é fail-open, ignora writes e exige rota estática", async () => {
  const logs = [];
  const handler = async () => "unchanged";
  const wrapped = withBffPerformanceTelemetry(handler, {
    route: "/api/oneview/servicenow/me",
    logger: (entry) => { logs.push(entry); throw new Error("logger_failed"); },
    now: (() => { const values = [1, 2]; return () => values.shift(); })(),
  });
  assert.equal(await wrapped({ method: "GET" }, { statusCode: 200 }), "unchanged");
  assert.equal(logs.length, 1);
  assert.equal(await wrapped({ method: "POST" }, { statusCode: 200 }), "unchanged");
  assert.equal(logs.length, 1);
  assert.throws(
    () => withBffPerformanceTelemetry(handler, { route: "/api/oneview/incidents/:sysId" }),
    /unsupported_performance_route/,
  );
});

test("OV-P0-319 seis rotas prioritárias usam o wrapper central", async () => {
  const routes = [
    ["api/oneview/alerts.js", "/api/oneview/alerts"],
    ["api/oneview/incidents.js", "/api/oneview/incidents"],
    ["api/oneview/links.js", "/api/oneview/links"],
    ["api/oneview/runtime-health.js", "/api/oneview/runtime-health"],
    ["api/oneview/incidents/related-alert.js", "/api/oneview/incidents/related-alert"],
    ["api/oneview/servicenow/me.js", "/api/oneview/servicenow/me"],
  ];
  for (const [file, route] of routes) {
    const source = await read(file);
    const module = await import(new URL(`../${file}`, import.meta.url));
    assert.equal(typeof module.default, "function");
    assert.match(source, /withBffPerformanceTelemetry/);
    assert.match(source, new RegExp(`route: "${route.replaceAll("/", "\\/")}"`));
  }
});
