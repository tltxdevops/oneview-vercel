/**
 * SN-P0-34 — ServiceNow PROD Window Audit (somente GET / read-only).
 *
 * Compara AUTO ZABBIX (caller_id) vs UNIVERSO MONITORAMENTO (contact_type=monitoring)
 * em janelas de opened_at. Não altera BFF/integração. Não grava .env.
 * Nunca imprime password/token/username.
 *
 * Uso (credenciais PROD só na sessão — não grava arquivo):
 *   $env:SERVICENOW_BASE_URL="https://<PROD>.service-now.com"
 *   $env:SERVICENOW_USERNAME="..."
 *   $env:SERVICENOW_PASSWORD="..."
 *   $env:SERVICENOW_ZABBIX_MONITORING_CALLER_ID="aa62f29f47477610082e3d02e26d4358"
 *   node scripts/sn-p0-34-prod-window-audit.mjs
 *
 * Opcional:
 *   --caller-id=<sys_id>
 *   --allow-dev   (só se quiser auditar DEV de propósito; default recusa *dev*)
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

const CANDIDATE_PROD_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
const EXAMPLE_LIMIT = 10;
const SAMPLE_SCAN_LIMIT = 100;
const TZ = "America/Sao_Paulo";

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

/** Formata Date → "YYYY-MM-DD HH:mm:ss" no fuso America/Sao_Paulo (ServiceNow opened_at). */
function formatSnLocal(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function startOfLocalDay(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // Meia-noite SP ≈ 03:00 UTC (sem DST fixo; suficiente para janela operacional).
  return new Date(`${ymd}T03:00:00.000Z`);
}

function buildPeriods(now = new Date()) {
  const todayStart = startOfLocalDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  return [
    {
      id: "hoje",
      label: "hoje (desde 00:00 America/Sao_Paulo)",
      from: formatSnLocal(todayStart),
      to: formatSnLocal(now),
    },
    {
      id: "ultimas_24h",
      label: "últimas 24h",
      from: formatSnLocal(new Date(now.getTime() - dayMs)),
      to: formatSnLocal(now),
    },
    {
      id: "ultimos_7d",
      label: "últimos 7 dias",
      from: formatSnLocal(new Date(now.getTime() - 7 * dayMs)),
      to: formatSnLocal(now),
    },
    {
      id: "ago_01_12_2026",
      label: "01/08/2026 até 12/08/2026",
      from: "2026-08-01 00:00:00",
      to: "2026-08-12 23:59:59",
    },
  ];
}

function openedAtRange(from, to) {
  return `opened_at>=${from}^opened_at<=${to}`;
}

function buildAutoQuery(callerId, from, to) {
  return `caller_id=${callerId}^${openedAtRange(from, to)}^ORDERBYDESCopened_at`;
}

function buildUniverseQuery(from, to) {
  return `contact_type=monitoring^${openedAtRange(from, to)}^ORDERBYDESCopened_at`;
}

async function countQuery(config, sysparm_query) {
  const page = await serviceNowGet("incident", {
    config,
    sysparm_query,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_display_value: "false",
  });
  return Number.isFinite(page.totalCount) ? page.totalCount : page.count;
}

async function samplePage(config, sysparm_query, limit = SAMPLE_SCAN_LIMIT) {
  return serviceNowGet("incident", {
    config,
    sysparm_query,
    sysparm_fields: [
      "sys_id",
      "number",
      "short_description",
      "opened_at",
      "sys_updated_on",
      "state",
      "priority",
      "caller_id",
      "contact_type",
      "assigned_to",
      "assignment_group",
      "company",
    ].join(","),
    sysparm_limit: limit,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });
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

function pair(raw) {
  return {
    value: extractServiceNowValue(raw) || null,
    display: extractServiceNowDisplay(raw) || extractServiceNowValue(raw) || null,
  };
}

function summarizeRecords(records, totalHint) {
  const opened = records
    .map((r) => extractServiceNowValue(r.opened_at))
    .filter(Boolean)
    .sort();
  const assigned = records.filter((r) => Boolean(extractServiceNowValue(r.assigned_to))).length;
  const unassigned = records.length - assigned;
  const callers = tally(records, (r) => pair(r.caller_id));
  const primaryCaller = callers[0] || null;

  return {
    total_x_total_count: totalHint,
    sample_scanned: records.length,
    newest_opened_at: opened.length ? opened[opened.length - 1] : null,
    oldest_opened_at_in_sample: opened.length ? opened[0] : null,
    // Quando total > sample, oldest no sample NÃO é o mais antigo do período;
    // buscamos extremo com ORDERBYopened_at (asc) em chamada separada.
    states: tally(records, (r) => pair(r.state)),
    priorities: tally(records, (r) => pair(r.priority)),
    assigned_in_sample: assigned,
    unassigned_in_sample: unassigned,
    caller_ids_in_sample: callers,
    primary_caller: primaryCaller,
    examples: records.slice(0, EXAMPLE_LIMIT).map((raw) => ({
      number: extractServiceNowValue(raw.number),
      sys_id: extractServiceNowValue(raw.sys_id),
      opened_at: extractServiceNowValue(raw.opened_at),
      state: pair(raw.state),
      priority: pair(raw.priority),
      assigned_to: pair(raw.assigned_to),
      caller_id: pair(raw.caller_id),
      contact_type: pair(raw.contact_type),
      company: pair(raw.company),
      short_description: String(extractServiceNowValue(raw.short_description) || "").slice(0, 120),
    })),
  };
}

async function auditWindow(config, { id, label, from, to }, callerId) {
  const autoQuery = buildAutoQuery(callerId, from, to);
  const universeQuery = buildUniverseQuery(from, to);

  const [autoTotal, universeTotal] = await Promise.all([
    countQuery(config, autoQuery.replace(/\^ORDERBYDESC.*/, "")),
    countQuery(config, universeQuery.replace(/\^ORDERBYDESC.*/, "")),
  ]);

  const [autoPage, universePage, autoOldestPage, universeOldestPage] = await Promise.all([
    samplePage(config, autoQuery, SAMPLE_SCAN_LIMIT),
    samplePage(config, universeQuery, SAMPLE_SCAN_LIMIT),
    autoTotal > 0
      ? samplePage(config, `caller_id=${callerId}^${openedAtRange(from, to)}^ORDERBYopened_at`, 1)
      : Promise.resolve({ records: [] }),
    universeTotal > 0
      ? samplePage(config, `contact_type=monitoring^${openedAtRange(from, to)}^ORDERBYopened_at`, 1)
      : Promise.resolve({ records: [] }),
  ]);

  // Assigned/unassigned counts via Aggregate quando possível (universo e auto).
  let autoAssigned = null;
  let autoUnassigned = null;
  let universeAssigned = null;
  let universeUnassigned = null;
  try {
    const baseAuto = `caller_id=${callerId}^${openedAtRange(from, to)}`;
    const baseUni = `contact_type=monitoring^${openedAtRange(from, to)}`;
    const [aAssigned, aEmpty, uAssigned, uEmpty] = await Promise.all([
      countQuery(config, `${baseAuto}^assigned_toISNOTEMPTY`),
      countQuery(config, `${baseAuto}^assigned_toISEMPTY`),
      countQuery(config, `${baseUni}^assigned_toISNOTEMPTY`),
      countQuery(config, `${baseUni}^assigned_toISEMPTY`),
    ]);
    autoAssigned = aAssigned;
    autoUnassigned = aEmpty;
    universeAssigned = uAssigned;
    universeUnassigned = uEmpty;
  } catch {
    // Mantém null; sample continua disponível.
  }

  // State/priority distributions via Aggregate (mais fiel que sample).
  async function groupCounts(baseQuery, field) {
    try {
      const stats = await serviceNowStats("incident", {
        config,
        sysparm_count: true,
        sysparm_group_by: field,
        sysparm_query: baseQuery,
      });
      const mapped = mapAggregateGroupCounts(stats.rows, field);
      return Object.entries(mapped)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count);
    } catch {
      return null;
    }
  }

  const baseAuto = `caller_id=${callerId}^${openedAtRange(from, to)}`;
  const baseUni = `contact_type=monitoring^${openedAtRange(from, to)}`;
  const [autoStates, autoPriorities, uniStates, uniPriorities] = await Promise.all([
    groupCounts(baseAuto, "state"),
    groupCounts(baseAuto, "priority"),
    groupCounts(baseUni, "state"),
    groupCounts(baseUni, "priority"),
  ]);

  const autoSummary = summarizeRecords(autoPage.records || [], autoTotal);
  const universeSummary = summarizeRecords(universePage.records || [], universeTotal);

  autoSummary.oldest_opened_at = extractServiceNowValue(autoOldestPage.records?.[0]?.opened_at)
    || autoSummary.oldest_opened_at_in_sample;
  universeSummary.oldest_opened_at = extractServiceNowValue(universeOldestPage.records?.[0]?.opened_at)
    || universeSummary.oldest_opened_at_in_sample;
  autoSummary.newest_opened_at = autoSummary.examples[0]?.opened_at || autoSummary.newest_opened_at;
  universeSummary.newest_opened_at = universeSummary.examples[0]?.opened_at || universeSummary.newest_opened_at;

  if (autoStates) autoSummary.states = autoStates;
  if (autoPriorities) autoSummary.priorities = autoPriorities;
  if (uniStates) universeSummary.states = uniStates;
  if (uniPriorities) universeSummary.priorities = uniPriorities;

  autoSummary.assigned = autoAssigned;
  autoSummary.unassigned = autoUnassigned;
  universeSummary.assigned = universeAssigned;
  universeSummary.unassigned = universeUnassigned;

  return {
    period: { id, label, opened_at_from: from, opened_at_to: to },
    queries: {
      auto_zabbix: autoQuery,
      universo_monitoring: universeQuery,
    },
    auto_zabbix: autoSummary,
    universo_monitoring: universeSummary,
    delta: {
      universe_minus_auto: Math.max(0, (universeTotal || 0) - (autoTotal || 0)),
      auto_share_of_universe_pct: universeTotal
        ? Number((((autoTotal || 0) / universeTotal) * 100).toFixed(1))
        : null,
    },
  };
}

async function confirmCallerIdentity(config, candidateId) {
  const byId = await serviceNowGet("sys_user", {
    config,
    sysparm_query: `sys_id=${candidateId}`,
    sysparm_fields: "sys_id,user_name,name,active,email",
    sysparm_limit: 5,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  }).catch((error) => ({ error: sanitizeServiceNowError(error), records: [] }));

  const byName = await serviceNowGet("sys_user", {
    config,
    sysparm_query: "nameLIKEzabbix^ORuser_nameLIKEzabbix^ORDERBYname",
    sysparm_fields: "sys_id,user_name,name,active,email",
    sysparm_limit: 25,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  }).catch((error) => ({ error: sanitizeServiceNowError(error), records: [] }));

  // Amostra recente de incidentes com esse caller (sem janela) para display_value.
  const incidentSample = await serviceNowGet("incident", {
    config,
    sysparm_query: `caller_id=${candidateId}^ORDERBYDESCopened_at`,
    sysparm_fields: "sys_id,number,opened_at,caller_id,contact_type",
    sysparm_limit: 5,
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
  const incidentCallerDisplays = (incidentSample.records || []).map((raw) => pair(raw.caller_id));

  const candidateExistsAsUser = Boolean(userHit);
  const candidateAppearsInNameSearch = nameHits.some((u) => u.sys_id === candidateId);
  const candidateSeenOnIncidents = incidentCallerDisplays.some((c) => c.value === candidateId);

  return {
    candidate_sys_id: candidateId,
    exists_as_sys_user: candidateExistsAsUser,
    sys_user: userHit
      ? {
        sys_id: extractServiceNowValue(userHit.sys_id),
        user_name: extractServiceNowValue(userHit.user_name),
        name: extractServiceNowDisplay(userHit.name) || extractServiceNowValue(userHit.name),
        active: extractServiceNowValue(userHit.active),
      }
      : null,
    name_search_zabbix: nameHits,
    incident_caller_display_samples: incidentCallerDisplays,
    candidate_matches_prod_hypothesis: candidateExistsAsUser || candidateSeenOnIncidents,
    notes: {
      by_id_error: byId.error || null,
      by_name_error: byName.error || null,
      incident_sample_error: incidentSample.error || null,
      appears_in_name_search: candidateAppearsInNameSearch,
    },
  };
}

async function main() {
  // Não carrega .env.local por padrão — evita misturar DEV. Só sessão/process env.
  // Para fallback local explícito: --load-local-env (ainda assim exige --allow-dev se host for *dev*).
  if (hasFlag("load-local-env")) {
    const { loadLocalEnv } = await import("./_lib/local-env.mjs");
    loadLocalEnv(path.join(rootDir, ".env.local"));
  }

  const config = getServiceNowConfig();
  if (!config.configured) {
    console.error(JSON.stringify({
      ok: false,
      card: "SN-P0-34",
      error: "servicenow_not_configured",
      hint: "Defina SERVICENOW_BASE_URL / USERNAME / PASSWORD na sessão (não grave .env).",
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const host = hostOnly(config.baseUrl);
  if (looksLikeDevHost(host) && !hasFlag("allow-dev")) {
    console.error(JSON.stringify({
      ok: false,
      card: "SN-P0-34",
      error: "refusing_dev_host",
      host,
      hint: "Instância parece DEV. Forneça PROD via sessão ou use --allow-dev apenas se intencional.",
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const callerId = argValue("caller-id")
    || String(config.zabbixMonitoringCallerId || "").trim()
    || CANDIDATE_PROD_CALLER_ID;

  const startedAt = Date.now();
  const periods = buildPeriods(new Date());

  let callerConfirm;
  try {
    callerConfirm = await confirmCallerIdentity(config, callerId);
  } catch (error) {
    callerConfirm = {
      candidate_sys_id: callerId,
      error: error instanceof ServiceNowClientError ? error.code : sanitizeServiceNowError(error),
    };
  }

  const windows = [];
  for (const period of periods) {
    try {
      windows.push(await auditWindow(config, period, callerId));
    } catch (error) {
      windows.push({
        period,
        error: error instanceof ServiceNowClientError ? error.code : sanitizeServiceNowError(error),
      });
    }
  }

  const report = {
    ok: true,
    card: "SN-P0-34",
    mode: "read_only_get",
    host,
    timezone: TZ,
    caller_id_used: callerId,
    candidate_prod_caller_id: CANDIDATE_PROD_CALLER_ID,
    caller_id_equals_candidate: callerId === CANDIDATE_PROD_CALLER_ID,
    caller_confirmation: callerConfirm,
    windows,
    duration_ms: Date.now() - startedAt,
    constraints: {
      methods: ["GET"],
      bff_unchanged: true,
      env_not_written: true,
      integration_unchanged: true,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    card: "SN-P0-34",
    error: error instanceof ServiceNowClientError ? error.code : sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
});
