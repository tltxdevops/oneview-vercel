import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  AILOS_TEAMS_DESTINATION_ID,
  AILOS_TEAMS_PILOT_DESTINATION,
  CLIENT_SHARE_ENVS,
  clientShareDestinationCatalog,
  clientShareMessageContract,
  clientShareSmokeAuditRecord,
  isClientSharingEnabled,
  parseTeamsWorkflowWebhookRegistry,
  publicClientShareDestination,
  resolveTeamsWorkflowWebhookUrl,
  TEAMS_WORKFLOW_AILOS_ENV,
  TEAMS_WORKFLOW_WEBHOOKS_ENV,
  teamsWorkflowEnvName,
  teamsWorkflowTimeoutMs,
  teamsWorkflowWebhookConfigError,
} from "../api/_lib/oneview-client-sharing.js";
import { insertAuditLog } from "../api/_lib/audit.js";
import { createClientSharingHandler } from "../api/_lib/oneview-client-sharing-handler.js";
import {
  sendTeamsClientShare,
  sendWebexClientShare,
  TEAMS_TRANSPORT_STRATEGY,
  teamsWorkflowAlertPayload,
  teamsWorkflowSmokePayload,
} from "../api/_lib/oneview-client-sharing-transports.js";

const WEBHOOK = "https://example.webhook.office.com/webhookb2/ailos-secret-token";
const OTHER_HOOK = "https://example.webhook.office.com/webhookb2/other-secret-token";

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, end(value) { this.body = JSON.parse(value); } };
}

function ailosDestination() {
  return {
    ...AILOS_TEAMS_PILOT_DESTINATION,
    teams_webhook_url: OTHER_HOOK,
  };
}

function handlerFor({ env, teams, fetchImpl } = {}) {
  let existing = false;
  const audits = [];
  const calls = { teams: 0, webex: 0 };
  const resolvedEnv = {
    ONEVIEW_CLIENT_SHARING_ENABLED: "false",
    TEAMS_WORKFLOW_AILOS: WEBHOOK,
    ...env,
  };
  return {
    audits,
    calls,
    handler: createClientSharingHandler({
      authorize: async () => ({ id: "operator-1", name: "Operador" }),
      env: resolvedEnv,
      enabled: () => isClientSharingEnabled(resolvedEnv),
      catalog: () => clientShareDestinationCatalog(resolvedEnv),
      transaction: async (work) => work({ query: async (sql) => ({ rowCount: sql.includes("metadata->>") && existing ? 1 : 0 }) }),
      audit: async (client, record) => {
        existing = true;
        audits.push(record);
      },
      teams: teams || ((input) => sendTeamsClientShare({ ...input, fetchImpl })),
      webex: async () => {
        calls.webex += 1;
        return { transport: "webex", status: "dry_run", destination_id: "must-not-run", external_called: false };
      },
    }),
  };
}

async function sendAlert(handler, body) {
  const res = response();
  await handler({
    method: "POST",
    query: { mode: "send" },
    body,
    headers: {},
  }, res);
  return res;
}

function ailosAlertMessage(partial = {}) {
  return {
    client_key: "ailos",
    client_name: "Ailos",
    severity: "warning",
    host: "AILOS - SFP03200APIC03",
    equipment: "SFP03200APIC03",
    problem: "ICMP ping indisponível",
    started_at: "2026-09-30T12:03:00Z",
    status: "Ativo",
    message_type: "alert",
    oneview_url: "https://oneview.example/alertas?alert=sfp03200apic03",
    ...partial,
  };
}

