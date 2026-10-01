import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  clientShareDestinationCatalog,
  clientShareIdempotencyKey,
  clientShareMessageContract,
  clientSharePreview,
  isClientSharingEnabled,
  resolveClientShareRoute,
} from "../api/_lib/oneview-client-sharing.js";
import { createClientSharingHandler } from "../api/_lib/oneview-client-sharing-handler.js";
import { sendTeamsClientShare, sendWebexClientShare } from "../api/_lib/oneview-client-sharing-transports.js";

const message = {
  client_key: "cliente-a", client_name: "Cliente A", severity: "High", host: "router-a", problem: "Link indisponível",
  started_at: "2026-09-28T12:00:00Z", status: "Ativo", message_type: "alert", oneview_url: "https://oneview.example/alertas?alert=1",
};

function env(destinations, enabled = false) {
  return { ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON: JSON.stringify(destinations), ONEVIEW_CLIENT_SHARING_ENABLED: enabled ? "true" : "false" };
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, end(value) { this.body = JSON.parse(value); } };
}
function destination(partial) {
  return {
    route_key: "noc", route_label: "NOC", destination_name: "NOC", enabled: true, is_default: false, ...partial,
  };
}

test("client sharing: Teams, Webex e sem destino seguem o catálogo por rota", () => {
  const configured = env([
    destination({ client_key: "teams", destination_id: "teams:noc", channel_type: "teams" }),
    destination({ client_key: "webex", destination_id: "webex:noc", channel_type: "webex" }),
  ]);
  const catalog = clientShareDestinationCatalog(configured);
  assert.equal(resolveClientShareRoute({ clientKey: "teams", catalog }).selected.channel_type, "teams");
  assert.equal(resolveClientShareRoute({ clientKey: "webex", catalog }).selected.channel_type, "webex");
  assert.equal(resolveClientShareRoute({ clientKey: "none", catalog }).reason, "no_destination");
});

test("client sharing: preview usa contrato canônico, snapshot opcional e flag inicia desligada", () => {
  const normalized = clientShareMessageContract(message);
  const preview = clientSharePreview(normalized, null);
  assert.equal(normalized.snapshot, null);
  assert.equal(preview.text, [
    "🔴 router-a - Link indisponível",
    "📟 Equipamento: router-a",
    "📅 Data/Hora: 28/09/2026 - 09:00:00",
    "🛠️ Ação: Alerta em análise.",
    "🔄 Próximos Passos: Acompanhando alerta.",
    "🔎 Acompanhamento: Equipe NOC",
  ].join("\n"));
  assert.equal(
    clientShareMessageContract({ ...message, incident_number: "INC0088000" }).action,
    "Aberto chamado INC0088000 para acompanhamento de alerta.",
  );
  assert.equal(clientShareMessageContract({ ...message, actor_name: "Operador" }).follow_up, "Equipe NOC");
  assert.equal(isClientSharingEnabled(env([])), false);
  assert.equal(clientShareIdempotencyKey("client-share:0123456789abcdef"), "client-share:0123456789abcdef");
});

test("client sharing: campos editados usam o mesmo texto canônico no preview", () => {
  const normalized = clientShareMessageContract({
    ...message,
    equipment: "router-a.internal",
    incident_number: "INC0088000",
    action: "Cliente acionado via central.",
    next_steps: "Aguardando validação.",
    follow_up: "Ana NOC",
  });
  const preview = clientSharePreview(normalized, null);
  assert.match(preview.text, /📟 Equipamento: router-a\.internal/);
  assert.match(preview.text, /🛠️ Ação: Cliente acionado via central\./);
  assert.match(preview.text, /🔄 Próximos Passos: Aguardando validação\./);
  assert.match(preview.text, /🔎 Acompanhamento: Ana NOC/);
  assert.match(preview.text, /Link indisponível/);
  assert.doesNotMatch(preview.text, /Cliente A|oneview\.example|Abrir no OneView|Abrir no ServiceNow/);
});

test("client sharing: campos editáveis são limitados e não injetam novas linhas", () => {
  const normalized = clientShareMessageContract({
    ...message,
    action: "Cliente <script>alert(1)</script>\nacionado",
    next_steps: `A${"b".repeat(400)}`,
    follow_up: "  Ana\nNOC  ",
  });
  assert.equal(normalized.action, "Cliente <script>alert(1)</script> acionado");
  assert.equal(normalized.next_steps.length, 240);
  assert.equal(normalized.follow_up, "Ana NOC");
  assert.equal(clientSharePreview(normalized, null).text.split("\n").length, 6);
});

test("client sharing: timestamp inválido é rejeitado antes do preview", () => {
  assert.throws(
    () => clientShareMessageContract({ ...message, started_at: "28/09/2026 12:00" }),
    /invalid_client_share_message/,
  );
});

test("client sharing: feature flag off bloqueia send antes de adapter ou audit", async () => {
  let called = false;
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    enabled: () => false,
    teams: async () => { called = true; throw new Error("must_not_send"); },
    audit: async () => { called = true; },
  });
  const res = response();
  await handler({ method: "POST", query: { mode: "send" }, body: { message, idempotency_key: "client-share:0123456789abcdef" }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "client_sharing_disabled");
  assert.equal(called, false);
});

test("client sharing: mesma idempotency_key em duplo clique só registra um dry-run", async () => {
  let existing = false;
  let sends = 0;
  let audits = 0;
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    enabled: () => true,
    catalog: () => [destination({ client_key: "cliente-a", destination_id: "cliente-a:noc", channel_type: "teams" })],
    transaction: async (work) => work({ query: async (sql) => {
      if (sql.includes("metadata->>")) return { rowCount: existing ? 1 : 0 };
      return { rowCount: 0 };
    } }),
    audit: async () => { audits += 1; existing = true; },
    teams: async () => { sends += 1; return { transport: "teams", status: "dry_run", external_called: false }; },
  });
  const request = { method: "POST", query: { mode: "send" }, body: { message, idempotency_key: "client-share:0123456789abcdef" }, headers: {} };
  const first = response(); const second = response();
  await handler(request, first);
  await handler(request, second);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(audits, 2);
  assert.equal(sends, 1);
});

test("client sharing: adapters não-piloto permanecem dry-run e Webex não faz IO", async () => {
  const destinationRecord = destination({
    client_key: "both", destination_id: "both:noc", channel_type: "teams", teams_webhook_url: "https://example.webhook.office.com/secret",
  });
  assert.equal((await sendTeamsClientShare({ destination: destinationRecord })).external_called, false);
  assert.equal((await sendTeamsClientShare({ destination: destinationRecord, live: true })).status, "smoke_destination_not_allowed");
  assert.equal((await sendWebexClientShare({ destination: destinationRecord })).external_called, false);
  const source = await readFile(new URL("../api/_lib/oneview-client-sharing-transports.js", import.meta.url), "utf8");
  const webex = source.slice(source.indexOf("export async function sendWebexClientShare"));
  assert.doesNotMatch(webex, /fetch\s*\(/);
  assert.doesNotMatch(source, /graph\.microsoft\.com|ChannelMessage/);
});

test("client sharing: UI possui modal, preview e botão guardado por feature flag", async () => {
  const [dialog, actions] = await Promise.all([
    readFile(new URL("../src/components/oneview/ClientShareDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/AlertOperationalShareActions.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(actions, /Enviar para o cliente/);
  assert.match(dialog, /Cliente sem canal de comunicação configurado/);
  assert.match(dialog, /externalEnabled/);
  assert.match(dialog, /liveSend/);
  assert.match(dialog, /idempotency/);
});
