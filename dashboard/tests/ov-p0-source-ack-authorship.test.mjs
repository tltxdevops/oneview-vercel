import assert from "node:assert/strict";
import test from "node:test";

import {
  displayZabbixAckAuthor,
  enrichPayloadAcknowledgesWithUserDirectory,
  isZabbixAckMessageOnly,
  pickEffectiveZabbixAcknowledgement,
  resolveZabbixPayloadAckAuthorship,
  zabbixAckUserDirectoryKey,
} from "../api/_lib/oneview-source-ack-authorship.js";
import { mergeSourceAckAuthorship, resolveOneViewAckInitiator } from "../api/_lib/oneview-source-ack-authorship.js";
import { resolveSourceAck } from "../api/_lib/oneview-db.js";

const ZURICH_ACKS = [
  {
    acknowledgeid: "40438",
    userid: "46",
    clock: "1729000000",
    action: "4",
    username: "andrei.operator",
    message: "comentário operacional",
  },
  {
    acknowledgeid: "40439",
    userid: "15",
    clock: "1729000100",
    action: "2",
    username: "api.tltx",
    message: "ACK automático",
  },
];

test("Zurich 137721230: action=2 api.tltx vence comentário Andrei action=4", () => {
  const effective = pickEffectiveZabbixAcknowledgement(ZURICH_ACKS, true);
  assert.equal(effective?.acknowledgeid, "40439");
  assert.equal(effective?.userid, "15");
  assert.equal(isZabbixAckMessageOnly(effective?.action), false);
  assert.equal(isZabbixAckMessageOnly("4"), true);

  const auth = resolveZabbixPayloadAckAuthorship(ZURICH_ACKS, true);
  assert.equal(auth.actor_name, "Conta técnica");
  assert.equal(auth.author_username, "api.tltx");
  assert.equal(auth.acknowledge_id, "40439");
  assert.equal(auth.zabbix_userid, "15");
});

test("Teletex Guilherme userid 86 com username real", () => {
  const auth = resolveZabbixPayloadAckAuthorship([
    {
      acknowledgeid: "17723245",
      userid: "86",
      clock: "1729000200",
      action: "6",
      username: "guilherme.franco@teletex.com.br",
      message: "[OneView] Reconhecido",
    },
  ], true);
  assert.equal(auth.zabbix_userid, "86");
  assert.equal(auth.actor_name, "guilherme.franco@teletex.com.br");
  assert.equal(auth.technical_account, false);
});

test("userid igual em datasources diferentes não mistura username", () => {
  const teletex = resolveZabbixPayloadAckAuthorship([
    { acknowledgeid: "1", userid: "86", clock: "10", action: "2", username: "guilherme.franco@teletex.com.br" },
  ], true);
  const zurich = resolveZabbixPayloadAckAuthorship([
    { acknowledgeid: "2", userid: "86", clock: "10", action: "2", username: "outro.usuario" },
  ], true);
  assert.notEqual(teletex.actor_name, zurich.actor_name);
});

test("ACK confirmado sem username nem nome resolvido", () => {
  const display = displayZabbixAckAuthor(null, "99", { datasourceLabel: "zurich" });
  assert.equal(display.actor_name, "Usuário Zabbix #99 (zurich)");
  assert.equal(display.author_unresolved, true);
});

test("Zurich 137721230 realista: userid 15 sem username no payload + cache api.tltx", () => {
  const dataSourceId = "8e93d5d4-1796-4a7e-9a84-91170dde7248";
  const raw = [
    { acknowledgeid: "40438", userid: "46", clock: "1729000000", action: "4", message: "comentário" },
    { acknowledgeid: "40439", userid: "15", clock: "1729000100", action: "2", message: "ACK" },
  ];
  const directory = new Map([
    [zabbixAckUserDirectoryKey(dataSourceId, "15"), { username: "api.tltx", display_name: null }],
  ]);
  const enriched = enrichPayloadAcknowledgesWithUserDirectory(raw, directory, dataSourceId);
  const auth = resolveZabbixPayloadAckAuthorship(enriched, true, { datasourceLabel: "zurich" });
  assert.equal(auth.actor_name, "Conta técnica");
  assert.equal(auth.author_username, "api.tltx");
  assert.equal(auth.acknowledge_id, "40439");
});

test("Teletex 17723245 realista: userid 86 + cache Guilherme e iniciador OneView", () => {
  const dataSourceId = "138d28c0-28b3-42b9-984f-b5d7f05cfd89";
  const raw = [{ acknowledgeid: "177689", userid: "86", clock: "1729000200", action: "2", message: "[OneView]" }];
  const directory = new Map([
    [zabbixAckUserDirectoryKey(dataSourceId, "86"), {
      username: "guilherme.franco@teletex.com.br",
      display_name: "Guilherme Franco",
    }],
  ]);
  const enriched = enrichPayloadAcknowledgesWithUserDirectory(raw, directory, dataSourceId);
  const merged = resolveSourceAck({
    data_source_id: dataSourceId,
    datasource_name: "teletex-http",
    acknowledged_source: true,
    payload_acknowledges: enriched,
    oneview_ack_status: "success",
    oneview_ack_actor_name: "Guilherme Franco",
  }, [], directory);
  assert.equal(merged.actor_name, "Guilherme Franco");
  assert.equal(merged.oneview_initiated_by, "Guilherme Franco");
  assert.equal(merged.zabbix_userid, "86");
});

test("mergeSourceAckAuthorship prioriza payload canônico e preserva iniciador OneView", () => {
  const canonical = resolveZabbixPayloadAckAuthorship(ZURICH_ACKS, true);
  const history = {
    acknowledged: true,
    actor_name: "andrei.operator",
    origin: "zabbix",
    canonical_from_payload: false,
  };
  const merged = mergeSourceAckAuthorship(
    canonical,
    history,
    resolveOneViewAckInitiator({ oneview_ack_status: "success", oneview_ack_actor_name: "Guilherme Franco" }),
  );
  assert.equal(merged.actor_name, "Conta técnica");
  assert.equal(merged.oneview_initiated_by, "Guilherme Franco");
  assert.equal(merged.canonical_from_payload, true);
});