async function smoke(handler, body, destinationId = AILOS_TEAMS_DESTINATION_ID) {
  const res = response();
  await handler({
    method: "POST",
    query: { mode: "send", smoke: "1" },
    body: { destination_id: destinationId, idempotency_key: "client-share-smoke:ailos-01", ...body },
    headers: {},
  }, res);
  return res;
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("piloto Ailos: destino canônico sem webhook e metadados internos", () => {
  const catalog = clientShareDestinationCatalog({});
  const ailos = catalog.find((item) => item.destination_id === AILOS_TEAMS_DESTINATION_ID);
  assert.equal(catalog.filter((item) => item.channel_type === "teams").length, 1);
  assert.equal(ailos.client_key, "ailos");
  assert.equal(ailos.route_key, "noc");
  assert.equal(ailos.route_label, "Ailos");
  assert.equal(ailos.destination_name, "Ailos");
  assert.equal(ailos.channel_type, "teams");
  assert.equal(ailos.enabled, true);
  assert.equal(ailos.is_default, true);
  assert.equal(ailos.team_id, "bb8dcc45-957b-4aec-8c77-f28338d2444f");
  assert.equal(ailos.channel_id, "19:HnFt-pLXTtlhf2RRczlD0ZAjyy766IIWz-8vpNWn33k1@thread.tacv2");
  assert.equal(ailos.tenant_id, "9c36f529-164f-47cd-bca0-ba7c0d710407");
  assert.equal(ailos.teams_webhook_url, null);
  const published = publicClientShareDestination(ailos);
  assert.equal(Object.hasOwn(published, "teams_webhook_url"), false);
  assert.equal(Object.hasOwn(published, "team_id"), false);
  assert.equal(JSON.stringify(published).includes(WEBHOOK), false);
});

test("piloto Ailos: JSON não sobrescreve destino nem injeta webhook", () => {
  const catalog = clientShareDestinationCatalog({
    ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
      ...AILOS_TEAMS_PILOT_DESTINATION,
      destination_name: "Ailos Override",
      teams_webhook_url: WEBHOOK,
    }]),
  });
  const matches = catalog.filter((item) => item.destination_id === AILOS_TEAMS_DESTINATION_ID);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].destination_name, "Ailos");
  assert.equal(matches[0].teams_webhook_url, null);
});

test("piloto Ailos: ENV server-side resolve só ailos-teams", () => {
  const env = { TEAMS_WORKFLOW_AILOS: WEBHOOK, TEAMS_WORKFLOW_TIMEOUT_MS: "5000" };
  assert.equal(teamsWorkflowEnvName("ailos-teams", env), TEAMS_WORKFLOW_AILOS_ENV);
  assert.equal(resolveTeamsWorkflowWebhookUrl("ailos-teams", env), WEBHOOK);
  assert.equal(resolveTeamsWorkflowWebhookUrl("braskem:noc:teams", env), null);
  assert.equal(teamsWorkflowTimeoutMs(env), 5000);
  assert.equal(teamsWorkflowTimeoutMs({}), 8000);
  assert.equal(CLIENT_SHARE_ENVS.teamsWorkflowAilos, TEAMS_WORKFLOW_AILOS_ENV);
  assert.equal(CLIENT_SHARE_ENVS.teamsWorkflowWebhooks, TEAMS_WORKFLOW_WEBHOOKS_ENV);
  assert.equal(isClientSharingEnabled({}), false);
  assert.equal(isClientSharingEnabled({ ONEVIEW_CLIENT_SHARING_ENABLED: "false" }), false);
});

test("registry Teams: JSON válido resolve HTTPS só para destination_id habilitado", () => {
  const catalogEnv = {
    ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
      client_key: "braskem",
      route_key: "noc",
      route_label: "NOC",
      destination_id: "braskem:noc:teams",
      destination_name: "NOC",
      channel_type: "teams",
      enabled: true,
      is_default: true,
    }]),
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({
      "ailos-teams": OTHER_HOOK,
      "braskem:noc:teams": WEBHOOK,
      "ghost-dest": WEBHOOK,
    }),
  };
  assert.equal(parseTeamsWorkflowWebhookRegistry(catalogEnv).error, null);
  assert.equal(resolveTeamsWorkflowWebhookUrl("ailos-teams", catalogEnv), OTHER_HOOK);
  assert.equal(resolveTeamsWorkflowWebhookUrl("braskem:noc:teams", catalogEnv), WEBHOOK);
  assert.equal(resolveTeamsWorkflowWebhookUrl("ghost-dest", catalogEnv), null);
  assert.equal(resolveTeamsWorkflowWebhookUrl("braskem:noc:teams", {
    ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
      client_key: "braskem",
      route_key: "noc",
      route_label: "NOC",
      destination_id: "braskem:noc:teams",
      destination_name: "NOC",
      channel_type: "teams",
      enabled: false,
    }]),
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "braskem:noc:teams": WEBHOOK }),
  }), null);
  assert.equal(teamsWorkflowEnvName("ailos-teams", catalogEnv), TEAMS_WORKFLOW_WEBHOOKS_ENV);
  assert.equal(teamsWorkflowWebhookConfigError("ailos-teams", catalogEnv), null);
});

