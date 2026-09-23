import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createIncidentsHandler, parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import { ZABBIX_MONITORING_CALLER_ID } from "../api/_lib/oneview-incidents-read-model.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const request = (query) => ({ query });

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(value) { this.body = value ? JSON.parse(value) : undefined; },
  };
}

test("OV-P0-317: manual exclui somente Zabbix Monitoring e sempre fica nos estados abertos", () => {
  assert.equal(ZABBIX_MONITORING_CALLER_ID, "aa62f29f47477610082e3d02e26d4358");
  const filters = parseIncidentFilters(request({ manual: "true", state: "6" }));
  assert.equal(filters.manual, true);
  assert.equal(filters.state, "1,2,3");
});

test("OV-P0-317: assigned_to não altera a classificação manual", async () => {
  const source = await read("api/_lib/oneview-incidents-read-model.js");
  const start = source.indexOf("if (filters.manual)");
  const end = source.indexOf("if (filters.caller_id)", start);
  const manualClause = source.slice(start, end);

  const automaticWithAnalyst = {
    caller_id: ZABBIX_MONITORING_CALLER_ID,
    assigned_to: "analyst-sys-id",
  };
  const manualWithAnalyst = {
    caller_id: "another-caller-sys-id",
    assigned_to: "analyst-sys-id",
  };
  const isManualByCaller = (row) => !row.caller_id || row.caller_id.toLowerCase() !== ZABBIX_MONITORING_CALLER_ID;

  assert.equal(isManualByCaller(automaticWithAnalyst), false);
  assert.equal(isManualByCaller(manualWithAnalyst), true);
  assert.match(manualClause, /caller_id is null or lower\(btrim\(caller_id::text\)\) <>/);
  assert.doesNotMatch(manualClause, /assigned_to/);
});

test("OV-P0-317: BFF encaminha manual ao read-model sem chamada ServiceNow", async () => {
  let received = null;
  const handler = createIncidentsHandler({
    authorize: async () => ({ id: "viewer" }),
    featureFlagProvider: () => true,
    readModelPage: async (filters) => {
      received = filters;
      return {
        items: [],
        pagination: { page: 1, page_size: 25, total_items: 0, total_pages: 0, has_next: false, has_previous: false },
        counts: { total: 0, open: 0, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 },
        facets: {},
      };
    },
    logger: () => undefined,
  });
  const res = response();
  await handler({ method: "GET", query: { manual: "true" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual([received.manual, received.state], [true, "1,2,3"]);
});

test("OV-P0-317: aba Manuais usa somente o BFF read-model e preserva ações do chamado", async () => {
  const [api, readModel, page, related, actions] = await Promise.all([
    read("api/_lib/oneview-incidents.js"),
    read("api/_lib/oneview-incidents-read-model.js"),
    read("src/pages/Chamados.tsx"),
    read("src/components/oneview/IncidentRelatedAlertSection.tsx"),
    read("src/components/oneview/IncidentActions.tsx"),
  ]);
  assert.match(api, /"manual"/);
  assert.match(readModel, /ZABBIX_MONITORING_CALLER_ID/);
  assert.match(readModel, /caller_id is null or lower\(btrim\(caller_id::text\)\) <>/);
  assert.doesNotMatch(readModel, /MANUAL_INCIDENT_CONTACT_TYPES/);
  assert.match(page, /label: "Manuais"/);
  assert.match(page, /manual: viewMode === "manual"/);
  assert.match(page, /Chamados manuais abertos/);
  assert.match(related, /Sem alerta relacionado/);
  assert.match(related, /Este chamado não possui correlação com um alerta do OneView\./);
  assert.match(actions, /Não há alerta relacionado a este chamado\./);
  assert.match(actions, /Assumir chamado/);
  assert.match(actions, /Adicionar anotação/);
  assert.match(actions, /Colocar em espera/);
});
