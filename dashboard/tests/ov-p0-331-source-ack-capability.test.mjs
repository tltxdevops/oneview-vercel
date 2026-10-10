import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON,
  getSourceAcknowledgeConfig,
  sourceAckCapability,
} from "../api/_lib/oneview-source-acknowledge.js";
import {
  sourceAckCanOpen,
  sourceAckIsPending,
  sourceAckTooltip,
  sourceAckUnavailableReason,
  sourceAckVisualState,
} from "../src/lib/oneview-alert-source-ack.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const allowedConfig = Object.freeze({
  enabled: true,
  allowedDatasources: new Set(["teletex-http"]),
});

function alert(overrides = {}) {
  return {
    status_source: "active",
    acknowledged_source: false,
    source_event_id: "423474784",
    datasource_name: "teletex-http",
    source_ack_available: true,
    source_ack_unavailable_reason: null,
    ...overrides,
  };
}

test("teletex-http + sync_enabled -> source_ack_available true", () => {
  assert.deepEqual(sourceAckCapability({
    datasourceName: "teletex-http",
    syncEnabled: true,
    config: allowedConfig,
  }), {
    source_ack_available: true,
    source_ack_unavailable_reason: null,
  });
});

test("datasource ainda não homologado -> false com motivo explícito", () => {
  const capability = sourceAckCapability({
    datasourceName: "outra-origem",
    syncEnabled: true,
    config: allowedConfig,
  });
  assert.equal(capability.source_ack_available, false);
  assert.equal(capability.source_ack_unavailable_reason, SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON);
  assert.equal(capability.source_ack_unavailable_reason, "Reconhecimento pelo OneView ainda não disponível nesta origem");
});

test("feature ligada sem allowlist ainda libera só teletex-http", () => {
  const config = getSourceAcknowledgeConfig({ ONEVIEW_SOURCE_ACK_REQUEST_ENABLED: "true" });
  assert.equal(sourceAckCapability({
    datasourceName: "teletex-http",
    syncEnabled: true,
    config,
  }).source_ack_available, true);
  for (const datasourceName of ["zurich", "rhp", "castrolanda", "fraport", "fraport-for", "fraport-poa", "maps"]) {
    assert.equal(sourceAckCapability({
      datasourceName,
      syncEnabled: true,
      config,
    }).source_ack_available, false, datasourceName);
  }
});

test("sync desligado ou feature desligada também fecham a capability", () => {
  assert.equal(sourceAckCapability({
    datasourceName: "teletex-http",
    syncEnabled: false,
    config: allowedConfig,
  }).source_ack_available, false);
  assert.equal(sourceAckCapability({
    datasourceName: "teletex-http",
    syncEnabled: true,
    config: { enabled: false, allowedDatasources: allowedConfig.allowedDatasources },
  }).source_ack_available, false);
});

test("allowed -> botão habilitado", () => {
  const row = alert();
  assert.equal(sourceAckCanOpen(row), true);
  assert.equal(sourceAckTooltip(row), "Reconhecer no Zabbix");
  assert.equal(sourceAckUnavailableReason(row), null);
});

test("not allowed -> botão disabled e sem motivo de 403", () => {
  const row = alert({
    source_ack_available: false,
    source_ack_unavailable_reason: SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON,
  });
  assert.equal(sourceAckCanOpen(row), false);
  assert.equal(sourceAckTooltip(row), SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON);
  assert.equal(sourceAckUnavailableReason(row), SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON);
});

test("capability ausente fecha o botão", () => {
  const row = alert({ source_ack_available: undefined, source_ack_unavailable_reason: undefined });
  assert.equal(sourceAckCanOpen(row), false);
  assert.equal(sourceAckTooltip(row), SOURCE_ACK_ORIGIN_UNAVAILABLE_REASON);
});

test("resolved -> disabled", () => {
  const row = alert({ status_source: "resolved", resolved_at: "2026-10-09T12:00:00.000Z" });
  assert.equal(sourceAckVisualState(row), "resolved");
  assert.equal(sourceAckCanOpen(row), false);
  assert.equal(sourceAckTooltip(row), "Alerta já resolvido");
});

test("already ack -> disabled", () => {
  const row = alert({ acknowledged_source: true, acknowledged_by: "zabbix" });
  assert.equal(sourceAckVisualState(row), "acknowledged");
  assert.equal(sourceAckCanOpen(row), false);
  assert.match(sourceAckTooltip(row), /Reconhecido/);
});

test("pending OneView -> estado de espera, sem abrir ACK", () => {
  const row = alert({ source_ack_status: "pending" });
  assert.equal(sourceAckIsPending(row), true);
  assert.equal(sourceAckCanOpen(row), false);
  assert.equal(sourceAckVisualState(row), "pending");
  assert.equal(sourceAckTooltip(row), "Aguardando confirmação da origem");
});

test("lista, detalhe e snapshot carregam a capability do backend", async () => {
  const db = await read("api/_lib/oneview-db.js");
  const fallback = await read("api/_lib/oneview-fallback.js");
  const action = await read("src/components/oneview/AlertSourceAckAction.tsx");
  const mapper = db.slice(db.indexOf("function mapAlertRows"), db.indexOf("function mapTopHosts"));
  assert.match(mapper, /sourceAckCapability\(/);
  assert.match(db, /d\.sync_enabled/);
  assert.match(fallback, /source_ack_available: false/);
  assert.match(action, /disabled=\{!canOpen/);
  assert.match(action, /source_ack_available !== true/);
  assert.doesNotMatch(action, /teletex-http/);
  assert.doesNotMatch(await read("src/lib/oneview-alert-source-ack.ts"), /teletex-http/);
});
