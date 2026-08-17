/**
 * HOTFIX-P0-CLIENT-LABEL — customer real nunca é sobrescrito por operational_scope_label.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

const PLATFORM_SCOPE_LABEL = "Infraestrutura de monitoramento";
const TEST_SCOPE_LABEL = "Ambiente de teste";
const UNKNOWN_SCOPE_LABEL = "Cliente não identificado";
const UNCLASSIFIED_CLIENT_LABEL = "Cliente não classificado";

function normalizedClientKey(...values) {
  return values
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isDatasourceLikeLabel(normalized) {
  if (!normalized) return false;
  return (
    normalized === "teletex-http"
    || normalized.includes("datasource")
    || /(^|[\s_-])http($|[\s_-])/.test(normalized)
    || normalized.endsWith("-http")
  );
}

function isPlaceholderClientLabel(normalized) {
  if (!normalized) return true;
  return (
    normalized === "unclassified"
    || normalized === "cliente-nao-classificado"
    || normalized === "cliente nao classificado"
    || normalized === "cliente nao identificado"
    || normalized === "sem classificacao"
  );
}

function isUnclassifiedClient(customer) {
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  const source = String(customer?.source || "").trim().toLowerCase();
  const normalizedName = normalizedClientKey(name);
  const normalizedKey = normalizedClientKey(key);
  const hasRealName = Boolean(name)
    && !isPlaceholderClientLabel(normalizedName)
    && !isDatasourceLikeLabel(normalizedName);
  if (hasRealName) return false;
  const hasRealKey = Boolean(key)
    && !isPlaceholderClientLabel(normalizedKey)
    && !isDatasourceLikeLabel(normalizedKey);
  if (hasRealKey) return false;
  if (source === "datasource_fallback") return true;
  if (isPlaceholderClientLabel(normalizedKey) || isPlaceholderClientLabel(normalizedName)) return true;
  if (isDatasourceLikeLabel(normalizedName) || isDatasourceLikeLabel(normalizedKey)) return true;
  return !normalizedName && !normalizedKey;
}

function canonicalClientName(customer, fallback = UNKNOWN_SCOPE_LABEL) {
  const safeFallback = fallback === UNCLASSIFIED_CLIENT_LABEL ? UNKNOWN_SCOPE_LABEL : fallback;
  if (isUnclassifiedClient(customer)) return safeFallback;
  const name = String(customer?.name || "").trim();
  const key = String(customer?.key || "").trim();
  if (name && !isPlaceholderClientLabel(normalizedClientKey(name)) && !isDatasourceLikeLabel(normalizedClientKey(name))) {
    return name;
  }
  if (key && !isPlaceholderClientLabel(normalizedClientKey(key)) && !isDatasourceLikeLabel(normalizedClientKey(key))) {
    return key;
  }
  return safeFallback;
}

function normalizeOperationalScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  if (scope === "customer" || scope === "platform" || scope === "test" || scope === "unknown") return scope;
  return null;
}

/** Mirror of ClientIdentity helpers after OV-P0-102. */
function operationalClientLabel(entity, fallback = UNKNOWN_SCOPE_LABEL) {
  if (!isUnclassifiedClient(entity)) return canonicalClientName(entity, fallback);
  const scope = normalizeOperationalScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM_SCOPE_LABEL;
  if (scope === "test") return label || TEST_SCOPE_LABEL;
  if (scope === "unknown") return label || UNKNOWN_SCOPE_LABEL;
  if (label === PLATFORM_SCOPE_LABEL || label === TEST_SCOPE_LABEL || label === UNKNOWN_SCOPE_LABEL) return label;
  if (scope === "customer" && label && label !== UNCLASSIFIED_CLIENT_LABEL) return label;
  return fallback === UNCLASSIFIED_CLIENT_LABEL ? UNKNOWN_SCOPE_LABEL : fallback;
}

