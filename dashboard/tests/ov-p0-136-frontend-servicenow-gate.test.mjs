import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-P0-136 Chamados não depende de flag Vite e BFF preserva kill-switch runtime", async () => {
  const [index, sidebar, app, monitoring, relatedIncidents, incidentsBff] = await Promise.all([
    read("src/pages/Index.tsx"),
    read("src/components/layout/Sidebar.tsx"),
    read("src/App.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/components/oneview/AlertRelatedIncidentsSection.tsx"),
    read("api/_lib/oneview-incidents.js"),
  ]);

  const frontend = [index, sidebar, monitoring, relatedIncidents].join("\n");
  assert.doesNotMatch(frontend, /isServiceNowIncidentsUiEnabled|snIncidentsEnabled|import\.meta\.env\.VITE_SERVICENOW_INCIDENTS_ENABLED/);
  assert.doesNotMatch(index, /Chamados ServiceNow não estão habilitados neste ambiente\./);
  assert.match(index, /fetchHomeIncidents/);
  assert.match(index, /incidentLoadErrorMessage\(incidentsResult\?\.reason\)/);
  assert.match(index, /Sua sessão expirou\. Entre novamente\./);
  assert.match(sidebar, /href: "\/chamados"/);
  assert.match(app, /path="\/chamados"/);
  assert.match(incidentsBff, /booleanFlag\(env\.SERVICENOW_INCIDENTS_ENABLED, false\)/);
  assert.match(incidentsBff, /error: "servicenow_incidents_disabled"/);
});
