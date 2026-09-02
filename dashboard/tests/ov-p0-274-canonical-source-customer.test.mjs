/**
 * OV-P0-274 — Fonte Zabbix ≠ Cliente canônico + drawer de identidade.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAlertListQuery } from "../api/_lib/oneview-db.js";
import { splitAlertCustomerFilter } from "../api/_lib/oneview-scope.js";
import {
  customerFilterCountNoun,
  isDatasourceOnlyFilterValue,
  splitLegacyCustomerQuery,
  zabbixSourceDisplayName,
} from "../src/lib/oneview-zabbix-source.ts";
import { extractPersistedOperatorTags } from "../src/lib/oneview-operator-display.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function request(query = {}) {
  return { method: "GET", query, headers: {} };
}

const CRITICAL_CUSTOMERS = [
  { key: "j.macedo", name: "J.Macedo", source: "teletex-http" },
  { key: "saque e pague", name: "Saque e Pague", source: "teletex-http" },
  { key: "tigre", name: "Tigre", source: "teletex-http" },
  { key: "triunfante", name: "Triunfante", source: "teletex-http" },
  { key: "zurich", name: "Zurich", source: "zurich" },
  { key: "castrolanda", name: "Castrolanda", source: "castrolanda" },
  { key: "rhp", name: "RHP", source: "rhp" },
  { key: "fraport-for", name: "Fraport FOR", source: "fraport-for" },
  { key: "fraport-poa", name: "Fraport POA", source: "fraport-poa" },
  { key: "protege", name: "Protege", source: "teletex-http" },
  { key: "sanepar", name: "Sanepar", source: "teletex-http" },
  { key: "berneck", name: "Berneck", source: "teletex-http" },
];

test("OV-P0-274: datasource is not customer", async () => {
  assert.equal(isDatasourceOnlyFilterValue("teletex-http"), true);
  assert.equal(isDatasourceOnlyFilterValue("zurich"), false);
  assert.equal(isDatasourceOnlyFilterValue("castrolanda"), false);
  assert.equal(isDatasourceOnlyFilterValue("j.macedo"), false);
  assert.equal(zabbixSourceDisplayName("teletex-http"), "Teletex");
  assert.equal(zabbixSourceDisplayName("fraport-for"), "Fraport FOR");
  const identity = await read("src/components/oneview/ClientIdentity.tsx");
  assert.match(identity, /UNKNOWN_SCOPE_LABEL = "Cliente não identificado"/);
  assert.match(identity, /isDatasourceLikeLabel/);
  assert.match(identity, /nunca exibe "unclassified" nem usa datasource como cliente/);
});

test("OV-P0-274: teletex-http + canonical customers stay split", () => {
  for (const customer of ["j.macedo", "saque e pague", "tigre", "triunfante"]) {
    const query = buildAlertListQuery(request({
      status: "active",
      customer,
      datasource: "teletex-http",
    }));
    assert.deepEqual(query.filters.datasources, ["teletex-http"], customer);
    assert.ok(query.filters.customers.includes(customer), customer);
    assert.match(query.whereSql, /d\.name = any/);
    assert.match(query.whereSql, /lower\(btrim\(a\.customer_name\)\)/);
  }
});

test("OV-P0-274: zurich datasource + Zurich customer can combine", () => {
  const query = buildAlertListQuery(request({
    status: "active",
    customer: "Zurich",
    datasource: "zurich",
  }));
  assert.deepEqual(query.filters.datasources, ["zurich"]);
  assert.deepEqual(query.filters.customers, ["zurich"]);
});

test("OV-P0-274: unclassified keeps datasource and never uses it as Cliente", async () => {
  const identity = await read("src/components/oneview/ClientIdentity.tsx");
  assert.match(identity, /UNKNOWN_SCOPE_LABEL = "Cliente não identificado"/);
  assert.match(identity, /isUnclassifiedClient/);
  const query = buildAlertListQuery(request({
    status: "active",
    customer: "unclassified",
    datasource: "teletex-http",
  }));
  assert.ok(query.filters.customers.includes("unclassified"));
  assert.deepEqual(query.filters.datasources, ["teletex-http"]);
  assert.equal(zabbixSourceDisplayName("teletex-http"), "Teletex");
});

test("OV-P0-274: source filter uses datasource query, customer filter uses identity", () => {
  const source = buildAlertListQuery(request({ datasource: "rhp", status: "active" }));
  assert.deepEqual(source.filters.datasources, ["rhp"]);
  assert.deepEqual(source.filters.customers, []);
  const customer = buildAlertListQuery(request({ customer: "Berneck", status: "active" }));
  assert.deepEqual(customer.filters.customers, ["berneck"]);
  assert.deepEqual(customer.filters.datasources, []);
  const legacy = splitAlertCustomerFilter(["teletex-http", "Berneck"]);
  assert.deepEqual(legacy.datasources, ["teletex-http"]);
  assert.deepEqual(legacy.customers, ["berneck"]);
});

test("OV-P0-274: critical customers keep identity distinct from Fonte Zabbix", () => {
  for (const item of CRITICAL_CUSTOMERS) {
    const query = buildAlertListQuery(request({
      status: "active",
      customer: item.key,
      datasource: item.source,
    }));
    assert.ok(query.filters.customers.includes(item.key), item.key);
    assert.ok(query.filters.datasources.includes(item.source), item.source);
    assert.equal(isDatasourceOnlyFilterValue(item.key), false, item.key);
    assert.ok(zabbixSourceDisplayName(item.source));
  }
});

test("OV-P0-274: count noun is scoped, never generic alertas", () => {
  assert.equal(customerFilterCountNoun("filter"), "neste filtro");
  assert.equal(customerFilterCountNoun("prioritary"), "prioritário");
});

test("OV-P0-274: legacy customer=teletex-http migrates to datasource", () => {
  const split = splitLegacyCustomerQuery(["teletex-http", "Triunfante"]);
  assert.deepEqual(split.datasources, ["teletex-http"]);
  assert.deepEqual(split.customers, ["Triunfante"]);
});

test("OV-P0-274: operator display uses persisted tags only", () => {
  const none = extractPersistedOperatorTags({
    event_tags: [{ tag: "host", value: "EMBRATEL down" }],
    trigger_tags: [{ tag: "problem", value: "Link caiu" }],
  });
  assert.equal(none.length, 0);
  const found = extractPersistedOperatorTags({
    event_tags: [{ tag: "operadora", value: "OPERADORA-4G" }],
  });
  assert.equal(found[0]?.value, "OPERADORA-4G");
});

test("OV-P0-274: drawer identity/state/SN/operator/audit contract", async () => {
  const drawer = await read("src/components/oneview/AlertDetailDrawer.tsx");
  assert.match(drawer, /aria-label="Identidade"/);
  assert.match(drawer, /label="Cliente"/);
  assert.match(drawer, /label="Fonte Zabbix"/);
  assert.match(drawer, /label="Host"/);
  assert.match(drawer, /label="Host técnico"/);
  assert.match(drawer, /Trigger\/Problema/);
  assert.doesNotMatch(drawer, /label="IP".*host_visible_name|hostname de IP/i);
  assert.match(drawer, /aria-label="Estado"/);
  assert.match(drawer, /Estado da origem/);
  assert.match(drawer, /ACK origem/);
  assert.match(drawer, /ACK OneView/);
  assert.match(drawer, /Primeira ocorrência/);
  assert.match(drawer, /Indisponível na origem/);
  assert.match(drawer, /Auditoria da identidade/);
  assert.match(drawer, /Fonte da identidade do cliente/);
  assert.match(drawer, /source_event_id/);
  assert.match(drawer, /primaryPersistedOperatorTag/);
  assert.match(drawer, /operationalClientLabel/);
  assert.doesNotMatch(drawer, /alert\.datasource_name.*Cliente/);
});

test("OV-P0-274: cross-surface Fonte Zabbix + canonical Cliente", async () => {
  const files = [
    "src/pages/Index.tsx",
    "src/pages/Monitoring.tsx",
    "src/pages/Alerts.tsx",
    "src/pages/Historico.tsx",
    "src/pages/Operadoras.tsx",
    "src/components/oneview/AlertDetailDrawer.tsx",
  ];
  const zabbixSourceFilterFiles = files.filter((file) => file !== "src/pages/Index.tsx");
  for (const file of files) {
    const source = await read(file);
    assert.match(source, /operationalClientLabel|facetCustomerDisplayName|customer_key|Cliente/, file);
    assert.doesNotMatch(source, /datasourceCards/, file);
  }
  for (const file of zabbixSourceFilterFiles) {
    const source = await read(file);
    assert.match(source, /Fonte Zabbix|zabbixSourceDisplayName|ZabbixSourceFilter/, file);
  }
  const combobox = await read("src/components/oneview/ClientFilterCombobox.tsx");
  assert.match(combobox, /neste filtro/);
  assert.doesNotMatch(combobox, /\{Number\(customer\.alerts_count\).toLocaleString\("pt-BR"\)\} alertas/);
  const home = await read("src/pages/Index.tsx");
  assert.doesNotMatch(home, /label="Datasource"/);
  assert.doesNotMatch(home, /ZabbixSourceFilter/);
  assert.doesNotMatch(home, /label="Fonte Zabbix"/);
  const alerts = await read("src/pages/Alerts.tsx");
  assert.match(alerts, /datasources: selectedDatasources/);
  const monitoring = await read("src/pages/Monitoring.tsx");
  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(monitoring, /oneview-live-transition/);
});
