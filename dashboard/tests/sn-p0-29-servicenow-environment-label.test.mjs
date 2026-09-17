/**
 * SN-P0-29 — ServiceNow Environment Label
 * Superfícies operacionais usam somente "ServiceNow" (sem DEV/prod hardcoded).
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

test("SN-P0-29 ServiceNowDevLink: Abrir no ServiceNow (sem DEV)", async () => {
  const link = await read("src/components/oneview/ServiceNowDevLink.tsx");
  assert.match(link, /SERVICENOW_LINK_LABEL\s*=\s*"Abrir no ServiceNow"/);
  assert.match(link, /SERVICENOW_LINK_TOOLTIP\s*=\s*"Requer acesso ao ServiceNow\."/);
  assert.doesNotMatch(link, /Abrir no ServiceNow DEV/);
  assert.doesNotMatch(link, /Requer acesso ao ServiceNow DEV/);
  // Sem hardcode de ambiente operacional no componente.
  assert.doesNotMatch(link, /["']DEV["']|["']prod["']|["']produção["']/i);
});

test("SN-P0-29 superfícies operacionais: badge/sidebar sem ServiceNow DEV", async () => {
  const [chamados, sidebar, section] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
  ]);

  assert.doesNotMatch(chamados, /<Badge[^>]*>[\s\S]*ServiceNow/);
  assert.match(chamados, /ServiceNowDevLink/);
  assert.doesNotMatch(chamados, /ServiceNow DEV/);
  assert.match(sidebar, /secondary:\s*"ServiceNow"/);
  assert.doesNotMatch(sidebar, /ServiceNow DEV/);
  assert.match(section, /ServiceNowDevLink/);
  assert.doesNotMatch(section, /ServiceNow DEV/);
});

test("SN-P0-29 URL/auth/integração intactas (só label muda)", async () => {
  const [link, incidents, client] = await Promise.all([
    read("src/components/oneview/ServiceNowDevLink.tsx"),
    read("api/_lib/oneview-incidents.js"),
    read("api/_lib/servicenow-client.js"),
  ]);

  assert.match(link, /href=\{url\}/);
  assert.match(link, /target="_blank"/);
  assert.match(incidents, /servicenow_url/);
  assert.match(incidents, /buildServiceNowIncidentUrl|incident\.do/);
  assert.match(client, /buildBasicAuthHeader/);
  assert.doesNotMatch(link, /buildBasicAuthHeader|SERVICENOW_PASSWORD|Authorization/);
});
