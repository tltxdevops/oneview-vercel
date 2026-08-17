/**
 * OV-P0-71 — Drawer Fidelity Final (contrato BFF → drawer).
 * Sem DB: trava regras comprovadas pela auditoria real de 30 alertas.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

const {
  deriveOperationalScope,
  OPERATIONAL_SCOPE_LABELS,
} = require("../api/_lib/oneview-operational-scope.js");

const PLATFORM = OPERATIONAL_SCOPE_LABELS.platform;
const TEST = OPERATIONAL_SCOPE_LABELS.test;
const UNKNOWN = OPERATIONAL_SCOPE_LABELS.unknown;
const UNCLASSIFIED = "Cliente não classificado";
const MISSING_HOST = "Host não informado";

function nfd(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isDatasourceLike(normalized) {
  if (!normalized) return false;
  return (
    normalized === "teletex-http"
    || normalized.includes("datasource")
    || /(^|[\s_-])http($|[\s_-])/.test(normalized)
    || normalized.endsWith("-http")
  );
}

function isPlaceholderClient(normalized) {
  if (!normalized) return true;
  return [
    "unclassified",
    "cliente-nao-classificado",
    "cliente nao classificado",
    "cliente nao identificado",
    "sem classificacao",
  ].includes(normalized);
}

function isUnclassifiedClient(customer) {
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  const source = String(customer?.source || "").trim().toLowerCase();
  const nn = nfd(name);
  const nk = nfd(key);
  if (name && !isPlaceholderClient(nn) && !isDatasourceLike(nn)) return false;
  if (key && !isPlaceholderClient(nk) && !isDatasourceLike(nk)) return false;
  if (source === "datasource_fallback") return true;
  if (isPlaceholderClient(nk) || isPlaceholderClient(nn)) return true;
  if (isDatasourceLike(nn) || isDatasourceLike(nk)) return true;
  return !nn && !nk;
}

function canonicalClientName(customer) {
  if (isUnclassifiedClient(customer)) return UNCLASSIFIED;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  if (name && !isPlaceholderClient(nfd(name)) && !isDatasourceLike(nfd(name))) return name;
  if (key && !isPlaceholderClient(nfd(key)) && !isDatasourceLike(nfd(key))) return key;
  return UNCLASSIFIED;
}

function normalizeScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  if (scope === "customer" || scope === "platform" || scope === "test" || scope === "unknown") return scope;
  return null;
}

/** Mirror FE operationalClientLabel (HOTFIX-P0-CLIENT-LABEL). */
function operationalClientLabel(entity) {
  if (!isUnclassifiedClient(entity)) return canonicalClientName(entity);
  const scope = normalizeScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM;
  if (scope === "test") return label || TEST;
  if (scope === "unknown") return label || UNKNOWN;
  if (label === PLATFORM || label === TEST || label === UNKNOWN) return label;
  if (scope === "customer" && label) return label;
  return UNCLASSIFIED;
}

function isMissingHost(value) {
  const text = String(value || "").trim();
  if (!text || text === "-" || /^host$/i.test(text)) return true;
  if (/^host protegido\b/i.test(text)) return true;
  const normalized = nfd(text);
  return ["host nao informado", "host nao identificado", "host nao disponivel"].includes(normalized);
}

function canonicalHostName(host) {
  for (const candidate of [host?.host_visible_name, host?.host_technical_name, host?.host_name]) {
    const value = String(candidate || "").trim();
    if (value && !isMissingHost(value)) return value;
  }
  return MISSING_HOST;
}

function safeHostIp(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || ["-", "[redacted]", "[ip_protegido]"].includes(candidate.toLowerCase())) return null;
  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return null;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null;
  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return null;
  if (first === 100 && second >= 64 && second <= 127) return null;
  if (first === 169 && second === 254) return null;
  if (first === 172 && second >= 16 && second <= 31) return null;
  if (first === 192 && second === 168) return null;
  return candidate;
}

