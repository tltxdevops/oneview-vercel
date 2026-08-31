/**
 * OV-P0-255 — refresh operacional 10s (Home, Monitoramento, Alertas, Operadoras).
 * Histórico 60s e Settings 60s permanecem. Sem reset de drawer/filtro/scroll/?alert=.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-255 intervalos: 10s nas quatro telas; Histórico/Settings mais lentos", async () => {
  const [home, monitoring, alerts, operators, history, settings] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Operadoras.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/pages/Settings.tsx"),
  ]);

  assert.match(home, /SUMMARY_REFRESH_MS = 10_000/);
  assert.match(home, /LIST_REFRESH_MS = 10_000/);
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(alerts, /SUMMARY_REFRESH_MS = 10_000/);
  assert.match(alerts, /ALERTS_REFRESH_MS = 10_000/);
  assert.match(operators, /OPERATORS_REFRESH_MS = 10_000/);

  assert.match(history, /HISTORY_REFRESH_MS = 60_000/);
  assert.match(settings, /SETTINGS_REFRESH_SECONDS = 60/);

  assert.doesNotMatch(home, /SUMMARY_REFRESH_MS = 30_000/);
  assert.doesNotMatch(monitoring, /REFRESH_MS = 30_000/);
  assert.doesNotMatch(alerts, /ALERTS_REFRESH_MS = 30_000/);
});

test("OV-P0-255 visibility: pausa hidden e refresh ao voltar", async () => {
  const [home, monitoring, alerts, operators] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Operadoras.tsx"),
  ]);

  for (const screen of [home, monitoring, alerts, operators]) {
    assert.match(screen, /if \(document\.hidden\) return/);
    assert.match(screen, /visibilitychange/);
  }
});

test("OV-P0-255 dedup: request equivalente não empilha; quiet não reseta UI", async () => {
  const [home, monitoring, alerts, operators] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Operadoras.tsx"),
  ]);

  assert.match(home, /if \(summaryInFlight\.current\) return summaryInFlight\.current/);
  assert.match(home, /mode === "quiet" && listsRequest\.current && !listsRequest\.current\.signal\.aborted/);
  assert.match(monitoring, /if \(inFlight\.current\) return inFlight\.current/);
  assert.match(alerts, /if \(summaryRequestRef\.current\) return summaryRequestRef\.current/);
  assert.match(alerts, /options\?\.quiet && alertsRequestRef\.current && !alertsRequestRef\.current\.signal\.aborted/);
  assert.match(operators, /mode === "quiet" && listRequest\.current && !listRequest\.current\.signal\.aborted/);

  assert.match(home, /loadSummary\("quiet"\)/);
  assert.match(home, /loadLists\("quiet"\)/);
  assert.match(alerts, /loadAlerts\(\{ quiet: true \}\)/);
  assert.match(operators, /loadQueue\("quiet"\)/);
  assert.match(operators, /enableAutoRefresh=\{false\}/);

  const quietQueue = operators.slice(
    operators.indexOf("const loadQueue"),
    operators.indexOf("const loadSelectedAlert"),
  );
  assert.doesNotMatch(quietQueue, /loadSelectedAlert|setSelectedAlertId|searchParams\.delete\("alert"\)/);
  assert.match(quietQueue, /if \(mode !== "quiet"\) setPayload\(null\)/);

  assert.match(alerts, /não limpa detail\/history/);
});
