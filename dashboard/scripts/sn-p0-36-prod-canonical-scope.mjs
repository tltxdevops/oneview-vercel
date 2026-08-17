/**
 * SN-P0-36 — PROD Canonical Incident Scope (GET-only).
 *
 * Compara A/B/C/D na instância PROD. Não altera runtime, não grava .env,
 * não imprime username/password. Sem POST/PATCH/DELETE.
 *
 * Uso (credenciais PROD só na sessão):
 *   $env:SERVICENOW_BASE_URL="https://<PROD>.service-now.com"
 *   $env:SERVICENOW_USERNAME="..."
 *   $env:SERVICENOW_PASSWORD="..."
 *   $env:SERVICENOW_ZABBIX_MONITORING_CALLER_ID="<sys_id>"
 *   node scripts/sn-p0-36-prod-canonical-scope.mjs
 *
 * Opcional:
 *   --caller-id=<sys_id>
 *   --from=2026-08-01 --to=2026-08-13
 *   --allow-dev   (recusado por padrão)
 *   --load-local-env
 *   --override-host=<prod.service-now.com>  (in-memory; não grava arquivo)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  mapAggregateGroupCounts,
  sanitizeServiceNowError,
  serviceNowGet,
  serviceNowStats,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
} from "../api/_lib/servicenow-normalize.js";
import { buildIncidentSysparmQuery, parseIncidentFilters } from "../api/_lib/oneview-incidents.js";

const INFORMED_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
const SAMPLE = 20;
const FIELDS = [
  "sys_id",
  "number",
  "opened_at",
  "sys_updated_on",
  "state",
  "priority",
  "caller_id",
  "contact_type",
  "assigned_to",
  "assignment_group",
  "company",
  "short_description",
].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function hostOnly(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

function looksLikeDevHost(host) {
  const h = String(host || "").toLowerCase();
  return h.includes("dev") || h.includes("test") || h.includes("sandbox");
}

function pair(raw) {
  return {
    value: extractServiceNowValue(raw) || null,
    display: extractServiceNowDisplay(raw) || extractServiceNowValue(raw) || null,
  };
}

function tally(records, keyOf) {
  const map = new Map();
  for (const raw of records) {
    const value = keyOf(raw);
    const id = value.value || "(null)";
    const display = value.display || id;
    const cur = map.get(id) || { value: id, display_value: display, count: 0 };
    cur.count += 1;
    if (display && display !== id) cur.display_value = display;
    map.set(id, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || String(a.display_value).localeCompare(String(b.display_value)));
}

async function countQuery(config, sysparm_query) {
  const stats = await serviceNowStats("incident", {
    config,
    sysparm_query: sysparm_query || undefined,
    sysparm_count: "true",
  }).catch(() => null);
  const n = Number(stats?.total);
  if (Number.isFinite(n)) return n;
  const page = await serviceNowGet("incident", {
    config,
    sysparm_query: sysparm_query || undefined,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_display_value: "false",
  });
  return Number.isFinite(page.totalCount) ? page.totalCount : page.count;
}

async function sample(config, sysparm_query, limit = SAMPLE) {
  return serviceNowGet("incident", {
    config,
    sysparm_query,
    sysparm_fields: FIELDS,
    sysparm_limit: limit,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });
}

async function oldest(config, filterQuery) {
  const page = await sample(config, `${filterQuery}^ORDERBYopened_at`, 1);
  return extractServiceNowValue(page.records?.[0]?.opened_at) || null;
}

async function newest(config, filterQuery) {
  const page = await sample(config, `${filterQuery}^ORDERBYDESCopened_at`, 1);
  return extractServiceNowValue(page.records?.[0]?.opened_at) || null;
}

async function groupCounts(config, baseQuery, field) {
  try {
    const stats = await serviceNowStats("incident", {
      config,
      sysparm_count: true,
      sysparm_group_by: field,
      sysparm_query: baseQuery || undefined,
    });
    return Object.entries(mapAggregateGroupCounts(stats.rows, field))
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
  } catch {
    return null;
  }
}

async function assignedSplit(config, baseQuery) {
  const prefix = baseQuery ? `${baseQuery}^` : "";
  try {
    const [assigned, unassigned] = await Promise.all([
      countQuery(config, `${prefix}assigned_toISNOTEMPTY`),
      countQuery(config, `${prefix}assigned_toISEMPTY`),
    ]);
    return { assigned, unassigned };
  } catch {
    return { assigned: null, unassigned: null };
  }
}

function summarizeSample(records) {
  const opened = records.map((r) => extractServiceNowValue(r.opened_at)).filter(Boolean).sort();
  return {
    sample_size: records.length,
    states_in_sample: tally(records, (r) => pair(r.state)),
    priorities_in_sample: tally(records, (r) => pair(r.priority)),
    callers_in_sample: tally(records, (r) => pair(r.caller_id)),
    contact_types_in_sample: tally(records, (r) => pair(r.contact_type)),
    assigned_in_sample: records.filter((r) => Boolean(extractServiceNowValue(r.assigned_to))).length,
    unassigned_in_sample: records.filter((r) => !extractServiceNowValue(r.assigned_to)).length,
    sample_opened_newest: opened.length ? opened[opened.length - 1] : null,
    sample_opened_oldest: opened.length ? opened[0] : null,
    examples: records.slice(0, SAMPLE).map((raw) => ({
      number: extractServiceNowValue(raw.number),
      sys_id: extractServiceNowValue(raw.sys_id),
      opened_at: extractServiceNowValue(raw.opened_at),
      state: pair(raw.state),
      priority: pair(raw.priority),
      assigned_to: pair(raw.assigned_to),
      caller_id: pair(raw.caller_id),
      contact_type: pair(raw.contact_type),
      company: pair(raw.company),
      short_description: String(extractServiceNowValue(raw.short_description) || "").slice(0, 100),
    })),
  };
}

async function auditUniverse(config, { id, label, filter }) {
  const total = await countQuery(config, filter);
  const ordered = filter
    ? `${filter}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`
    : "ORDERBYDESCsys_updated_on^ORDERBYsys_id";
  const page = await sample(config, ordered, SAMPLE);
  const summary = summarizeSample(page.records || []);
  const [openedNewest, openedOldest, states, priorities, split] = await Promise.all([
    total > 0 ? newest(config, filter || "sys_idISNOTEMPTY") : Promise.resolve(null),
    total > 0 ? oldest(config, filter || "sys_idISNOTEMPTY") : Promise.resolve(null),
    groupCounts(config, filter, "state"),
    groupCounts(config, filter, "priority"),
    assignedSplit(config, filter),
  ]);
  return {
    id,
    label,
    sysparm_query: filter || "(none)",
    totalCount: total,
    opened_at_newest: openedNewest,
    opened_at_oldest: openedOldest,
    states: states || summary.states_in_sample,
    priorities: priorities || summary.priorities_in_sample,
    assigned: split.assigned,
    unassigned: split.unassigned,
    ...summary,
  };
}

async function confirmCaller(config, callerId) {
  const byId = await serviceNowGet("sys_user", {
    config,
    sysparm_query: `sys_id=${callerId}`,
    sysparm_fields: "sys_id,user_name,name,active",
    sysparm_limit: 5,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  }).catch((error) => ({ error: sanitizeServiceNowError(error), records: [] }));

  const byName = await serviceNowGet("sys_user", {
    config,
    sysparm_query: "nameLIKEzabbix^ORuser_nameLIKEzabbix^ORDERBYname",
    sysparm_fields: "sys_id,user_name,name,active",
    sysparm_limit: 25,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  }).catch((error) => ({ error: sanitizeServiceNowError(error), records: [] }));

  const userHit = (byId.records || [])[0] || null;
  const nameHits = (byName.records || []).map((raw) => ({
    sys_id: extractServiceNowValue(raw.sys_id),
    user_name: extractServiceNowValue(raw.user_name),
    name: extractServiceNowDisplay(raw.name) || extractServiceNowValue(raw.name),
    active: extractServiceNowValue(raw.active),
  }));

  return {
    informed_sys_id: callerId,
    exists_as_sys_user: Boolean(userHit),
    sys_user: userHit
      ? {
        sys_id: extractServiceNowValue(userHit.sys_id),
        user_name: extractServiceNowValue(userHit.user_name),
        name: extractServiceNowDisplay(userHit.name) || extractServiceNowValue(userHit.name),
        active: extractServiceNowValue(userHit.active),
      }
      : null,
    name_search_zabbix: nameHits,
    by_id_error: byId.error || null,
    by_name_error: byName.error || null,
  };
}

async function main() {
  if (hasFlag("load-local-env")) {
    const { loadLocalEnv } = await import("./_lib/local-env.mjs");
    loadLocalEnv(path.join(rootDir, ".env.local"));
  }

  const overrideHost = argValue("override-host");
  if (overrideHost) {
    const host = overrideHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    process.env.SERVICENOW_BASE_URL = `https://${host}`;
  }

  const config = getServiceNowConfig();
  const host = hostOnly(config.baseUrl);
  const callerId = (
    argValue("caller-id")
    || config.zabbixMonitoringCallerId
    || INFORMED_CALLER_ID
  ).toLowerCase();
  const openedFrom = argValue("from", "2026-08-01");
  const openedTo = argValue("to", "2026-08-13");
  const window = `opened_at>=${openedFrom} 00:00:00^opened_at<=${openedTo} 23:59:59`;

  const report = {
    card: "SN-P0-36",
    audited_at: new Date().toISOString(),
    method: "GET-only Table + Stats API",
    env_file_written: false,
    credentials_printed: false,
    effective: {
      hostname: host,
      scheme_host: config.baseUrl ? `${new URL(config.baseUrl).protocol}//${host}` : null,
      configured: config.configured,
      is_dev_hostname: looksLikeDevHost(host),
      override_host_in_memory: Boolean(overrideHost),
      caller_id_source: argValue("caller-id")
        ? "cli"
        : (config.zabbixMonitoringCallerId ? "env" : "informed_constant_sn_p0_35"),
      caller_id: callerId,
      window: { opened_from: openedFrom, opened_to: openedTo },
    },
    bff_today: {
      chamados_default: buildIncidentSysparmQuery(parseIncidentFilters({ query: {} })),
      implicit: ["contact_type=monitoring"],
      caller_id_default: false,
      correlation: "contact_type=monitoring^caller_id=<SERVICENOW_ZABBIX_MONITORING_CALLER_ID>^descriptionLIKEeventid=",
    },
    blocked: null,
    error: null,
  };

  if (!config.configured) {
    report.blocked = "servicenow_not_configured";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  if (looksLikeDevHost(host) && !hasFlag("allow-dev")) {
    report.blocked = "refusing_dev_host";
    report.hint = "Forneça PROD via sessão ou --override-host=<prod.service-now.com> (in-memory). .env.local não é gravado.";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  const queryA = "";
  const queryB = `caller_id=${callerId}^${window}`;
  const queryC = "contact_type=monitoring";
  const queryD = `caller_id=${callerId}^contact_type=monitoring`;
  const queryCWindow = `contact_type=monitoring^${window}`;
  const queryDWindow = `caller_id=${callerId}^contact_type=monitoring^${window}`;

  try {
    report.caller_identity = await confirmCaller(config, callerId);

    const [A, B, C, D] = await Promise.all([
      auditUniverse(config, { id: "A", label: "todos os incidentes visíveis à ACL", filter: queryA }),
      auditUniverse(config, { id: "B", label: "caller_id + janela opened_at", filter: queryB }),
      auditUniverse(config, { id: "C", label: "contact_type=monitoring (BFF /chamados)", filter: queryC }),
      auditUniverse(config, { id: "D", label: "caller_id + contact_type=monitoring", filter: queryD }),
    ]);
    report.universes = { A, B, C, D };

    const [
      bNotMonitoring,
      bMonitoringEmpty,
      cNotCaller,
      dWindow,
      cWindow,
      bOutsideWindowInD,
    ] = await Promise.all([
      countQuery(config, `${queryB}^contact_type!=monitoring`),
      countQuery(config, `${queryB}^contact_typeISEMPTY`),
      countQuery(config, `${queryC}^caller_id!=${callerId}`),
      countQuery(config, queryDWindow),
      countQuery(config, queryCWindow),
      countQuery(config, `${queryD}^${window.replace(/^/, "")}`.replace("^^", "^")),
    ]);

    const bMinusC = (bNotMonitoring || 0) + (bMonitoringEmpty || 0);
    const dMinusC = 0;
    const bMinusD = bMinusC;
    const cMinusBApprox = Math.max(0, (C.totalCount || 0) - (dWindow || 0));

    const bNotMonSample = await sample(
      config,
      `${queryB}^contact_type!=monitoring^ORDERBYDESCopened_at`,
      SAMPLE,
    ).catch(() => ({ records: [] }));
    const cNotCallerSample = await sample(
      config,
      `${queryC}^caller_id!=${callerId}^ORDERBYDESCsys_updated_on`,
      SAMPLE,
    ).catch(() => ({ records: [] }));

    report.diffs = {
      notes: {
        "B-C": "INC do caller na janela cujo contact_type ≠ monitoring (ou vazio). Estes somem do BFF atual.",
        "C-B": "INC monitoring que não são do caller informado e/ou estão fora da janela B.",
        "B-D": "Igual a B-C quando D = caller∩monitoring (D sem janela: B-D = B sem monitoring).",
        "D-C": "Deve ser 0 se D ⊆ C.",
      },
      "B-C": {
        count: bMinusC,
        contact_type_not_monitoring: bNotMonitoring,
        contact_type_empty: bMonitoringEmpty,
        sample: summarizeSample(bNotMonSample.records || []).examples,
      },
      "C-B": {
        count_approx: cMinusBApprox,
        monitoring_not_this_caller: cNotCaller,
        monitoring_in_window: cWindow,
        caller_monitoring_in_window: dWindow,
        sample_monitoring_other_caller: summarizeSample(cNotCallerSample.records || []).examples,
      },
      "B-D": {
        count: bMinusD,
        interpretation: "caller+janela fora de contact_type=monitoring",
      },
      "D-C": {
        count: dMinusC,
        interpretation: "D é interseção caller∩monitoring ⊆ C",
      },
    };

    report.contact_type_consistency_on_caller = {
      caller_all_time: D.totalCount,
      caller_in_window: B.totalCount,
      caller_monitoring_in_window: dWindow,
      caller_window_excluded_by_contact_type: bMinusC,
      pct_caller_window_with_monitoring: B.totalCount
        ? Number(((((B.totalCount || 0) - bMinusC) / B.totalCount) * 100).toFixed(1))
        : null,
    };

    const callerExists = report.caller_identity.exists_as_sys_user || (B.totalCount || 0) > 0 || (D.totalCount || 0) > 0;
    const bffExcludesValidCaller = bMinusC > 0;
    const monitoringBroaderThanCaller = (C.totalCount || 0) > (D.totalCount || 0);

    report.recommendation = {
      canonical_query: monitoringBroaderThanCaller && (D.totalCount || 0) > 0
        ? "contact_type=monitoring"
        : ((D.totalCount || 0) > 0 ? "contact_type=monitoring^caller_id=<ZABBIX_PROD>" : "INCONCLUSIVO — caller informado pode não existir em PROD"),
      complementary_query: monitoringBroaderThanCaller
        ? "Filtro opcional UX: caller_id=<ZABBIX_PROD> para recorte automático Zabbix"
        : (bffExcludesValidCaller
          ? "Se o processo PROD criar INC Zabbix sem contact_type=monitoring, complementar com caller_id=<ZABBIX_PROD> (união), não interseção"
          : null),
      bff_today_excludes_valid: bffExcludesValidCaller,
      caller_exists_in_prod: callerExists,
      rationale: null,
    };

    if (!callerExists) {
      report.recommendation.rationale =
        "O sys_id informado não aparece como sys_user nem em incidentes PROD. Correlation alerta→INC com esse ID fica vazia. Universo /chamados (só monitoring) é independente do caller.";
      report.recommendation.canonical_query = "contact_type=monitoring";
      report.recommendation.complementary_query =
        "Descobrir sys_id PROD de 'zabbix monitoring' via name_search_zabbix e gravar só em secret store (não copiar ID DEV).";
    } else if (bffExcludesValidCaller) {
      report.recommendation.canonical_query = "contact_type=monitoring";
      report.recommendation.complementary_query =
        "Não estreitar /chamados para caller_id. Correlation deve usar caller PROD + monitoring. INC do caller sem contact_type=monitoring ficam de fora do OneView hoje — se forem operacionais, o processo SN precisa setar contact_type (não o BFF inventar fallback).";
      report.recommendation.rationale =
        "BFF /chamados = contact_type=monitoring. INC do caller Zabbix sem esse contact_type existem em B e não em C.";
    } else if (monitoringBroaderThanCaller) {
      report.recommendation.canonical_query = "contact_type=monitoring";
      report.recommendation.complementary_query =
        "caller_id=<ZABBIX_PROD> só como filtro opcional e na correlação alerta→INC (não como universo de /chamados).";
      report.recommendation.rationale =
        "C ⊃ D: monitoring inclui automação Zabbix e chamados manuais NOC. SN-P0-25 já trata isso como universo canônico.";
    } else {
      report.recommendation.canonical_query = "contact_type=monitoring";
      report.recommendation.rationale = "C e D coincidem na prática; monitoring continua o predicado estável.";
    }
  } catch (error) {
    report.error = {
      code: error?.code || error?.name || "error",
      message: sanitizeServiceNowError(error),
      status: error?.status ?? null,
    };
    process.exitCode = 1;
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