function sourceAckPresentation(alert) {
  const sourceAck = alert?.source_ack;
  if (sourceAck) {
    if (!sourceAck.acknowledged) {
      return { status: "pending", actorLabel: null, at: null };
    }
    return {
      status: "acknowledged",
      actorLabel: sourceAck.actor_name || null,
      at: sourceAck.acknowledged_at || null,
    };
  }
  if (!alert?.acknowledged_source) {
    return { status: "pending", actorLabel: null, at: null };
  }
  return {
    status: "acknowledged",
    actorLabel: alert.acknowledged_source_by || null,
    at: alert.acknowledged_source_at || null,
  };
}

/** Projection do drawer a partir do item alert-detail. */
function drawerFromBff(item) {
  const customer = {
    key: item.customer_key,
    name: item.customer_name,
    source: item.customer_source,
    operational_scope: item.operational_scope,
    operational_scope_label: item.operational_scope_label,
  };
  const resolved = Boolean(item.resolved_at)
    || String(item.status_source || "").toLowerCase() === "resolved"
    || ["resolved", "normalized"].includes(String(item.status_internal || "").toLowerCase());
  const ack = sourceAckPresentation(item);
  return {
    customer: operationalClientLabel(customer),
    host: canonicalHostName(item),
    problem: String(item.problem_name || "").trim() || "Alerta sem descrição",
    severity: String(item.severity || "not_classified"),
    status: resolved ? "Resolvido" : "Ativo",
    ack: item.acknowledged_source ? "ACK" : "ACK pendente",
    ack_actor: ack.actorLabel,
    ack_at: ack.at,
    first_seen_at: item.first_seen_at ?? null,
    last_seen_at: item.last_seen_at ?? null,
    resolved_at: item.resolved_at ?? null,
    duration_seconds: item.duration_seconds ?? null,
    ip: safeHostIp(item.host_ip),
    scope: normalizeScope(item.operational_scope),
  };
}

test("OV-P0-71: cliente real nunca é sobrescrito por scope (auditoria Nissan/platform)", () => {
  const bff = {
    customer_key: "nissan",
    customer_name: "Nissan",
    customer_source: "host_group",
    operational_scope: "platform",
    operational_scope_label: PLATFORM,
    host_visible_name: "Nissan - Zabbix Proxy",
    problem_name: "Zabbix proxy missing data",
    severity: "warning",
    status_source: "active",
    acknowledged_source: false,
    host_ip: null,
    first_seen_at: "2026-08-11T10:00:00.000Z",
    last_seen_at: "2026-08-11T11:00:00.000Z",
    resolved_at: null,
    duration_seconds: 3600,
  };
  const drawer = drawerFromBff(bff);
  assert.equal(drawer.customer, "Nissan");
  assert.equal(drawer.scope, "platform");
  assert.equal(drawer.host, "Nissan - Zabbix Proxy");
  assert.equal(drawer.ip, null);
});

test("OV-P0-71: platform/test/unknown sem customer → labels canônicos", () => {
  assert.equal(
    drawerFromBff({
      customer_name: null,
      customer_key: null,
      customer_source: "datasource_fallback",
      operational_scope: "platform",
      operational_scope_label: PLATFORM,
      host_visible_name: "Zabbix server",
      problem_name: "packages changed",
      severity: "warning",
      acknowledged_source: false,
      host_ip: null,
    }).customer,
    PLATFORM,
  );
  assert.equal(
    drawerFromBff({
      customer_name: null,
      operational_scope: "test",
      operational_scope_label: TEST,
      host_visible_name: "TLTX - LAB",
      problem_name: "test alert",
      severity: "information",
      acknowledged_source: false,
      host_ip: null,
    }).customer,
    TEST,
  );
  assert.equal(
    drawerFromBff({
      customer_name: null,
      customer_source: "datasource_fallback",
      operational_scope: "unknown",
      operational_scope_label: UNKNOWN,
      host_visible_name: "orphan-host",
      problem_name: "unclassified",
      severity: "average",
      acknowledged_source: false,
      host_ip: null,
    }).customer,
    UNKNOWN,
  );
});

