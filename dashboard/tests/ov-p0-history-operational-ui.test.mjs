import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const historyPath = new URL("../src/pages/Historico.tsx", import.meta.url);

async function readHistory() {
  return readFile(historyPath, "utf8");
}

test("Histórico usa tabs e quick filters oficiais sem criar variante visual local", async () => {
  const source = await readHistory();

  assert.match(source, /clientSelect=\{<SectionAccentTitle level=\{1\}>Histórico<\/SectionAccentTitle>\}/);
  assert.match(source, /TabsTrigger value="alertas">Alertas/);
  assert.match(source, /TabsTrigger value="eventos">Eventos/);
  assert.match(source, /HISTORY_RISK_PRESETS\.map/);
  assert.match(source, /<OneViewPill/);
  assert.match(source, /selected=\{risk === preset\.value\}/);
  assert.doesNotMatch(source, /rounded-\[|bg-gradient|shadow-(?:sm|md|lg|xl|2xl)|text-\[|text-xs|text-sm/);
});

test("Histórico mantém Cliente, Busca, Período e Mais filtros na barra principal", async () => {
  const source = await readHistory();

  assert.match(source, /className="ov-control-official h-9"/);
  assert.match(source, /placeholder="Buscar host, problema ou cliente"/);
  assert.match(source, /Filtrar por período/);
  assert.match(source, /Mais filtros/);
  assert.match(source, /aria-expanded=\{filtersOpen\}/);
  assert.match(source, /historico-alertas-mais-filtros/);
  assert.match(source, /Fonte Zabbix/);
  assert.match(source, />Severidade<\/Label>/);
  assert.match(source, />Estado<\/Label>/);
  assert.match(source, />ACK<\/Label>/);
});

test("Histórico expõe filtros ativos removíveis e tabela operacional responsiva", async () => {
  const source = await readHistory();

  assert.match(source, /aria-label="Filtros ativos"/);
  assert.match(source, /Remover filtro \$\{filter\.label\}/);
  assert.match(source, />Limpar todos<\/OneViewTextAction>/);
  assert.match(source, /Table className="ov-operational-table table-fixed"/);
  assert.match(source, /hidden[^"\n]*xl:table-cell/);
  assert.match(source, /status=\{alertStatusLabel\(alert\) === "Ativo" \? "monitoring-down" : "monitoring-normalized"\}/);
  assert.match(source, /status="incident-waiting" label="Pendente"/);
  assert.match(source, /status="incident-resolved" label="Reconhecido"/);
});

test("migração visual preserva consultas, paginação, risco, ACK e drawer", async () => {
  const source = await readHistory();

  assert.match(source, /fetchAlerts\(request\)/);
  assert.match(source, /fetchGlobalHistory\(\{/);
  assert.match(source, /applyHistoryRiskPreset/);
  assert.match(source, /acknowledgedSource/);
  assert.match(source, /pageSize: PAGE_SIZE/);
  assert.match(source, /AlertDetailDrawer/);
  assert.match(source, /defaultTab="history"/);
  assert.doesNotMatch(source, /fetch\(|axios|\.css"/);
});
