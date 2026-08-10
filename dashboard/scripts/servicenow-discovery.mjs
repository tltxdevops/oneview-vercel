/**
 * SN-P0-01B — Discovery Monitoramento (ServiceNow read-only GET).
 * Não grava no banco. Não altera frontend/BFF/deploy. Nunca imprime senha/token.
 *
 * Uso:
 *   node scripts/servicenow-discovery.mjs
 *   node scripts/servicenow-discovery.mjs --caller-id=<sys_id>
 *
 * Query fixa: contact_type=monitoring
 * Opcional: ^caller_id=<sys_id> via --caller-id
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGetAll,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
  SERVICENOW_INCIDENT_FIELDS_CSV,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const MONITORING_QUERY = "contact_type=monitoring";
const TOP_CALLERS = 10;
const RECENT_LIMIT = 5;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function asInt(value, fallback, { min = 1, max = 50_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function hostOnly(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function parseCallerIdFlag(argv) {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "").trim();
    if (arg === "--caller-id" || arg === "--caller_id") {
      return String(args[i + 1] || "").trim() || null;
    }
    const match = arg.match(/^--caller[-_]id=(.+)$/i);
    if (match) return String(match[1] || "").trim() || null;
  }
  return null;
}

function buildMonitoringQuery(callerId) {
  const caller = String(callerId || "").trim();
  if (!caller) return MONITORING_QUERY;
  return `${MONITORING_QUERY}^caller_id=${caller}`;
}

function withStableOrder(query) {
  return `${query}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`;
}

function fieldPair(raw) {
  const value = extractServiceNowValue(raw);
  const display = extractServiceNowDisplay(raw);
  if (value == null && display == null) return null;
  return {
    value,
    display_value: display && display !== value ? display : display || null,
  };
}

function collectCallers(records) {
  const bySysId = new Map();

  for (const raw of records) {
    const pair = fieldPair(raw?.caller_id);
    const sysId = pair?.value;
    if (!sysId) continue;

    const current = bySysId.get(sysId) || {
      display_value: null,
      sys_id: sysId,
      quantidade: 0,
    };
    current.quantidade += 1;
    if (!current.display_value && pair.display_value) {
      current.display_value = pair.display_value;
    }
    bySysId.set(sysId, current);
  }

  return [...bySysId.values()].sort(
    (a, b) => b.quantidade - a.quantidade
      || String(a.display_value || "").localeCompare(String(b.display_value || ""))
      || a.sys_id.localeCompare(b.sys_id),
  );
}

function truncateText(value, max = 160) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function recentIncident(raw) {
  const caller = fieldPair(raw?.caller_id);
  const contact = fieldPair(raw?.contact_type);
  const assignmentGroup = fieldPair(raw?.assignment_group);
  const assignedTo = fieldPair(raw?.assigned_to);
  const company = fieldPair(raw?.company);

  return {
    number: extractServiceNowValue(raw?.number),
    caller_id: caller,
    contact_type: contact,
    state: fieldPair(raw?.state),
    priority: fieldPair(raw?.priority),
    assignment_group: assignmentGroup,
    assigned_to: assignedTo,
    company,
    short_description: truncateText(extractServiceNowValue(raw?.short_description), 160),
    opened_at: extractServiceNowValue(raw?.opened_at),
    sys_updated_on: extractServiceNowValue(raw?.sys_updated_on),
    u_hostname_zabbix: extractServiceNowValue(raw?.u_hostname_zabbix),
    u_ip_zabbix: extractServiceNowValue(raw?.u_ip_zabbix),
    correlation_id: extractServiceNowValue(raw?.correlation_id),
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.error(JSON.stringify({
      event: "servicenow_discovery_failed",
      error: "servicenow_not_configured",
      hint: "Defina SERVICENOW_BASE_URL, SERVICENOW_USERNAME e SERVICENOW_PASSWORD no .env.local",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const callerId = parseCallerIdFlag(process.argv);
  const query = buildMonitoringQuery(callerId);
  const pageLimit = asInt(process.env.SERVICENOW_PAGE_LIMIT, config.defaultLimit, { min: 1, max: 1000 });
  const maxRecords = asInt(process.env.SERVICENOW_DISCOVERY_MAX_RECORDS, 500, { min: 1, max: 5000 });
  const orderedQuery = withStableOrder(query);

  const startedAt = Date.now();
  let pageResult;

  try {
    pageResult = await serviceNowGetAll("incident", {
      config,
      sysparm_query: orderedQuery,
      sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
      sysparm_limit: pageLimit,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
      maxRecords,
    });
  } catch (error) {
    const code = error instanceof ServiceNowClientError
      ? error.code
      : sanitizeServiceNowError(error);
    console.error(JSON.stringify({
      event: "servicenow_discovery_monitoramento_failed",
      error: code,
      status: error?.status ?? null,
      duration_ms: Date.now() - startedAt,
      base_host: hostOnly(config.baseUrl),
      query,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const records = pageResult.records;
  const callers = collectCallers(records);
  const topCallers = callers.slice(0, TOP_CALLERS);
  const recent = records.slice(0, RECENT_LIMIT).map((item) => recentIncident(item));

  const report = {
    event: "servicenow_discovery_sn_p0_01b_monitoramento",
    mode: "read_only_get",
    base_host: hostOnly(config.baseUrl),
    table: "incident",
    query,
    sysparm_display_value: "all",
    page_limit: pageLimit,
    max_records: maxRecords,
    total_retornado: records.length,
    x_total_count: pageResult.totalCount,
    paginas_consultadas: pageResult.pages,
    truncated: pageResult.truncated,
    duration_ms: Date.now() - startedAt,
    caller_id_agrupados: callers,
    caller_id_count: callers.length,
    top_10_callers: topCallers,
    incidentes_recentes: recent,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "servicenow_discovery_monitoramento_failed",
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
});
