import assert from "node:assert/strict";
import test from "node:test";

import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";
import { fetchReadModelIncidentsPage } from "../api/_lib/oneview-incidents-read-model.js";

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

function readOnlyPool(queries) {
  return {
    async query(sql, values = []) {
      queries.push({ sql: String(sql), values });
      if (String(sql).includes("select count(*)::int as total,")) {
        return { rows: [{ total: 0, open: 0, in_progress: 0, resolved: 0, closed: 0, unassigned: 0 }] };
      }
      if (String(sql).includes("select count(*)::int as total from")) return { rows: [{ total: 0 }] };
      return { rows: [] };
    },
  };
}

test("OV-P0-265: default /chamados filters do not hide contact types", () => {
  const filters = parseIncidentFilters(request());
  assert.equal(filters.contact_type, null);
  assert.equal(filters.caller_id, null);
  assert.equal(filters.company, null);
  assert.equal(filters.assignment_group, null);
});

test("OV-P0-265: contact type is explicit and supports blank channel", () => {
  assert.equal(parseIncidentFilters(request({ contact_type: "monitoring" })).contact_type, "monitoring");
  assert.equal(parseIncidentFilters(request({ contact_type: "__blank" })).contact_type, "__blank");
});

test("OV-P0-265: read-model SQL scopes channel only when requested", async () => {
  const defaultQueries = [];
  await fetchReadModelIncidentsPage(parseIncidentFilters(request()), {
    pool: readOnlyPool(defaultQueries),
    relatedAlertResolver: async () => new Map(),
  });
  assert.equal(defaultQueries.some(({ sql }) => /where\s+true\s+order by/i.test(sql)), true);
  assert.equal(defaultQueries.some(({ sql }) => /contact_type::text, ''\) = 'monitoring'/i.test(sql)), false);

  const filteredQueries = [];
  await fetchReadModelIncidentsPage(parseIncidentFilters(request({ contact_type: "monitoring" })), {
    pool: readOnlyPool(filteredQueries),
    relatedAlertResolver: async () => new Map(),
  });
  assert.equal(filteredQueries.some(({ sql, values }) => /lower\(coalesce\(contact_type::text, ''\)\)/i.test(sql) && values.includes("monitoring")), true);
});

test("OV-P0-265: duplicate scope remains intentionally monitoring-only", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../api/_lib/oneview-incident-duplicates.js", import.meta.url), "utf8"));
  assert.match(source, /coalesce\(contact_type::text, ''\) = 'monitoring'/);
});