test("registry Teams: JSON inválido, HTTP e destino ausente falham com erro claro", () => {
  assert.equal(parseTeamsWorkflowWebhookRegistry({ ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: "{not-json" }).error, "webhook_registry_invalid");
  assert.equal(parseTeamsWorkflowWebhookRegistry({ ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: "[]" }).error, "webhook_registry_invalid");
  assert.equal(teamsWorkflowWebhookConfigError("ailos-teams", { ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: "{not-json" }), "webhook_registry_invalid");
  assert.equal(teamsWorkflowWebhookConfigError("ailos-teams", {
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "ailos-teams": "http://insecure.example/hook" }),
  }), "webhook_not_configured");
  assert.equal(teamsWorkflowWebhookConfigError("ailos-teams", {
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "ghost-dest": WEBHOOK }),
  }), "webhook_not_configured");
  assert.equal(resolveTeamsWorkflowWebhookUrl("ailos-teams", {
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "ailos-teams": "http://insecure.example/hook" }),
    TEAMS_WORKFLOW_AILOS: WEBHOOK,
  }), null);
  assert.equal(teamsWorkflowWebhookConfigError("ailos-teams", { TEAMS_WORKFLOW_AILOS: "" }), "webhook_not_configured");
});

test("registry Teams: JSON prevalece sobre TEAMS_WORKFLOW_AILOS e não vaza URL", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler, audits } = handlerFor({
    env: {
      TEAMS_WORKFLOW_AILOS: WEBHOOK,
      ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "ailos-teams": OTHER_HOOK }),
    },
    fetchImpl,
  });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-json-winsxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, OTHER_HOOK);
  assert.equal(JSON.stringify(res.body).includes(OTHER_HOOK), false);
  assert.equal(JSON.stringify(res.body).includes(WEBHOOK), false);
  assert.equal(JSON.stringify(audits).includes(OTHER_HOOK), false);
  assert.equal(Object.hasOwn(res.body.deliveries[0], "env_name"), false);
});

test("registry Teams: JSON sozinho habilita send Ailos sem TEAMS_WORKFLOW_AILOS", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler } = handlerFor({
    env: {
      TEAMS_WORKFLOW_AILOS: "",
      ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "ailos-teams": WEBHOOK }),
    },
    fetchImpl,
  });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-json-onlyxxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  assert.equal(JSON.stringify(res.body).includes(WEBHOOK), false);
  const destRes = response();
  await handler({
    method: "GET",
    query: { mode: "destinations", client_key: "ailos" },
    headers: {},
  }, destRes);
  assert.equal(destRes.statusCode, 200);
  assert.equal(JSON.stringify(destRes.body).includes(WEBHOOK), false);
  assert.equal(JSON.stringify(destRes.body).includes("webhookb2"), false);
});

test("registry Teams: JSON inválido no send não chama HTTP e erro é claro", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 200, text: async () => "ok" }));
  const { handler, audits } = handlerFor({
    env: { ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: "{broken", TEAMS_WORKFLOW_AILOS: WEBHOOK },
    fetchImpl,
  });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-json-badxxxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, "webhook_registry_invalid");
  assert.equal(res.body.destination_id, AILOS_TEAMS_DESTINATION_ID);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(audits.length, 0);
});

test("registry Teams: destino extra no JSON não altera roteamento nem dispara POST", async () => {
  let called = false;
  const { handler } = handlerFor({
    env: {
      ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
        client_key: "braskem",
        route_key: "noc",
        route_label: "NOC",
        destination_id: "braskem:noc:teams",
        destination_name: "NOC",
        channel_type: "teams",
        enabled: true,
        is_default: true,
      }]),
      ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({
        "ailos-teams": WEBHOOK,
        "braskem:noc:teams": OTHER_HOOK,
      }),
    },
    teams: async () => { called = true; throw new Error("must_not_send"); },
  });
  const res = await sendAlert(handler, {
    destination_id: "braskem:noc:teams",
    idempotency_key: "client-share:registry-no-route1",
    message: {
      client_key: "braskem", client_name: "Braskem", severity: "High", host: "host-a",
      problem: "Indisponível", started_at: "2026-09-30T12:00:00Z", status: "Ativo", message_type: "alert",
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "client_sharing_disabled");
  assert.equal(called, false);
  assert.equal(resolveTeamsWorkflowWebhookUrl("braskem:noc:teams", {
    ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
      client_key: "braskem",
      route_key: "noc",
      route_label: "NOC",
      destination_id: "braskem:noc:teams",
      destination_name: "NOC",
      channel_type: "teams",
      enabled: true,
    }]),
    ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON: JSON.stringify({ "braskem:noc:teams": OTHER_HOOK }),
  }), OTHER_HOOK);
});

