import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WORK_NOTE_ERROR,
  buildOneViewWorkNote,
  createServiceNowWorkNoteHandler,
} from "../api/_lib/oneview-servicenow-work-note.js";
import { serviceNowPatchIncidentWorkNote } from "../api/_lib/servicenow-actions-client.js";

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
  actor = ACTOR,
  patch = async () => ({}),
  audit = async () => undefined,
  readIncident = async () => ({ sys_id: INCIDENT_SYS_ID, number: "INC0081234" }),
  invalidate = async () => undefined,
} = {}) {
  return createServiceNowWorkNoteHandler({
    authorize: async () => true,
    actorProvider: () => actor,
    configProvider: () => CONFIG,
    readIncident,
    patchIncident: patch,
    audit,
    invalidateIncidentCache: invalidate,
    logger: () => undefined,
  });
}

async function request(handler, body) {
  const res = responseRecorder();
  await handler({ method: "POST", query: { sysId: INCIDENT_SYS_ID }, body }, res);
  return res;
}

test("OV-P0-306 work note válida recebe prefixo backend e retorna contrato mínimo", async () => {
  const patches = [];
  let invalidations = 0;
  const res = await request(createHandler({
    patch: async (sysId, note, options) => patches.push({ sysId, note, options }),
    invalidate: async (sysId) => { assert.equal(sysId, INCIDENT_SYS_ID); invalidations += 1; },
  }), { work_note: "  Realizado contato com a operadora.  " });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { success: true, incident_number: "INC0081234", result: "added" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].sysId, INCIDENT_SYS_ID);
  assert.equal(
    patches[0].note,
    "[OneView • Guilherme Franco • guilherme.franco@teletex.com.br]\nRealizado contato com a operadora.",
  );
  assert.equal(patches[0].options.config.username, "teletex_Integration");
  assert.equal(invalidations, 1);
  assert.doesNotMatch(JSON.stringify(res.payload), /entra-oid|sys_id|teletex_Integration/i);
});

test("OV-P0-306 nota vazia, tipo inválido e campos extras são rejeitados sem PATCH", async () => {
  let patches = 0;
  const handler = createHandler({ patch: async () => { patches += 1; } });
  for (const body of [
    { work_note: "   " },
    { work_note: 123 },
    { work_note: "ok", actor: "forjado" },
    { work_note: "ok", email: "outro@teletex.com.br" },
    { work_note: "ok", author: "Teletex Integration" },
    { work_note: "ok", assignment_group: "x" },
    { work_note: "ok", credentials: "x" },
  ]) {
    const res = await request(handler, body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, { error: WORK_NOTE_ERROR.INVALID });
  }
  assert.equal(patches, 0);
});

test("OV-P0-306 autor do browser não substitui ator autenticado", async () => {
  assert.equal(
    buildOneViewWorkNote(ACTOR, "Nota"),
    "[OneView • Guilherme Franco • guilherme.franco@teletex.com.br]\nNota",
  );
  let patches = 0;
  const forged = await request(createHandler({ patch: async () => { patches += 1; } }), {
    work_note: "Nota",
    name: "Outro Usuário",
    user_sys_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(patches, 0);
});

test("OV-P0-306 PATCH técnico contém somente work_notes", async () => {
  let captured;
  await serviceNowPatchIncidentWorkNote(INCIDENT_SYS_ID, "Nota final", {
    config: CONFIG,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ result: { sys_id: INCIDENT_SYS_ID } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(captured.init.method, "PATCH");
  assert.deepEqual(JSON.parse(captured.init.body), { work_notes: "Nota final" });
  assert.match(captured.init.headers.Authorization, /^Basic /);
  assert.doesNotMatch(captured.init.body, /assigned_to|assignment_group|state|comments/);
});

test("OV-P0-306 falha de rede após dispatch é incerta e nunca gera retry", async () => {
  let attempts = 0;
  await assert.rejects(
    serviceNowPatchIncidentWorkNote(INCIDENT_SYS_ID, "Nota final", {
      config: CONFIG,
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("socket closed");
      },
    }),
    (error) => error?.code === WORK_NOTE_ERROR.RESULT_UNCERTAIN,
  );
  assert.equal(attempts, 1);

  const res = await request(createHandler({
    patch: async () => { throw { code: WORK_NOTE_ERROR.RESULT_UNCERTAIN }; },
  }), { work_note: "Nota final" });
  assert.equal(res.statusCode, 504);
  assert.deepEqual(res.payload, { error: WORK_NOTE_ERROR.RESULT_UNCERTAIN });
});

test("OV-P0-306 audit registra identidade e metadados sem texto integral", async () => {
  const audits = [];
  await request(createHandler({ audit: async (entry) => audits.push(entry) }), {
    work_note: "conteúdo operacional sensível",
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor.actor_id, ACTOR.actor_id);
  assert.equal(audits[0].actor.actor_name, ACTOR.actor_name);
  assert.equal(audits[0].actor.actor_username, ACTOR.actor_username);
  assert.equal(audits[0].incident.number, "INC0081234");
  assert.equal(audits[0].workNoteLength, "conteúdo operacional sensível".length);
  assert.equal(audits[0].result, "success");
  assert.doesNotMatch(JSON.stringify(audits), /conteúdo operacional sensível/);
});

test("OV-P0-306 usa actor da sessão, UI somente em Links e Monitoring permanece sem IncidentActions", async () => {
  const [handler, route, component, links, monitoring] = await Promise.all([
    readFile(new URL("../api/_lib/oneview-servicenow-work-note.js", import.meta.url), "utf8"),
    readFile(new URL("../api/oneview/incidents/[sysId]/work-note.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/IncidentActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Monitoring.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(handler, /actorProvider = getAuthenticatedActor/);
  assert.match(handler, /Object\.keys\(body\).*key !== "work_note"/s);
  assert.match(route, /oneview-servicenow-work-note/);
  assert.match(component, /Adicionar anotação/);
  assert.match(component, /requestServiceNowIncidentWorkNote/);
  assert.match(links, /<IncidentActions incident=\{incident\}/);
  assert.doesNotMatch(monitoring, /IncidentActions/);
});
