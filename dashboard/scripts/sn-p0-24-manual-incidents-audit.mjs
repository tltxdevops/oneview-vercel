/**
 * SN-P0-24 — Auditar incidentes manuais vs automáticos Zabbix (somente GET).
 * Não altera BFF/DB/FE. Nunca imprime senha/token.
 *
 * Uso: node scripts/sn-p0-24-manual-incidents-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  mapAggregateGroupCounts,
  sanitizeServiceNowError,
  serviceNowGet,
  serviceNowStats,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const COMPARE_FIELDS = [
  "number",
  "caller_id",
  "contact_type",
  "company",
  "assignment_group",
  "assigned_to",
  "state",
  "priority",
  "opened_by",
  "sys_created_by",
];
const EXTRA_FIELDS = [
  "short_description",
  "sys_created_on",
  "opened_at",
  "u_hostname_zabbix",
  "correlation_id",
  "description",
];
const FIELDS_CSV = [...new Set([...COMPARE_FIELDS, ...EXTRA_FIELDS])].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : "";
}

function resolveZabbixCallerId(config) {
  return argValue("caller-id") || String(config.zabbixMonitoringCallerId || "").trim();
}

/** Seed opcional NOC via env CSV (primeiro id) ou --noc-caller-id — sem hardcode DEV. */
function resolveNocCallerId(config) {
  const fromArg = argValue("noc-caller-id");
  if (fromArg) return fromArg;
  const seeds = Array.isArray(config.callerFilterSeeds) ? config.callerFilterSeeds : [];
  return seeds[0] || "";
}

function pair(raw) {
  const value = extractServiceNowValue(raw);
  const display = extractServiceNowDisplay(raw);
  if (value == null && display == null) return { value: null, display: null };
  return {
    value,
    display: display && display !== value ? display : display || value,
  };
}

function pick(row) {
  const out = {};
  for (const field of COMPARE_FIELDS) {
    const p = pair(row?.[field]);
    out[field] = p.value;
    out[`${field}_display`] = p.display;
  }
  out.short_description = extractServiceNowValue(row?.short_description);
  out.sys_created_on = extractServiceNowValue(row?.sys_created_on);
  out.opened_at = extractServiceNowValue(row?.opened_at);
  out.u_hostname_zabbix = extractServiceNowValue(row?.u_hostname_zabbix);
  out.correlation_id = extractServiceNowValue(row?.correlation_id);
  const desc = String(extractServiceNowValue(row?.description) || "");
  out.has_eventid = /eventid[=:]?\s*\d+/i.test(desc) || /tr_events\.php\?[^\s]*eventid=\d+/i.test(desc);
  out.has_zabbix_link = /zabbix/i.test(desc);
  return out;
}

function uniqCounts(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key] ?? "(null)";
    const display = row[`${key}_display`] || value;
    const label = value === "(null)" ? "(null)" : `${value} | ${display}`;
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
}

async function fetchList(config, query, limit) {
  const res = await serviceNowGet("incident", {
    sysparm_query: `${query}^ORDERBYDESCsys_created_on`,
    sysparm_fields: FIELDS_CSV,
    sysparm_limit: limit,
    sysparm_offset: 0,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  }, { config });
  return {
    total: res.totalCount,
    rows: (res.records || []).map(pick),
  };
}

async function groupBy(config, query, field) {
  const res = await serviceNowStats("incident", {
    sysparm_query: query,
    sysparm_count: "true",
    sysparm_group_by: field,
  }, { config });
  return mapAggregateGroupCounts(res.rows, field);
}

