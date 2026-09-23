/**
 * SN-P0-29 — autocomplete de busca em Chamados + normalização INC.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createIncidentSearchSuggestHandler } from "../api/_lib/oneview-incident-search-suggest.js";
import { INCIDENT_SUGGEST_QUERY_KEYS } from "../api/_lib/oneview-incidents.js";
import { searchReadModelIncidentSuggestions } from "../api/_lib/oneview-incidents-read-model.js";
import { matchRank, mergeRankedSuggestions } from "../api/_lib/oneview-search-suggest-rank.js";
import {
  INCIDENT_EXACT_NUMBER_SEARCH_RE,
  normalizeIncSearchDraft,
  resolveIncidentSearch,
} from "../src/lib/oneview-chamados-search.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(value) {
      this.body = value ? JSON.parse(value) : undefined;
    },
  };
}

function requestMock(query = {}, method = "GET") {
  return { method, query, headers: {} };
}

test("SN-P0-29 mergeRankedSuggestions prioriza prefixo e cliente", () => {
  assert.equal(matchRank("SANEPAR", "Sanep"), 0);
  const merged = mergeRankedSuggestions([
    { kind: "host", value: "host-x-sanep", label: "host-x-sanep" },
    { kind: "company", value: "SANEPAR", label: "SANEPAR" },
  ], "Sanep", 5);
  assert.equal(merged[0].kind, "company");
  assert.equal(merged[0].label, "SANEPAR");
});

test("SN-P0-29 normalizeIncSearchDraft — INC prefix", () => {
  assert.equal(normalizeIncSearchDraft("inc"), "INC");
  assert.equal(normalizeIncSearchDraft("inc008"), "INC008");
  assert.equal(normalizeIncSearchDraft("Inc0087484"), "INC0087484");
  assert.equal(normalizeIncSearchDraft("maps"), "maps");
  assert.equal(normalizeIncSearchDraft("87484"), "87484");
  assert.equal(normalizeIncSearchDraft("SANEPAR"), "SANEPAR");
});

test("SN-P0-29 resolveIncidentSearch — SN-P0-28 inalterado", () => {
  assert.ok(INCIDENT_EXACT_NUMBER_SEARCH_RE.test("inc0067312"));
  assert.deepEqual(resolveIncidentSearch("inc0067312"), { number: "INC0067312" });
  assert.deepEqual(resolveIncidentSearch("ICMP ping"), { search: "ICMP ping" });
  assert.deepEqual(resolveIncidentSearch("inc008"), { number: "INC008" });
});

test("SN-P0-29 allowlist inclui q e limit", () => {
  assert.ok(INCIDENT_SUGGEST_QUERY_KEYS.includes("q"));
  assert.ok(INCIDENT_SUGGEST_QUERY_KEYS.includes("limit"));
});

test("SN-P0-29 search-suggest handler — q curto rejeita", async () => {
  const handler = createIncidentSearchSuggestHandler({
    authorize: async () => ({ ok: true }),
    featureFlagProvider: () => true,
    suggest: async () => ({ suggestions: [] }),
  });
  const res = responseMock();
  await handler(requestMock({ q: "i" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error, "invalid_query");
});

test("SN-P0-29 search-suggest handler — retorna sugestões", async () => {
  const handler = createIncidentSearchSuggestHandler({
    authorize: async () => ({ ok: true }),
    featureFlagProvider: () => true,
    suggest: async (_filters, { q, limit }) => ({
      suggestions: [{ kind: "number", value: "INC001", label: "INC001", number: "INC001" }],
      q,
      limit,
    }),
  });
  const res = responseMock();
  await handler(requestMock({ q: "INC001", page: "1", page_size: "25" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.suggestions?.length, 1);
  assert.equal(res.body?.suggestions?.[0]?.value, "INC001");
});

test("SN-P0-29 read-model suggest — modo INC usa prefixo", async () => {
  const queries = [];
  const pool = {
    query: async (text, values) => {
      queries.push({ text: String(text), values });
      return {
        rows: [{
          number: "INC0087484",
          company_label: "Cliente X",
          short_description: "Host down",
        }],
      };
    },
  };
  const result = await searchReadModelIncidentSuggestions(
    { page: 1, page_size: 25, search: null, number: null },
    { q: "INC008", limit: 5, pool },
  );
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].kind, "number");
  assert.equal(result.suggestions[0].value, "INC0087484");
  assert.match(queries[0].text, /upper\(number::text\) like/i);
  assert.ok(queries[0].values.some((value) => String(value).includes("INC008")));
});

test("SN-P0-29 UI — Chamados usa autocomplete", async () => {
  const chamados = await read("src/pages/Chamados.tsx");
  assert.match(chamados, /ChamadosSearchField/);
  const searchField = await read("src/components/oneview/OneViewTableSearchField.tsx");
  assert.match(searchField, /HighlightLabel|Filtrar tabela por cliente/);
  assert.match(chamados, /oneview-chamados-search/);
  assert.match(chamados, /resolveIncidentSearch/);
});

test("SN-P0-29 API route search-suggest existe", async () => {
  const route = await read("api/oneview/incidents/search-suggest.js");
  assert.match(route, /oneview-incident-search-suggest/);
});

test("SN-P0-29 FE API client — search-suggest path", async () => {
  const api = await read("src/lib/oneview-api.ts");
  assert.match(api, /fetchIncidentSearchSuggestions/);
  assert.match(api, /oneViewIncidentSearchSuggestPath/);
  assert.match(api, /search-suggest/);
});