test("piloto Ailos: feature flag global continua false e send de outro destino não chama Teams", async () => {
  let called = false;
  const { handler } = handlerFor({
    env: {
      ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify([{
        client_key: "braskem",
        route_key: "noc",
        route_label: "NOC",
        destination_id: "braskem:noc:teams",
        destination_name: "NOC",
        channel_type: "teams",
        enabled: true,
        is_default: true,
      }]),
    },
    teams: async () => { called = true; throw new Error("must_not_send"); },
  });
  const res = await sendAlert(handler, {
    destination_id: "braskem:noc:teams",
    idempotency_key: "client-share:regular-blocked1",
    message: {
      client_key: "braskem", client_name: "Braskem", severity: "High", host: "host-a",
      problem: "Indisponível", started_at: "2026-09-30T12:00:00Z", status: "Ativo", message_type: "alert",
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "client_sharing_disabled");
  assert.equal(called, false);
});

test("piloto Ailos: preview libera live_send com flag global false", async () => {
  const { handler } = handlerFor();
  const res = response();
  await handler({
    method: "POST",
    query: { mode: "preview" },
    body: { message: ailosAlertMessage() },
    headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.live_send, true);
  assert.equal(res.body.external_enabled, true);
  assert.equal(res.body.destination.destination_id, AILOS_TEAMS_DESTINATION_ID);
  assert.equal(res.body.preview.text, [
    "🟡 AILOS - SFP03200APIC03 - ICMP ping indisponível",
    "📟 Equipamento: SFP03200APIC03",
    "📅 Data/Hora: 30/09/2026 - 09:03:00",
    "🛠️ Ação: Alerta em análise.",
    "🔄 Próximos Passos: Acompanhando alerta.",
    "🔎 Acompanhamento: Equipe NOC",
  ].join("\n"));
  assert.doesNotMatch(res.body.preview.text, /Abrir no OneView|Abrir no ServiceNow|https?:\/\//);
});

test("piloto Ailos: send real do alerta posta Adaptive Card no Workflow", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const message = ailosAlertMessage();
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-01xxxx",
    message,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dry_run, false);
  assert.equal(res.body.live_send, true);
  assert.equal(res.body.smoke, undefined);
  assert.equal(res.body.deliveries[0].destination_id, "ailos-teams");
  assert.equal(res.body.deliveries[0].status, "sent");
  assert.equal(res.body.deliveries[0].http_status, 202);
  assert.equal(res.body.deliveries[0].external_called, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "application/json");
  const posted = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(posted, teamsWorkflowAlertPayload(clientShareMessageContract(message)));
  assert.deepEqual(posted.attachments[0].content.body.map((item) => item.text), [
    "🟡 AILOS - SFP03200APIC03 - ICMP ping indisponível",
    "📟 Equipamento: SFP03200APIC03",
    "📅 Data/Hora: 30/09/2026 - 09:03:00",
    "🛠️ Ação: Alerta em análise.",
    "🔄 Próximos Passos: Acompanhando alerta.",
    "🔎 Acompanhamento: Equipe NOC",
  ]);
  assert.equal(posted.attachments[0].content.actions, undefined);
  assert.doesNotMatch(JSON.stringify(posted), /Abrir no OneView|Abrir no ServiceNow|FactSet|Action.OpenUrl/);
  assert.doesNotMatch(JSON.stringify(posted), /Teste OneView/);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(audits[0].entityType, "client_share");
  assert.equal(typeof audits[0].entityId, "string");
  assert.match(audits[0].entityId, /^[a-f0-9]{32}$/);
  assert.equal(audits[0].actorName, "Operador");
  assert.equal(audits[0].actorId, "operator-1");
  assert.equal(audits[0].metadata.destination_id, "ailos-teams");
  assert.equal(audits[0].metadata.status, "reserved");
  assert.equal(audits[0].metadata.live_send, true);
  assert.equal(audits[1].action, "client_share_sent");
  assert.equal(audits[1].metadata.status, "sent");
  assert.equal(audits[1].metadata.http_status, 202);
  assert.equal(JSON.stringify(res.body).includes(WEBHOOK), false);
  assert.equal(JSON.stringify(audits).includes(WEBHOOK), false);
});

test("piloto Ailos: send real sem ENV não faz POST", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 200, text: async () => "ok" }));
  const { handler, audits } = handlerFor({ env: { TEAMS_WORKFLOW_AILOS: "" }, fetchImpl });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-noenvxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, "webhook_not_configured");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(audits.length, 0);
});

