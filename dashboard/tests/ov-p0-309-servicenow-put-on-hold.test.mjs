import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PUT_ON_HOLD_ERROR,
  createServiceNowPutOnHoldHandler,
  fetchServiceNowPutOnHoldIncident,
  incidentMatchesPutOnHold,
  ownershipMatches,
} from "../api/_lib/oneview-servicenow-put-on-hold.js";
import {
  getServiceNowExternalVendorsConfig,
  resolveExternalVendor,
} from "../api/_lib/oneview-servicenow-external-vendors.js";
import {
  SERVICENOW_PUT_ON_HOLD_REASON,
  SERVICENOW_PUT_ON_HOLD_STATE,
  serviceNowPatchIncidentPutOnHold,
} from "../api/_lib/servicenow-actions-client.js";

const INCIDENT_SYS_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_SYS_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GROUP_SYS_ID = "2abab0fe47622610082e3d02e26d4325";
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

function incident({
  state = "2",
  holdReason = "",
  vendor = "",
  assignedTo = USER_SYS_ID,
  assigneeName = "Guilherme Franco",
  assignmentGroup = GROUP_SYS_ID,
  groupName = "N1 - Serviços - NOC",
} = {}) {
  return {
    sys_id: INCIDENT_SYS_ID,
    number: "INC0081234",
    state,
    hold_reason: holdReason,
    external_vendor: vendor,
    assigned_to_id: assignedTo,
    assigned_to_name: assigneeName,
    assignment_group_id: assignmentGroup,
    assignment_group_name: groupName,
    updated_on: "2026-09-15 21:00:00",
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
  reads = [incident(), incident({ state: "3", holdReason: "4", vendor: "Cisco" })],
  patch = async () => ({}),
  audit = async () => undefined,
  invalidate = async () => undefined,
  vendorEnv = {},
  identityGuard = async () => null,
} = {}) {
  let readIndex = 0;
  return createServiceNowPutOnHoldHandler({
    authorize: async () => true,
    actorProvider: () => ACTOR,
    configProvider: () => CONFIG,
    vendorConfigProvider: () => getServiceNowExternalVendorsConfig(vendorEnv),
    readIncident: async () => reads[Math.min(readIndex++, reads.length - 1)],
    patchIncident: patch,
    audit,
    invalidateIncidentCache: invalidate,
    identityGuard,
    logger: () => undefined,
  });
}

async function request(handler, body = { external_vendor: "Cisco" }) {
  const res = responseRecorder();
  await handler({ method: "POST", query: { sysId: INCIDENT_SYS_ID }, body }, res);
  return res;
}

test("OV-P0-309 vendor allow-list usa default Cisco quando env ausente", () => {
  const config = getServiceNowExternalVendorsConfig({});
  assert.deepEqual(config.externalVendors, ["Cisco"]);
  assert.equal(config.source, "default:oneview-servicenow-external-vendors");
  assert.equal(resolveExternalVendor("cisco", config), "Cisco");
  assert.equal(resolveExternalVendor(" Juniper ", config), null);
});

test("OV-P0-309 hold PATCH envia somente state=3, hold_reason=4 e u_external_vendor", async () => {
  const patches = [];
  let invalidations = 0;
  const audits = [];
  const res = await request(createHandler({
    patch: async (sysId, payload, options) => {
      patches.push({ sysId, payload, options });
      return {};
    },
    audit: async (entry) => { audits.push(entry); },
    invalidate: async (sysId) => { assert.equal(sysId, INCIDENT_SYS_ID); invalidations += 1; },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].payload, {
    state: SERVICENOW_PUT_ON_HOLD_STATE,
    hold_reason: SERVICENOW_PUT_ON_HOLD_REASON,
    u_external_vendor: "Cisco",
  });
  assert.equal(invalidations, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].externalVendor, "Cisco");
  assert.equal(audits[0].result, "success");
});

test("OV-P0-309 hold preserva ownership após confirmação", async () => {
  const before = incident({ assignedTo: USER_SYS_ID, assignmentGroup: GROUP_SYS_ID });
  const after = incident({ state: "3", holdReason: "4", vendor: "Cisco", assignedTo: USER_SYS_ID, assignmentGroup: GROUP_SYS_ID });
  assert.ok(ownershipMatches(before, after));
  assert.ok(incidentMatchesPutOnHold(after, "Cisco"));
});

test("OV-P0-309 vendor inválido e campos extras retornam 400 sem PATCH", async () => {
  let patches = 0;
  const handler = createHandler({ patch: async () => { patches += 1; } });
  const invalidVendor = await request(handler, { external_vendor: "Acme" });
  const extraField = await request(handler, { external_vendor: "Cisco", state: "3" });
  assert.equal(invalidVendor.statusCode, 400);
  assert.equal(extraField.statusCode, 400);
  assert.equal(patches, 0);
});

