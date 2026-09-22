import assert from "node:assert/strict";
import test from "node:test";

import {
  expandServiceNowCompanyFilterToken,
  mapsServiceNowProblemCorrelationToken,
  matchServiceNowOperationalBridge,
  resolveServiceNowCompanyLabelFromRow,
  resolveServiceNowIncidentCustomerLabel,
} from "../api/_lib/oneview-servicenow-customer-bridge.js";

test("MAPS: empresa ServiceNow reconhecida como bridge operacional", () => {
  const company = "MAPS S.A SOLUCOES E SERVICOS - SP - SAO PAULO - 014493";
  const bridge = matchServiceNowOperationalBridge(company);
  assert.equal(bridge?.operationalKey, "maps");
  assert.equal(bridge?.datasource, "maps");
  assert.equal(bridge?.label, "MAPS");
});

test("MAPS: filtro company=maps expande termos de busca", () => {
  const { terms } = expandServiceNowCompanyFilterToken("maps");
  assert.ok(terms.includes("MAPS"));
  assert.ok(terms.includes("maps"));
});

test("MAPS: bridge usa display_values quando company é sys_id", () => {
  const label = resolveServiceNowCompanyLabelFromRow({
    company: "42f4bac2970a4b5030f7f796f053afb4",
    display_values: { company: "MAPS S.A SOLUCOES E SERVICOS" },
  });
  assert.equal(label, "MAPS S.A SOLUCOES E SERVICOS");
  assert.equal(matchServiceNowOperationalBridge(label)?.datasource, "maps");
});

test("MAPS: token de problema extrai nome do túnel VPN", () => {
  const token = mapsServiceNowProblemCorrelationToken("VPN IPSec mapsregistradora-to-susep is Down");
  assert.equal(token, "mapsregistradora-to-susep");
});

test("MAPS: label canônico no campo customer do chamado", () => {
  const label = resolveServiceNowIncidentCustomerLabel(
    "sys-id-company",
    "MAPS S.A SOLUCOES E SERVICOS",
  );
  assert.equal(label, "MAPS");
});