test("piloto Ailos: send real idempotency_key impede segundo POST", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-dupxxxx",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(audits[1].action, "client_share_sent");
});

test("piloto Ailos: send mapeia audit camelCase, persiste idempotency e bloqueia segundo POST", async () => {
  const inserts = [];
  const storedKeys = new Set();
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const env = {
    ONEVIEW_CLIENT_SHARING_ENABLED: "false",
    TEAMS_WORKFLOW_AILOS: WEBHOOK,
  };
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    env,
    enabled: () => false,
    catalog: () => clientShareDestinationCatalog(env),
    transaction: async (work) => work({
      query: async (sql, values = []) => {
        if (String(sql).includes("insert into audit_logs")) {
          inserts.push(values);
          const metadata = JSON.parse(values[14] || "{}");
          if (metadata.idempotency_key) storedKeys.add(metadata.idempotency_key);
          return { rowCount: 1 };
        }
        if (String(sql).includes("metadata->>'idempotency_key'")) {
          return { rowCount: storedKeys.has(values[1]) ? 1 : 0 };
        }
        return { rowCount: 0 };
      },
    }),
    audit: insertAuditLog,
    teams: (input) => sendTeamsClientShare({ ...input, fetchImpl }),
    webex: async () => ({ transport: "webex", status: "dry_run", destination_id: "must-not-run", external_called: false }),
  });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-audit-map-01",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.dry_run, false);
  assert.equal(first.body.live_send, true);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.deliveries[0].status, "sent");
  assert.equal(first.body.deliveries[0].http_status, 202);
  assert.equal(first.body.idempotency_key, body.idempotency_key);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0][4], "client_share_requested");
  assert.equal(inserts[1][4], "client_share_sent");
  assert.equal(inserts[0][6], "client_share");
  assert.match(String(inserts[0][7]), /^[a-f0-9]{32}$/);
  assert.equal(inserts[0][1], "Operador");
  assert.equal(inserts[0][3], "operator-1");
  assert.equal(JSON.parse(inserts[0][14]).idempotency_key, body.idempotency_key);
  assert.equal(storedKeys.has(body.idempotency_key), true);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.deliveries.length, 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(inserts.length, 2);
});

test("piloto Ailos: acompanhamento do card não usa o sender; audit registra o actor", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const message = ailosAlertMessage({ follow_up: "Ana NOC" });
  const preview = response();
  await handler({
    method: "POST",
    query: { mode: "preview" },
    body: { message },
    headers: {},
  }, preview);
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-ownerxxx",
    message,
  });
  assert.equal(preview.statusCode, 200);
  assert.match(preview.body.preview.text, /🔎 Acompanhamento: Ana NOC/);
  assert.doesNotMatch(preview.body.preview.text, /🔎 Acompanhamento: Operador/);
  assert.equal(preview.body.preview.text, teamsWorkflowAlertPayload(clientShareMessageContract(message))
    .attachments[0].content.body.map((item) => item.text).join("\n"));
  assert.equal(res.statusCode, 200);
  const posted = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(posted.attachments[0].content.body[5].text, "🔎 Acompanhamento: Ana NOC");
  assert.equal(preview.body.preview.text, posted.attachments[0].content.body.map((item) => item.text).join("\n"));
  assert.equal(audits[0].actorName, "Operador");
  assert.notEqual(audits[0].actorName, "Ana NOC");
});

