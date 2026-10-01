import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-325: UI envia ACK e não o confirma localmente", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  const action = await read("src/components/oneview/AlertSourceAckAction.tsx");
  assert.match(alerts, /<AlertSourceAckAction\s+alert=\{alert\}\s+variant="icon"/);
  assert.match(drawer, /<AlertSourceAckAction[\s\S]*variant="button"/);
  assert.match(action, /Reconhecimento enviado ao Zabbix/);
  assert.match(action, /setEnqueued\(result\.status === "pending"\)/);
  assert.doesNotMatch(alerts, /applyLocalSourceAck/);
  assert.doesNotMatch(drawer, /applyLocalSourceAck/);
});

test("OV-P0-325: contrato ACK externo aponta para produtor BFF", async () => {
  const api = await read("src/lib/oneview-api.ts");
  const handler = await read("api/_lib/oneview-source-acknowledge.js");
  assert.match(api, /\/oneview\/alerts\/\$\{encodeURIComponent\(alertId\)\}\/source-acknowledge/);
  assert.match(api, /status: "pending" \| "confirmed"/);
  assert.match(handler, /zabbix_event_acknowledge/);
  assert.match(handler, /insert into alert_acknowledgements/);
  assert.match(handler, /insert into integration_outbox/);
  assert.match(handler, /pg_advisory_xact_lock/);
  assert.doesNotMatch(handler, /problem\.acknowledge|event\.acknowledge|api_jsonrpc|\bfetch\s*\(/i);
});
