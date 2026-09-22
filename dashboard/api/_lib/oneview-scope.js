/**
 * Production operational scope. Keep this allowlist server-side so a request
 * can narrow the result, but can never add Maps or an arbitrary datasource.
 */
export const ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES = Object.freeze([
  "teletex-http",
  "rhp",
  "maps",
  "castrolanda",
  "zurich",
  "fraport-for",
  "fraport-poa",
]);

/** Fontes dedicadas sem customer_key persistido — filtro `customer=` remapeia para `d.name`. */
export const DATASOURCE_ONLY_CUSTOMER_TOKENS = Object.freeze([
  "teletex-http",
  "maps",
]);

/** Fonte Zabbix dedicada = cliente operacional quando não há customer_key no alerta. */
export const DEDICATED_DATASOURCE_CUSTOMER_LABELS = Object.freeze({
  maps: "MAPS",
});

export function getOperationalDataSourceNames() {
  return [...ONEVIEW_OPERATIONAL_DATA_SOURCE_NAMES];
}

/**
 * OV-P0-274 — `customer=` é identidade canônica (customer_key/name).
 * Tokens datasource-only (teletex-http, maps, *-http) remapeiam para `d.name`.
 * Zurich / Castrolanda / RHP / Fraport permanecem filtro de cliente.
 */
export function isDatasourceOnlyCustomerToken(value, dataSourceNames = getOperationalDataSourceNames()) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  if (DATASOURCE_ONLY_CUSTOMER_TOKENS.includes(normalized)) return true;
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
