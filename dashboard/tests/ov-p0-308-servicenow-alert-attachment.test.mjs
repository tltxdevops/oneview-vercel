import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ATTACHMENT_ERROR,
  MAX_ATTACHMENT_BYTES,
  createServiceNowAttachmentHandler,
  isPngBuffer,
  sanitizeAttachmentFileName,
} from "../api/_lib/oneview-servicenow-attachment.js";
import { serviceNowPostIncidentAttachment } from "../api/_lib/servicenow-actions-client.js";

const INCIDENT_SYS_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR = Object.freeze({
  actor_id: "entra-oid-123",
  actor_name: "Guilherme Franco",
  actor_username: "guilherme.franco@teletex.com.br",
});
const CONFIG = Object.freeze({
  configured: true,
  baseUrl: "https://servicenow.example",
  username: "teletex_Integration",
  password: "secret",
  timeoutMs: 1_000,
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.payload = body ? JSON.parse(body) : null; },
  };
}

function createHandler({
  postAttachment = async () => ({}),
  audit = async () => undefined,
  identityGuard = async () => null,
} = {}) {
  return createServiceNowAttachmentHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    configProvider: () => CONFIG,
    readIncident: async () => ({ sys_id: INCIDENT_SYS_ID, number: "INC0081234" }),
    postAttachment,
    audit,
    identityGuard,
    logger: () => undefined,
  });
}

test("OV-P0-308 PNG válido é aceito e enviado ao ServiceNow", async () => {
  assert.equal(isPngBuffer(PNG), true);
  assert.equal(sanitizeAttachmentFileName("oneview-alerta-inc0081234.png", "INC0081234"), "oneview-alerta-inc0081234.png");

  let captured;
  await serviceNowPostIncidentAttachment(INCIDENT_SYS_ID, "oneview-alerta-inc0081234.png", PNG, {
    config: CONFIG,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ result: { sys_id: "att-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.match(captured.url, /table_name=incident/);
  assert.match(captured.url, new RegExp(`table_sys_id=${INCIDENT_SYS_ID}`));
  assert.match(captured.url, /file_name=oneview-alerta-inc0081234\.png/);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "image/png");
});

test("OV-P0-308 MIME inválido e payload inválido são rejeitados sem POST", async () => {
  let posts = 0;
  const handler = createHandler({ postAttachment: async () => { posts += 1; } });
  const resBadMime = responseRecorder();
  await handler({
    method: "POST",
    query: { sysId: INCIDENT_SYS_ID, file_name: "ok.png" },
    headers: { "content-type": "application/json" },
    body: PNG,
  }, resBadMime);
  assert.equal(resBadMime.statusCode, 400);
  assert.deepEqual(resBadMime.payload, { error: ATTACHMENT_ERROR.INVALID });

  const resBadBytes = responseRecorder();
  await handler({
    method: "POST",
    query: { sysId: INCIDENT_SYS_ID },
    headers: { "content-type": "image/png" },
    body: Buffer.from("not-a-png"),
  }, resBadBytes);
  assert.equal(resBadBytes.statusCode, 400);
  assert.equal(posts, 0);
});

test("OV-P0-308 tamanho inválido é rejeitado", async () => {
  const handler = createHandler();
  const res = responseRecorder();
  await handler({
    method: "POST",
    query: { sysId: INCIDENT_SYS_ID },
    headers: { "content-type": "image/png" },
    body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0),
  }, res);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.payload, { error: ATTACHMENT_ERROR.TOO_LARGE });
});

test("OV-P0-308 timeout não gera retry e retorna ATTACHMENT_RESULT_UNCERTAIN", async () => {
  let attempts = 0;
  await assert.rejects(
    serviceNowPostIncidentAttachment(INCIDENT_SYS_ID, "oneview-alerta-inc0081234.png", PNG, {
      config: CONFIG,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("socket closed");
      },
    }),
    (error) => error?.code === "ATTACHMENT_RESULT_UNCERTAIN",
  );
  assert.equal(attempts, 1);

  const res = responseRecorder();
  await createHandler({
    postAttachment: async () => { throw { code: ATTACHMENT_ERROR.RESULT_UNCERTAIN }; },
  })({
    method: "POST",
    query: { sysId: INCIDENT_SYS_ID, file_name: "oneview-alerta-inc0081234.png" },
    headers: { "content-type": "image/png" },
    body: PNG,
  }, res);
  assert.equal(res.statusCode, 504);
  assert.deepEqual(res.payload, { error: ATTACHMENT_ERROR.RESULT_UNCERTAIN });
});

test("OV-P0-308 audit não armazena binário/base64", async () => {
  const audits = [];
  const res = responseRecorder();
  await createHandler({
    audit: async (entry) => audits.push(entry),
  })({
    method: "POST",
    query: { sysId: INCIDENT_SYS_ID, file_name: "oneview-alerta-inc0081234.png" },
    headers: { "content-type": "image/png" },
    body: PNG,
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor.actor_id, ACTOR.actor_id);
  assert.equal(audits[0].fileName, "oneview-alerta-inc0081234.png");
  assert.equal(audits[0].contentType, "image/png");
  assert.equal(audits[0].sizeBytes, PNG.length);
  assert.doesNotMatch(JSON.stringify(audits), /base64|iVBOR/i);
});

test("OV-P0-308 Links exibe 4 ações via Mais ações e Monitoring permanece sem IncidentActions", async () => {
  const [component, links, monitoring, route] = await Promise.all([
    readFile(new URL("../src/components/oneview/IncidentActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Monitoring.tsx", import.meta.url), "utf8"),
    readFile(new URL("../api/oneview/incidents/[sysId]/alert-attachment.js", import.meta.url), "utf8"),
  ]);
  assert.match(component, /Assumir chamado/);
  assert.match(component, /Adicionar anotação/);
  assert.match(component, /Anexar detalhes do alerta/);
  assert.match(component, /Mais ações/);
  assert.match(component, /Colocar em espera/);
  assert.match(component, /AlertArtifactCard/);
  assert.match(links, /buildAlertArtifactFromCanonicalLink/);
  assert.match(links, /IncidentDetailActions/);
  assert.match(links, /buildAlertArtifactFromCanonicalLink/);
  assert.doesNotMatch(monitoring, /<IncidentActions/);
  assert.match(route, /oneview-servicenow-attachment/);
});

test("OV-P0-315 attachment blocks an identity conflict before POST", async () => {
  let posts = 0;
  const res = responseRecorder();
  await createHandler({
    identityGuard: async () => { throw { code: ATTACHMENT_ERROR.IDENTITY_CONFLICT }; },
    postAttachment: async () => { posts += 1; },
  })({
    method: "POST", query: { sysId: INCIDENT_SYS_ID, file_name: "oneview-alerta-inc0081234.png" },
    headers: { "content-type": "image/png" }, body: PNG,
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.error, ATTACHMENT_ERROR.IDENTITY_CONFLICT);
  assert.equal(posts, 0);
});
