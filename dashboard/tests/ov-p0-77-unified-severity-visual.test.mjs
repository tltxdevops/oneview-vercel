/**
 * OV-P0-77 — Unified Severity Visual: uma fonte de verdade para as 5 severidades Zabbix.
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

const CANONICAL = ["information", "warning", "average", "high", "disaster"];

test("OV-P0-77 oneview-severity-visual: tons canônicos das cinco severidades + dark", async () => {
  const visual = await read("src/lib/oneview-severity-visual.ts");
  const badge = await read("src/components/badges/SeverityBadge.tsx");

  assert.match(visual, /export function severityTone/);
  assert.match(visual, /export const ONEVIEW_SEVERITY_TONE/);
  assert.match(visual, /ONEVIEW_SEVERITY_CATALOG/);
  assert.match(visual, /export const ONEVIEW_SEVERITY_UI/);

  for (const key of CANONICAL) {
    assert.match(visual, new RegExp(`${key}:\\s*[\\s\\S]*?dark:`));
  }

  assert.match(visual, /information:[^,]*(?:sky)/);
  assert.match(visual, /warning:[^,]*(?:yellow)/);
  assert.match(visual, /average:[^,]*(?:amber)/);
  assert.match(visual, /high:[^,]*(?:red-3|red-50|bg-red-50)[\s\S]*?font-semibold/);
  assert.match(visual, /disaster:[^,]*(?:red-7|red-8|bg-red-2)[\s\S]*?font-semibold/);

  // High = vermelho claro (bg-50/border-300); Disaster = forte (bg-200/border-800)
  const highBlock = visual.slice(visual.indexOf("high:"), visual.indexOf("disaster:"));
  assert.match(highBlock, /bg-red-50/);
  assert.match(highBlock, /border-red-300/);
  assert.doesNotMatch(highBlock, /bg-red-200|border-red-800/);

  const disasterBlock = visual.slice(visual.indexOf("disaster:"), visual.indexOf("critical:"));
  assert.match(disasterBlock, /bg-red-200|border-red-800/);
  assert.doesNotMatch(disasterBlock, /orange|bg-red-50/);

  assert.match(badge, /severityTone/);
  assert.match(badge, /formatOneViewSeverityLabel/);
  assert.doesNotMatch(badge, /BAIXO|MÉDIO|ALTO|CRÍTICO/);
});

test("OV-P0-77 severityTone runtime: cinco labels oficiais sem tradução", async () => {
  // TS module via Vite path alias não roda direto; espelha contrato via source + API labels.
  const api = await read("src/lib/oneview-api.ts");
  for (const label of ["Information", "Warning", "Average", "High", "Disaster"]) {
    assert.match(api, new RegExp(`"${label}"`));
  }
  assert.doesNotMatch(api, /Informação|Aviso|Média|Alta|Desastre/);

  const visualSrc = await read("src/lib/oneview-severity-visual.ts");
  // Garante que labels UI vêm do catálogo de dados, não de tradução local
  assert.match(visualSrc, /label: ONEVIEW_SEVERITY_CATALOG\[severity\]\.label/);
  assert.doesNotMatch(visualSrc, /Informação|Desastre|Crítico/);
});

test("OV-P0-77 superfícies: Home / Monitoramento / Alertas / Histórico / drawer usam fonte única", async () => {
  const [index, monitoring, alerts, historico, drawer, visual] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
    read("src/lib/oneview-severity-visual.ts"),
  ]);

  assert.match(index, /SeverityBadge/);
  assert.match(monitoring, /SeverityBadge/);
  assert.match(alerts, /SeverityBadge/);
  assert.match(alerts, /ONEVIEW_SEVERITY_UI|severityCatalog = ONEVIEW_SEVERITY_UI/);
  assert.match(historico, /SeverityBadge/);
  assert.match(drawer, /SeverityBadge/);

  // Sem wash vermelho na linha do Monitoramento
  assert.doesNotMatch(monitoring, /bg-red-50\/40|dark:bg-red-950\/20/);

  // Drawer não mantém catálogo local concorrente
  assert.doesNotMatch(drawer, /const SEVERITY_TONE/);
  assert.doesNotMatch(index, /function severityTone/);
  assert.doesNotMatch(monitoring, /function severityTone/);

  // Fonte única
  assert.match(visual, /OV-P0-77/);
  assert.match(alerts, /from "@\/lib\/oneview-severity-visual"/);
});

test("OV-P0-77: High ≠ Disaster (tokens distintos)", async () => {
  // Extrai as strings de tom via regex simples do source
  const visual = await read("src/lib/oneview-severity-visual.ts");
  const extract = (key) => {
    const re = new RegExp(`${key}:\\s*\\n?\\s*"([^"]+)"`);
    const match = visual.match(re);
    assert.ok(match, `missing tone for ${key}`);
    return match[1];
  };
  const high = extract("high");
  const disaster = extract("disaster");
  const information = extract("information");
  const warning = extract("warning");
  const average = extract("average");

  assert.notEqual(high, disaster);
  assert.match(high, /red-50|red-300/);
  assert.match(disaster, /red-700|red-800|bg-red-200/);
  assert.match(information, /sky/);
  assert.match(warning, /yellow/);
  assert.match(average, /amber/);
  assert.match(high, /font-semibold/);
  assert.match(disaster, /font-semibold/);
  assert.doesNotMatch(information, /font-semibold/);
  assert.doesNotMatch(warning, /font-semibold/);
  assert.doesNotMatch(average, /font-semibold/);
  assert.doesNotMatch(high, /orange/);
});
