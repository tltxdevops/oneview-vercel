import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { mergeRankedSuggestions } from "../api/_lib/oneview-search-suggest-rank.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("OV-P0-323: busca livre de cliente consulta todas as identidades do cliente", () => {
  const built = buildAlertListQuery({ query: { page: "1", page_size: "50", search_field: "customer", search: "Sanepar" } });
  assert.match(built.whereSql, /coalesce\(a\.customer_name, ''\) ilike/);
  assert.match(built.whereSql, /coalesce\(a\.client_name, ''\) ilike/);
  assert.match(built.whereSql, /coalesce\(a\.customer_key, ''\) ilike/);
  assert.equal(built.params.at(-1), "%Sanepar%");
  const all = buildAlertListQuery({ query: { page: "1", page_size: "50", search: "maps" } });
  assert.doesNotMatch(all.whereSql, /\$\{SAFE_CUSTOMER_NAME_SQL\}/);
  assert.match(all.whereSql, /case[\s\S]*customer_name/);
});

test("OV-P0-323: sugestão Cliente preserva customer_key canônica", () => {
  const suggestions = mergeRankedSuggestions([
    { kind: "customer", value: "Congás", label: "Congás", customer_key: "solarwinds" },
    { kind: "customer", value: "Sanepar", label: "Sanepar", customer_key: "sanepar" },
  ], "san");
  assert.equal(suggestions.find((item) => item.value === "Sanepar")?.customer_key, "sanepar");
});

test("OV-P0-323: escolha de Cliente aplica filtro estruturado e não texto amplo", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /onSearchSuggestionPick/);
  assert.match(alerts, /suggestion\.kind === "customer" && suggestion\.customer_key/);
  assert.match(alerts, /setSelectedCustomerKeys\(\[suggestion\.customer_key\]\)/);
  assert.match(alerts, /setSearchQuery\(""\)/);
});

test("OV-P0-323: sugestão BFF retorna chave e MAPS não usa N+1", async () => {
  const [suggest, db] = await Promise.all([
    read("api/_lib/oneview-alerts-search-suggest.js"),
    read("api/_lib/oneview-db.js"),
  ]);
  assert.match(suggest, /SAFE_CUSTOMER_KEY_SQL/);
  assert.match(suggest, /customer_key: kind === "customer"/);
  assert.doesNotMatch(db, /Promise\.all\(targets\.map/);
  assert.match(db, /unnest\(\$1::text\[\], \$2::text\[\]\)/);
  assert.match(db, /maps_servicenow_list_enrichment_failed/);
});
