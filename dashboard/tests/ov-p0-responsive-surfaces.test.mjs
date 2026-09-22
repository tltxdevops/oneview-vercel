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

test("Alerts exposes Fonte Zabbix filter while preserving datasource URL/BFF scope", async () => {
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /ZabbixSourceFilter/);
  assert.match(alerts, /mergeOperationalZabbixSourceFilterOptions/);
  assert.match(alerts, /datasources: selectedDatasources/);
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