function historyEventClientLabel(entity) {
  if (!isUnclassifiedClient(entity)) return canonicalClientName(entity, UNKNOWN_SCOPE_LABEL);
  const scope = normalizeOperationalScope(entity?.operational_scope);
  const label = String(entity?.operational_scope_label || "").trim();
  if (scope === "platform") return label || PLATFORM_SCOPE_LABEL;
  if (scope === "test") return label || TEST_SCOPE_LABEL;
  if (scope === "unknown") return label || UNKNOWN_SCOPE_LABEL;
  if (label === PLATFORM_SCOPE_LABEL || label === TEST_SCOPE_LABEL || label === UNKNOWN_SCOPE_LABEL) return label;
  return UNKNOWN_SCOPE_LABEL;
}

function resolveDisplayName(customer, operationalScopeLabel) {
  if (!isUnclassifiedClient(customer)) return canonicalClientName(customer);
  const explicit = String(operationalScopeLabel || customer?.operational_scope_label || "").trim();
  return explicit || operationalClientLabel(customer);
}

test("HOTFIX-P0-CLIENT-LABEL: clientes reais nunca são sobrescritos por scope_label", () => {
  const cases = [
    { key: "sanepar", name: "Sanepar" },
    { key: "prefosasco", name: "PrefOsasco" },
    { key: "unicap", name: "Unicap" },
    { key: "protege", name: "Protege" },
  ];

  for (const customer of cases) {
    for (const scope of ["unknown", "platform", "test", "customer", null]) {
      const entity = {
        ...customer,
        operational_scope: scope,
        operational_scope_label: UNKNOWN_SCOPE_LABEL,
      };
      assert.equal(
        operationalClientLabel(entity),
        customer.name,
        `${customer.name} + scope=${scope} via operationalClientLabel`,
      );
      assert.equal(
        historyEventClientLabel(entity),
        customer.name,
        `${customer.name} + scope=${scope} via historyEventClientLabel`,
      );
      assert.equal(
        resolveDisplayName(entity, historyEventClientLabel(entity)),
        customer.name,
        `${customer.name} + scope=${scope} via ClientIdentity resolve`,
      );
    }
  }
});

test("HOTFIX-P0-CLIENT-LABEL: sem customer real → scope_label decide", () => {
  assert.equal(
    historyEventClientLabel({
      name: null,
      key: null,
      operational_scope: "platform",
      operational_scope_label: PLATFORM_SCOPE_LABEL,
    }),
    PLATFORM_SCOPE_LABEL,
  );
  assert.equal(
    historyEventClientLabel({
      name: null,
      key: null,
      operational_scope: "test",
      operational_scope_label: TEST_SCOPE_LABEL,
    }),
    TEST_SCOPE_LABEL,
  );
  assert.equal(
    historyEventClientLabel({
      name: null,
      key: null,
      operational_scope: "unknown",
      operational_scope_label: UNKNOWN_SCOPE_LABEL,
    }),
    UNKNOWN_SCOPE_LABEL,
  );
  assert.equal(
    resolveDisplayName(
      { name: null, key: null, operational_scope: "platform" },
      PLATFORM_SCOPE_LABEL,
    ),
    PLATFORM_SCOPE_LABEL,
  );
});

test("HOTFIX-P0-CLIENT-LABEL: ClientIdentity prioriza customer real no source", async () => {
  const [identity, historico] = await Promise.all([
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Historico.tsx"),
  ]);

  assert.match(identity, /HOTFIX-P0-CLIENT-LABEL/);
  assert.match(identity, /hasRealCustomer/);
  assert.match(identity, /if \(!isUnclassifiedClient\(entity\)\)/);
  assert.match(identity, /canonicalClientName\(customer\)/);
  // operational_scope_label não pode sobrescrever cliente real.
  assert.doesNotMatch(
    identity,
    /const name = explicitLabel \|\| operationalClientLabel/,
  );

  assert.match(historico, /ClientIdentity/);
  assert.match(historico, /historyEventClientLabel/);
});
