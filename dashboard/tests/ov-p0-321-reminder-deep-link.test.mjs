import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createOperatorReminderDeepLinkHandler } from "../api/_lib/oneview-operator-reminder-deep-link.js";

const actor = { id: "analyst-1", name: "Ana Analista" };
const REMINDER_ID = "11111111-1111-4111-8111-111111111111";
const base = {
  id: REMINDER_ID, data_source_id: "ds-1", source_host_id: "host-1",
  context_snapshot: { customer: { name: "Sanepar" }, link: { service_name: "WAN principal" } },
};
function response() {
  return { statusCode: 0, body: null, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, end(value) { this.body = JSON.parse(value); } };
}
function request(query) { return { method: "GET", query, headers: {}, socket: {} }; }
function queryFor(row, received) {
  return async (work) => work({ query: async (sql, values) => {
    received?.push({ sql, values });
    return { rows: row ? [row] : [] };
  } });
}

test("OV-P0-321 circuito abre somente o detalhe do lembrete pertencente ao analista", async () => {
  const received = [];
  const resolved = [];
  const route = createOperatorReminderDeepLinkHandler({
    authorize: async () => actor,
    query: queryFor({ ...base, subject_type: "circuit", subject_key: "circuit:wan1", circuit_key: "wan1", source_trigger_id: null }, received),
    resolveSubject: async (input) => { resolved.push(input); return { id: "wan1", data_source_id: "ds-1", source_host_id: "host-1" }; },
    logger: () => undefined,
  });
  const res = response();
  await route(request({ reminder_id: REMINDER_ID, ds: "ds-1", host: "host-1", circuit: "wan1", subject_type: "circuit", subject_key: "circuit:wan1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "available");
  assert.deepEqual(resolved, [{ subjectType: "circuit", circuitKey: "wan1", dataSourceId: "ds-1", sourceHostId: "host-1", sourceTriggerId: null }]);
  assert.deepEqual(received[0].values, [REMINDER_ID, actor.id]);
});

test("OV-P0-321 alert_subject resolve pelo trigger exato, sem fallback por host", async () => {
  const resolved = [];
  const route = createOperatorReminderDeepLinkHandler({
    authorize: async () => actor,
    query: queryFor({ ...base, subject_type: "alert_subject", subject_key: "alert:host-1:trigger-9", circuit_key: null, source_trigger_id: "trigger-9" }),
    resolveSubject: async (input) => { resolved.push(input); return { id: "alert-link", data_source_id: "ds-1", source_host_id: "host-1" }; },
    logger: () => undefined,
  });
  const res = response();
  await route(request({ reminder_id: REMINDER_ID, ds: "ds-1", host: "host-1", subject_type: "alert_subject", subject_key: "alert:host-1:trigger-9", trigger: "trigger-9" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "available");
  assert.equal(resolved[0].sourceTriggerId, "trigger-9");
  assert.equal(resolved[0].circuitKey, null);
});

test("OV-P0-321 alvo ausente preserva snapshot e não escolhe outro link", async () => {
  const route = createOperatorReminderDeepLinkHandler({
    authorize: async () => actor,
    query: queryFor({ ...base, subject_type: "circuit", subject_key: "circuit:wan1", circuit_key: "wan1", source_trigger_id: null }),
    resolveSubject: async () => null,
    logger: () => undefined,
  });
  const res = response();
  await route(request({ reminder_id: REMINDER_ID, ds: "ds-1", host: "host-1", circuit: "wan1", subject_type: "circuit", subject_key: "circuit:wan1" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "unavailable");
  assert.equal(res.body.link, null);
  assert.equal(res.body.reminder.context_snapshot.customer.name, "Sanepar");
});

test("OV-P0-321 identidade divergente ou lembrete de outro analista não abre detalhe", async () => {
  let resolved = 0;
  const route = createOperatorReminderDeepLinkHandler({
    authorize: async () => actor,
    query: queryFor({ ...base, subject_type: "circuit", subject_key: "circuit:wan1", circuit_key: "wan1", source_trigger_id: null }),
    resolveSubject: async () => { resolved += 1; return {}; },
    logger: () => undefined,
  });
  const res = response();
  await route(request({ reminder_id: REMINDER_ID, ds: "ds-1", host: "host-1", circuit: "other", subject_type: "circuit", subject_key: "circuit:other" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(resolved, 0);
});

test("OV-P0-321 popup leva reminder_id e a tela abre por resolução direta, não pela lista", async () => {
  const [notification, provider, page] = await Promise.all([
    readFile(new URL("../src/lib/oneview-operator-reminder-notification.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/providers/OperatorReminderInboxProvider.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/Operadoras.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(notification, /params\.set\("reminder_id", item\.id\)/);
  assert.match(provider, /operadorasReminderLinkPath\(item\)/);
  assert.match(page, /fetchOperatorReminderDeepLink/);
  assert.match(page, /void openReminderDeepLink/);
  assert.match(page, /reminderDeepLinkVersion/);
});