test("piloto Ailos: card com chamado usa ação operacional e não inclui botões", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const { handler } = handlerFor({ fetchImpl });
  const message = ailosAlertMessage({
    incident_number: "INC0085840",
    incident_state: "Em andamento",
    servicenow_url: "https://teletex.service-now.com/nav_to.do?uri=incident.do?sys_id=abc",
  });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-incxxxxx",
    message,
  });
  assert.equal(res.statusCode, 200);
  const posted = JSON.parse(fetchImpl.calls[0].init.body);
  assert.match(posted.attachments[0].content.body[3].text, /Aberto chamado INC0085840 para acompanhamento de alerta\./);
  assert.equal(posted.attachments[0].content.actions, undefined);
  assert.doesNotMatch(JSON.stringify(posted), /Abrir no OneView|Abrir no ServiceNow|Action.OpenUrl/);
  assert.equal(JSON.stringify(posted).includes("webhookb2"), false);
});

test("piloto Ailos: HTTP 4xx não finge sucesso e não faz retry", async () => {
  let attempts = 0;
  const fetchImpl = mockFetch(async () => {
    attempts += 1;
    return { status: 400, text: async () => "bad payload" };
  });
  const { handler, audits } = handlerFor({ fetchImpl });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-rejectxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dry_run, false);
  assert.equal(res.body.deliveries[0].status, "definite_failure");
  assert.equal(res.body.deliveries[0].http_status, 400);
  assert.notEqual(res.body.deliveries[0].status, "sent");
  assert.equal(attempts, 1);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(audits[1].action, "client_share_failed");
  assert.equal(audits[1].metadata.status, "definite_failure");
});

test("piloto Ailos: reserva commita antes do POST e o resultado vira INSERT", async () => {
  const events = [];
  let existing = false;
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    env: { ONEVIEW_CLIENT_SHARING_ENABLED: "false", TEAMS_WORKFLOW_AILOS: WEBHOOK },
    enabled: () => false,
    catalog: () => clientShareDestinationCatalog({ TEAMS_WORKFLOW_AILOS: WEBHOOK }),
    transaction: async (work) => {
      events.push("tx-open");
      const result = await work({ query: async (sql) => ({ rowCount: String(sql).includes("metadata->>") && existing ? 1 : 0 }) });
      events.push("tx-commit");
      return result;
    },
    audit: async (_client, record) => {
      existing = true;
      events.push(record.action);
    },
    teams: async (input) => {
      events.push("post");
      return sendTeamsClientShare({ ...input, fetchImpl });
    },
    webex: async () => ({ transport: "webex", status: "dry_run", destination_id: "must-not-run", external_called: false }),
  });
  const res = await sendAlert(handler, {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-orderxxx",
    message: ailosAlertMessage(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deliveries[0].status, "sent");
  assert.deepEqual(events, [
    "tx-open", "client_share_requested", "tx-commit",
    "post",
    "tx-open", "client_share_sent", "tx-commit",
  ]);
  assert.equal(fetchImpl.calls.length, 1);
});

test("piloto Ailos: timeout após POST é ambiguous e não libera a mesma key", async () => {
  const { handler, audits } = handlerFor({
    teams: async () => ({
      transport: "teams",
      status: "timeout",
      destination_id: AILOS_TEAMS_DESTINATION_ID,
      external_called: true,
      http_status: null,
      ambiguous: true,
    }),
  });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-timeoutx",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.body.deliveries[0].status, "ambiguous");
  assert.equal(first.body.deliveries[0].ambiguous, true);
  assert.equal(first.body.deliveries[0].external_called, true);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(audits[1].action, "client_share_failed");
  assert.equal(audits[1].metadata.status, "ambiguous");
  assert.equal(second.body.duplicate, true);
});

test("piloto Ailos: HTTP 5xx após POST é ambiguous e impede retry", async () => {
  let attempts = 0;
  const fetchImpl = mockFetch(async () => {
    attempts += 1;
    return { status: 503, text: async () => "upstream" };
  });
  const { handler, audits } = handlerFor({ fetchImpl });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-5xxxxxx",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.body.deliveries[0].status, "ambiguous");
  assert.equal(first.body.deliveries[0].http_status, 503);
  assert.equal(attempts, 1);
  assert.equal(audits[1].action, "client_share_failed");
  assert.equal(audits[1].metadata.status, "ambiguous");
  assert.equal(second.body.duplicate, true);
  assert.equal(attempts, 1);
});

