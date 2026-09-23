import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createIncidentsHandler, parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import {
  EXCLUDED_ASSIGNMENT_GROUP_IDS,
  TENABLE_INTEGRATION_CALLER_ID,
  ZABBIX_MONITORING_CALLER_ID,
  fetchReadModelIncidentsPage,
} from "../api/_lib/oneview-incidents-read-model.js";

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

test("OV-P0-317: Chamados exclui Tenable e grupos antes de lista, filtros e totais", async () => {
  const [source, duplicates, page] = await Promise.all([
    read("api/_lib/oneview-incidents-read-model.js"),
    read("api/_lib/oneview-incident-duplicates.js"),
    read("src/pages/Chamados.tsx"),
  ]);
  assert.equal(TENABLE_INTEGRATION_CALLER_ID, "150f6c0887cf8b10d5fd84c30cbb354c");
  assert.deepEqual(EXCLUDED_ASSIGNMENT_GROUP_IDS, [
    "fa5a17eb47fa47106b618ca2036d43b0",
    "9f0a34be47622610082e3d02e26d43ab",
    "fa7a932f47fa47106b618ca2036d43b1",
  ]);
  assert.match(source, /caller_id is null or lower\(btrim\(caller_id::text\)\) <> \$\{addParam\(values, TENABLE_INTEGRATION_CALLER_ID\)\}/);
  assert.match(source, /EXCLUDED_ASSIGNMENT_GROUP_IDS/);
  assert.match(source, /fetchCounts\(pool, effectiveFilters\)/);
  assert.match(source, /fetchFacets\(pool, effectiveFilters\)/);
  assert.match(source, /fetchGlobalCounts\(pool\)/);
  assert.match(source, /global_counts:/);
  assert.match(duplicates, /TENABLE_INTEGRATION_CALLER_ID/);
  assert.match(duplicates, /EXCLUDED_ASSIGNMENT_GROUP_IDS/);
  assert.match(duplicates, /caller_id is null or lower\(btrim\(caller_id::text\)\) <>/);
  assert.match(page, /const globalCounts = payload\?\.global_counts/);
  assert.match(page, /safeCount\(globalCounts\?\.manual\)/);
  assert.match(page, /setViewMode\("list"\);/);
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

test("OV-P0-317: clique de KPI preserva regra manual e pula somente metadados redundantes", async () => {
  const filters = parseIncidentFilters(request({
    manual: "true",
    include_counts: "false",
    include_global_counts: "false",
    include_facets: "false",
  }));
  assert.deepEqual(
    [filters.manual, filters.state, filters.include_counts, filters.include_global_counts, filters.include_facets],
    [true, "1,2,3", false, false, false],
  );

  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("servicenow_sync_state")) return { rows: [] };
      if (sql.includes("select count(*)::int as total")) return { rows: [{ total: 0 }] };
      if (sql.includes("from servicenow_incidents")) return { rows: [] };
      throw new Error("unexpected query");
    },
  };
  const page = await fetchReadModelIncidentsPage(filters, { pool });
  assert.equal(page.pagination.total_items, 0);
  assert.equal("counts" in page, false);
  assert.equal("global_counts" in page, false);
  assert.equal("facets" in page, false);
  assert.equal(queries.some((sql) => sql.includes("count(*) filter") || sql.includes("group by")), false);

  const source = await read("src/pages/Chamados.tsx");
  assert.match(source, /includeGlobalCounts: includeMetadata/);
  assert.match(source, /applyFilters\(next, "metric"\)/);
  assert.match(source, /global_counts: response\.global_counts \?\? previous\?\.global_counts/);
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
