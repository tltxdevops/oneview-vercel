/**
 * SN-P0-12 — KPIs de estado alinhados ao state ServiceNow (sem inferência por descrição).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { INCIDENT_STATE_KPI } from "../api/_lib/oneview-incidents.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("SN-P0-12 define KPIs explícitos por state", () => {
  assert.equal(INCIDENT_STATE_KPI.open.state, "1");
  assert.equal(INCIDENT_STATE_KPI.in_progress.state, "2");
  assert.equal(INCIDENT_STATE_KPI.resolved.state, "6");
  assert.equal(INCIDENT_STATE_KPI.closed.state, "7");
  assert.equal(INCIDENT_STATE_KPI.open.label, "Abertos");
  assert.equal(INCIDENT_STATE_KPI.in_progress.label, "Em andamento");
  assert.equal(INCIDENT_STATE_KPI.resolved.label, "Resolvidos");
  assert.equal(INCIDENT_STATE_KPI.closed.label, "Encerrados");
});

test("SN-P0-12 BFF conta Resolvidos=6 e Encerrados=7 separados", async () => {
  const source = await read("api/_lib/oneview-incidents.js");
  assert.match(source, /INCIDENT_STATE_KPI\.resolved\.state/);
  assert.match(source, /INCIDENT_STATE_KPI\.closed\.state/);
  assert.doesNotMatch(source, /state:\s*"6,7"|stateIN6,7/);
  assert.match(source, /closed,/);
  assert.match(source, /Não inferir por short_description|Não inferir por short_description/i);
});

test("SN-P0-12 Chamados expõe Encerrados e não mistura 6+7 no KPI Resolvidos", async () => {
  const chamados = await read("src/pages/Chamados.tsx");
  assert.match(chamados, /label:\s*"Encerrados"/);
  assert.match(chamados, /label:\s*"Resolvidos"/);
  assert.match(chamados, /label:\s*"Abertos"/);
  assert.match(chamados, /label:\s*"Em andamento"/);
  assert.match(chamados, /counts\?\.closed/);
  assert.match(chamados, /selectMetric\("closed"\)/);
  assert.match(chamados, /applied\.state === "6"/);
  assert.match(chamados, /applied\.state === "7"/);
  assert.doesNotMatch(chamados, /state === "6,7"|state:\s*"6,7"/);
});

test("SN-P0-12 contrato FE/API inclui counts.closed", async () => {
  const api = await read("src/lib/oneview-api.ts");
  assert.match(api, /closed:\s*number/);
  assert.match(api, /resolved:\s*number/);
});

test("SN-P0-12B summary usa Aggregate API com fallback Table", async () => {
  const [incidents, client] = await Promise.all([
    read("api/_lib/oneview-incidents.js"),
    read("api/_lib/servicenow-client.js"),
  ]);
  assert.match(client, /\/api\/now\/stats\//);
  assert.match(client, /export async function serviceNowStats/);
  assert.match(incidents, /serviceNowStats/);
  assert.match(incidents, /sysparm_group_by:\s*"state"/);
  assert.match(incidents, /fetchIncidentCountsViaTable/);
  assert.match(incidents, /servicenow_access_forbidden|Aggregate|getStats/);
});