test("piloto Ailos: falha no audit final após 2xx não libera retry", async () => {
  const audits = [];
  let existing = false;
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "" }));
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    env: { ONEVIEW_CLIENT_SHARING_ENABLED: "false", TEAMS_WORKFLOW_AILOS: WEBHOOK },
    enabled: () => false,
    catalog: () => clientShareDestinationCatalog({ TEAMS_WORKFLOW_AILOS: WEBHOOK }),
    transaction: async (work) => work({ query: async (sql) => ({ rowCount: String(sql).includes("metadata->>") && existing ? 1 : 0 }) }),
    audit: async (_client, record) => {
      existing = true;
      audits.push(record);
      if (record.action === "client_share_sent") throw new Error("audit_result_failed");
    },
    teams: (input) => sendTeamsClientShare({ ...input, fetchImpl }),
    webex: async () => ({ transport: "webex", status: "dry_run", destination_id: "must-not-run", external_called: false }),
  });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-audfailx",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.deliveries[0].status, "sent");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(second.body.duplicate, true);
  assert.equal(fetchImpl.calls.length, 1);
});

test("piloto Ailos: erro local antes do POST é definite_failure e a reserva permanece", async () => {
  let posts = 0;
  const { handler, audits } = handlerFor({
    teams: async () => {
      posts += 1;
      throw new Error("local_adapter_crash");
    },
  });
  const body = {
    destination_id: AILOS_TEAMS_DESTINATION_ID,
    idempotency_key: "client-share:ailos-alert-localxxx",
    message: ailosAlertMessage(),
  };
  const first = await sendAlert(handler, body);
  const second = await sendAlert(handler, body);
  assert.equal(first.body.deliveries[0].status, "definite_failure");
  assert.equal(first.body.deliveries[0].external_called, false);
  assert.equal(posts, 1);
  assert.equal(audits[0].action, "client_share_requested");
  assert.equal(audits[1].action, "client_share_failed");
  assert.equal(second.body.duplicate, true);
  assert.equal(posts, 1);
});

test("piloto Ailos: smoke recusa outro destination_id sem fetch", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 200, text: async () => "ok" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const res = await smoke(handler, {}, "braskem:noc:teams");
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "smoke_destination_not_allowed");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(audits.length, 0);
});

test("piloto Ailos: smoke sem ENV não faz POST", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 200, text: async () => "ok" }));
  const { handler, audits } = handlerFor({ env: { TEAMS_WORKFLOW_AILOS: "" }, fetchImpl });
  const res = await smoke(handler);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, "webhook_not_configured");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(audits.length, 0);
});

test("piloto Ailos: smoke POST application/json no Workflow com Adaptive Card", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 202, text: async () => "1" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const res = await smoke(handler);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dry_run, false);
  assert.equal(res.body.smoke, true);
  assert.equal(res.body.idempotency_key, "client-share-smoke:ailos-01");
  assert.equal(res.body.deliveries[0].destination_id, "ailos-teams");
  assert.equal(res.body.deliveries[0].strategy, TEAMS_TRANSPORT_STRATEGY);
  assert.equal(res.body.deliveries[0].external_called, true);
  assert.equal(res.body.deliveries[0].http_status, 202);
  assert.equal(res.body.deliveries[0].status, "sent");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, WEBHOOK);
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), teamsWorkflowSmokePayload());
  assert.equal(audits[0].action, "client_share_smoke");
  assert.equal(audits[0].entityType, "client_share");
  assert.equal(typeof audits[0].entityId, "string");
  assert.match(audits[0].entityId, /^[a-f0-9]{32}$/);
  assert.equal(audits[0].actorName, "Operador");
  assert.equal(audits[0].metadata.destination_id, "ailos-teams");
  assert.equal(audits[0].metadata.smoke, true);
  assert.equal(audits[1].action, "client_share_sent");
  assert.equal(audits[1].metadata.http_status, 202);
  assert.equal(JSON.stringify(res.body).includes(WEBHOOK), false);
  assert.equal(JSON.stringify(audits).includes(WEBHOOK), false);
});

