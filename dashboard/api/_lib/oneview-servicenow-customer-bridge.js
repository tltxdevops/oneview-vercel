/**
 * Ponte read-only: empresa ServiceNow → cliente operacional / fonte Zabbix dedicada.
 * Usado em filtros de Chamados e correlação incidente ↔ alerta (ex.: MAPS).
 */
import { DEDICATED_DATASOURCE_CUSTOMER_LABELS } from "./oneview-scope.js";

const BRIDGES = Object.freeze([
  {
    operationalKey: "maps",
    datasource: "maps",
    label: DEDICATED_DATASOURCE_CUSTOMER_LABELS.maps || "MAPS",
    companyPattern: /\bmaps\b/i,
  },
]);

function text(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function displayBag(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve rótulo humano da empresa SN (sys_id + display_values). */
export function resolveServiceNowCompanyLabelFromRow({ company = null, display_values = null } = {}) {
  const values = displayBag(display_values);
  return text(values.company) || text(company);
}

/** SQL read-only: empresa MAPS no read model ServiceNow. */
export const MAPS_SERVICENOW_COMPANY_WHERE_SQL = `(
  lower(coalesce(display_values->>'company', '')) like '%maps%'
  or lower(coalesce(display_values::text, '')) like '%maps s.a%'
)`;

/** @returns {{ operationalKey: string, datasource: string, label: string } | null} */
export function matchServiceNowOperationalBridge(company) {
  const haystack = text(company);
  if (!haystack) return null;
  for (const bridge of BRIDGES) {
    if (bridge.companyPattern.test(haystack)) {
      return {
        operationalKey: bridge.operationalKey,
        datasource: bridge.datasource,
        label: bridge.label,
      };
    }
  }
  return null;
}

/**
 * Expande token de filtro `company=` quando o usuário escolhe cliente operacional (ex.: maps).
 * @returns {{ terms: string[], bridge: ReturnType<typeof matchServiceNowOperationalBridge> }}
 */
export function expandServiceNowCompanyFilterToken(token) {
  const raw = text(token);
  if (!raw) return { terms: [], bridge: null };
  const normalized = raw.toLowerCase();
  const bridge = BRIDGES.find((item) => item.operationalKey === normalized) || null;
  if (bridge) {
    return { terms: [bridge.label, bridge.operationalKey], bridge };
  }
  return { terms: [raw], bridge: matchServiceNowOperationalBridge(raw) };
}

/** Normaliza texto do problema Zabbix para busca na description do chamado MAPS. */
export function mapsServiceNowProblemCorrelationToken(problemName) {
  let problem = String(problemName || "").trim().replace(/\{\$[^}]+\}/g, "").replace(/\s+/g, " ");
  if (!problem) return null;
  const vpnMatch = problem.match(/\bvpn\s+ipsec\s+(.+?)\s+is\b/i);
  if (vpnMatch?.[1]) return vpnMatch[1].trim().slice(0, 120);
  if (problem.length > 160) return problem.slice(0, 160);
  return problem;
}

export function resolveServiceNowIncidentCustomerLabel(company, companyDisplay = null) {
  const bridge = matchServiceNowOperationalBridge(companyDisplay || company);
  if (bridge) return bridge.label;
  return text(companyDisplay) || text(company);
}
