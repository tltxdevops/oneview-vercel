/**
 * OV-P0-274 — Fonte Zabbix (datasource) distinta de Cliente (customer_*).
 * Labels amigáveis só para as fontes operacionais do BFF; a lista vem das facets.
 */

export const ZABBIX_SOURCE_DISPLAY_NAMES: Record<string, string> = {
  "teletex-http": "Teletex",
  rhp: "RHP",
  maps: "MAPS",
  castrolanda: "Castrolanda",
  zurich: "Zurich",
  "fraport-for": "Fraport FOR",
  "fraport-poa": "Fraport POA",
};

/** Tokens ocultos do filtro Cliente (infra compartilhada). */
export const DATASOURCE_ONLY_FILTER_NAMES = Object.freeze([
  "teletex-http",
]);

/** `customer=` na URL remapeia para datasource no BFF (sem customer_key no banco). */
export const DATASOURCE_ONLY_QUERY_TOKENS = Object.freeze([
  "teletex-http",
  "maps",
]);

/** Fonte dedicada listada no filtro Cliente; contagem vem de facets.datasources. */
export const DEDICATED_CLIENT_DATASOURCE_KEYS = Object.freeze([
  "maps",
]);

export const OPERATIONAL_ZABBIX_FILTER_SOURCE_KEYS = Object.freeze(
  Object.keys(ZABBIX_SOURCE_DISPLAY_NAMES),
);

export type ZabbixSourceFacetRow = {
  id?: string | null;
  name: string;
  alerts_count?: number | null;
};

export function zabbixSourceKey(value?: string | null): string {
  return String(value || "").trim().toLowerCase();
}

export function zabbixSourceDisplayName(value?: string | null): string {
  const key = zabbixSourceKey(value);
  if (!key) return "Fonte não identificada";
  return ZABBIX_SOURCE_DISPLAY_NAMES[key] || String(value || "").trim();
}

export function isDatasourceOnlyQueryToken(value?: string | null): boolean {
  const key = zabbixSourceKey(value);
  if (!key) return false;
  if (DATASOURCE_ONLY_QUERY_TOKENS.includes(key)) return true;
  return key.includes("datasource") || key.endsWith("-http");
}

export function isDatasourceOnlyFilterValue(value?: string | null): boolean {
  const key = zabbixSourceKey(value);
  if (!key) return false;
  if (DATASOURCE_ONLY_FILTER_NAMES.includes(key)) return true;
  return key.includes("datasource") || key.endsWith("-http");
}

function facetCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

/** Garante as 7 fontes operacionais no seletor Fonte Zabbix, mesclando facets do BFF. */
export function mergeOperationalZabbixSourceFilterOptions(
  facetOptions?: ZabbixSourceFacetRow[] | null,
): ZabbixSourceFacetRow[] {
  const merged = new Map<string, ZabbixSourceFacetRow>();
  for (const key of OPERATIONAL_ZABBIX_FILTER_SOURCE_KEYS) {
    merged.set(key, { name: key, alerts_count: 0 });
  }
  for (const option of facetOptions ?? []) {
    const key = zabbixSourceKey(option.name);
    if (!key) continue;
    merged.set(key, { ...merged.get(key), ...option, name: option.name || key });
  }
  return [...merged.values()].sort((left, right) => {
    const countDiff = facetCount(right.alerts_count) - facetCount(left.alerts_count);
    if (countDiff !== 0) return countDiff;
    return zabbixSourceDisplayName(left.name).localeCompare(zabbixSourceDisplayName(right.name), "pt-BR");
  });
}

/** MAPS e outras fontes dedicadas sem customer_key entram no filtro Cliente. */
export function augmentCustomerFacetsWithDedicatedDatasources<
  T extends { key: string; name: string; alerts_count?: number | null },
>(customers: T[], datasources?: ZabbixSourceFacetRow[] | null): T[] {
  const result = [...customers];
  for (const datasourceKey of DEDICATED_CLIENT_DATASOURCE_KEYS) {
    if (result.some((row) => zabbixSourceKey(row.key) === datasourceKey)) continue;
    const row = (datasources ?? []).find((item) => zabbixSourceKey(item.name) === datasourceKey);
    if (!row) continue;
    result.push({
      key: datasourceKey,
      name: zabbixSourceDisplayName(datasourceKey),
      alerts_count: row.alerts_count ?? 0,
    } as T);
  }
  return result;
}

/**
 * Deep links antigos podiam mandar `customer=teletex-http`.
 * Zurich/RHP/Castrolanda permanecem Cliente (customer_key).
 */
export function splitLegacyCustomerQuery(values: string[] | null | undefined): {
  customers: string[];
  datasources: string[];
} {
  const customers: string[] = [];
  const datasources: string[] = [];
  for (const raw of values ?? []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    if (isDatasourceOnlyQueryToken(value)) datasources.push(zabbixSourceKey(value));
    else customers.push(value);
  }
  return {
    customers: [...new Set(customers)],
    datasources: [...new Set(datasources)],
  };
}

export function customerFilterCountNoun(scope: "prioritary" | "filter"): string {
  return scope === "prioritary" ? "prioritário" : "neste filtro";
}

export type CanonicalAlertIdentity = {
  customerKey: string | null;
  customerName: string;
  zabbixSourceKey: string | null;
  zabbixSourceName: string;
};

export function formatZabbixSourceAudit(input: {
  data_source_id?: string | null;
  datasource_name?: string | null;
}): string {
  const name = String(input.datasource_name || "").trim();
  const id = String(input.data_source_id || "").trim();
  if (name && id) return `${name} · ${id}`;
  return name || id || "Indisponível na origem";
}
