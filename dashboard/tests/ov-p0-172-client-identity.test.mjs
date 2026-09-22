import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalCustomerDisplayName, canonicalCustomerKey, safeCustomerIdentity } from "../api/_lib/oneview-db.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("OV-P0-172 merges only trim/casing variants and keeps a deterministic display", () => {
  assert.equal(canonicalCustomerKey("Ailos"), "ailos");
  assert.equal(canonicalCustomerKey(" ailos "), "ailos");
  assert.equal(canonicalCustomerDisplayName("ailos"), "Ailos");
  assert.equal(canonicalCustomerDisplayName("Ailos "), "Ailos");
  assert.notEqual(canonicalCustomerKey("Ailos"), canonicalCustomerKey("Ailos Sistemas"));
});

test("OV-P0-172 resolves MAPS from dedicated datasource when customer_key is absent", () => {
  const identity = safeCustomerIdentity({
    customer_name: null,
    customer_key: null,
    datasource_name: "maps",
  });
  assert.equal(identity.customerKey, "maps");
  assert.equal(identity.customerName, "MAPS");
  assert.equal(identity.unidentified, false);
});

test("OV-P0-172 aggregates the canonical key without losing source identity", () => {
  const rows = [
    { customer_name: "Ailos", customer_key: "Ailos", data_source_id: "source-a", count: 12 },
    { customer_name: "ailos ", customer_key: "ailos", data_source_id: "source-b", count: 8 },
  ];
  const aggregate = rows.reduce((result, row) => {
    const identity = safeCustomerIdentity(row);
    const key = identity.customerKey;
    const current = result.get(key) || { name: identity.customerName, count: 0, sources: new Set() };
    current.count += row.count;
    current.sources.add(row.data_source_id);
    result.set(key, current);
    return result;
  }, new Map());

  assert.equal(aggregate.size, 1);
  assert.deepEqual(aggregate.get("ailos"), { name: "Ailos", count: 20, sources: new Set(["source-a", "source-b"]) });
});

test("OV-P0-172 applies the canonical read model to facets, filters and all operational UIs", () => {
  const db = read("api/_lib/oneview-db.js");
  const identity = read("src/components/oneview/ClientIdentity.tsx");
  for (const page of ["src/pages/Index.tsx", "src/pages/Monitoring.tsx", "src/pages/Alerts.tsx", "src/pages/Historico.tsx"]) {
    assert.match(read(page), /fetchOneViewFacets|getOneViewFacets|fetchClientsTopSummary|canonicalClientName|operationalClientLabel/);
  }
  assert.match(db, /lower\(btrim\(a\.customer_name\)\)/);
  assert.match(db, /client_name_original/);
  assert.match(db, /customer_name_original/);
  assert.match(db, /SAFE_CUSTOMER_KEY_SQL\} = any/);
  assert.match(identity, /canonicalClientKey/);
  assert.match(identity, /ailos: "Ailos"/);
});
