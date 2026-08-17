/**
 * OV-P0-108 — Alert Detail Fidelity + ServiceNow Explicit Reference
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RELATION_SOURCE,
  correlateAlertRelatedIncidents,
  extractServiceNowRefsFromAlertTags,
  filterOperationalAlertTags,
  isInternalZabbixIntegrationTag,
} from "../api/_lib/oneview-inc-correlation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-108 extrai __zbx_servicenow_* de event/trigger/host/template tags", () => {
  const refs = extractServiceNowRefsFromAlertTags({
    event_tags: [
      { tag: "__zbx_servicenow_sys_id", value: "AA62F29F47477610082E3D02E26D4358" },
      { tag: "__zbx_servicenow_number", value: "INC0067822" },
      { tag: "__zbx_servicenow_link", value: "https://example.service-now.com/incident.do?sys_id=aa62" },
      { tag: "Application", value: "ERP" },
    ],
    trigger_tags: [{ tag: "__zbx_servicenow_number", value: "inc0067822" }],
    host_tags: [],
    template_tags: [{ tag: "__zbx_servicenow_sys_id", value: "aa62f29f47477610082e3d02e26d4358" }],
  });

  assert.deepEqual(refs.sysIds, ["aa62f29f47477610082e3d02e26d4358"]);
  assert.deepEqual(refs.numbers, ["INC0067822"]);
  assert.equal(refs.links.length, 1);
  assert.equal(isInternalZabbixIntegrationTag("__zbx_servicenow_number"), true);
  assert.equal(isInternalZabbixIntegrationTag("Application"), false);

  const operational = filterOperationalAlertTags([
    { tag: "__zbx_servicenow_number", value: "INC1" },
    { tag: "Application", value: "ERP" },
  ]);
  assert.deepEqual(operational, [{ tag: "Application", value: "ERP" }]);
});

test("OV-P0-108 prioridade: sys_id → number tag → histórico → event_id → none", async () => {
  const calls = [];
  const bySysId = async (ids) => {
    calls.push(["sys", ids]);
    return {
      incidents: [{ sys_id: ids[0], number: "INC0067822" }],
      checked_at: "t1",
    };
  };
  const byNumber = async (numbers) => {
    calls.push(["number", numbers]);
    return { incidents: [{ sys_id: "x", number: numbers[0] }], checked_at: "t2" };
  };
  const byEvent = async (eventId) => {
    calls.push(["event", eventId]);
    return { incidents: [{ sys_id: "e", number: "INC9" }], checked_at: "t3" };
  };

  const viaSys = await correlateAlertRelatedIncidents({
    sourceEventId: "111",
    incidentSysIds: ["aa62f29f47477610082e3d02e26d4358"],
    tagIncidentNumbers: ["INC0067822"],
    incidentNumbers: ["INC0001"],
    lookupBySysId: bySysId,
    lookupByNumber: byNumber,
    lookupByEventId: byEvent,
  });
  assert.equal(viaSys.relation_source, RELATION_SOURCE.ZABBIX_SERVICENOW_SYS_ID);
  assert.deepEqual(calls[0], ["sys", ["aa62f29f47477610082e3d02e26d4358"]]);

  calls.length = 0;
  const viaTagNumber = await correlateAlertRelatedIncidents({
    sourceEventId: "111",
    tagIncidentNumbers: ["INC0067822"],
    incidentNumbers: ["INC0001"],
    lookupBySysId: async () => ({ incidents: [] }),
    lookupByNumber: byNumber,
    lookupByEventId: byEvent,
  });
  assert.equal(viaTagNumber.relation_source, RELATION_SOURCE.ZABBIX_SERVICENOW_NUMBER);
  assert.deepEqual(calls[0][1], ["INC0067822"]);

  calls.length = 0;
  const viaHistory = await correlateAlertRelatedIncidents({
    sourceEventId: "111",
    incidentNumbers: ["INC0001"],
    historyItems: [{ comment: "ver INC0001" }],
    lookupBySysId: async () => ({ incidents: [] }),
    lookupByNumber: byNumber,
    lookupByEventId: byEvent,
  });
  assert.equal(viaHistory.relation_source, RELATION_SOURCE.ZABBIX_INC_REFERENCE);

  calls.length = 0;
  const viaEvent = await correlateAlertRelatedIncidents({
    sourceEventId: "111",
    lookupBySysId: async () => ({ incidents: [] }),
    lookupByNumber: async () => ({ incidents: [] }),
    lookupByEventId: byEvent,
  });
  assert.equal(viaEvent.relation_source, RELATION_SOURCE.ZABBIX_EVENT_ID);

  const none = await correlateAlertRelatedIncidents({
    sourceEventId: null,
    lookupBySysId: async () => ({ incidents: [] }),
    lookupByNumber: async () => ({ incidents: [] }),
    lookupByEventId: async () => ({ incidents: [] }),
  });
  assert.equal(none.relation_source, RELATION_SOURCE.NONE);
});

test("OV-P0-108 drawer: sem flicker full-tab; oculta tags internas; Chamado relacionado", async () => {
  const [drawer, section, historico, index, monitoring, api] = await Promise.all([
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(drawer, /filterOperationalAlertTags/);
  assert.match(drawer, /Tags operacionais/);
  assert.doesNotMatch(drawer, /isLoading \? \(\s*<>\s*<Skeleton/);
  assert.match(drawer, /value=\{activeTab\}/);
  assert.doesNotMatch(drawer, /key=\{`\$\{alert\.id\}:\$\{initialTab\}`\}/);

  assert.match(section, /Chamado relacionado/);
  assert.match(section, /extractServiceNowRefsFromAlertTags/);
  assert.match(section, /tagIncidentNumbers|incidentSysIds/);
  assert.match(section, /ProjectedIncidentCard|Carregando detalhe do chamado/);
  assert.match(section, /Estado/);
  assert.match(section, /Última atualização/);

  assert.match(historico, /OV-P0-108/);
  assert.match(historico, /\[selectedAlertId\]/);
  assert.doesNotMatch(historico, /\[alertItems, selectedAlertId\]/);

  assert.match(index, /mantém preview\/detail existente/);
  const indexLoad = index.slice(index.indexOf("const loadSelectedAlert"), index.indexOf("const openAlert"));
  assert.doesNotMatch(indexLoad, /setDetail\(null\)/);
  assert.doesNotMatch(indexLoad, /setHistory\(null\)/);
  assert.match(monitoring, /mantém preview\/detail existente/);
  const monitoringLoad = monitoring.slice(
    monitoring.indexOf("const loadSelectedAlert"),
    monitoring.indexOf("const closeAlert"),
  );
  assert.doesNotMatch(monitoringLoad, /setDetail\(null\)/);
  assert.doesNotMatch(monitoringLoad, /setHistory\(null\)/);

  assert.match(api, /zabbix_servicenow_sys_id/);
  assert.match(api, /sn_number/);
  assert.match(api, /incidentSysIds/);
});

test("OV-P0-108 handler aceita sys_id e sn_number", async () => {
  const handler = await read("api/_lib/oneview-alert-incidents.js");
  assert.match(handler, /parseIncidentSysIdInputs/);
  assert.match(handler, /parseTagIncidentNumberInputs/);
  assert.match(handler, /sn_number/);
  assert.match(handler, /lookupBySysId/);
  assert.match(handler, /tagIncidentNumbers/);
});
