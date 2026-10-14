import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOneViewQueryGeneration } from "../src/lib/oneview-query-generation.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0 go-live: erro de rota/drawer não derruba a aplicação e retry existe", async () => {
  const [boundary, app, alertDrawer, incidentDrawer, pkg] = await Promise.all([
    read("src/components/oneview/OneViewErrorBoundary.tsx"),
    read("src/App.tsx"),
    read("src/components/oneview/AlertDetailDrawer.tsx"),
    read("src/components/oneview/IncidentDetailDrawer.tsx"),
    read("package.json"),
  ]);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /Tentar novamente/);
  assert.match(boundary, /scope === "drawer"/);
  assert.doesNotMatch(boundary, /stack/);
  assert.doesNotMatch(boundary, /error\.message/);
  assert.match(app, /scope="global"/);
  assert.match(app, /scope="route"/);
  assert.match(app, /route\(<SettingsPage \/>\)/);
  assert.match(alertDrawer, /scope="drawer"/);
  assert.match(incidentDrawer, /scope="drawer"/);
  const scripts = JSON.parse(pkg).scripts;
  assert.match(scripts.typecheck, /tsc --noEmit/);
  assert.match(scripts.build, /npm run typecheck/);
  assert.match(scripts.build, /npm run test:go-live-p0/);
  assert.match(scripts.build, /vite\.js build|vite build/);
  assert.doesNotMatch(scripts.build, /continue-on-error/);
});

test("OV-P0 go-live: 503 / abort / keep-last payload / concorrência", async () => {
  const [api, chamados, alerts, monitoring, settings, main, serverAuth, incidents, response] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Chamados.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Settings.tsx"),
    read("src/main.tsx"),
    read("src/lib/server-auth.ts"),
    read("api/_lib/oneview-incidents.js"),
    read("api/_lib/oneview-response.js"),
  ]);
  assert.match(api, /export function isOneViewAbortError/);
  assert.doesNotMatch(api, /oneViewFresh && cached && cached.expiresAt > Date.now\(\)\) return cached.value/);
  assert.doesNotMatch(api, /if \(cached && cached.expiresAt > now\)/);
  assert.match(chamados, /Atualização falhou — exibindo último dado disponível/);
  assert.doesNotMatch(chamados, /setDuplicatesPayload\(null\)/);
  assert.match(chamados, /if \(payloadRef.current\) setRefreshing\(true\)/);
  assert.match(chamados, /duplicatesLoading && !duplicatesPayload\?\.groups\?\.length/);
  assert.match(alerts, /controller.signal.aborted \|\| isOneViewAbortError/);
  assert.match(alerts, /onRetry=\{\(\) => void loadAlerts\(\)\}/);
  assert.match(alerts, /setAlertsError\(null\)/);
  assert.doesNotMatch(alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "", /hasLoadedAlerts, health/);
  assert.match(monitoring, /(?:inFlightGeneration\(\) === generation.peek\(\)|queryGenerationRef\.current\.inFlightGeneration\(\) === queryGenerationRef\.current\.peek\(\))/);
  assert.match(monitoring, /isOneViewAbortError/);
  assert.match(settings, /OperationalErrorBanner/);
  assert.match(settings, /Atualização falhou — exibindo último dado disponível/);
  assert.match(main, /\/api\/auth\/config/);
  assert.match(main, /controller.abort\(\), 15_000\)/);
  assert.match(serverAuth, /AUTH_FETCH_TIMEOUT_MS = 15_000/);
  assert.match(serverAuth, /\/auth\/me/);
  assert.doesNotMatch(incidents, /error\?\.message/);
  assert.doesNotMatch(incidents, /oneview_incidents_error/);
  assert.match(incidents, /error_class: "http_5xx"/);
  assert.match(response, /error_class: requestErrorClass/);
  assert.match(response, /status: Number.isInteger\(code\) \? code : 0/);
});

test("OV-P0 go-live: geração descarta resposta stale e polling reusa o mesmo request", () => {
  const gen = createOneViewQueryGeneration();
  const first = gen.begin();
  assert.equal(gen.isCurrent(first), true);
  assert.equal(gen.inFlightGeneration(), first);
  const next = gen.advance();
  assert.equal(gen.isCurrent(first), false);
  assert.equal(gen.peek(), next);
  assert.notEqual(gen.inFlightGeneration(), gen.peek());
  const started = gen.begin();
  assert.equal(started, next);
  assert.equal(gen.inFlightGeneration(), gen.peek());
});
