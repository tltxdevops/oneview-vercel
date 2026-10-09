import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function createHelpersFromSource(source) {
  assert.match(source, /host_visible_name → host_technical_name → host_name/);
  assert.match(source, /MISSING_HOST_LABEL = "Host não informado"/);
  assert.match(source, /UNCLASSIFIED_CLIENT_LABEL = "Cliente não classificado"/);
  assert.match(source, /UNKNOWN_SCOPE_LABEL = "Cliente não identificado"/);
  assert.match(source, /Host protegido/);
  assert.match(source, /datasource_fallback/);
  assert.match(source, /nunca exibe "unclassified"/i);

  const normalize = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const isMissingHostLabel = (value) => {
    const text = String(value || "").trim();
    if (!text) return true;
    if (text === "-" || /^host$/i.test(text)) return true;
    if (/^host protegido\b/i.test(text)) return true;
    const normalized = normalize(text);
    return normalized === "host nao informado"
      || normalized === "host nao identificado"
      || normalized === "host nao disponivel";
  };

  const canonicalHostName = (host, fallback = "Host não informado") => {
    for (const candidate of [host?.host_visible_name, host?.host_technical_name, host?.host_name]) {
      const value = String(candidate || "").trim();
      if (value && !isMissingHostLabel(value)) return value;
    }
    return fallback;
  };

  const isPlaceholderClient = (normalized) => !normalized
    || normalized === "unclassified"
    || normalized === "cliente-nao-classificado"
    || normalized === "cliente nao classificado"
    || normalized === "cliente nao identificado"
    || normalized === "sem classificacao";

  const isDatasourceLike = (normalized) => normalized === "teletex-http"
    || normalized.includes("datasource")
    || normalized.endsWith("-http");

  const isUnclassifiedClient = (customer) => {
    const name = String(customer?.name || "").trim();
    const key = String(customer?.key || "").trim();
    const source = String(customer?.source || "").trim().toLowerCase();
    const nName = normalize(name);
    const nKey = normalize(key);
    if (name && !isPlaceholderClient(nName) && !isDatasourceLike(nName)) return false;
    if (key && !isPlaceholderClient(nKey) && !isDatasourceLike(nKey)) return false;
    if (source === "datasource_fallback") return true;
    if (isPlaceholderClient(nKey) || isPlaceholderClient(nName)) return true;
    if (isDatasourceLike(nName) || isDatasourceLike(nKey)) return true;
    return !nName && !nKey;
  };

  const canonicalClientName = (customer, fallback = "Cliente não identificado") => {
    const safeFallback = fallback === "Cliente não classificado" ? "Cliente não identificado" : fallback;
    if (isUnclassifiedClient(customer)) return safeFallback;
    const name = String(customer?.name || "").trim();
    const key = String(customer?.key || "").trim();
    if (name && !isPlaceholderClient(normalize(name)) && !isDatasourceLike(normalize(name))) return name;
    if (key && !isPlaceholderClient(normalize(key)) && !isDatasourceLike(normalize(key))) return key;
    return safeFallback;
  };

  return { canonicalHostName, canonicalClientName };
}

test("OV-P0-40 helpers: host canônico e remove Host protegido", async () => {
  const source = await read("src/components/oneview/ClientIdentity.tsx");
  const { canonicalHostName } = createHelpersFromSource(source);

  assert.equal(
    canonicalHostName({
      host_visible_name: "srv-visible",
      host_technical_name: "srv-tech",
      host_name: "srv-raw",
    }),
    "srv-visible",
  );
  assert.equal(
    canonicalHostName({
      host_visible_name: null,
      host_technical_name: "srv-tech",
      host_name: "srv-raw",
    }),
    "srv-tech",
  );
  assert.equal(
    canonicalHostName({
      host_visible_name: "Host protegido ABCD1234",
      host_technical_name: "srv-tech",
      host_name: "srv-raw",
    }),
    "srv-tech",
  );
  assert.equal(
    canonicalHostName({
      host_visible_name: "Host protegido ABCD1234",
      host_technical_name: "Host protegido FFFF",
      host_name: null,
    }),
    "Host não informado",
  );
  assert.equal(canonicalHostName({}), "Host não informado");
});

