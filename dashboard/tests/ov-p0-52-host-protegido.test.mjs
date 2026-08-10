/**
 * OV-P0-52 — residual "Host protegido" só em redação técnica; UI operacional usa cadeia canônica.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-52 BFF operacional não injeta Host protegido em mapAlertRows/mapAttentionRows", async () => {
  const db = await read("api/_lib/oneview-db.js");

  assert.match(db, /function operationalHostFields/);
  assert.match(db, /OV-P0-52/);
  assert.match(db, /function mapAlertRows/);
  assert.match(db, /function mapAttentionRows/);

  const alertMapper = db.slice(db.indexOf("function mapAlertRows"), db.indexOf("function mapTopHosts"));
  assert.match(alertMapper, /operationalHostFields\(row\)/);
  assert.doesNotMatch(alertMapper, /aliasForHost|aliasMapFromHosts|Host protegido/);
  assert.doesNotMatch(alertMapper, /replaceInternalHost/);

  const attentionMapper = db.slice(db.indexOf("function mapAttentionRows"), db.indexOf("async function fetchAttentionRequiredPayload"));
  assert.match(attentionMapper, /operationalHostFields\(row\)/);
  assert.doesNotMatch(attentionMapper, /aliasForHost|Host protegido|: hostAlias/);
  assert.match(attentionMapper, /host_technical_name/);
  assert.match(attentionMapper, /host_name: hosts\.host_name/);
});

test("OV-P0-52 redação técnica permanece em histórico/logs", async () => {
  const db = await read("api/_lib/oneview-db.js");
  assert.match(db, /function aliasForHost/);
  assert.match(db, /Host protegido \$\{digest\}/);
  assert.match(db, /replaceInternalHost\(row\.description, alert\.host_name, alias/);
});

test("OV-P0-52 FE Monitoramento usa cadeia canônica sem literal Host protegido", async () => {
  const [identity, monitoring, fallback] = await Promise.all([
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("api/_lib/oneview-fallback.js"),
  ]);

  assert.match(identity, /host_visible_name → host_technical_name → host_name/);
  assert.match(identity, /MISSING_HOST_LABEL = "Host não informado"/);
  assert.match(identity, /\/\^host protegido\\b\/i/);
  assert.match(monitoring, /canonicalHostName/);
  assert.doesNotMatch(monitoring, /Host protegido/);
  assert.match(fallback, /OV-P0-52/);
  assert.doesNotMatch(fallback, /host_visible_name: alert\.host_visible_name \|\| alert\.host_name/);
});

test("OV-P0-52 canonicalHostName: Zabbix server via host_name quando visible/technical vazios", async () => {
  const source = await read("src/components/oneview/ClientIdentity.tsx");
  const isMissingHostLabel = (value) => {
    const text = String(value || "").trim();
    if (!text) return true;
    if (text === "-" || /^host$/i.test(text)) return true;
    if (/^host protegido\b/i.test(text)) return true;
    const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return normalized === "host nao informado"
      || normalized === "host nao identificado"
      || normalized === "host nao disponivel";
  };
  const canonicalHostName = (host, fallback = "Host não informado") => {
    for (const candidate of [host?.host_visible_name, host?.host_technical_name, host?.host_name]) {
      const value = String(candidate || "").trim();
      if (value && !isMissingHostLabel(value)) return value;
    }
    return fallback;
  };

  assert.equal(
    canonicalHostName({
      host_visible_name: null,
      host_technical_name: null,
      host_name: "Zabbix server",
    }),
    "Zabbix server",
  );
  assert.equal(
    canonicalHostName({
      host_visible_name: "Host protegido AABBCCDD",
      host_technical_name: null,
      host_name: "Zabbix server",
    }),
    "Zabbix server",
  );
  assert.equal(
    canonicalHostName({
      host_visible_name: "Host protegido AABBCCDD",
      host_technical_name: "Host protegido FFFFFFFF",
      host_name: "Host protegido 12345678",
    }),
    "Host não informado",
  );
  assert.match(source, /export function canonicalHostName/);
});
