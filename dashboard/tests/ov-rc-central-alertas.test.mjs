import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createServiceNowClaimHandler } from "../api/_lib/oneview-servicenow-claim.js";
import { createServiceNowMeHandler } from "../api/_lib/oneview-servicenow-me.js";
import { SERVICENOW_CLAIM_ERROR } from "../api/_lib/oneview-servicenow-claim.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.payload = body ? JSON.parse(body) : null; },
  };
}

test("sessão ausente responde 401 em /me e /claim sem autorizar o operador", async () => {
  const me = responseRecorder();
  await createServiceNowMeHandler()({ method: "GET", headers: {} }, me);
  assert.equal(me.statusCode, 401);
  assert.equal(me.payload.error, "authentication_required");

  let patches = 0;
  const claim = responseRecorder();
  await createServiceNowClaimHandler({
    patchIncident: async () => { patches += 1; },
  })({ method: "POST", headers: {}, query: { sysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, body: {} }, claim);
  assert.equal(claim.statusCode, 401);
  assert.equal(claim.payload.error, "authentication_required");
  assert.equal(patches, 0);
});

test("claim desligado não escreve no ServiceNow", async () => {
  let patches = 0;
  const res = responseRecorder();
  await createServiceNowClaimHandler({
    authorize: async () => ({ id: "operator" }),
    actorProvider: () => ({ actor_id: "operator", actor_name: "Operador", actor_username: "op@example.com" }),
    claimConfigProvider: () => ({ enabled: false, nocAssignmentGroupSysId: "2abab0fe47622610082e3d02e26d4325" }),
    patchIncident: async () => { patches += 1; },
    logger: () => undefined,
  })({ method: "POST", headers: {}, query: { sysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, body: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, SERVICENOW_CLAIM_ERROR.CLAIM_DISABLED);
  assert.equal(patches, 0);
});

test("a Central separa duração, tempo até ACK, claim e supressão indisponível", async () => {
  const [alerts, drawer, suppress, env] = await Promise.all([
    readFile(new URL("../src/pages/Alerts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/AlertDetailDrawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/AlertSuppressUnavailable.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.local.example", import.meta.url), "utf8"),
  ]);
  assert.match(alerts, /Duração do problema ativo/);
  assert.match(alerts, /Duração até o recovery/);
  assert.match(alerts, /Tempo até ACK/);
  assert.match(alerts, /ACK mede tempo de resposta/);
  assert.match(alerts, /onIncidentClaimed=\{\(\) => \{ void loadAlerts\(\{ quiet: true \}\); \}\}/);
  assert.match(alerts, /SelectItem value="50"/);
  assert.match(alerts, /SelectItem value="100"/);
  assert.match(alerts, /Suprimidos/);
  assert.match(drawer, /label="Duração"/);
  assert.match(drawer, /Problema ainda ativo/);
  assert.match(drawer, /Até o recovery/);
  assert.match(drawer, /Tempo até ACK/);
  assert.match(drawer, /visibleActions=\{\["claim"\]\}/);
  assert.match(drawer, /AlertSuppressUnavailable/);
  assert.match(suppress, /disabled/);
  assert.match(suppress, /Supressão indisponível até a homologação do probe e do executor/);
  assert.doesNotMatch(suppress, /requestSuppress|event\.acknowledge|action:\s*36|action:\s*64/);
  assert.match(env, /ONEVIEW_ACK_REQUEST_ENABLED=false/);
  assert.match(env, /ONEVIEW_ACK_EXECUTION_ENABLED=false/);
  assert.doesNotMatch(env, /ONEVIEW_SUPPRESS_REQUEST_ENABLED=true/);
  assert.doesNotMatch(env, /ONEVIEW_SERVICENOW_CLAIM_ENABLED=true/);
});
