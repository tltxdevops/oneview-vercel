import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  clientShareCatalogFromSpreadsheet,
  clientShareMessageContract,
  publicClientShareDestination,
  resolveClientShareRoute,
} from "../api/_lib/oneview-client-sharing.js";
import { createClientSharingHandler } from "../api/_lib/oneview-client-sharing-handler.js";
import { sendTeamsClientShare, TEAMS_TRANSPORT_STRATEGY } from "../api/_lib/oneview-client-sharing-transports.js";

const SECRET = "https://example.webhook.office.com/webhookb2/secret-token-value";
const TOKEN = "webex-token-must-not-leak";

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, setHeader() { return this; }, end(value) { this.body = JSON.parse(value); } };
}

function group(clientKey, route, name, id, extra = {}) {
  return {
    client_key: clientKey,
    route_key: route,
    route_label: name,
    destination_id: id,
    destination_name: name,
    channel_type: "teams",
    enabled: true,
    is_default: false,
    ...extra,
  };
}

const several = [
  group("braskem", "backup", "Backup", "braskem:backup:teams"),
  group("braskem", "radio", "Radio", "braskem:radio:teams"),
  group("braskem", "sap-basis", "SAP Basis", "braskem:sap-basis:teams", { is_default: true, teams_webhook_url: SECRET, token: TOKEN }),
  group("braskem", "sap-basis", "SAP Basis Webex", "braskem:sap-basis:webex", { channel_type: "webex", webex_token: TOKEN }),
];

const single = [group("acme", "noc", "NOC", "acme:noc:teams", { teams_webhook_url: SECRET, token: TOKEN })];

function message(clientKey, route) {
  return {
    client_key: clientKey,
    client_name: clientKey,
    severity: "High",
    host: "host-a",
    problem: "Indisponível",
    started_at: "2026-09-28T12:00:00Z",
    status: "Ativo",
    message_type: "alert",
    ...(route ? { route_key: route } : {}),
  };
}

function handlerFor(catalog, { enabled = true, teams, webex, audit } = {}) {
  let existing = false;
  let sends = 0;
  const calls = { teams: 0, webex: 0, audit: 0, teamsDestination: null };
  return {
    calls,
    handler: createClientSharingHandler({
      authorize: async () => ({ id: "operator-1", name: "Operador" }),
      enabled: () => enabled,
      catalog: () => catalog,
      transaction: async (work) => work({ query: async (sql) => {
        if (sql.includes("metadata->>")) return { rowCount: existing ? 1 : 0 };
        return { rowCount: 0 };
      } }),
      audit: async (client, record) => {
        calls.audit += 1;
        existing = true;
        if (audit) audit(record);
      },
      teams: async (input) => {
        calls.teams += 1;
        calls.teamsDestination = input.destination?.destination_id || null;
        sends += 1;
        if (teams) return teams(input);
        return sendTeamsClientShare(input);
      },
      webex: async (input) => {
        calls.webex += 1;
        if (webex) return webex(input);
        return { transport: "webex", status: "dry_run", destination_id: input.destination?.destination_id || null, external_called: false };
      },
    }),
    sends: () => sends,
  };
}

async function send(handler, body) {
  const res = response();
  await handler({ method: "POST", query: { mode: "send" }, body, headers: {} }, res);
  return res;
}

test("roteamento: cliente com 1 grupo seleciona automaticamente", () => {
  const resolved = resolveClientShareRoute({ clientKey: "acme", routeKey: "outra-rota", catalog: single });
  assert.equal(resolved.selection, "auto");
  assert.equal(resolved.reason, "single_destination");
  assert.equal(resolved.requires_selection, false);
  assert.equal(resolved.selected.destination_id, "acme:noc:teams");
  assert.equal(JSON.stringify(resolved.destinations).includes(SECRET), false);
  assert.equal(JSON.stringify(resolved.selected).includes(TOKEN), false);
});

