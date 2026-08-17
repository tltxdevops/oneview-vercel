/**
 * OV-P0-78 — Operational UI Design System: tokens + componentes compartilhados.
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

test("OV-P0-78 tokens e componentes compartilhados existem", async () => {
  const [tokens, segmented, group, cta, trunc, combobox, identity] = await Promise.all([
    read("src/lib/oneview-operational-ui.ts"),
    read("src/components/oneview/OperationalSegmentedControl.tsx"),
    read("src/components/oneview/OperationalFilterGroup.tsx"),
    read("src/components/oneview/OperationalCta.tsx"),
    read("src/components/oneview/TruncatedText.tsx"),
    read("src/components/oneview/ClientFilterCombobox.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);

  assert.match(tokens, /export const OV_FILTER_CONTROL/);
  assert.match(tokens, /h-8/);
  assert.match(tokens, /OV_CLIENT_FILTER_WIDTH|w-\[12rem\]/);
  assert.match(tokens, /export const OV_CTA/);
  assert.match(tokens, /h-7 px-2 text-xs/);
  assert.match(tokens, /OV_FILTER_DIVIDER/);
  assert.match(tokens, /OV_SEGMENTED/);

  assert.match(segmented, /OperationalSegmentedControl/);
  assert.match(group, /OperationalFilterGroup/);
  assert.match(cta, /OperationalCta/);
  assert.match(trunc, /TruncatedText/);

  assert.match(combobox, /OV_CLIENT_FILTER_TRIGGER/);
  assert.doesNotMatch(combobox, /h-9 min-w-\[11\.5rem\] rounded-xl/);
  assert.match(identity, /size\?: "xs" \| "sm" \| "md" \| "lg"/);
  assert.match(identity, /h-8 w-8/); // logos 32px em listas (sm)
});

test("OV-P0-78 páginas usam componentes/tokens compartilhados", async () => {
  const [monitoring, index, alerts, historico] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(monitoring, /OperationalSegmentedControl/);
  assert.match(monitoring, /OperationalFilterGroup/);
  assert.match(monitoring, /OperationalCta/);
  assert.match(monitoring, /TruncatedText/);
  assert.match(monitoring, /Janela temporal/);
  assert.doesNotMatch(monitoring, /bg-red-50\/40/);

  assert.match(index, /OperationalSegmentedControl/);
  assert.match(index, /OperationalFilterGroup/);
  assert.match(index, /OperationalCta/);
  assert.match(index, /OV_FILTER_CONTROL|OV_FILTER_CHIP/);

  assert.match(alerts, /OV_FILTER_CONTROL/);
  assert.match(alerts, /OV_CTA/);
  assert.match(alerts, /text-left/);
  assert.match(alerts, /text-right[\s\S]*Duração|Duração[\s\S]*text-right/);

  assert.match(historico, /OV_FILTER_CONTROL/);
  assert.match(historico, /OV_CTA/);
});

test("OV-P0-78 severidade: High claro ≠ Disaster forte", async () => {
  const visual = await read("src/lib/oneview-severity-visual.ts");
  const extract = (key) => {
    const re = new RegExp(`${key}:\\s*\\n?\\s*"([^"]+)"`);
    const match = visual.match(re);
    assert.ok(match, `missing ${key}`);
    return match[1];
  };
  const high = extract("high");
  const disaster = extract("disaster");
  assert.notEqual(high, disaster);
  assert.match(high, /red-50|red-300/);
  assert.match(disaster, /red-700|red-800|bg-red-200/);
  assert.doesNotMatch(high, /orange/);
});
