/**
 * OV-P0-102 — RC consistency: cliente sem classificação + critical ∈ família High.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-102: operationalClientLabel nunca cai em Cliente não classificado", async () => {
  const identity = await read("src/components/oneview/ClientIdentity.tsx");
  assert.match(identity, /fallback = UNKNOWN_SCOPE_LABEL/);
  assert.match(identity, /export function facetCustomerDisplayName/);
  assert.match(identity, /Nunca exibe "Cliente não classificado"/);
  assert.doesNotMatch(
    identity,
    /operationalClientLabel\([\s\S]*?fallback = UNCLASSIFIED_CLIENT_LABEL/,
  );
});

test("OV-P0-102: superfícies operacionais não forçam Cliente não classificado", async () => {
  const [index, monitoring, alerts, historico] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  for (const [label, source] of [
    ["Index", index],
    ["Monitoring", monitoring],
    ["Alerts", alerts],
    ["Historico", historico],
  ]) {
    assert.match(source, /facetCustomerDisplayName/, `${label} usa facetCustomerDisplayName`);
    assert.doesNotMatch(
      source,
      /name:\s*UNCLASSIFIED_CLIENT_LABEL|name:\s*"Cliente não classificado"/,
      `${label} não força label legado`,
    );
  }

  assert.doesNotMatch(
    historico,
    /customers\.push\(\{[\s\S]*key:\s*"unclassified"/,
    "Histórico não injeta opção artificial unclassified",
  );
  assert.match(alerts, /name: label \|\| UNKNOWN_SCOPE_LABEL/);
});

test("OV-P0-102: critical ∈ família High na query; Disaster isolado; badge High", async () => {
  const [api, visual, monitoringLib, alerts] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/lib/oneview-severity-visual.ts"),
    read("src/lib/oneview-monitoring.ts"),
    read("src/pages/Alerts.tsx"),
  ]);

  assert.match(api, /export function expandHighFamilySeverities/);
  assert.match(api, /if \(seen\.has\("high"\)\) seen\.add\("critical"\)/);
  assert.match(api, /canonicalizeSeveritiesForApi\(values: string\[]\): OneViewSeverity\[] \{\s*return expandHighFamilySeverities/);
  assert.match(api, /critical: "High"/);
  assert.match(api, /disasterFamilySeverities[\s\S]*return \["disaster"\]/);
  assert.doesNotMatch(
    api,
    /disasterFamilySeverities[\s\S]*severities\.push\("critical"\)/,
  );

  assert.match(visual, /normalized === "critical" \? "high"/);
  assert.match(visual, /if \(severity === "critical"\)[\s\S]*label: "High"/);
  assert.match(visual, /critical: "P2"/);

  // Prioritários UI permanece sem chip Critical; expansão ocorre no fetchAlerts.
  assert.match(monitoringLib, /MONITOR_PRIORITARY_SEVERITIES = \["average", "high", "disaster"\]/);
  assert.match(monitoringLib, /severities: \[\.\.\.severities\]/);
  assert.match(alerts, /filter\(\(s\) => s !== "critical"\)/);
  assert.doesNotMatch(alerts, /setSelectedSeverities\(\["disaster", "high", "critical"\]\)/);
});

test("OV-P0-102 helpers: expandHighFamilySeverities e labels", async () => {
  function isOneViewSeverity(value) {
    return ["disaster", "critical", "high", "average", "warning", "information", "not_classified"].includes(value);
  }
  function expandHighFamilySeverities(values) {
    const seen = new Set();
    for (const value of values) {
      const raw = String(value || "").trim().toLowerCase();
      if (!isOneViewSeverity(raw)) continue;
      seen.add(raw);
    }
    if (seen.has("high")) seen.add("critical");
    return [...seen];
  }

  assert.deepEqual(expandHighFamilySeverities(["high"]).sort(), ["critical", "high"]);
  assert.deepEqual(expandHighFamilySeverities(["disaster"]), ["disaster"]);
  assert.deepEqual(
    expandHighFamilySeverities(["average", "high", "disaster"]).sort(),
    ["average", "critical", "disaster", "high"],
  );
  assert.deepEqual(expandHighFamilySeverities(["disaster", "critical"]).sort(), ["critical", "disaster"]);
});
