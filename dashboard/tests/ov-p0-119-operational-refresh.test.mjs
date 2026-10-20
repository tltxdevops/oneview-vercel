import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-119 aplica polling operacional pelo BFF sem perder estado local", async () => {
  const [api, home, monitoring, alerts, history, settings] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Settings.tsx"),
  ]);

  assert.match(api, /const API_BASE_URL = "\/api"/);
  assert.match(home, /SUMMARY_REFRESH_MS = 10_000/);
  assert.match(home, /LIST_REFRESH_MS = 10_000/);
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(alerts, /SUMMARY_REFRESH_MS = 30_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(history, /HISTORY_REFRESH_MS = 60_000/);
  assert.match(history, /tab === "eventos"\) void loadEvents\(\);\s*else void loadAlerts\(\)/);
  assert.match(settings, /SETTINGS_REFRESH_SECONDS = 60/);
  assert.match(settings, /if \(loadRequestRef\.current\) return loadRequestRef\.current/);
  assert.doesNotMatch(settings, /void loadPage\(\);\s*\}, \[loadPage\]\)/);

  assert.match(home, /facetsInFlight\.current/);
  assert.match(home, /criticalAlertsRequest\.current\?\.abort\(\)/);
  assert.match(monitoring, /if \(inFlight\.current\) \{\s*queryGenerationRef\.current\.deferCurrentIfDifferent\(\);\s*return inFlight\.current/);
  assert.match(alerts, /alertsRequestRef\.current\?\.abort\(\)/);
  assert.match(history, /eventsRequestRef\.current\?\.abort\(\)/);
  assert.match(history, /alertsRequestRef\.current\?\.abort\(\)/);
  assert.match(monitoring, /reconcileFreshAttention/);
  assert.match(alerts, /não limpa detail\/history/);
  assert.match(history, /não re-fetch em refresh da tabela/);

  for (const screen of [home, monitoring, alerts, history, settings]) {
    assert.match(screen, /from "@\/lib\/oneview-api"/);
    assert.doesNotMatch(screen, /\b(?:fetch|axios|XMLHttpRequest)\s*\(/);
  }

  const clientCode = `${api}\n${home}\n${monitoring}\n${alerts}\n${history}\n${settings}`;
  assert.doesNotMatch(clientCode, /https?:\/\/[^"'`\s]*(?:zabbix|servicenow)/i);
});
