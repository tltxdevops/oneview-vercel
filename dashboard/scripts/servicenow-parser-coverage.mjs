/**
 * SN-P0-06 — cobertura do parser Zabbix em description (somente GET).
 * Sem banco/frontend/deploy. Não relaciona registros.
 *
 * Uso:
 *   node scripts/servicenow-parser-coverage.mjs
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
  normalizeServiceNowIncidents,
  sanitizeIncidentExample,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const MAX_RECORDS = 500;
const FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "caller_id",
  "contact_type",
  "opened_at",
  "sys_updated_on",
  "correlation_id",
  "u_hostname_zabbix",
  "u_ip_zabbix",
].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
}

function resolveZabbixCallerId(config) {
  return argValue("caller-id") || String(config.zabbixMonitoringCallerId || "").trim();
}

function pct(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

function hostOnly(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.error(JSON.stringify({
      event: "servicenow_parser_coverage_failed",
      error: "servicenow_not_configured",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const zabbixCallerId = resolveZabbixCallerId(config);
  if (!zabbixCallerId) {
    console.error(JSON.stringify({
      event: "servicenow_parser_coverage_failed",
      error: "servicenow_caller_not_configured",
      hint: "Defina SERVICENOW_ZABBIX_MONITORING_CALLER_ID ou --caller-id=",
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const QUERY = `contact_type=monitoring^caller_id=${zabbixCallerId}`;

  const startedAt = Date.now();
  let pageResult;
  try {
    pageResult = await serviceNowGetAll("incident", {
      config,
      sysparm_query: `${QUERY}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`,
      sysparm_fields: FIELDS,
      sysparm_limit: 100,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
      maxRecords: MAX_RECORDS,
    });
  } catch (error) {
    const code = error instanceof ServiceNowClientError
      ? error.code
      : sanitizeServiceNowError(error);
    console.error(JSON.stringify({
      event: "servicenow_parser_coverage_failed",
      error: code,
      status: error?.status ?? null,
      duration_ms: Date.now() - startedAt,
      base_host: hostOnly(config.baseUrl),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const normalized = normalizeServiceNowIncidents(pageResult.records);
  const total = normalized.length;
  const withEventId = normalized.filter((item) => item.zabbix_event_id).length;
  const withHost = normalized.filter((item) => item.zabbix_host).length;
  const withIp = normalized.filter((item) => item.zabbix_ip).length;
  const withAll = normalized.filter(
    (item) => item.zabbix_event_id && item.zabbix_host && item.zabbix_ip,
  ).length;
  const withEventAndHost = normalized.filter(
    (item) => item.zabbix_event_id && item.zabbix_host,
  ).length;

  const report = {
    event: "servicenow_parser_coverage_sn_p0_06",
    mode: "read_only_get",
    base_host: hostOnly(config.baseUrl),
    query: QUERY,
    sample_size: total,
    x_total_count: pageResult.totalCount,
    truncated: pageResult.truncated,
    duration_ms: Date.now() - startedAt,
    cobertura: {
      zabbix_event_id: { count: withEventId, pct: pct(withEventId, total) },
      zabbix_host: { count: withHost, pct: pct(withHost, total) },
      zabbix_ip: { count: withIp, pct: pct(withIp, total) },
      event_id_and_host: { count: withEventAndHost, pct: pct(withEventAndHost, total) },
      all_three: { count: withAll, pct: pct(withAll, total) },
    },
    exemplos_sanitizados: normalized.slice(0, 5).map((item) => sanitizeIncidentExample(item)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "servicenow_parser_coverage_failed",
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
});
