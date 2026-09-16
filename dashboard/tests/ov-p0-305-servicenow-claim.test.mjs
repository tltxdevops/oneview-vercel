import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SERVICENOW_CLAIM_ERROR,
  createServiceNowClaimHandler,
  fetchServiceNowClaimIncident,
} from "../api/_lib/oneview-servicenow-claim.js";
import { SERVICENOW_IDENTITY_ERROR } from "../api/_lib/oneview-servicenow-identity.js";
import { serviceNowPatchIncidentClaim } from "../api/_lib/servicenow-actions-client.js";

const INCIDENT_SYS_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_SYS_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_USER_SYS_ID = "cccccccccccccccccccccccccccccccc";
const GROUP_SYS_ID = "2abab0fe47622610082e3d02e26d4325";
const ACTOR = Object.freeze({ actor_id: "entra-oid", actor_name: "Guilherme Franco", actor_username: "guilherme.franco@teletex.com.br" });

function incident({ assignedTo = "", assigneeName = "", assignmentGroup = "", groupName = "", updatedOn = "2026-09-15 21:00:00" } = {}) {
  return {
    sys_id: INCIDENT_SYS_ID,
    number: "INC0081234",
    state: "3",
    assigned_to_id: assignedTo,
    assigned_to_name: assigneeName,
    assignment_group_id: assignmentGroup,
    assignment_group_name: groupName,
    active: true,
    updated_on: updatedOn,
  };
}

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
  identity = { user: { sys_id: USER_SYS_ID }, noc_member: true },
  reads = [incident(), incident({ assignedTo: USER_SYS_ID, assigneeName: "Guilherme Franco", assignmentGroup: GROUP_SYS_ID, groupName: "N1 - Serviços - NOC" })],
  patch = async () => ({}),
  audit = async () => undefined,
  invalidate = async () => undefined,
} = {}) {
  let readIndex = 0;
  return createServiceNowClaimHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    identityResolver: { resolveOperationalServiceNowIdentity: async () => identity },
    claimConfigProvider: () => ({ enabled: true, nocAssignmentGroupSysId: GROUP_SYS_ID }),
    readIncident: async () => reads[Math.min(readIndex++, reads.length - 1)],
    patchIncident: patch,
    audit,
    invalidateIncidentCache: invalidate,
    logger: () => undefined,
  });
}

async function request(handler, { body = { confirm_reassign: false } } = {}) {
  const res = responseRecorder();
  await handler({ method: "POST", query: { sysId: INCIDENT_SYS_ID }, body }, res);
  return res;
}

test("OV-P0-305 claim unassigned faz PATCH somente com grupo NOC e usuário resolvido", async () => {
  const patches = [];
  let invalidations = 0;
  const handler = createHandler({
    patch: async (sysId, payload) => { patches.push({ sysId, payload }); return {}; },
    invalidate: async (sysId) => { assert.equal(sysId, INCIDENT_SYS_ID); invalidations += 1; },
  });
  const res = await request(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.already_assigned, false);
  assert.deepEqual(patches, [{ sysId: INCIDENT_SYS_ID, payload: { assignment_group: GROUP_SYS_ID, assigned_to: USER_SYS_ID } }]);
  assert.equal(invalidations, 1);
  assert.doesNotMatch(JSON.stringify(res.payload), new RegExp(`${USER_SYS_ID}|${GROUP_SYS_ID}`));
});

test("OV-P0-305 assigned_to=self retorna sucesso idempotente sem PATCH", async () => {
  let patches = 0;
  const self = incident({ assignedTo: USER_SYS_ID, assigneeName: "Guilherme Franco", assignmentGroup: OTHER_USER_SYS_ID, groupName: "Outro grupo" });
  const res = await request(createHandler({ reads: [self], patch: async () => { patches += 1; } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.already_assigned, true);
  assert.equal(patches, 0);
});

test("OV-P0-305 assigned_to=other requer confirmação explícita", async () => {
  let patches = 0;
  const other = incident({ assignedTo: OTHER_USER_SYS_ID, assigneeName: "João Silva" });
  const res = await request(createHandler({ reads: [other], patch: async () => { patches += 1; } }));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, {
    error: SERVICENOW_CLAIM_ERROR.ASSIGNED_TO_OTHER,
    current_assignee_name: "João Silva",
    requires_confirmation: true,
  });
  assert.equal(patches, 0);
});

test("OV-P0-305 reassign confirmado faz PATCH", async () => {
  let patches = 0;
  const other = incident({ assignedTo: OTHER_USER_SYS_ID, assigneeName: "João Silva" });
  const confirmed = incident({ assignedTo: USER_SYS_ID, assigneeName: "Guilherme Franco", assignmentGroup: GROUP_SYS_ID, groupName: "N1 - Serviços - NOC" });
  const res = await request(createHandler({ reads: [other, confirmed], patch: async () => { patches += 1; } }), { body: { confirm_reassign: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.incident.assigned_to_name, "Guilherme Franco");
  assert.equal(patches, 1);
});

test("OV-P0-305 NOC ausente e usuário ServiceNow ausente falham sem leitura/PATCH", async () => {
  let reads = 0;
  let patches = 0;
  const noMembership = createHandler({
    identity: { user: { sys_id: USER_SYS_ID }, noc_member: false },
    reads: [null],
    patch: async () => { patches += 1; },
  });
  const membershipRes = await request(noMembership);
  assert.equal(membershipRes.statusCode, 403);
  assert.equal(membershipRes.payload.error, SERVICENOW_IDENTITY_ERROR.NOC_MEMBERSHIP_REQUIRED);

  const noUser = createServiceNowClaimHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    identityResolver: { resolveOperationalServiceNowIdentity: async () => { throw { code: SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND }; } },
    claimConfigProvider: () => ({ enabled: true, nocAssignmentGroupSysId: GROUP_SYS_ID }),
    readIncident: async () => { reads += 1; return null; },
    patchIncident: async () => { patches += 1; },
    logger: () => undefined,
  });
  const userRes = await request(noUser);
  assert.equal(userRes.statusCode, 404);
  assert.equal(userRes.payload.error, SERVICENOW_IDENTITY_ERROR.USER_NOT_FOUND);
  assert.equal(reads, 0);
  assert.equal(patches, 0);
});

test("OV-P0-305 incidente inexistente e PATCH 5xx retornam erro seguro", async () => {
  const missing = await request(createHandler({ reads: [null] }));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.payload.error, SERVICENOW_CLAIM_ERROR.INCIDENT_NOT_FOUND);

  const unavailable = await request(createHandler({ patch: async () => { throw { code: "servicenow_unavailable" }; } }));
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.payload, { error: SERVICENOW_CLAIM_ERROR.UNAVAILABLE });
});

