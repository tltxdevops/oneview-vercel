import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  THEO_HEALTH_ACTION_TYPES,
  classifyTheoWebexHealth,
} from "../api/_lib/oneview-runtime-health-truth.js";

const now = Date.parse("2026-09-11T14:00:00.000Z");
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const enabled = {
  automationEnabled: true,
  configured: true,
  now,
};

test("Theo action types include legacy marker and current dispatch types", () => {
  assert.deepEqual([...THEO_HEALTH_ACTION_TYPES], [
    "theo_webex_notification",
    "theo_alert_notification_v1",
    "theo_unseen_alert_notification_v1",
    "theo_operator_reminder_v1",
  ]);
});

test("enabled=false → DISABLED / READY_DISABLED, never STALE/FAILED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    automationEnabled: false,
    heartbeatAt: at(20),
    lastSuccessAt: at(40),
    lastError: "theo_http_500",
  });
  assert.equal(health.semantic, "DISABLED");
  assert.equal(health.status, "READY_DISABLED");
  assert.equal(health.detail, "Desativado");
  assert.notEqual(health.status, "DOWN");
  assert.notEqual(health.status, "STALE");
  assert.notEqual(health.status, "DEGRADED");
});

test("enabled=true + heartbeat fresh + fila vazia → HEALTHY", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    pendingCount: 0,
  });
  assert.equal(health.semantic, "HEALTHY");
  assert.equal(health.status, "HEALTHY");
  assert.equal(health.heartbeat, "fresh");
});

test("heartbeat fresh + último dispatch success → HEALTHY", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    lastSuccessAt: at(2),
    lastSuccessActionType: "theo_alert_notification_v1",
    pendingCount: 0,
  });
  assert.equal(health.semantic, "HEALTHY");
  assert.equal(health.status, "HEALTHY");
});

test("sem mensagens recentes + heartbeat fresh → HEALTHY", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    lastSuccessAt: null,
    pendingCount: 0,
  });
  assert.equal(health.semantic, "HEALTHY");
  assert.equal(health.status, "HEALTHY");
});

test("marker legado ausente não causa FAILED sozinho", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    lastSuccessAt: null,
    lastSuccessActionType: null,
    pendingCount: 0,
  });
  assert.notEqual(health.semantic, "FAILED");
  assert.notEqual(health.status, "DOWN");
});

test("operator reminder Theo success conta como dispatch válido", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(4),
    lastSuccessAt: at(1),
    lastSuccessActionType: "theo_operator_reminder_v1",
    pendingCount: 0,
  });
  assert.equal(health.last_success_action_type, "theo_operator_reminder_v1");
  assert.equal(health.semantic, "DEGRADED");
  assert.notEqual(health.semantic, "FAILED");
});

test("heartbeat stale + dispatch recente success → DEGRADED, não FAILED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(4),
    lastSuccessAt: at(1),
    lastSuccessActionType: "theo_operator_reminder_v1",
  });
  assert.equal(health.semantic, "DEGRADED");
  assert.equal(health.status, "DEGRADED");
  assert.match(health.detail, /heartbeat|telemetria/i);
  assert.notEqual(health.status, "DOWN");
});

test("heartbeat stale severo + nenhum sucesso recente → FAILED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(6),
    lastSuccessAt: at(40),
    pendingCount: 0,
  });
  assert.equal(health.semantic, "FAILED");
  assert.equal(health.status, "DOWN");
});

test("retry/backlog recente → DEGRADED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    pendingCount: 3,
    retryCount: 2,
    oldestPendingAt: at(2),
  });
  assert.equal(health.semantic, "DEGRADED");
  assert.equal(health.status, "DEGRADED");
});

test("terminal failure recente → DEGRADED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    lastSuccessAt: at(20),
    lastFailedAt: at(2),
    lastError: "theo_http_502\nstack at dispatch",
  });
  assert.equal(health.semantic, "DEGRADED");
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.current_error, "theo_http_502");
  assert.doesNotMatch(String(health.current_error), /stack/);
});

test("database_unavailable ao ler heartbeat com dispatch recente → DEGRADED, não vermelho falso", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: null,
    heartbeatQueryFailed: true,
    lastSuccessAt: at(1),
    lastSuccessActionType: "theo_operator_reminder_v1",
  });
  assert.equal(health.semantic, "DEGRADED");
  assert.equal(health.status, "DEGRADED");
  assert.equal(health.heartbeat, "unavailable");
  assert.notEqual(health.status, "DOWN");
  assert.match(health.detail, /telemetria|heartbeat/i);
});

test("signals query failed com heartbeat fresh → DEGRADED/UNKNOWN, não FAILED", () => {
  const health = classifyTheoWebexHealth({
    ...enabled,
    heartbeatAt: at(1),
    signalsQueryFailed: true,
  });
  assert.notEqual(health.semantic, "FAILED");
  assert.notEqual(health.status, "DOWN");
  assert.equal(health.semantic, "DEGRADED");
});

test("payload de runtime-health consulta action_types Theo sem carregar payload", () => {
  const db = read("api/_lib/oneview-db.js");
  const runtime = read("src/lib/runtime-health.ts");
  assert.match(db, /classifyTheoWebexHealth/);
  assert.match(db, /THEO_HEALTH_ACTION_TYPES/);
  assert.match(db, /worker_id = any\(\$1::text\[\]\)/);
  assert.doesNotMatch(db, /action_type = 'theo_webex_notification' and \(created_by/);
  assert.doesNotMatch(db, /select payload from integration_outbox/i);
  assert.match(runtime, /Estado:/);
  assert.match(runtime, /Último dispatch Theo:/);
  assert.match(runtime, /Dispatcher:/);
  assert.match(runtime, /theoChipTone/);
});
