/**
 * SN-P0-23 — deep link ServiceNow DEV (label + tooltip; sem Basic Auth no browser).
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

test("SN-P0-23 ServiceNowDevLink: label DEV + tooltip de acesso", async () => {
  const link = await read("src/components/oneview/ServiceNowDevLink.tsx");
  assert.match(link, /Abrir no ServiceNow DEV/);
  assert.match(link, /Requer acesso ao ServiceNow DEV\./);
  assert.match(link, /TooltipContent/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.doesNotMatch(link, /\bBasic\b|btoa\(|SERVICENOW_PASSWORD|Authorization/);
  assert.doesNotMatch(link, /acquireToken|loginRequest|msal/i);
});

test("SN-P0-23 Chamados e drawer de alerta usam o deep link DEV", async () => {
  const [chamados, section, link, api] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/components/oneview/ServiceNowDevLink.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(chamados, /ServiceNowDevLink/);
  assert.match(section, /ServiceNowDevLink/);
  assert.match(link, /Abrir no ServiceNow DEV/);
  assert.match(link, /Requer acesso ao ServiceNow DEV/);
  assert.doesNotMatch(chamados, /Abrir no ServiceNow"/);
  assert.doesNotMatch(section, /Abrir no ServiceNow"/);

  // FE consome apenas URL pública do incidente — sem credenciais SN.
  const fetchSlice = api.slice(api.indexOf("export async function fetchIncidents"));
  assert.doesNotMatch(fetchSlice, /Basic |SERVICENOW_PASSWORD|btoa\(/);
});

test("SN-P0-23 BFF monta URL do incidente sem vazar Basic Auth ao FE", async () => {
  const [incidents, client] = await Promise.all([
    read("api/_lib/oneview-incidents.js"),
    read("api/_lib/servicenow-client.js"),
  ]);
  assert.match(incidents, /buildServiceNowIncidentUrl|incident\.do/);
  assert.match(incidents, /servicenow_url/);
  assert.match(client, /buildBasicAuthHeader/);
  // Basic Auth permanece só no client server-side.
  assert.doesNotMatch(incidents, /Authorization.*Basic|buildBasicAuthHeader/);
});