test("OV-P0-71: datasource nunca vira cliente no drawer", () => {
  const scope = deriveOperationalScope({
    customer_name: "teletex-http",
    customer_key: "teletex-http",
    customer_source: "datasource_fallback",
    host_groups: [],
    host_name: "orphan",
  });
  assert.equal(scope.operational_scope, "unknown");
  assert.equal(scope.operational_scope_label, UNKNOWN);

  const drawer = drawerFromBff({
    customer_name: null,
    customer_key: null,
    customer_source: "datasource_fallback",
    operational_scope: scope.operational_scope,
    operational_scope_label: scope.operational_scope_label,
    host_visible_name: "orphan",
    problem_name: "x",
    severity: "warning",
    acknowledged_source: false,
    host_ip: null,
  });
  assert.equal(drawer.customer, UNKNOWN);
  assert.notEqual(nfd(drawer.customer), "teletex-http");
});

test("OV-P0-71: ACK do drawer prioriza source_ack (ator/horário)", () => {
  const drawer = drawerFromBff({
    customer_name: "Unicap",
    customer_key: "unicap",
    customer_source: "problem_tag",
    operational_scope: "customer",
    operational_scope_label: "Unicap",
    host_visible_name: "UNICAP - X",
    problem_name: "High CPU",
    severity: "high",
    acknowledged_source: true,
    acknowledged_source_by: "Matheus Vieira",
    acknowledged_source_at: "2026-08-11T13:50:28.000Z",
    source_ack: {
      acknowledged: true,
      actor_name: "Rafael de Almeida",
      acknowledged_at: "2026-08-11T13:50:29.000Z",
      comment: "INC0067193",
      history_available: true,
    },
    host_ip: null,
    first_seen_at: "2026-08-11T12:00:00.000Z",
    last_seen_at: "2026-08-11T13:50:00.000Z",
    resolved_at: null,
    duration_seconds: 3293,
  });
  assert.equal(drawer.ack, "ACK");
  assert.equal(drawer.ack_actor, "Rafael de Almeida");
  assert.equal(drawer.ack_at, "2026-08-11T13:50:29.000Z");
  assert.equal(drawer.status, "Ativo");
  assert.ok(Number.isFinite(drawer.duration_seconds));
});

test("OV-P0-71: host_ip null no BFF → drawer não inventa IP; sem undefined/NaN", () => {
  const drawer = drawerFromBff({
    customer_name: "Sanepar",
    customer_key: "sanepar",
    operational_scope: "customer",
    operational_scope_label: "Sanepar",
    host_visible_name: "Sanepar - Router",
    problem_name: "High ICMP",
    severity: "warning",
    status_source: "active",
    acknowledged_source: false,
    host_ip: null,
    first_seen_at: "2026-08-11T10:00:00.000Z",
    last_seen_at: "2026-08-11T11:00:00.000Z",
    resolved_at: null,
    duration_seconds: 120,
  });
  assert.equal(drawer.ip, null);
  for (const [key, value] of Object.entries(drawer)) {
    assert.notEqual(value, undefined, key);
    if (typeof value === "number") assert.equal(Number.isNaN(value), false, key);
    if (typeof value === "string") {
      assert.doesNotMatch(value, /\bundefined\b/);
      assert.doesNotMatch(value, /\bNaN\b/);
    }
  }
});

test("OV-P0-71: wiring FE drawer consome BFF sem inferir cliente", async () => {
  const [drawer, identity, alerts, audit] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Alerts.tsx"),
    read("scripts/ov-p0-71-drawer-fidelity-audit.mjs"),
  ]);

  assert.match(drawer, /operationalClientLabel/);
  assert.match(drawer, /canonicalHostName/);
  assert.match(drawer, /safeHostIp\(alert\.host_ip\)/);
  assert.match(drawer, /interfaceFromAlertTags/);
  assert.match(drawer, /OV-P0-80|Detalhe do alerta/);
  assert.match(identity, /HOTFIX-P0-CLIENT-LABEL/);
  assert.match(identity, /Nunca infere cliente/);
  assert.match(alerts, /AlertDetailDrawer/);
  assert.match(alerts, /sourceAckPresentation|source_ack/);
  assert.match(drawer, /alert\.resolved_at/);
  assert.match(audit, /OV-P0-71/);
  assert.match(audit, /real_customer_overridden_by_scope/);
  assert.match(audit, /datasource_as_client/);
});
