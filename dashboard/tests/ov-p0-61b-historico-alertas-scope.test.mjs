/**
 * OV-P0-61B — Histórico > Alertas usa operational_scope_label (sem "Cliente não classificado").
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

test("OV-P0-61B Histórico Alertas: ClientIdentity consome scope label", async () => {
  const [historico, identity] = await Promise.all([
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);

  // Tabela Alertas (não só Eventos) usa historyEventClientLabel.
  const alertsTabIdx = historico.indexOf('TabsContent value="alertas"');
  const eventosTabIdx = historico.indexOf('TabsContent value="eventos"');
  assert.ok(alertsTabIdx >= 0 && eventosTabIdx > alertsTabIdx);

  const alertsSection = historico.slice(alertsTabIdx, eventosTabIdx);
  assert.match(alertsSection, /historyEventClientLabel/);
  assert.match(alertsSection, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(alertsSection, /operationalScopeLabel=\{historyEventClientLabel/);
  assert.match(alertsSection, /operational_scope_label: alert\.operational_scope_label/);

  // Drawer unificado (OV-P0-80+): escopo via operationalClientLabel no AlertDetailDrawer.
  assert.match(historico, /AlertDetailDrawer/);
  assert.match(historico, /defaultTab="history"/);
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  assert.match(drawer, /operationalClientLabel/);
  assert.match(drawer, /operational_scope_label: alert\.operational_scope_label/);

  // ClientIdentity consome scope label só sem customer real (HOTFIX-P0-CLIENT-LABEL).
  assert.match(identity, /hasRealCustomer/);
  assert.match(identity, /PLATFORM_SCOPE_LABEL/);
  assert.match(identity, /historyEventClientLabel/);
  assert.doesNotMatch(alertsSection, /canonicalClientName\(\{ key: alert\.customer_key/);
});

test("OV-P0-61B não altera worker/DB e reutiliza helpers", async () => {
  const [historico, identity] = await Promise.all([
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);
  assert.match(historico, /historyEventClientLabel/);
  assert.match(historico, /ClientIdentity/);
  assert.match(identity, /export function operationalClientLabel/);
  assert.match(identity, /export function historyEventClientLabel/);
  assert.doesNotMatch(historico, /migrate|ALTER TABLE|UPDATE alerts/i);
});
