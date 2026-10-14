import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fetchReadModelIncidentsPage } from "../api/_lib/oneview-incidents-read-model.js";
import { parseIncidentFilters } from "../api/_lib/oneview-incidents.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Chamados metadata-only skips page, pagination count and SLA reads", async () => {
  const filters = parseIncidentFilters({ query: {
    page: "1",
    page_size: "25",
    include_items: "false",
    include_counts: "false",
    include_global_counts: "false",
    include_facets: "false",
  } });
  const queries = [];
  const pool = {
    async query(text) {
      queries.push(String(text));
      return { rows: [] };
    },
  };

  const payload = await fetchReadModelIncidentsPage(filters, { pool });

  assert.deepEqual(payload.items, []);
  assert.equal(payload.pagination.total_items, 0);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /servicenow_sync_state/);
  assert.doesNotMatch(queries.join("\n"), /task_sla|count\(\*\).*servicenow_incidents|select[\s\S]*from servicenow_incidents/i);
});

test("frontend asks metadata without duplicating incident rows", async () => {
  const [api, chamados] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("src/pages/Chamados.tsx"),
  ]);
  assert.match(api, /includeItems\?: boolean/);
  assert.match(api, /include_items", "false"/);
  assert.match(chamados, /includeItems: false/);
});

test("Alerts list request is stable across health and loaded-state updates", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const loadBlock = alerts.match(/const loadAlerts[\s\S]*?const loadSummaryResources/)?.[0] ?? "";
  assert.match(loadBlock, /healthRef\.current/);
  assert.doesNotMatch(loadBlock, /\[.*hasLoadedAlerts.*health.*\]/s);
  assert.match(loadBlock, /setAlertsError\(null\)/);
});

test("Runtime Health strip uses summary view, pauses hidden tabs and keeps full Settings detail", async () => {
  const [api, config, db, strip, settings] = await Promise.all([
    read("src/lib/oneview-api.ts"),
    read("api/_lib/oneview-config.js"),
    read("api/_lib/oneview-db.js"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
    read("src/pages/Settings.tsx"),
  ]);
  assert.match(api, /runtime-health\?view=summary/);
  assert.match(config, /"runtime-health"[\s\S]*query: \["view"\]/);
  assert.match(db, /summaryOnly: view === "summary"/);
  assert.match(db, /summaryOnly \? Promise\.resolve\(null\) : queryRow/);
  assert.match(strip, /REFRESH_MS = 60_000/);
  assert.match(strip, /if \(document\.hidden\) return/);
  assert.match(strip, /visibilitychange/);
  assert.match(settings, /fetchRuntimeHealth\(\)/);
});

test("closed or background alert drawer does not keep source detail polling", async () => {
  const hook = await read("src/hooks/useAlertDrawerLiveRefresh.ts");
  assert.match(hook, /!document\.hidden && shouldPollAlertDrawer/);
  assert.match(hook, /return \(\) => poller\.abort\(\)/);
});
