/**
 * SN-P0-17 — Hardening da integração ServiceNow (timeout, status, retry GET, logs, UI).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRelatedIncidentsHandler } from "../api/_lib/oneview-alert-incidents.js";
import { createIncidentsHandler } from "../api/_lib/oneview-incidents.js";
import {
  DEFAULT_TIMEOUT_MS,
  getServiceNowConfig,
  isRetryableServiceNowError,
  mapServiceNowErrorToHttpStatus,
  mapServiceNowErrorToPublicCode,
  sanitizeServiceNowError,
  serviceNowGet,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";

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

function requestMock(query = {}, method = "GET") {
  return { method, query, headers: {} };
}

const snConfig = {
  configured: true,
  baseUrl: "https://example.service-now.com",
  username: "integration",
  password: "super-secret-password",
  timeoutMs: 80,
  retryMax: 2,
  defaultLimit: 100,
};

function jsonResponse(status, body = { result: [] }, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || "").toLowerCase();
        if (key === "content-length") return null;
        if (key === "x-total-count") return headers["x-total-count"] ?? "0";
        if (key === "link") return headers.link ?? null;
        return headers[key] ?? null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("SN-P0-17 config: timeout explícito e retry limitado", () => {
  const cfg = getServiceNowConfig({
    SERVICENOW_BASE_URL: "https://example.service-now.com",
    SERVICENOW_USERNAME: "u",
    SERVICENOW_PASSWORD: "p",
    SERVICENOW_TIMEOUT_MS: "12000",
    SERVICENOW_RETRY_MAX: "2",
  });
  assert.equal(cfg.timeoutMs, 12000);
  assert.equal(cfg.retryMax, 2);
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);

  const defaults = getServiceNowConfig({
    SERVICENOW_BASE_URL: "https://example.service-now.com",
    SERVICENOW_USERNAME: "u",
    SERVICENOW_PASSWORD: "p",
  });
  assert.equal(defaults.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(defaults.retryMax, 2);
});

test("SN-P0-17 401/403/429/5xx mapeados separadamente no BFF", () => {
  const cases = [
    ["servicenow_authentication_failed", 401, 502, "servicenow_authentication_failed"],
    ["servicenow_access_forbidden", 403, 502, "servicenow_access_forbidden"],
    ["servicenow_rate_limited", 429, 429, "servicenow_rate_limited"],
    ["servicenow_unavailable", 503, 502, "servicenow_unavailable"],
    ["servicenow_unavailable", 500, 502, "servicenow_unavailable"],
    ["servicenow_timeout", 504, 504, "servicenow_timeout"],
  ];

  for (const [code, snStatus, httpStatus, publicCode] of cases) {
    const error = new ServiceNowClientError(code, { status: snStatus });
    assert.equal(mapServiceNowErrorToHttpStatus(error), httpStatus, code);
    assert.equal(mapServiceNowErrorToPublicCode(error), publicCode, code);
  }

  assert.equal(isRetryableServiceNowError(new ServiceNowClientError("servicenow_authentication_failed", { status: 401 })), false);
  assert.equal(isRetryableServiceNowError(new ServiceNowClientError("servicenow_access_forbidden", { status: 403 })), false);
  assert.equal(isRetryableServiceNowError(new ServiceNowClientError("servicenow_rate_limited", { status: 429 })), true);
  assert.equal(isRetryableServiceNowError(new ServiceNowClientError("servicenow_unavailable", { status: 503 })), true);
  assert.equal(isRetryableServiceNowError(new ServiceNowClientError("servicenow_timeout", { status: 504 })), true);
});

test("SN-P0-17 sanitize nunca vaza credencial", () => {
  const message = sanitizeServiceNowError(
    new Error("Basic dXNlcjpwYXNz Authorization: Bearer tok password=super-secret SERVICENOW_PASSWORD=abc SERVICENOW_USERNAME=u"),
  );
  assert.doesNotMatch(message, /dXNlcjpwYXNz|Bearer tok|super-secret|SERVICENOW_PASSWORD=abc|SERVICENOW_USERNAME=u/);
  assert.match(message, /\[redacted\]/);
});

test("SN-P0-17 timeout explícito via AbortController", async () => {
  await assert.rejects(
    () => serviceNowGet("incident", {
      config: { ...snConfig, timeoutMs: 40, retryMax: 0 },
      fetchImpl: async (_url, init) => {
        await new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    }),
    (error) => error instanceof ServiceNowClientError && error.code === "servicenow_timeout",
  );
});

test("SN-P0-17 retry somente GET e limitado; 401 sem retry", async () => {
  let calls503 = 0;
  const okAfterRetry = await serviceNowGet("incident", {
    config: { ...snConfig, retryMax: 2, timeoutMs: 2000 },
    fetchImpl: async () => {
      calls503 += 1;
      if (calls503 < 3) return jsonResponse(503, { error: { message: "busy" } });
      return jsonResponse(200, { result: [{ sys_id: "1" }] }, { "x-total-count": "1" });
    },
  });
  assert.equal(calls503, 3);
  assert.equal(okAfterRetry.count, 1);

  let calls401 = 0;
  await assert.rejects(
    () => serviceNowGet("incident", {
      config: { ...snConfig, retryMax: 2, timeoutMs: 2000 },
      fetchImpl: async () => {
        calls401 += 1;
        return jsonResponse(401, { error: { message: "auth" } });
      },
    }),
    (error) => error instanceof ServiceNowClientError && error.code === "servicenow_authentication_failed",
  );
  assert.equal(calls401, 1);

  await assert.rejects(
    () => serviceNowGet("incident", {
      config: snConfig,
      method: "POST",
      fetchImpl: async () => jsonResponse(200),
    }),
    (error) => error instanceof ServiceNowClientError && error.code === "servicenow_method_not_allowed",
  );
});

test("SN-P0-17 related-incidents: erro SN não inventa match e códigos distintos", async () => {
  const cases = [
    ["servicenow_authentication_failed", 401, 502],
    ["servicenow_access_forbidden", 403, 502],
    ["servicenow_rate_limited", 429, 429],
    ["servicenow_unavailable", 503, 502],
    ["servicenow_timeout", 504, 504],
  ];

  for (const [code, snStatus, httpStatus] of cases) {
    const logs = [];
    const handler = createRelatedIncidentsHandler({
      authorize: async () => ({ id: "u1" }),
      featureFlagProvider: () => true,
      configProvider: () => snConfig,
      logger: (entry) => logs.push(entry),
      getPage: async () => {
        throw new ServiceNowClientError(code, { status: snStatus });
      },
    });
    const res = responseMock();
    await handler(requestMock({ source_event_id: "327191633" }), res);
    assert.equal(res.statusCode, httpStatus, code);
    assert.equal(res.body.error, code, code);
    assert.equal(res.body.matched, false);
    assert.deepEqual(res.body.incidents, []);
    const serialized = JSON.stringify({ body: res.body, logs });
    assert.equal(serialized.includes("super-secret-password"), false);
    assert.equal(serialized.includes("Authorization"), false);
    assert.equal(serialized.includes("Basic "), false);
  }
});

test("SN-P0-17 incidents list: 403 SN ≠ feature flag off", async () => {
  const snForbidden = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => true,
    configProvider: () => snConfig,
    logger: () => undefined,
    getPage: async () => {
      throw new ServiceNowClientError("servicenow_access_forbidden", { status: 403 });
    },
    getStats: async () => {
      throw new ServiceNowClientError("servicenow_access_forbidden", { status: 403 });
    },
  });
  const resSn = responseMock();
  await snForbidden(requestMock({}), resSn);
  assert.equal(resSn.statusCode, 502);
  assert.equal(resSn.body.error, "servicenow_access_forbidden");

  const flagOff = createIncidentsHandler({
    authorize: async () => ({ id: "u1" }),
    featureFlagProvider: () => false,
    logger: () => undefined,
  });
  const resFlag = responseMock();
  await flagOff(requestMock({}), resFlag);
  assert.equal(resFlag.statusCode, 403);
  assert.equal(resFlag.body.error, "servicenow_incidents_disabled");
});

test("SN-P0-17 UI/Home/Alertas: seção isolada e páginas sem fetchIncidents", async () => {
  const [section, api, index, alerts] = await Promise.all([
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
  ]);

  assert.match(section, /ServiceNow indisponível/);
  assert.match(section, /setError\("ServiceNow indisponível"\)/);
  assert.match(section, /fetchAlertRelatedIncidents/);
  assert.doesNotMatch(section, /throw\s/);

  assert.match(api, /servicenow_authentication_failed:\s*"ServiceNow indisponível"/);
  assert.match(api, /servicenow_access_forbidden:\s*"ServiceNow indisponível"/);

  assert.doesNotMatch(index, /fetchIncidents\b/);
  assert.doesNotMatch(alerts, /fetchIncidents\b/);
  assert.match(index, /AlertRelatedIncidentsSection/);
  assert.match(alerts, /AlertRelatedIncidentsSection/);

  const client = await read("api/_lib/servicenow-client.js");
  assert.match(client, /timeoutMs/);
  assert.match(client, /retryMax/);
  assert.match(client, /isRetryableServiceNowError/);
  assert.match(client, /serviceNowGetWithRetry/);
  assert.doesNotMatch(client, /console\.(log|info|debug|warn|error)\([^)]*password/i);
});
