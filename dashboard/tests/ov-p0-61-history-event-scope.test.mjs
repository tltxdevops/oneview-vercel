/**
 * OV-P0-61 — scope de Eventos (Histórico): customer-first + labels corretos.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveHistoryEventOperationalScope,
  deriveOperationalScope,
  OPERATIONAL_SCOPE_LABELS,
} from "../api/_lib/oneview-operational-scope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("OV-P0-61 Eventos: customer existente prevalece sobre platform", () => {
  const scope = deriveHistoryEventOperationalScope({
    customer_name: "Sanepar",
    customer_key: "sanepar",
    host_name: "Zabbix server",
  });
  assert.equal(scope.operational_scope, "customer");
  assert.equal(scope.operational_scope_label, "Sanepar");

  // Regra geral (alertas) ainda prioriza platform quando explícito.
  assert.equal(
    deriveOperationalScope({
      customer_name: "Sanepar",
      customer_key: "sanepar",
      host_name: "Zabbix server",
    }).operational_scope,
    "platform",
  );
});

test("OV-P0-61 Eventos: customer null + platform/test/unknown", () => {
  assert.deepEqual(
    deriveHistoryEventOperationalScope({
      customer_name: null,
      host_name: "Zabbix server",
    }),
    {
      operational_scope: "platform",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.platform,
    },
  );

  assert.deepEqual(
    deriveHistoryEventOperationalScope({
      customer_name: "Cliente não classificado",
      customer_key: "unclassified",
      host_groups: [{ name: "Zabbix/Proxies" }],
    }),
    {
      operational_scope: "platform",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.platform,
    },
  );

  assert.deepEqual(
    deriveHistoryEventOperationalScope({
      customer_name: null,
      host_groups: [{ name: "TLTX/Testes" }],
      host_name: "lab-01",
    }),
    {
      operational_scope: "test",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.test,
    },
  );

  assert.deepEqual(
    deriveHistoryEventOperationalScope({
      customer_name: null,
      host_name: "Pref Osasco - AP",
    }),
    {
      operational_scope: "unknown",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.unknown,
    },
  );
});

test("OV-P0-61 Eventos: nunca rotula como Cliente não classificado", async () => {
  const [db, historico, identity] = await Promise.all([
    read("api/_lib/oneview-db.js"),
    read("src/pages/Historico.tsx"),
    read("src/components/oneview/ClientIdentity.tsx"),
  ]);

  assert.match(db, /deriveHistoryEventOperationalScope/);
  assert.match(db, /fetchGlobalHistoryPayload/);
  assert.match(db, /operational_scope_label/);

  assert.match(historico, /historyEventClientLabel/);
  assert.match(historico, /operationalScopeLabel/);
  assert.match(historico, /eventos/);
  // Eventos não devem cair no fallback "Cliente não classificado".
  assert.match(identity, /historyEventClientLabel/);
  assert.match(identity, /UNKNOWN_SCOPE_LABEL/);
  assert.match(identity, /Cliente não identificado/);
});
