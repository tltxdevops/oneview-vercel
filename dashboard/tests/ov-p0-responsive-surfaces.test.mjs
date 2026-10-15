import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("cancelable GET requests are never shared across mounted screens", async () => {
  const api = await read("src/lib/oneview-api.ts");
  assert.match(api, /export function canShareOneViewRead\(init\?: RequestInit\)/);
  assert.match(api, /&& !init\?\.signal/);
  assert.match(api, /const shared = canShare \? inFlightReads\.get\(key\) : undefined/);
  assert.match(api, /if \(canShare\) inFlightReads\.set\(key, request\)/);
  assert.match(api, /if \(canShare\) inFlightReads\.delete\(key\)/);
});

test("Alerts removes Fonte Zabbix and date-field controls while preserving canonical source details", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  assert.doesNotMatch(alerts, /ZabbixSourceFilter|mergeOperationalZabbixSourceFilterOptions|datasources: selectedDatasources|Campo de data/);
  assert.match(alerts, /dateField: "first_seen"/);
  assert.match(drawer, /Fonte Zabbix/);
});

test("Operational filters adapt between wide desktop popover and compact bottom sheet", async () => {
  const panel = await read("src/components/oneview/OperationalFilterPanel.tsx");
  const tools = await read("src/components/oneview/ConfigurableTableTools.tsx");
  assert.match(panel, /side="bottom"/);
  assert.match(panel, /max-h-\[82dvh\]/);
  assert.match(panel, /overlayClassName="bg-black\/40"/);
  assert.match(panel, /COMPACT_FILTER_BREAKPOINT = 1024/);
  assert.match(panel, /align="end"/);
  assert.match(panel, /width: "min\(58rem, calc\(100vw - 2rem\)\)"/);
  assert.match(panel, /maxHeight: "min\(78dvh, var\(--radix-popover-content-available-height\)\)"/);
  assert.match(panel, /grid min-w-0 grid-cols-1 items-end/);
  assert.match(tools, /OperationalFilterPanel/);
  assert.match(tools, /lg:grid-cols-\[minmax\(18rem,1fr\)_auto\]/);
});

test("operational lists use responsive column metadata and do not render ServiceNow errors inside table cells", async () => {
  const [chamados, alerts, history, actions] = await Promise.all([
    read("src/pages/Chamados.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/IncidentActions.tsx"),
  ]);
  for (const source of [chamados, alerts, history]) {
    assert.match(source, /useOperationalTableLayout/);
    assert.match(source, /responsivePriority/);
    assert.match(source, /operationalColumnPreferredWidth/);
  }
  assert.match(history, /import \{ dashboardWidgetsForPage \}/);
  assert.match(chamados, /incidentTableLayout\.visibleColumns\.map/);
  assert.match(chamados, /column\.id === "actions" && "sticky right-0/);
  assert.match(alerts, /id: "actions", label: "Ações", required: true/);
  assert.match(alerts, /liveDurationSeconds\(alert, durationNow\)/);
  assert.match(alerts, /sticky right-0/);
  assert.match(alerts, /column\.id === "actions" && "sticky right-0 z-20 bg-inherit"/);
  assert.match(alerts, /key="actions" className="sticky right-0 z-10 bg-inherit/);
  assert.doesNotMatch(alerts, /key="actions" className="[^"]*bg-background/);
  assert.match(alerts, /const ackColumnFilter/);
  assert.match(alerts, /Filtrar analista do ACK/);
  assert.match(actions, /!isTableCell && holdOptionsError/);
  assert.match(actions, /async function loadHoldOptions/);
});

test("Monitoring, History and platform health have narrow viewport escape paths", async () => {
  const [monitoring, history, health] = await Promise.all([
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/PlatformHealthStrip.tsx"),
  ]);
  assert.match(monitoring, /overflow-y-auto overflow-x-hidden/);
  assert.match(monitoring, /min-\[1440px\]:overflow-hidden/);
  assert.match(monitoring, /min-h-\[24rem\]/);
  assert.match(monitoring, /flex-col items-stretch[^\n]+sm:flex-row/);
  assert.match(history, /flex-nowrap gap-2 overflow-x-auto/);
  assert.match(history, /flex flex-col gap-3[^\n]+sm:flex-row/);
  assert.match(health, /hidden whitespace-nowrap text-xs font-medium text-foreground sm:inline/);
});

test("Links uses progressive filters, mobile cards and a compact desktop table", async () => {
  const links = await read("src/pages/Operadoras.tsx");
  assert.match(links, /ClientFilterCombobox/);
  assert.match(links, /Mais filtros/);
  assert.match(links, /md:hidden/);
  assert.match(links, /table-fixed/);
  assert.match(links, /md:grid-cols-3 xl:grid-cols-5/);
  assert.match(links, /Fila operacional de links/);
  assert.match(links, /fetchCanonicalLinks/);
  assert.match(links, /mode === "quiet"/);
  assert.match(links, /document\.hidden/);
});
