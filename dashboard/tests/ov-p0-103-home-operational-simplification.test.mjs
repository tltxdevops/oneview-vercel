/**
 * OV-P0-103 — Home Operational Simplification.
 * Janelas 30m|2h|8h|24h; severidade local; chamados sem responsável.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-103 Home windows: 30m|2h|8h|24h default 2h (isolado do Monitoramento)", async () => {
  const [home, index, recent, monitoring] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-recent.ts"),
    read("src/pages/Monitoring.tsx"),
  ]);

  assert.match(home, /HOME_OPERATIONAL_WINDOW_PRESETS/);
  assert.match(home, /DEFAULT_HOME_OPERATIONAL_WINDOW: HomeOperationalWindowPreset = "2h"/);
  assert.match(home, /"30m": 30 \* 60_000/);
  assert.match(home, /"2h": 2 \* 60 \* 60_000/);
  assert.match(home, /"8h": 8 \* 60 \* 60_000/);
  assert.match(home, /"24h": 24 \* 60 \* 60_000/);
  assert.doesNotMatch(home, /"15m":|"1h":|"6h":/);

  assert.match(index, /HOME_OPERATIONAL_WINDOW_OPTIONS\.map/);
  assert.match(index, /parseHomeOperationalWindow/);
  assert.match(index, /homeOperationalWindowMs/);
  assert.doesNotMatch(index, /HOME_WINDOW_OPTIONS\.map/);
  assert.doesNotMatch(index, /parseHomeWindow\(/);

  // oneview-recent mantém presets legados; Monitoring usa MONITOR_WINDOW_* (OV-P0-104).
  assert.match(recent, /"15m": 15 \* 60_000/);
  assert.match(recent, /"6h": 6 \* 60 \* 60_000/);
  assert.match(monitoring, /parseMonitorWindow|MONITOR_WINDOW_OPTIONS/);
});

test("OV-P0-103 Resumo operacional: filtro local toggle (sem /alertas)", async () => {
  const [home, index] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
  ]);

  assert.match(home, /export function toggleHomeSeverityFilter/);
  assert.match(index, /toggleHomeSeverityFilter|toggleSeverityStrip/);
  assert.match(index, /selected: severityFilter === severity/);
  assert.match(index, /onClick: \(\) => toggleSeverityStrip\(severity\)/);
  assert.doesNotMatch(index, /href: severityAlertsHref/);
  assert.doesNotMatch(index, /severityAlertsHref/);

  function toggleHomeSeverityFilter(current, next) {
    return current === next ? "all" : next;
  }
  assert.equal(toggleHomeSeverityFilter("all", "high"), "high");
  assert.equal(toggleHomeSeverityFilter("high", "high"), "all");
  assert.equal(toggleHomeSeverityFilter("high", "disaster"), "disaster");
});

test("OV-P0-103 Chamados sem responsável: unassigned + estados operacionais + teto 100", async () => {
  const [home, index, helper] = await Promise.all([
    read("src/lib/oneview-home.ts"),
    read("src/pages/Index.tsx"),
    read("src/lib/oneview-operational-incidents.ts"),
  ]);

  assert.match(home, /HOME_UNASSIGNED_OPERATIONAL_STATES = OPERATIONAL_INCIDENT_STATES/);
  assert.match(helper, /unassigned: mode === INCIDENTS_QUEUE_MODE\.unassigned \? true : undefined/);
  assert.match(helper, /OPERATIONAL_INCIDENT_STATES = "1,2,3"/);
  assert.match(home, /prioritizeHomeUnassignedIncidents/);
  assert.match(home, /buildHomeUnassignedChamadosHref/);
  assert.match(helper, /return "\/chamados\?unassigned=true"/);
  assert.match(home, /HOME_INCIDENTS_PAGE_SIZE = OPERATIONAL_INCIDENTS_PAGE_SIZE/);
  assert.match(helper, /OPERATIONAL_INCIDENTS_PAGE_SIZE = 100/);

  assert.match(index, /Chamados sem responsável/);
  assert.match(index, /buildHomeChamadosHref|buildHomeUnassignedChamadosHref/);
  assert.match(index, /Nenhum chamado monitoring sem responsável/);
  assert.match(index, /AlertDetailDrawer/);
  assert.doesNotMatch(index, /to="\/chamados"/);

  // Não altera fetch de /chamados com helpers da Home.
  const chamados = await read("src/pages/Chamados.tsx");
  assert.doesNotMatch(chamados, /HOME_UNASSIGNED_OPERATIONAL_STATES|fetchHomeIncidents/);
});

test("OV-P0-103 prioritizeHomeUnassignedIncidents: Novo/Em andamento primeiro; exclui 6/7", () => {
  function prioritizeHomeUnassignedIncidents(items) {
    const CLOSED = new Set(["6", "7"]);
    const rank = (state) => {
      if (state === "1") return 0;
      if (state === "2") return 1;
      if (state === "3") return 2;
      return 9;
    };
    return items
      .filter((item) => !CLOSED.has(String(item.state || "").trim()))
      .sort((left, right) => {
        const diff = rank(String(left.state || "").trim()) - rank(String(right.state || "").trim());
        if (diff !== 0) return diff;
        return Date.parse(String(right.opened_at || "")) - Date.parse(String(left.opened_at || ""));
      });
  }

  const sorted = prioritizeHomeUnassignedIncidents([
    { number: "INC3", state: "3", opened_at: "2026-08-01T10:00:00Z" },
    { number: "INC6", state: "6", opened_at: "2026-08-02T10:00:00Z" },
    { number: "INC2", state: "2", opened_at: "2026-08-01T12:00:00Z" },
    { number: "INC1b", state: "1", opened_at: "2026-08-01T09:00:00Z" },
    { number: "INC1a", state: "1", opened_at: "2026-08-01T11:00:00Z" },
    { number: "INC7", state: "7", opened_at: "2026-08-03T10:00:00Z" },
  ]);

  assert.deepEqual(
    sorted.map((item) => item.number),
    ["INC1a", "INC1b", "INC2", "INC3"],
  );
});
