/**
 * Home / Monitoramento — fila de chamados rica:
 * Sem responsável / Com analista / Todos, multi-select, janela em todos os modos.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

const INCIDENTS_QUEUE_MODE = { unassigned: "unassigned", assigned: "assigned", all: "all" };
const SAFE_SYS_ID = /^[a-f0-9]{32}$/i;
const ANALYST_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ANALYST_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function parseIncidentsQueueMode(value) {
  if (value === INCIDENTS_QUEUE_MODE.assigned) return INCIDENTS_QUEUE_MODE.assigned;
  if (value === INCIDENTS_QUEUE_MODE.all) return INCIDENTS_QUEUE_MODE.all;
  return INCIDENTS_QUEUE_MODE.unassigned;
}

function parseAssignedToSysIds(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const seen = new Set();
  for (const token of raw.split(",")) {
    const id = token.trim().toLowerCase();
    if (!SAFE_SYS_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
  }
  return [...seen];
}

function openedFromForWindow(windowMs, now = Date.now()) {
  const start = new Date(now - Math.max(Number(windowMs) || 0, 0));
  if (Number.isNaN(start.getTime())) return new Date(now).toISOString().slice(0, 10);
  return start.toISOString().slice(0, 10);
}

function buildOperationalChamadosHref(params) {
  const mode = parseIncidentsQueueMode(params?.mode);
  if (mode === INCIDENTS_QUEUE_MODE.unassigned) return "/chamados?unassigned=true";
  const assignedTo = parseAssignedToSysIds(params?.assignedTo).join(",");
  if (!assignedTo) return "/chamados";
  return `/chamados?assigned_to=${encodeURIComponent(assignedTo)}`;
}

function applyIncidentsQueueToSearchParams(params, mode, assignedTo) {
  const ids = mode === INCIDENTS_QUEUE_MODE.unassigned ? [] : parseAssignedToSysIds(assignedTo);
  if (mode === INCIDENTS_QUEUE_MODE.unassigned) {
    params.delete("incidents");
    params.delete("assigned_to");
    return;
  }
  params.set("incidents", mode);
  if (ids.length) params.set("assigned_to", ids.join(","));
  else params.delete("assigned_to");
}

test("fila operacional: 3 coberturas, CSV de sys_id, janela em todos os modos", () => {
  assert.equal(parseIncidentsQueueMode(null), "unassigned");
  assert.equal(parseIncidentsQueueMode("assigned"), "assigned");
  assert.equal(parseIncidentsQueueMode("all"), "all");
  assert.equal(parseIncidentsQueueMode("nope"), "unassigned");

  assert.deepEqual(parseAssignedToSysIds(`${ANALYST_A},${ANALYST_B},lixo`), [ANALYST_A, ANALYST_B]);
  assert.deepEqual(parseAssignedToSysIds("not-a-sys-id"), []);

  const now = Date.parse("2026-08-31T15:00:00.000Z");
  assert.equal(openedFromForWindow(2 * 60 * 60_000, now), "2026-08-31");
  assert.equal(openedFromForWindow(24 * 60 * 60_000, now), "2026-08-30");

  assert.equal(buildOperationalChamadosHref({ mode: "unassigned" }), "/chamados?unassigned=true");
  assert.equal(buildOperationalChamadosHref({ mode: "assigned" }), "/chamados");
  assert.equal(buildOperationalChamadosHref({ mode: "all" }), "/chamados");
  assert.equal(
    buildOperationalChamadosHref({ mode: "assigned", assignedTo: [ANALYST_A, ANALYST_B] }),
    `/chamados?assigned_to=${ANALYST_A}%2C${ANALYST_B}`,
  );

  const defaultUrl = new URLSearchParams("window=2h");
  applyIncidentsQueueToSearchParams(defaultUrl, "unassigned", [ANALYST_A]);
  assert.equal(defaultUrl.get("incidents"), null);
  assert.equal(defaultUrl.get("assigned_to"), null);

  const allUrl = new URLSearchParams();
  applyIncidentsQueueToSearchParams(allUrl, "all", [ANALYST_A, ANALYST_B]);
  assert.equal(allUrl.get("incidents"), "all");
  assert.equal(allUrl.get("assigned_to"), `${ANALYST_A},${ANALYST_B}`);
});

test("helper compartilhado: janela sempre; has_assignee / include_unassigned conforme cobertura", async () => {
  const helper = await read("src/lib/oneview-operational-incidents.ts");

  assert.match(helper, /OPERATIONAL_INCIDENTS_PAGE_SIZE = 100/);
  assert.match(helper, /INCIDENTS_QUEUE_MODE = \{[\s\S]*all: "all"/);
  assert.match(helper, /unassigned: mode === INCIDENTS_QUEUE_MODE\.unassigned \? true : undefined/);
  assert.match(helper, /hasAssignee: mode === INCIDENTS_QUEUE_MODE\.assigned && !assignedCsv \? true : undefined/);
  assert.match(helper, /includeUnassigned: mode === INCIDENTS_QUEUE_MODE\.all && Boolean\(assignedCsv\) \? true : undefined/);
  assert.match(helper, /const openedFrom = params\?\.windowMs/);
  assert.doesNotMatch(helper, /showAnalysts && params\?\.windowMs/);
});

test("Home e Monitoramento: 3 modos, multi-select e janela", async () => {
  const [index, monitoring, toolbar, chamados, bff, api, readModel] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/oneview/OperationalIncidentsToolbar.tsx"),
    read("src/pages/Chamados.tsx"),
    read("api/_lib/oneview-incidents.js"),
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-incidents-read-model.js"),
  ]);

  assert.match(toolbar, /Sem responsável/);
  assert.match(toolbar, /Com analista/);
  assert.match(toolbar, /Todos/);
  assert.match(toolbar, /Analistas ·/);
  assert.match(toolbar, /Buscar analista/);
  assert.match(toolbar, /onAssignedToChange: \(assignedTo: string\[\]\)/);

  assert.match(index, /parseAssignedToSysIds/);
  assert.match(index, /Chamados sem responsável/);
  assert.match(index, /Chamados em acompanhamento/);
  assert.match(index, /title=\{incidentsPanelTitle\}/);

  assert.match(monitoring, /parseAssignedToSysIds/);
  assert.match(monitoring, /OperationalIncidentsToolbar/);

  assert.match(chamados, /parseAssignedToSysIds\(searchParams\.get\("assigned_to"\)\)/);

  assert.match(bff, /"has_assignee"/);
  assert.match(bff, /"include_unassigned"/);
  assert.match(bff, /export function parseAssignedToFilter/);
  assert.match(api, /hasAssignee/);
  assert.match(api, /includeUnassigned/);
  assert.match(api, /has_assignee/);
  assert.match(readModel, /filters\.include_unassigned/);
  assert.match(readModel, /filters\.has_assignee/);
  assert.match(readModel, /lower\(assigned_to::text\) = any\(/);
});