test("piloto Ailos: timeout controlado, HTTP 5xx ambíguo e sem retry cego", async () => {
  const hanging = mockFetch(() => new Promise(() => {}));
  const timeout = await sendTeamsClientShare({
    destination: ailosDestination(),
    live: true,
    env: { TEAMS_WORKFLOW_AILOS: WEBHOOK },
    fetchImpl: hanging,
    timeoutMs: 20,
  });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.http_status, null);
  assert.equal(timeout.ambiguous, true);
  assert.equal(timeout.retryable, false);
  assert.equal(timeout.external_called, true);
  assert.equal(hanging.calls.length, 1);

  let attempts = 0;
  const ambiguous = await sendTeamsClientShare({
    destination: ailosDestination(),
    live: true,
    env: { TEAMS_WORKFLOW_AILOS: WEBHOOK },
    fetchImpl: mockFetch(async () => {
      attempts += 1;
      return { status: 503, text: async () => "upstream" };
    }),
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.http_status, 503);
  assert.equal(ambiguous.retryable, false);
  assert.equal(attempts, 1);

  const catalogHookIgnored = await sendTeamsClientShare({
    destination: ailosDestination(),
    live: true,
    env: { TEAMS_WORKFLOW_AILOS: WEBHOOK },
    fetchImpl: mockFetch(async (url) => {
      assert.equal(url, WEBHOOK);
      assert.notEqual(url, OTHER_HOOK);
      return { status: 200, text: async () => "" };
    }),
  });
  assert.equal(catalogHookIgnored.status, "sent");
});

test("piloto Ailos: idempotency_key impede segundo POST", async () => {
  const fetchImpl = mockFetch(async () => ({ status: 200, text: async () => "ok" }));
  const { handler, audits } = handlerFor({ fetchImpl });
  const first = await smoke(handler);
  const second = await smoke(handler);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(audits.length, 2);
});

test("piloto Ailos: Webex permanece dry-run e código não hardcoda webhook", async () => {
  const webex = await sendWebexClientShare({ destination: ailosDestination() });
  assert.equal(webex.external_called, false);
  assert.equal(webex.status, "dry_run");
  const [transport, sharing, handler, dialog] = await Promise.all([
    readFile(new URL("../api/_lib/oneview-client-sharing-transports.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-client-sharing.js", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-client-sharing-handler.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/ClientShareDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sharing, /ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON/);
  assert.match(transport, /teamsWorkflowEnvName|resolveTeamsWorkflowWebhookUrl/);
  assert.doesNotMatch(transport, /console\.(log|info|debug|warn)\(/);
  assert.doesNotMatch(sharing, /console\.(log|info|debug|warn)\(/);
  assert.doesNotMatch(handler, /console\.(log|info|debug|warn)\(/);
  assert.doesNotMatch(dialog, /ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON|TEAMS_WORKFLOW_AILOS|teams_webhook_url/);
  assert.doesNotMatch(transport, /logic\.azure\.com|powerautomate\.microsoft\.com|webhookb2\//);
  assert.doesNotMatch(sharing, /logic\.azure\.com|powerautomate\.microsoft\.com|webhookb2\//);
  assert.doesNotMatch(handler, /logic\.azure\.com|powerautomate\.microsoft\.com|webhookb2\//);
  assert.doesNotMatch(handler, /\bUPDATE\b|\bDELETE\b/);
  assert.match(handler, /client_share_requested/);
  assert.match(handler, /status: "reserved"/);
  assert.match(sharing, /client_share_sent/);
  assert.match(sharing, /client_share_failed/);
  assert.doesNotMatch(transport, /ChannelMessage|graph\.microsoft\.com/);
  const webexSource = transport.slice(transport.indexOf("export async function sendWebexClientShare"));
  assert.doesNotMatch(webexSource, /fetch\s*\(/);
  const payload = teamsWorkflowSmokePayload();
  assert.equal(payload.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(payload.attachments[0].content.body[0].text, "Teste OneView - Ailos");
  assert.match(dialog, /liveSend/);
  assert.match(dialog, /Mensagem enviada para Ailos no Teams/);
  assert.match(dialog, /Falha no envio ao Teams/);
  assert.match(dialog, /canal Teams configurado/);
  assert.match(dialog, /sending/);
});

test("piloto Ailos: audit de smoke registra HTTP status e idempotency_key", () => {
  const record = clientShareSmokeAuditRecord({
    actor: { id: "operator-1", name: "Operador" },
    destination: AILOS_TEAMS_PILOT_DESTINATION,
    idempotencyKey: "client-share-smoke:ailos-01",
    delivery: { status: "sent", http_status: 202, external_called: true, ambiguous: false },
  });
  assert.equal(record.action, "client_share_smoke");
  assert.equal(record.metadata.idempotency_key, "client-share-smoke:ailos-01");
  assert.equal(record.metadata.http_status, 202);
  assert.equal(record.metadata.destination_id, "ailos-teams");
  assert.equal(JSON.stringify(record).includes(WEBHOOK), false);
});