test("OV-P0-305 timeout do PATCH confirma por releitura antes de nova escrita", async () => {
  let patches = 0;
  const initial = incident();
  const afterTimeout = incident({ assignedTo: USER_SYS_ID, assigneeName: "Guilherme Franco", assignmentGroup: GROUP_SYS_ID, groupName: "N1 - Serviços - NOC" });
  const res = await request(createHandler({
    reads: [initial, afterTimeout],
    patch: async () => { patches += 1; throw { code: "servicenow_timeout" }; },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(patches, 1);
});

test("OV-P0-305 rejeita campos de identidade e group enviados pelo browser", async () => {
  let reads = 0;
  let patches = 0;
  const handler = createHandler({
    reads: [incident()],
    patch: async () => { patches += 1; },
  });
  const assignedTo = await request(handler, { body: { confirm_reassign: true, assigned_to: OTHER_USER_SYS_ID } });
  const group = await request(handler, { body: { confirm_reassign: true, assignment_group: GROUP_SYS_ID } });
  assert.equal(assignedTo.statusCode, 400);
  assert.equal(group.statusCode, 400);
  assert.equal(assignedTo.payload.error, SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
  assert.equal(group.payload.error, SERVICENOW_CLAIM_ERROR.INVALID_REQUEST);
  assert.equal(reads, 0);
  assert.equal(patches, 0);
});

test("OV-P0-305 audit falho não mascara PATCH confirmado", async () => {
  const res = await request(createHandler({ audit: async () => { throw new Error("db unavailable"); } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
});

test("OV-P0-305 read direto solicita campos mínimos e write client usa PATCH restrito", async () => {
  const reads = [];
  const resolved = await fetchServiceNowClaimIncident(INCIDENT_SYS_ID, {
    config: { configured: true },
    getPage: async (table, options) => {
      reads.push({ table, options });
      return { records: [{
        sys_id: INCIDENT_SYS_ID, number: "INC0081234", state: "3", active: "true", sys_updated_on: "2026-09-15 21:00:00",
        assignment_group: { value: GROUP_SYS_ID, display_value: "N1 - Serviços - NOC" },
        assigned_to: { value: USER_SYS_ID, display_value: "Guilherme Franco" },
      }] };
    },
  });
  assert.equal(resolved.assigned_to_name, "Guilherme Franco");
  assert.equal(reads[0].table, "incident");
  assert.equal(reads[0].options.sysparm_fields, "sys_id,number,state,assignment_group,assigned_to,active,sys_updated_on");

  let request;
  await serviceNowPatchIncidentClaim(INCIDENT_SYS_ID, { assignment_group: GROUP_SYS_ID, assigned_to: USER_SYS_ID }, {
    config: { configured: true, baseUrl: "https://servicenow.example", username: "user", password: "secret", timeoutMs: 1_000 },
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ result: { sys_id: INCIDENT_SYS_ID } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(request.url, new RegExp(`/incident/${INCIDENT_SYS_ID}`));
  assert.equal(request.init.method, "PATCH");
  assert.deepEqual(JSON.parse(request.init.body), { assignment_group: GROUP_SYS_ID, assigned_to: USER_SYS_ID });
  assert.equal(request.init.headers.Accept, "application/json");
  assert.equal(request.init.headers["Content-Type"], "application/json");
});

test("OV-P0-305 rota e IncidentActions funcionam no drawer de Operadoras sem navegação", async () => {
  const [route, component, operadoras] = await Promise.all([
    readFile(new URL("../api/oneview/incidents/[sysId]/claim.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/IncidentActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /oneview-servicenow-claim/);
  assert.match(component, /fetchServiceNowOperatorIdentity/);
  assert.match(component, /requestServiceNowIncidentClaim/);
  assert.match(component, /INCIDENT_ASSIGNED_TO_OTHER/);
  assert.match(component, /Seu usuário não pertence ao grupo N1 - Serviços - NOC no ServiceNow/);
  assert.match(operadoras, /<IncidentActions incident=\{incident\} onClaimed=/);
  assert.doesNotMatch(component, /work_note|assignment_group.*payload|assigned_to.*payload/);
});
