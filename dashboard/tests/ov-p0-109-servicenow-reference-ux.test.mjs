/**
 * OV-P0-109 — Alert/History ServiceNow Reference UX
 * Projeta servicenow_reference na listagem sem N+1 ServiceNow.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  projectServiceNowReferenceFromAlertTags,
} from "../api/_lib/oneview-inc-correlation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-109 projeta number/sys_id/url/+N só a partir das tags", () => {
  const ref = projectServiceNowReferenceFromAlertTags({
    event_tags: [
      { tag: "__zbx_servicenow_sys_id", value: "aa62f29f47477610082e3d02e26d4358" },
      { tag: "__zbx_servicenow_number", value: "INC0067822" },
      { tag: "__zbx_servicenow_number", value: "INC0000001" },
    ],
    trigger_tags: [],
    host_tags: [],
  }, { baseUrl: "https://example.service-now.com" });

  assert.equal(ref.number, "INC0067822");
  assert.equal(ref.sys_id, "aa62f29f47477610082e3d02e26d4358");
  assert.equal(ref.extra_count, 1);
  assert.match(ref.url, /incident\.do\?sys_id=aa62f29f47477610082e3d02e26d4358/);

  assert.equal(projectServiceNowReferenceFromAlertTags({ event_tags: [] }), null);
});

test("OV-P0-109 BFF list SELECT inclui tags e mapAlertRows projeta referência sem HTTP SN", async () => {
  const db = await read("api/_lib/oneview-db.js");
  assert.match(db, /a\.event_tags,\s*\n\s*a\.trigger_tags,\s*\n\s*a\.host_tags/);

  const mapper = db.slice(db.indexOf("function mapAlertRows"), db.indexOf("function mapTopHosts"));
  assert.match(mapper, /projectServiceNowReferenceFromAlertTags/);
  assert.match(mapper, /servicenow_reference/);
  assert.match(mapper, /SERVICENOW_BASE_URL|getServiceNowConfig/);
  assert.doesNotMatch(mapper, /serviceNowGet|fetchIncidents|correlateAlertRelatedIncidents/);
});

test("OV-P0-109 Histórico: colunas ACK/Chamado/Estado; linha abre drawer; sem Abrir redundante", async () => {
  const historico = await read("src/pages/Historico.tsx");
  assert.match(historico, /<TableHead>ACK<\/TableHead>/);
  assert.match(historico, /<TableHead>Chamado<\/TableHead>/);
  assert.match(historico, /<TableHead>Estado<\/TableHead>/);
  assert.match(historico, /AlertServiceNowReferenceCell/);
  assert.match(historico, /servicenow_reference/);
  assert.match(historico, /Pendente/);
  assert.match(historico, /defaultTab="history"/);
  assert.match(historico, /onClick=\{\(\) => openAlertDetail\(alert\.id\)\}/);
  assert.doesNotMatch(historico, /<TableHead className="text-right">Ação<\/TableHead>/);
  // Botão Abrir removido da tabela de alertas (eventos podem manter).
  const alertasTable = historico.slice(
    historico.indexOf("<TableHead>Cliente</TableHead>"),
    historico.indexOf("Nenhum alerta encontrado"),
  );
  assert.doesNotMatch(alertasTable, />\s*Abrir\s*</);
});

test("OV-P0-109 Alertas: coluna compacta Chamado com mesma referência", async () => {
  const [alerts, cell, api] = await Promise.all([
    read("src/pages/Alerts.tsx"),
    read("src/components/oneview/AlertServiceNowReferenceCell.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);
  assert.match(alerts, /<TableHead className="px-3 text-left">Chamado<\/TableHead>/);
  assert.match(alerts, /AlertServiceNowReferenceCell/);
  assert.match(alerts, /servicenow_reference/);
  assert.match(alerts, /tableColumnCount = 10/);
  assert.match(cell, /stopPropagation/);
  assert.match(cell, /extra_count/);
  assert.match(api, /servicenow_reference\?:/);
});
