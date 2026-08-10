/**
 * OV-P0-56 — escopo operacional (customer|platform|test|unknown).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveOperationalScope,
  hasPlatformEvidence,
  hasTestEvidence,
  OPERATIONAL_SCOPE_LABELS,
} from "../api/_lib/oneview-operational-scope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-56 platform: Zabbix server / Zabbix/Proxies explícitos", () => {
  assert.equal(
    deriveOperationalScope({ host_name: "Zabbix server" }).operational_scope,
    "platform",
  );
  assert.equal(
    deriveOperationalScope({
      host_groups: [{ name: "Zabbix/Proxies" }],
      customer_name: "Sanepar",
    }).operational_scope,
    "platform",
  );
  assert.equal(
    deriveOperationalScope({ host_name: "Zabbix server" }).operational_scope_label,
    OPERATIONAL_SCOPE_LABELS.platform,
  );
  assert.equal(hasPlatformEvidence({ host_name: "gateway-sp-01" }), false);
  assert.equal(hasPlatformEvidence({ host_groups: [{ name: "SOC/MDR" }] }), false);
  assert.equal(hasPlatformEvidence({ host_groups: [{ name: "PRODAM" }] }), false);
});

test("OV-P0-56 test: TLTX/Testes, HML, POC em grupos", () => {
  assert.equal(
    deriveOperationalScope({
      host_groups: [{ name: "TLTX/Testes" }],
      host_name: "host-a",
    }).operational_scope,
    "test",
  );
  assert.equal(
    deriveOperationalScope({
      host_groups: [{ name: "Cliente/HML/App" }],
      host_name: "host-b",
    }).operational_scope,
    "test",
  );
  assert.equal(
    deriveOperationalScope({
      host_groups: [{ name: "POC-Lab" }],
      host_name: "host-c",
    }).operational_scope,
    "test",
  );
  assert.equal(
    deriveOperationalScope({ host_groups: [{ name: "TLTX/Testes" }] }).operational_scope_label,
    OPERATIONAL_SCOPE_LABELS.test,
  );
  assert.equal(hasTestEvidence({ host_groups: [{ name: "SP_GATEWAY" }] }), false);
  assert.equal(hasTestEvidence({ host_name: "HOST-COM-HML-NO-NOME" }), false);
});

test("OV-P0-56 customer classificado e unknown", () => {
  assert.deepEqual(
    deriveOperationalScope({
      customer_name: "Sanepar",
      customer_key: "sanepar",
      host_name: "Sanepar - Router",
    }),
    {
      operational_scope: "customer",
      operational_scope_label: "Sanepar",
    },
  );

  assert.equal(
    deriveOperationalScope({
      customer_name: null,
      customer_source: "datasource_fallback",
      host_name: "Zabbix server",
    }).operational_scope,
    "platform",
  );

  assert.equal(
    deriveOperationalScope({
      customer_name: "Cliente não classificado",
      host_name: "Pref Osasco - AP",
    }).operational_scope,
    "unknown",
  );

  assert.equal(
    deriveOperationalScope({
      customer_name: null,
      host_name: null,
    }).operational_scope_label,
    OPERATIONAL_SCOPE_LABELS.unknown,
  );
});

test("OV-P0-56 não classifica SOC/MDR/PRODAM/SP_*/GATEWAY sem prova", () => {
  for (const name of ["SOC/MDR", "PRODAM", "SP_FOO", "GATEWAY-CORE", "SP_GATEWAY"]) {
    const scope = deriveOperationalScope({
      host_groups: [{ name }],
      host_name: "host-x",
      customer_name: null,
    });
    assert.equal(scope.operational_scope, "unknown", name);
  }
});

test("OV-P0-56 BFF/UI wiring sem inferência FE e preserva customer_name", async () => {
  const [db, scopeLib, identity, summary, alerts, index, monitoring, historico, api] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("api/_lib/oneview-operational-scope.js"),
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/components/oneview/AlertOperationalSummary.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(scopeLib, /deriveOperationalScope/);
  assert.match(db, /deriveOperationalScope/);
  assert.match(db, /operational_scope:/);
  assert.match(db, /operational_scope_label:/);
  assert.match(db, /a\.host_groups/);

  assert.match(identity, /operationalClientLabel/);
  assert.match(identity, /Infraestrutura de monitoramento/);
  assert.match(identity, /Ambiente de teste/);
  assert.match(identity, /Cliente não identificado/);
  assert.doesNotMatch(identity, /SOC\/MDR|PRODAM|SP_\*/);

  assert.match(summary, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(alerts, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(index, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(monitoring, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(historico, /operationalScope=\{alert\.operational_scope\}/);
  assert.match(api, /operational_scope\?:/);
});
