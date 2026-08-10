/**
 * OV-P0-56 / OV-P0-61 — escopo operacional derivado (read-only, sem migration).
 * customer | platform | test | unknown — somente com evidência explícita.
 * Nunca altera customer_name original; nao classifica SOC/MDR/PRODAM/SP_* nem GATEWAY sem prova.
 */

export const OPERATIONAL_SCOPES = Object.freeze(["customer", "platform", "test", "unknown"]);

export const OPERATIONAL_SCOPE_LABELS = Object.freeze({
  platform: "Infraestrutura de monitoramento",
  test: "Ambiente de teste",
  unknown: "Cliente não identificado",
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function groupNames(alert) {
  const groups = Array.isArray(alert?.host_groups) ? alert.host_groups : [];
  return groups
    .map((item) => clean(item?.name))
    .filter(Boolean);
}

function hostCandidates(alert) {
  return [
    alert?.host_visible_name,
    alert?.host_technical_name,
    alert?.host_name,
  ].map(clean).filter(Boolean);
}

function hasHostEvidence(alert) {
  return hostCandidates(alert).length > 0;
}

/** Plataforma: host/grupo explicitamente Zabbix server ou Zabbix/Proxies. */
export function hasPlatformEvidence(alert) {
  const haystacks = [...hostCandidates(alert), ...groupNames(alert)].map(normalize);
  for (const text of haystacks) {
    if (!text) continue;
    if (text === "zabbix server") return true;
    if (text.includes("zabbix server")) return true;
    if (text === "zabbix/proxies" || text === "zabbix / proxies") return true;
    if (text.includes("zabbix/proxies") || text.includes("zabbix / proxies")) return true;
  }
  return false;
}

/**
 * Teste: grupos TLTX/Testes, HML ou POC explicitamente identificados.
 * Não usa prefixos genéricos (SP_*, GATEWAY, SOC, MDR, PRODAM).
 */
export function hasTestEvidence(alert) {
  for (const name of groupNames(alert)) {
    const text = normalize(name);
    if (!text) continue;
    if (text.includes("tltx/testes") || text.includes("tltx / testes")) return true;
    if (/(^|[\/_\s-])hml([\/_\s-]|$)/.test(text)) return true;
    if (/(^|[\/_\s-])poc([\/_\s-]|$)/.test(text)) return true;
  }
  return false;
}

function isPlaceholderCustomerName(normalizedName) {
  return !normalizedName
    || normalizedName === "unclassified"
    || normalizedName === "cliente nao classificado"
    || normalizedName === "cliente nao identificado"
    || normalizedName === "sem classificacao"
    || normalizedName === "cliente oneview";
}

function isDatasourceLike(normalized) {
  if (!normalized) return false;
  return (
    normalized === "teletex-http"
    || normalized.includes("datasource")
    || /(^|[\s_-])http($|[\s_-])/.test(normalized)
    || normalized.endsWith("-http")
  );
}

/** Cliente classificado normalmente (nome real, sem fallback de datasource). */
export function hasClassifiedCustomer(alert) {
  const source = normalize(alert?.customer_source);
  if (source === "datasource_fallback") return false;
  const key = normalize(alert?.customer_key);
  if (key === "unclassified") return false;
  const name = normalize(alert?.customer_name);
  if (isPlaceholderCustomerName(name) || isDatasourceLike(name)) return false;
  return Boolean(clean(alert?.customer_name));
}

/**
 * Escopo geral (alertas/listas): platform/test têm prioridade sobre customer
 * quando a evidência de host/grupo é explícita (OV-P0-56).
 */
export function deriveOperationalScope(alert) {
  if (hasPlatformEvidence(alert)) {
    return {
      operational_scope: "platform",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.platform,
    };
  }

  if (hasTestEvidence(alert)) {
    return {
      operational_scope: "test",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.test,
    };
  }

  if (hasClassifiedCustomer(alert)) {
    return {
      operational_scope: "customer",
      operational_scope_label: clean(alert.customer_name),
    };
  }

  return {
    operational_scope: "unknown",
    operational_scope_label: OPERATIONAL_SCOPE_LABELS.unknown,
  };
}

/**
 * OV-P0-61 — contrato de apresentação de Eventos (Histórico).
 * customer existente → cliente
 * customer null + platform → Infraestrutura de monitoramento
 * customer null + test → Ambiente de teste
 * customer null + unknown → Cliente não identificado
 *
 * Não altera dados históricos; só deriva campos de apresentação.
 */
export function deriveHistoryEventOperationalScope(alert) {
  if (hasClassifiedCustomer(alert)) {
    return {
      operational_scope: "customer",
      operational_scope_label: clean(alert.customer_name),
    };
  }

  if (hasPlatformEvidence(alert)) {
    return {
      operational_scope: "platform",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.platform,
    };
  }

  if (hasTestEvidence(alert)) {
    return {
      operational_scope: "test",
      operational_scope_label: OPERATIONAL_SCOPE_LABELS.test,
    };
  }

  return {
    operational_scope: "unknown",
    operational_scope_label: OPERATIONAL_SCOPE_LABELS.unknown,
  };
}
