import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-326 search is local-first, bounded, cached and abortable", async () => {
  const field = await read("src/components/oneview/OneViewTableSearchField.tsx");
  assert.match(field, /localSuggestions\?: OneViewSearchSuggestion\[\]/);
  assert.match(field, /CACHE_TTL_MS = 30_000/);
  assert.match(field, /CACHE_MAX = 64/);
  assert.match(field, /abortRef\.current\?\.abort\(\)/);
  assert.match(field, /cacheKey\.startsWith\(key\)/);
  assert.match(field, /Aplicar Cliente/);
  assert.match(field, /Selecionado/);
  assert.match(field, />\s*Cliente\s*</);
  assert.match(field, /aria-label=\{`\$\{isClient \? "Cliente"/);
  assert.match(field, /event\.key === "ArrowDown"/);
  assert.match(field, /orderedSuggestions\[activeSuggestionIndex\]/);
  assert.match(field, /relative block w-full min-w-0/);
  assert.match(field, /h-9 w-full min-w-0 pl-9/);
});

test("OV-P0-326 Alerts applies client autocomplete additively and severity is multi-select", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /current\.includes\(suggestion\.customer_key!\)/);
  assert.match(alerts, /\[\.\.\.current, suggestion\.customer_key!\]/);
  assert.match(alerts, /isSearchSuggestionSelected/);
  assert.match(alerts, /repita para adicionar outros/);
  assert.match(alerts, /OperationalFacetMultiSelect/);
  assert.match(alerts, /gridClassName="lg:grid-cols-3"/);
  assert.match(alerts, /gridClassName="lg:grid-cols-4"/);
  assert.match(alerts, /lg:col-span-2">Analista do ACK/);
  assert.match(alerts, /triggerClassName="h-9 w-full min-w-0 max-w-none/);
  assert.doesNotMatch(alerts, /ZabbixSourceFilter|Campo de data|selectedDatasources/);
});

test("OV-P0-326 filter trigger forwards Radix interaction props", async () => {
  const panel = await read("src/components/oneview/OperationalFilterPanel.tsx");
  assert.match(panel, /forwardRef<HTMLButtonElement, FilterTriggerProps>/);
  assert.match(panel, /ref=\{ref\}/);
  assert.match(panel, /\{\.\.\.props\}/);
  assert.match(panel, /<PopoverTrigger asChild><FilterTrigger/);
});

test("OV-P0-326 alert suggestions match each bucket against its own field", async () => {
  const bff = await read("api/_lib/oneview-alerts-search-suggest.js");
  assert.match(bff, /runBucket\("customer", CUSTOMER_EXPR, CUSTOMER_EXPR/);
  assert.match(bff, /runBucket\("host", HOST_EXPR, HOST_EXPR/);
  assert.match(bff, /runBucket\("problem", PROBLEM_EXPR, PROBLEM_EXPR/);
  assert.doesNotMatch(bff, /const textMatch/);
  assert.match(bff, /Server-Timing/);
});
