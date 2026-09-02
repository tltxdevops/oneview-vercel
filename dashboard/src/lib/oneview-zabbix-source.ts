/**
 * OV-P0-274 — Fonte Zabbix (datasource) distinta de Cliente (customer_*).
 * Labels amigáveis só para as fontes operacionais do BFF; a lista vem das facets.
 */

export const ZABBIX_SOURCE_DISPLAY_NAMES: Record<string, string> = {
  "teletex-http": "Teletex",
  rhp: "RHP",
  castrolanda: "Castrolanda",
  zurich: "Zurich",
  "fraport-for": "Fraport FOR",
  "fraport-poa": "Fraport POA",
};

/** Tokens que nunca são identidade de cliente — só Fonte Zabbix. */
export const DATASOURCE_ONLY_FILTER_NAMES = Object.freeze([
  "teletex-http",
]);

export function zabbixSourceKey(value?: string | null): string {
  return String(value || "").trim().toLowerCase();
}

export function zabbixSourceDisplayName(value?: string | null): string {
  const key = zabbixSourceKey(value);
  if (!key) return "Fonte não identificada";
  return ZABBIX_SOURCE_DISPLAY_NAMES[key] || String(value || "").trim();
}

export function isDatasourceOnlyFilterValue(value?: string | null): boolean {
  const key = zabbixSourceKey(value);
  if (!key) return false;
  if ((DATASOURCE_ONLY_FILTER_NAMES as readonly string[]).includes(key)) return true;
  return key.includes("datasource") || key.endsWith("-http");
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
    if (isDatasourceOnlyFilterValue(value)) datasources.push(zabbixSourceKey(value));
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