test("roteamento: cliente com vários grupos exige seleção e não usa is_default", () => {
  const resolved = resolveClientShareRoute({ clientKey: "braskem", catalog: several });
  assert.equal(resolved.selection, "required");
  assert.equal(resolved.reason, "multiple_destinations");
  assert.equal(resolved.requires_selection, true);
  assert.equal(resolved.selected, null);
  assert.equal(resolved.destinations.length, 4);
});

test("roteamento: route_key confiável pré-seleciona o grupo correspondente", () => {
  const resolved = resolveClientShareRoute({ clientKey: "braskem", routeKey: "SAP Basis", catalog: several.filter((item) => item.channel_type === "teams") });
  assert.equal(resolved.selection, "preselected");
  assert.equal(resolved.reason, "route_key");
  assert.equal(resolved.selected.destination_id, "braskem:sap-basis:teams");
  assert.equal(resolved.requires_selection, false);
});

test("roteamento: route_key desconhecido ou ambíguo exige seleção sem adivinhar", () => {
  const unknown = resolveClientShareRoute({ clientKey: "braskem", routeKey: "citrix-lab", catalog: several });
  assert.equal(unknown.reason, "unknown_route");
  assert.equal(unknown.requires_selection, true);
  assert.equal(unknown.selected, null);
  const ambiguous = resolveClientShareRoute({ clientKey: "braskem", routeKey: "sap-basis", catalog: several });
  assert.equal(ambiguous.reason, "ambiguous_route");
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.destinations.some((item) => item.is_default), true);
});

test("roteamento: cliente sem destino não finge canal", () => {
  const resolved = resolveClientShareRoute({ clientKey: "sem-grupo", catalog: several });
  assert.equal(resolved.reason, "no_destination");
  assert.deepEqual(resolved.destinations, []);
  assert.equal(resolved.selected, null);
});

test("roteamento: destination_id inválido é rejeitado e não chama adapter", async () => {
  const { calls, handler } = handlerFor(several);
  const res = await send(handler, {
    message: message("braskem"),
    destination_id: "destino-inexistente",
    idempotency_key: "client-share:0123456789abcdef",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "invalid_destination_id");
  assert.equal(calls.teams, 0);
  assert.equal(calls.audit, 0);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false);
});

test("roteamento: send de um grupo, de vários grupos, rota desconhecida e cliente sem destino", async () => {
  const one = handlerFor(single);
  const auto = await send(one.handler, { message: message("acme", "qualquer"), idempotency_key: "client-share:auto-0123456789" });
  assert.equal(auto.statusCode, 200);
  assert.equal(auto.body.deliveries[0].destination_id, "acme:noc:teams");
  assert.equal(auto.body.deliveries[0].strategy, TEAMS_TRANSPORT_STRATEGY);
  assert.equal(auto.body.deliveries[0].external_called, false);
  assert.equal(JSON.stringify(auto.body).includes(SECRET), false);

  const many = handlerFor(several);
  const missing = await send(many.handler, { message: message("braskem"), idempotency_key: "client-share:many-0123456789" });
  assert.equal(missing.statusCode, 422);
  assert.equal(missing.body.error, "destination_selection_required");
  assert.equal(many.calls.teams, 0);

  const routed = handlerFor(several.filter((item) => item.channel_type === "teams"));
  const matched = await send(routed.handler, { message: message("braskem", "Radio"), idempotency_key: "client-share:route-012345678" });
  assert.equal(matched.statusCode, 200);
  assert.equal(routed.calls.teamsDestination, "braskem:radio:teams");
  assert.equal(routed.calls.webex, 0);

  const unknown = handlerFor(several);
  const unresolved = await send(unknown.handler, { message: message("braskem", "unix-legado"), idempotency_key: "client-share:unknown-0123456" });
  assert.equal(unresolved.statusCode, 422);
  assert.equal(unresolved.body.error, "destination_selection_required");
  assert.equal(unknown.calls.teams, 0);

  const empty = handlerFor(several);
  const none = await send(empty.handler, { message: message("sem-grupo"), idempotency_key: "client-share:none-0123456789" });
  assert.equal(none.statusCode, 422);
  assert.equal(none.body.error, "client_destination_not_configured");
  assert.equal(empty.calls.teams, 0);
});

