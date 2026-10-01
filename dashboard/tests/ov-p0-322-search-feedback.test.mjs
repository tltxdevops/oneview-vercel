import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("OV-P0-322: campo compartilhado diferencia debounce, busca e sugestões", async () => {
  const field = await read("src/components/oneview/OneViewTableSearchField.tsx");
  assert.match(field, /activity\?: "idle" \| "pending" \| "searching"/);
  assert.match(field, /Preparando busca/);
  assert.match(field, /Buscando por/);
  assert.match(field, /aria-live="polite"/);
  assert.match(field, /CommandGroup heading="Pesquisar"/);
  assert.doesNotMatch(field, /CommandGroup heading="Ação rápida"/);
});

test("OV-P0-322: toolbar não repete refresh e páginas identificam somente a busca", async () => {
  const [toolbar, alerts, history, incidents, links] = await Promise.all([
    read("src/components/oneview/ConfigurableTableTools.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Operadoras.tsx"),
  ]);
  assert.match(toolbar, /searchActivity/);
  assert.doesNotMatch(toolbar, /animate-spin" \/>Atualizando/);
  for (const page of [alerts, history, links]) {
    assert.match(page, /SearchLoading/);
    assert.match(page, /searchActivity=/);
  }
  assert.match(incidents, /incidentSearchLoading/);
  assert.match(incidents, /activity=\{incidentSearchActivity\}/);
  assert.match(links, /OneViewQuietRefreshIndicator/);
  assert.doesNotMatch(links, /refreshing \? "Atualizando/);
});
