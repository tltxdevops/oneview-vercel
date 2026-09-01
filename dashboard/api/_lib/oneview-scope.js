/**
 * Production operational scope. Keep this allowlist server-side so a request
 * can narrow the result, but can never add Maps or an arbitrary datasource.
 */
export const ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES = Object.freeze([
  "teletex-http",
  "rhp",
  "castrolanda",
  "zurich",
  "fraport-for",
  "fraport-poa",
]);

export function getOperationalDataSourceNames() {
  return [...ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES];
}

/**
 * OV-P0-267 — o combobox Cliente da UI envia `customer=`.
 * Quando o valor é o nome de uma fonte operacional, isso é filtro de
 * datasource (`d.name`), não identidade de customer_name.
 * Fontes fora do allowlist nunca entram por esse caminho.
 */
export function splitAlertCustomerFilter(values, dataSourceNames = getOperationalDataSourceNames()) {
  const allowed = new Set(
    (Array.isArray(dataSourceNames) ? dataSourceNames : [dataSourceNames])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const datasources = [];
  const customers = [];
  for (const raw of Array.isArray(values) ? values : [values]) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (allowed.has(normalized)) datasources.push(normalized);
    else customers.push(normalized);
  }
  return {
    datasources: [...new Set(datasources)],
    customers: [...new Set(customers)],
  };
}