test("OV-P0-40 helpers: cliente real, unclassified e datasource", async () => {
  const source = await read("src/components/oneview/ClientIdentity.tsx");
  const { canonicalClientName } = createHelpersFromSource(source);

  assert.equal(canonicalClientName({ key: "sanepar", name: "Sanepar" }), "Sanepar");
  assert.equal(
    canonicalClientName({ key: "unclassified", name: null, source: "datasource_fallback" }),
    "Cliente não identificado",
  );
  assert.equal(
    canonicalClientName({ key: "cliente-nao-classificado", name: "Cliente não classificado" }),
    "Cliente não identificado",
  );
  assert.equal(
    canonicalClientName({ key: "teletex-http", name: "teletex-http" }),
    "Cliente não identificado",
  );
  assert.equal(
    canonicalClientName({ key: "unclassified", name: "Sanepar", source: "datasource_fallback" }),
    "Sanepar",
  );
  assert.doesNotMatch(canonicalClientName({ key: "unclassified", name: "unclassified" }), /unclassified/i);
  assert.doesNotMatch(
    canonicalClientName({ key: "unclassified", name: null }),
    /Cliente não classificado/,
  );
});

test("OV-P0-40 páginas usam helpers canônicos de host/cliente", async () => {
  const [identity, index, monitoring, alerts, historico, api] = await Promise.all([
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Index.tsx"),
    read("src/pages/Monitoring.tsx"),
    read("src/pages/Alerts.tsx"),
    read("src/pages/Historico.tsx"),
    read("src/lib/oneview-api.ts"),
  ]);

  assert.match(identity, /export function canonicalHostName/);
  assert.match(identity, /export function canonicalClientName/);
  assert.match(identity, /UNCLASSIFIED_CLIENT_LABEL = "Cliente não classificado"/);
  assert.match(identity, /MISSING_HOST_LABEL = "Host não informado"/);

  for (const [label, source] of [
    ["Index", index],
    ["Monitoring", monitoring],
    ["Alerts", alerts],
    ["Historico", historico],
  ]) {
    assert.match(source, /canonicalHostName/, `${label} deve usar canonicalHostName`);
    assert.match(source, /ClientIdentity/, `${label} deve reutilizar ClientIdentity`);
    assert.doesNotMatch(source, /Host protegido/, `${label} não deve exibir Host protegido`);
    assert.doesNotMatch(source, /Host não identificado/, `${label} não deve usar label antigo de host`);
  }

  assert.match(index, /canonicalClientName|facetCustomerDisplayName|operationalClientLabel/);
  assert.match(monitoring, /facetCustomerDisplayName|canonicalClientName|operationalClientLabel/);
  assert.match(alerts, /isUnclassifiedClient|facetCustomerDisplayName|UNKNOWN_SCOPE_LABEL/);
  assert.match(historico, /facetCustomerDisplayName|canonicalClientName|historyEventClientLabel/);
  assert.match(api, /canonicalHostName\(alert\)/);
  assert.match(api, /canonicalClientName\(\{/);
  assert.match(api, /expandHighFamilySeverities/);
});

test("compact client table labels keep aliases local to presentation", async () => {
  const [identity, chamados] = await Promise.all([
    read("src/components/oneview/ClientIdentity.tsx"),
    read("src/pages/Chamados.tsx"),
  ]);

  assert.match(identity, /export function compactOperationalClientLabel/);
  assert.match(identity, /"real hospital portugues": "RHP"/);
  assert.match(identity, /"companhia de saneamento do parana": "Sanepar"/);
  assert.match(identity, /rhp: "RHP"/);
  assert.match(chamados, /compactOperationalClientLabel\(fullClientName, fullClientName\)/);
  assert.match(chamados, /title=\{fullClientName\}/);
});
