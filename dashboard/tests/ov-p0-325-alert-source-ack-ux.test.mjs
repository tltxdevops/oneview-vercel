import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { alertStatusReadModel, buildAlertListQuery, historyTitle, humanizeOneViewAckReason, oneViewAckReadModel } from "../api/_lib/oneview-db.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-325: UI envia ACK e não o confirma localmente", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  const action = await read("src/components/oneview/AlertSourceAckAction.tsx");
  assert.match(alerts, /<AlertSourceAckRowAction\s+alert=\{alert\}\s+onOpenDetail=\{openAlert\}/);
  assert.match(drawer, /<AlertSourceAckAction[\s\S]*variant="button"/);
  assert.match(action, /Reconhecimento enviado ao Zabbix/);
  assert.match(action, /const accepted = result\.status === "pending" && !result\.acknowledged_source/);
  assert.doesNotMatch(alerts, /applyLocalSourceAck/);
  assert.doesNotMatch(drawer, /applyLocalSourceAck/);
});

test("OV-P0-325: polling ACK Ã© isolado, terminal e sem refresh global", async () => {
  const api = await read("src/lib/oneview-api.ts");
  const action = await read("src/components/oneview/AlertSourceAckAction.tsx");
  const alerts = await read("src/pages/Alerts.tsx");
  const db = await read("api/_lib/oneview-db.js");

  assert.match(action, /SOURCE_ACK_POLL_INTERVAL_MS = 2_000/);
  assert.match(action, /SOURCE_ACK_POLL_TIMEOUT_MS = 45_000/);
  assert.match(action, /fetchAlert\(alert\.id, controller\.signal, \{ fresh: true \}\)/);
  assert.match(action, /reconcileSourceAckSubmission\(activeSubmission, currentAlert, Date\.now\(\), SOURCE_ACK_POLL_TIMEOUT_MS\)/);
  assert.match(action, /Aguardando confirma..o da origem/);
  assert.match(action, /Reconhecido/);
  assert.match(action, /window\.clearInterval\(timer\)/);
  assert.match(api, /source_ack_status\?: "pending" \| "processing" \| "failed" \| "cancelled" \| null/);
  assert.match(db, /ack\.acknowledgement_type = 'source'[\s\S]*oneview_ack on true/);

  const sourceAckHandler = alerts.slice(alerts.indexOf("const handleSourceAcknowledged"), alerts.indexOf("const toggleColumnSort"));
  assert.match(sourceAckHandler, /invalidateOneViewReadCache\("\/oneview\/alerts"/);
  assert.match(sourceAckHandler, /loadAlerts\(\{ quiet: true(?:, force: true)? \}\)/);
  assert.match(sourceAckHandler, /loadSelectedAlert\(alert\.id\)/);
  assert.doesNotMatch(sourceAckHandler, /loadSummaryResources|fetchOneViewFacets|fetchOneViewHealth|fetchOperationsHealth/);
});

test("P0 ACK OneView: read-model separa origem da ação e valida sucesso do Event ID 419733038", () => {
  const ack = oneViewAckReadModel({
    source_event_id: "419733038",
    oneview_ack_status: "success",
    oneview_ack_actor_name: "Guilherme Franco",
    oneview_ack_requested_at: "2026-10-06T12:00:00.000Z",
    oneview_ack_processed_at: "2026-10-06T12:00:02.000Z",
  });
  assert.equal(ack.status, "success");
  assert.equal(ack.actor_name, "Guilherme Franco");
  assert.equal(historyTitle("oneview_ack_confirmed"), "ACK confirmado na origem");
});

test("P0 ACK OneView: status terminal, histórico humanizado e filtro são independentes do estado do alerta", async () => {
  assert.deepEqual(
    ["pending", "processing", "success", "cancelled", "failed", null].map((oneview_ack_status) => oneViewAckReadModel({ oneview_ack_status }).status),
    ["pending", "processing", "success", "cancelled", "failed", "none"],
  );
  assert.equal(humanizeOneViewAckReason("alert_resolved_before_ack"), "Alerta resolvido antes do reconhecimento");
  assert.equal(humanizeOneViewAckReason("source_already_acknowledged"), "Alerta já estava reconhecido na origem");
  assert.equal(historyTitle("oneview_ack_cancelled"), "ACK cancelado");
  assert.equal(historyTitle("oneview_ack_failed"), "ACK falhou");

  const pending = buildAlertListQuery({ query: { status: "active", oneview_ack_status: "pending" } }, "teletex-http");
  const cancelled = buildAlertListQuery({ query: { status: "resolved", oneview_ack_status: "cancelled" } }, "teletex-http");
  assert.match(pending.whereSql, /a\.resolved_at is null/);
  assert.match(pending.whereSql, /= any\(\$\d+::text\[\]\)/);
  assert.deepEqual(pending.params.at(-1), ["pending", "processing"]);
  assert.match(cancelled.whereSql, /lower\(coalesce\(a\.status_source, ''\)\) = 'resolved'/);
  assert.match(cancelled.whereSql, /ack\.acknowledgement_type = 'source'/);

  const db = await read("api/_lib/oneview-db.js");
  for (const event of ["oneview_ack_requested", "oneview_ack_processing", "oneview_ack_confirmed", "oneview_ack_cancelled", "oneview_ack_failed"]) {
    assert.match(db, new RegExp(event));
  }
});

test("P0 alert status: cancelamento da origem é distinto do ACK cancelado", async () => {
  assert.equal(alertStatusReadModel({ status_source: "active", status_internal: "new" }), "active");
  assert.equal(alertStatusReadModel({ status_source: "resolved", status_internal: "normalized" }), "resolved");
  assert.equal(alertStatusReadModel({ status_source: "canceled", status_internal: "new" }), "cancelled");
  assert.equal(alertStatusReadModel({ status_source: "unknown", status_internal: "normalized" }), "resolved");
  assert.equal(oneViewAckReadModel({ oneview_ack_status: "cancelled" }).status, "cancelled");

  const alerts = await read("src/pages/Alerts.tsx");
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  assert.match(alerts, /setStatusFilter\("all"\)/);
  assert.match(drawer, /\["cancelled", "canceled"\]\.includes\(status\)/);
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
