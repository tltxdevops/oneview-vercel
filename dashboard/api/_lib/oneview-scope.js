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
 * OV-P0-274 — `customer=` é identidade canônica (customer_key/name).
 * Apenas tokens que nunca são cliente (teletex-http / *-http) ainda
 * remapeiam para `d.name`, para deep links antigos da OV-P0-267.
 * Zurich / Castrolanda / RHP / Fraport permanecem filtro de cliente.
 */
export function isDatasourceOnlyCustomerToken(value, dataSourceNames = getOperationalDataSourceNames()) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("datasource") || normalized.endsWith("-http")) return true;
  const allowed = new Set(
    (Array.isArray(dataSourceNames) ? dataSourceNames : [dataSourceNames])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter((name) => name.endsWith("-http") || name.includes("datasource")),
  );
  return allowed.has(normalized);
}

export function splitAlertCustomerFilter(values, dataSourceNames = getOperationalDataSourceNames()) {
  const datasources = [];
  const customers = [];
  for (const raw of Array.isArray(values) ? values : [values]) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (isDatasourceOnlyCustomerToken(normalized, dataSourceNames)) datasources.push(normalized);
    else customers.push(normalized);
  }
  return {
    datasources: [...new Set(datasources)],
    customers: [...new Set(customers)],
  };
}
