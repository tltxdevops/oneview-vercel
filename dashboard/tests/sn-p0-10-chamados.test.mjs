/**
 * SN-P0-10 — fechar Chamados read-only local (contrato focado).
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

test("SN-P0-10 Chamados: resumo operacional vivo e completo", async () => {
  const chamados = await read("src/pages/Chamados.tsx");
  for (const label of ["Total", "Abertos", "Em andamento", "Resolvidos", "Encerrados", "Sem responsável", "Duplicados"]) {
    assert.match(chamados, new RegExp(`label:\\s*"${label}"`));
  }
  assert.match(chamados, /counts\?\.total/);
  assert.match(chamados, /counts\?\.closed/);
});

test("SN-P0-10 Chamados: filtros server-side obrigatórios", async () => {
  const [chamados, api, incidents] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-incidents.js"),
  ]);

  for (const token of ["company", "state", "priority", "callerId", "openedFrom", "search"]) {
    assert.match(chamados, new RegExp(token));
  }
  assert.match(api, /opened_from|openedFrom/);
  assert.match(api, /caller_id|callerId/);
  assert.match(incidents, /company\.nameLIKE|opened_at>=|assigned_toISEMPTY/);
});

test("SN-P0-10 Chamados: tabela sem Abertura e com Atualização", async () => {
  const chamados = await read("src/pages/Chamados.tsx");
  assert.match(
    chamados,
    /COLUMNS\s*=\s*\[[^\]]*"Número"[^\]]*"Cliente"[^\]]*"Descrição"[^\]]*"Estado"[^\]]*"Prioridade"[^\]]*"Grupo"[^\]]*"Responsável"[^\]]*"Atualização"[^\]]*\]/s,
  );
  assert.doesNotMatch(chamados, /COLUMNS\s*=\s*\[[^\]]*"Abertura"[^\]]*\]/s);
  assert.match(chamados, /formatDateTime\(item\.sys_updated_on\)/);
  assert.doesNotMatch(chamados, /formatDateTime\(item\.opened_at\)/);
});

test("SN-P0-10 Chamados: drawer completo + alerta + ServiceNow", async () => {
  const [chamados, drawer, related] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
    read("src/components/oneview/IncidentRelatedAlertSection.tsx"),
  ]);
  assert.match(chamados, /IncidentDetailDrawer/);
  assert.match(chamados, /IncidentTableActionsCell/);
  assert.doesNotMatch(chamados, /IncidentOperationalActions/);
  assert.match(drawer, /IncidentDetailActions/);
  assert.match(drawer, /TabsTrigger value="summary"/);
  assert.match(drawer, /TabsTrigger value="alert"/);
  assert.match(drawer, /TabsTrigger value="technical"/);
  assert.match(drawer, /ServiceNowDevLink/);
  assert.match(drawer, /fetchIncidentDetail/);
  assert.match(related, /Alerta relacionado/);
  assert.match(related, /fetchIncidentRelatedAlert/);
  const link = await read("src/components/oneview/ServiceNowDevLink.tsx");
  assert.match(link, /Abrir no ServiceNow/);
  assert.match(link, /Requer acesso ao ServiceNow/);
  assert.doesNotMatch(link, /ServiceNow DEV/);
});

test("SN-P0-10 Chamados: erro != lista vazia e sem NaN/undefined", async () => {
  const [chamados, drawer] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
  ]);
  assert.match(chamados, /OperationalErrorBanner/);
  assert.match(`${chamados}\n${drawer}`, /ServiceNow indisponível/);
  assert.match(chamados, /Não foi possível carregar os chamados/);
  assert.match(chamados, /error \?[\s\S]*Não foi possível carregar[\s\S]*items\.length === 0/s);
  assert.match(chamados, /function safeCount/);
  assert.match(chamados, /text === "NaN"|=== "undefined"/);
  assert.doesNotMatch(chamados, /mock-data|mockChamados|mockClients/i);
  assert.doesNotMatch(chamados, /method:\s*["'](POST|PATCH|DELETE)["']/i);
});

test("SN-P0-10 BFF incidents permanece GET-only com counts.total", async () => {
  const incidents = await read("api/_lib/oneview-incidents.js");
  assert.match(incidents, /Sem POST\/PATCH\/DELETE/);
  assert.match(incidents, /total,\s*\n\s*open,/);
  assert.match(incidents, /req\.method !== "GET"/);
  assert.doesNotMatch(incidents, /\b(serviceNowPost|serviceNowPatch|serviceNowDelete)\b/);
});