test("OV-P0-309 timeout relê incidente e confirma hold sem retry agressivo", async () => {
  let patches = 0;
  const initial = incident();
  const afterTimeout = incident({ state: "3", holdReason: "4", vendor: "Cisco" });
  const res = await request(createHandler({
    reads: [initial, afterTimeout],
    patch: async () => {
      patches += 1;
      throw { code: "PUT_ON_HOLD_RESULT_UNCERTAIN" };
    },
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.incident.state, "3");
  assert.equal(patches, 1);
});

test("OV-P0-309 timeout sem confirmação retorna erro controlado", async () => {
  const initial = incident();
  const res = await request(createHandler({
    reads: [initial, incident({ state: "2" })],
    patch: async () => { throw { code: "PUT_ON_HOLD_RESULT_UNCERTAIN" }; },
  }));
  assert.equal(res.statusCode, 504);
  assert.equal(res.payload.error, PUT_ON_HOLD_ERROR.RESULT_UNCERTAIN);
});

test("OV-P0-309 write client PATCH restrito", async () => {
  let request;
  await serviceNowPatchIncidentPutOnHold(INCIDENT_SYS_ID, {
    state: SERVICENOW_PUT_ON_HOLD_STATE,
    hold_reason: SERVICENOW_PUT_ON_HOLD_REASON,
    u_external_vendor: "Cisco",
  }, {
    config: CONFIG,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ result: { sys_id: INCIDENT_SYS_ID } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.match(request.url, new RegExp(`/incident/${INCIDENT_SYS_ID}`));
  assert.equal(request.init.method, "PATCH");
  assert.deepEqual(JSON.parse(request.init.body), {
    state: "3",
    hold_reason: "4",
    u_external_vendor: "Cisco",
  });
});

test("OV-P0-309 read direto inclui hold_reason e u_external_vendor", async () => {
  const reads = [];
  const resolved = await fetchServiceNowPutOnHoldIncident(INCIDENT_SYS_ID, {
    config: CONFIG,
    getPage: async (table, options) => {
      reads.push({ table, options });
      return {
        records: [{
          sys_id: INCIDENT_SYS_ID,
          number: "INC0081234",
          state: "3",
          hold_reason: "4",
          u_external_vendor: { value: "Cisco", display_value: "Cisco" },
          sys_updated_on: "2026-09-15 21:00:00",
          assignment_group: { value: GROUP_SYS_ID, display_value: "N1 - Serviços - NOC" },
          assigned_to: { value: USER_SYS_ID, display_value: "Guilherme Franco" },
        }],
      };
    },
  });
  assert.equal(resolved.external_vendor, "Cisco");
  assert.match(reads[0].options.sysparm_fields, /hold_reason/);
  assert.match(reads[0].options.sysparm_fields, /u_external_vendor/);
});

test("OV-P0-309 IncidentActions completo em Links, claim inalterado, Monitoring sem actions", async () => {
  const [claimClient, component, operadoras, monitoring, workNote, attachment, putOnHoldHandler] = await Promise.all([
    readFile(new URL("../api/_lib/servicenow-actions-client.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/IncidentActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Monitoring.tsx", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-servicenow-work-note.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-servicenow-attachment.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-servicenow-put-on-hold.js", import.meta.url), "utf8"),
  ]);
  assert.match(claimClient, /serviceNowPatchIncidentClaim[\s\S]*assigned_to/);
  assert.doesNotMatch(claimClient, /serviceNowPatchIncidentClaim[\s\S]*hold_reason/);
  assert.match(component, /Mais ações/);
  assert.match(component, /DropdownMenu/);
  assert.match(component, /requestServiceNowIncidentPutOnHold/);
  assert.match(component, /Chamado colocado em espera/);
  assert.doesNotMatch(component, /Colocar em espera[\s\S]*flex flex-wrap gap-2[\s\S]*Colocar em espera/);
  assert.match(operadoras, /onPutOnHold=/);
  assert.match(operadoras, /IncidentDetailActions/);
  assert.match(operadoras, /buildAlertArtifactFromCanonicalLink/);
  assert.doesNotMatch(monitoring, /<IncidentActions/);
  assert.match(workNote, /export function buildOneViewWorkNote[\s\S]*?return `\[OneView • \$\{name\}\]/);
  assert.match(attachment, /serviceNowPostIncidentAttachment/);
  assert.match(putOnHoldHandler, /SERVICENOW_INCIDENT_PUT_ON_HOLD/);
});

test("OV-P0-309 confirmação exige passo explícito antes do PATCH", async () => {
  const component = await readFile(new URL("../src/components/oneview/IncidentActions.tsx", import.meta.url), "utf8");
  assert.match(component, /proceedHoldConfirmation/);
  assert.match(component, /setHoldConfirmOpen\(true\)/);
  assert.match(component, /AlertDialogAction[\s\S]*void putOnHold\(\)/);
});

test("OV-P0-315 put on hold blocks an identity conflict before PATCH", async () => {
  let patches = 0;
  const res = await request(createHandler({
    identityGuard: async () => { throw { code: PUT_ON_HOLD_ERROR.IDENTITY_CONFLICT }; },
    patch: async () => { patches += 1; },
  }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.error, PUT_ON_HOLD_ERROR.IDENTITY_CONFLICT);
  assert.equal(patches, 0);
});