test("roteamento: duplo clique permanece idempotente e feature flag off não envia", async () => {
  let existing = false;
  let sends = 0;
  const handler = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    enabled: () => true,
    catalog: () => several,
    transaction: async (work) => work({ query: async (sql) => ({ rowCount: sql.includes("metadata->>") && existing ? 1 : 0 }) }),
    audit: async () => { existing = true; },
    teams: async () => { sends += 1; return { transport: "teams", status: "dry_run", destination_id: "braskem:backup:teams", external_called: false, teams_webhook_url: SECRET }; },
  });
  const body = { message: message("braskem"), destination_id: "braskem:backup:teams", idempotency_key: "client-share:dup-0123456789ab" };
  const first = await send(handler, body);
  const second = await send(handler, body);
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(sends, 1);
  assert.equal(JSON.stringify(first.body).includes(SECRET), false);

  let called = false;
  const disabled = createClientSharingHandler({
    authorize: async () => ({ id: "operator-1", name: "Operador" }),
    enabled: () => false,
    catalog: () => single,
    teams: async () => { called = true; },
    audit: async () => { called = true; },
  });
  const blocked = await send(disabled, { message: message("acme"), idempotency_key: "client-share:flag-0123456789ab" });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.body.error, "client_sharing_disabled");
  assert.equal(called, false);
});

test("roteamento: planilha Cliente / SDC-Resp / Grupo vira catálogo sem vazar segredo nem hardcode de UI", async () => {
  const catalog = clientShareCatalogFromSpreadsheet([
    { Cliente: "Braskem", "SDC-Resp": "SAP Basis", Grupo: "SAP Basis", teams_webhook_url: SECRET, token: TOKEN },
    { Cliente: "Braskem", "SDC-Resp": "NetOps", Grupo: "NetOps" },
  ]);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].client_key, "braskem");
  assert.equal(catalog[0].route_key, "sap-basis");
  assert.equal(catalog[0].destination_name, "SAP Basis");
  assert.equal(catalog[0].channel_type, "teams");
  assert.equal(catalog[0].teams_webhook_url, null);
  const published = publicClientShareDestination(catalog[0]);
  assert.equal(JSON.stringify(published).includes(SECRET), false);
  assert.equal(Object.hasOwn(published, "token"), false);

  const contract = clientShareMessageContract(message("braskem"));
  assert.equal(contract.snapshot, null);
  assert.equal(contract.route_key, null);

  const [dialog, actions, api] = await Promise.all([
    readFile(new URL("../src/components/oneview/ClientShareDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/oneview/AlertOperationalShareActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(dialog, /Braskem|SAP Basis|NetOps|webhook|token/i);
  assert.doesNotMatch(actions, /Braskem|host_group/);
  assert.match(actions, /explicitAlertRouteKey/);
  assert.match(dialog, /Selecione o destino/);
  const shareTypes = api.slice(api.indexOf("export type ClientShareMessage"), api.indexOf("type OneViewFetchInit"));
  assert.doesNotMatch(shareTypes, /webhook|token/i);
});

test("transporte Teams usa Incoming Webhook, sem Graph, e não vaza segredo no dry-run", async () => {
  const delivery = await sendTeamsClientShare({ destination: single[0] });
  assert.equal(delivery.strategy, TEAMS_TRANSPORT_STRATEGY);
  assert.equal(delivery.external_called, false);
  assert.equal(JSON.stringify(delivery).includes(SECRET), false);
  const source = await readFile(new URL("../api/_lib/oneview-client-sharing-transports.js", import.meta.url), "utf8");
  assert.match(source, /teams_workflow_incoming_webhook/);
  assert.doesNotMatch(source, /ChannelMessage|graph\.microsoft\.com/);
  const webex = source.slice(source.indexOf("export async function sendWebexClientShare"));
  assert.doesNotMatch(webex, /fetch\s*\(/);
});