function printGroup(title, rows, key) {
  console.log(`\n## ${title} — distribuição ${key}`);
  for (const item of uniqCounts(rows, key)) {
    console.log(`  ${item.count}×  ${item.label}`);
  }
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    throw new ServiceNowClientError("servicenow_not_configured");
  }

  const ZABBIX_CALLER_ID = resolveZabbixCallerId(config);
  if (!ZABBIX_CALLER_ID) {
    throw new ServiceNowClientError("servicenow_caller_not_configured");
  }
  const nocCallerId = resolveNocCallerId(config);

  console.log(JSON.stringify({
    audit: "SN-P0-24",
    host: new URL(config.baseUrl).host,
    method: "GET",
    zabbix_caller_id: ZABBIX_CALLER_ID,
    noc_caller_id: nocCallerId || null,
  }, null, 2));

  const autoQuery = `contact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}`;
  const auto = await fetchList(config, autoQuery, 10);

  // Candidatos manuais NOC (várias sondas GET)
  const probes = [
    {
      id: "monitoring_not_zabbix_caller",
      query: `contact_type=monitoring^caller_id!=${ZABBIX_CALLER_ID}`,
      limit: 20,
    },
    {
      id: "assignment_group_LIKE_NOC",
      query: "assignment_group.nameLIKENOC",
      limit: 20,
    },
    {
      id: "opened_by_LIKE_NOC",
      query: "opened_by.nameLIKENOC",
      limit: 10,
    },
    {
      id: "short_description_LIKE_NOC_manual_hint",
      query: "short_descriptionLIKENOC^ORdescriptionLIKEabertura manual^ORshort_descriptionLIKEmanual",
      limit: 10,
    },
    {
      id: "contact_portal_teletex",
      query: "contact_type=portal_teletex",
      limit: 15,
    },
    {
      id: "contact_email",
      query: "contact_type=email",
      limit: 15,
    },
    {
      id: "contact_portal_csm",
      query: "contact_type=portal_csm",
      limit: 10,
    },
  ];
  if (nocCallerId) {
    probes.push({
      id: "caller_NOC_Protege",
      query: `caller_id=${nocCallerId}`,
      limit: 10,
    });
  }

  const probeResults = {};
  for (const probe of probes) {
    try {
      const data = await fetchList(config, probe.query, probe.limit);
      probeResults[probe.id] = {
        query: probe.query,
        total: data.total,
        sample_size: data.rows.length,
        contact_types: uniqCounts(data.rows, "contact_type"),
        callers: uniqCounts(data.rows, "caller_id").slice(0, 8),
        opened_by: uniqCounts(data.rows, "opened_by").slice(0, 8),
        sys_created_by: uniqCounts(data.rows, "sys_created_by").slice(0, 8),
        assignment_group: uniqCounts(data.rows, "assignment_group").slice(0, 8),
        rows: data.rows.slice(0, 10),
      };
    } catch (error) {
      probeResults[probe.id] = {
        query: probe.query,
        error: sanitizeServiceNowError(error),
      };
    }
  }

  // Stats globais de contact_type (amostra ampla sem filtro = pode ser grande; usar sem filtro com group)
  let contactTypeGlobal = null;
  try {
    contactTypeGlobal = await groupBy(config, "", "contact_type");
  } catch (error) {
    contactTypeGlobal = { error: sanitizeServiceNowError(error) };
  }

  let monitoringCallerGlobal = null;
  try {
    monitoringCallerGlobal = await groupBy(config, "contact_type=monitoring", "caller_id");
  } catch (error) {
    monitoringCallerGlobal = { error: sanitizeServiceNowError(error) };
  }

  // Selecionar 10 manuais "conhecidos": preferir caller NOC / assignment NOC / monitoring≠zabbix
  const manualPool = [];
  const seen = new Set();
  function pushManual(source, rows) {
    for (const row of rows || []) {
      if (!row?.number || seen.has(row.number)) continue;
      // Excluir automáticos Zabbix óbvios
      if (row.caller_id === ZABBIX_CALLER_ID && row.contact_type === "monitoring") continue;
      seen.add(row.number);
      manualPool.push({ source, ...row });
      if (manualPool.length >= 10) return true;
    }
    return false;
  }

  const preference = [
    "caller_NOC_Protege",
    "monitoring_not_zabbix_caller",
    "assignment_group_LIKE_NOC",
    "opened_by_LIKE_NOC",
    "contact_portal_teletex",
    "contact_email",
  ];
  for (const id of preference) {
    if (pushManual(id, probeResults[id]?.rows)) break;
  }

  console.log("\n========== AUTO (Zabbix) ==========");
  console.log(JSON.stringify({
    query: autoQuery,
    total: auto.total,
    sample: auto.rows,
    contact_type: uniqCounts(auto.rows, "contact_type"),
    caller_id: uniqCounts(auto.rows, "caller_id"),
    opened_by: uniqCounts(auto.rows, "opened_by"),
    sys_created_by: uniqCounts(auto.rows, "sys_created_by"),
    assignment_group: uniqCounts(auto.rows, "assignment_group"),
    company: uniqCounts(auto.rows, "company"),
    has_eventid: auto.rows.filter((r) => r.has_eventid).length,
  }, null, 2));

  console.log("\n========== MANUAL CANDIDATES (10) ==========");
  console.log(JSON.stringify({
    selected: manualPool,
    contact_type: uniqCounts(manualPool, "contact_type"),
    caller_id: uniqCounts(manualPool, "caller_id"),
    opened_by: uniqCounts(manualPool, "opened_by"),
    sys_created_by: uniqCounts(manualPool, "sys_created_by"),
    assignment_group: uniqCounts(manualPool, "assignment_group"),
    company: uniqCounts(manualPool, "company"),
    has_eventid: manualPool.filter((r) => r.has_eventid).length,
  }, null, 2));

  console.log("\n========== PROBES ==========");
  for (const [id, data] of Object.entries(probeResults)) {
    console.log(`\n### ${id}`);
    console.log(JSON.stringify({
      query: data.query,
      total: data.total,
      sample_size: data.sample_size,
      error: data.error,
      contact_types: data.contact_types,
      callers: data.callers,
      opened_by: data.opened_by,
      sys_created_by: data.sys_created_by,
      assignment_group: data.assignment_group,
      numbers: (data.rows || []).map((r) => r.number),
    }, null, 2));
  }

  console.log("\n========== GLOBAL STATS ==========");
  console.log(JSON.stringify({
    contact_type_all: contactTypeGlobal,
    callers_in_monitoring: monitoringCallerGlobal,
  }, null, 2));

  // Comparativo lado a lado compacto
  console.log("\n========== SIDE-BY-SIDE ==========");
  const compact = (row) => ({
    number: row.number,
    contact_type: row.contact_type_display || row.contact_type,
    caller: row.caller_id_display || row.caller_id,
    company: row.company_display || row.company,
    assignment_group: row.assignment_group_display || row.assignment_group,
    assigned_to: row.assigned_to_display || row.assigned_to,
    state: row.state_display || row.state,
    priority: row.priority_display || row.priority,
    opened_by: row.opened_by_display || row.opened_by,
    sys_created_by: row.sys_created_by_display || row.sys_created_by,
    eventid: row.has_eventid,
    source: row.source || "auto_zabbix",
  });
  console.log(JSON.stringify({
    auto: auto.rows.map(compact),
    manual: manualPool.map(compact),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
});
