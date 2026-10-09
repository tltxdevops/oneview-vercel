import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDuplicateFilters } from "../api/_lib/oneview-incident-duplicates.js";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";

const request = (query = {}) => ({ method: "GET", query, headers: {} });

test("Chamados aceita clientes repetidos, deduplica e preserva compatibilidade", () => {
  const filters = parseIncidentFilters(request({
    company: ["Ailos", "Sanepar", "ailos", "Congás"],
  }));

  assert.deepEqual(filters.companies, ["Ailos", "Sanepar", "Congás"]);
  assert.equal(filters.company, "Ailos");
});

test("Duplicados usa o mesmo escopo multicliente", () => {
  const filters = parseDuplicateFilters(request({
    customer: ["Ailos", "Sanepar", "AILOS"],
  }));

  assert.deepEqual(filters.companies, ["Ailos", "Sanepar"]);
  assert.equal(filters.company, "Ailos");
});

test("UI usa combobox multiseleção, remove Canal/Caller e iguala fundo de Ações", async () => {
  const source = await readFile(new URL("../src/pages/Chamados.tsx", import.meta.url), "utf8");

  assert.match(source, /<ClientFilterCombobox/);
  assert.match(source, /selectedKeys=\{draft\.companies\}/);
  assert.match(source, /companies:\s*uniqueCompanies\(\[\.\.\.draft\.companies, suggestion\.value\]\)/);
  assert.doesNotMatch(source, />\s*Canal\s*</);
  assert.doesNotMatch(source, />\s*Caller\s*</);
  assert.match(source, /column\.id === "actions" && "sticky right-0 z-20 bg-inherit text-center"/);
  assert.match(source, /className="sticky right-0 z-10 bg-inherit/);
});

test("API envia um company por cliente e SQL combina seleções por OR", async () => {
  const [api, readModel] = await Promise.all([
    readFile(new URL("../src/lib/oneview-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../api/_lib/oneview-incidents-read-model.js", import.meta.url), "utf8"),
  ]);

  assert.match(api, /for \(const company of companies\) search\.append\("company", company\)/);
  assert.match(readModel, /companyFilters\.flatMap/);
  assert.match(readModel, /companyClauses\.join\(" or "\)/);
});
