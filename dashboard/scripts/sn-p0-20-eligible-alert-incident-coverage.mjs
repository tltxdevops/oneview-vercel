/**
 * SN-P0-20 — Cobertura alerta→incidente só para alertas elegíveis.
 *
 * Elegibilidade (denominador):
 *   - severity IN (average, high, disaster)
 *   - source_event_id presente
 *   - idade mínima 10 minutos (first_seen_at)
 *   - janelas: 24h e 48h
 * Information/Warning fora do denominador.
 *
 * Match: fetchIncidentsBySourceEventId (eventid exato + monitoring + zabbix caller).
 * Sem writes. Sem fallback por host.
 *
 * Uso:
 *   node scripts/sn-p0-20-eligible-alert-incident-coverage.mjs
 *   node scripts/sn-p0-20-eligible-alert-incident-coverage.mjs --windows=24,48 --concurrency=4
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getOneViewDbConfig,
  getOneViewDbPool,
  resetOneViewDbPoolForTests,
} from "../api/_lib/oneview-db.js";
import { fetchIncidentsBySourceEventId } from "../api/_lib/oneview-incidents.js";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import { getPrimaryDataSourceName } from "../api/_lib/oneview-scope.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

export const ELIGIBLE_SEVERITIES = Object.freeze(["average", "high", "disaster"]);
export const MIN_AGE_MINUTES = 10;

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function pct(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

function mean(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number((((sorted[mid - 1] + sorted[mid]) / 2)).toFixed(1));
  }
  return Number(sorted[mid].toFixed(1));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(1));
}

export function parseIso(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function ageMinutes(firstSeenAt, now = new Date()) {
  const ms = parseIso(firstSeenAt);
  if (ms == null) return null;
  return Math.max(0, (now.getTime() - ms) / 60_000);
}

export function lagMinutes(firstSeenAt, openedAt) {
  const alertMs = parseIso(firstSeenAt);
  const openMs = parseIso(openedAt);
  if (alertMs == null || openMs == null) return null;
  return (openMs - alertMs) / 60_000;
}

function normalizeSeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  return ELIGIBLE_SEVERITIES.includes(severity) ? severity : null;
}

function customerLabel(value) {
  const text = String(value || "").trim();
  return text || "(sem cliente)";
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run()));
  return results;
}

/**
 * Alertas elegíveis: severity average/high/disaster, source_event_id, idade ≥ 10 min,
 * first_seen_at dentro da janela (horas).
 */
export async function fetchEligibleAlerts({
  windowHours,
  minAgeMinutes = MIN_AGE_MINUTES,
  dbConfig,
  primaryDataSourceName,
  now = new Date(),
  limit = 5000,
}) {
  const pool = getOneViewDbPool(dbConfig);
  const result = await pool.query({
    text: `
      select
        a.id::text as id,
        a.source_event_id,
        coalesce(nullif(a.host_visible_name, ''), nullif(a.host_technical_name, ''), nullif(a.host_name, '')) as host,
        coalesce(nullif(a.customer_name, ''), nullif(a.client_name, '')) as customer,
        lower(a.severity) as severity,
        a.status_source,
        a.first_seen_at,
        a.last_seen_at
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where d.name = $1
        and lower(a.severity) = any($2::text[])
        and a.source_event_id is not null
        and btrim(a.source_event_id) <> ''
        and a.first_seen_at is not null
        and a.first_seen_at <= $3::timestamptz - ($4::int * interval '1 minute')
        and a.first_seen_at >= $3::timestamptz - ($5::int * interval '1 hour')
      order by a.first_seen_at desc nulls last, a.id desc
      limit $6
    `,
    values: [
      primaryDataSourceName,
      [...ELIGIBLE_SEVERITIES],
      now.toISOString(),
      minAgeMinutes,
      windowHours,
      limit,
    ],
  });

  return result.rows.map((row) => ({
    id: String(row.id || ""),
    source_event_id: String(row.source_event_id || "").trim(),
    host: row.host ? String(row.host) : null,
    customer: customerLabel(row.customer),
    severity: normalizeSeverity(row.severity) || String(row.severity || "").toLowerCase(),
    status: row.status_source ? String(row.status_source) : null,
    first_seen_at: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  }));
}

function bumpGroup(map, key, matched) {
  const current = map.get(key) || { total: 0, matched: 0, unmatched: 0 };
  current.total += 1;
  if (matched) current.matched += 1;
  else current.unmatched += 1;
  map.set(key, current);
}

function finalizeGroup(map) {
  return [...map.entries()]
    .map(([key, stats]) => ({
      key,
      total: stats.total,
      matched: stats.matched,
      unmatched: stats.unmatched,
      match_pct: pct(stats.matched, stats.total),
    }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/**
 * Constrói o relatório a partir das linhas já resolvidas (puro / testável).
 */
export function buildEligibleCoverageReport({
  windowHours,
  now = new Date(),
  rows,
  unmatchedExamplesLimit = 15,
}) {
  const bySeverity = new Map();
  const byCustomer = new Map();
  const alertAges = [];
  const lags = [];
  const unmatchedHighAverage = [];
  const zeroMatchSeverities = [];
  const zeroMatchCustomers = [];

  let matched = 0;
  let unmatched = 0;
  let errors = 0;

  for (const row of rows) {
    const severity = normalizeSeverity(row.severity) || row.severity || "(unknown)";
    const customer = customerLabel(row.customer);
    const isMatched = Boolean(row.matched);
    const age = ageMinutes(row.first_seen_at, now);
    if (age != null) alertAges.push(age);

    bumpGroup(bySeverity, severity, isMatched);
    bumpGroup(byCustomer, customer, isMatched);

    if (row.error) {
      errors += 1;
      unmatched += 1;
    } else if (isMatched) {
      matched += 1;
      const openedAt = row.incident_opened_at || null;
      const lag = lagMinutes(row.first_seen_at, openedAt);
      if (lag != null) lags.push(lag);
    } else {
      unmatched += 1;
      if ((severity === "high" || severity === "average") && unmatchedHighAverage.length < unmatchedExamplesLimit) {
        unmatchedHighAverage.push({
          alert_id: row.id,
          source_event_id: row.source_event_id,
          severity,
          customer,
          host: row.host,
          first_seen_at: row.first_seen_at,
          age_minutes: age != null ? Number(age.toFixed(1)) : null,
        });
      }
    }
  }

  const severityStats = finalizeGroup(bySeverity);
  const customerStats = finalizeGroup(byCustomer);

  for (const item of severityStats) {
    if (item.total > 0 && item.matched === 0) zeroMatchSeverities.push(item.key);
  }
  for (const item of customerStats) {
    if (item.total > 0 && item.matched === 0) zeroMatchCustomers.push(item.key);
  }

  const total = rows.length;
  return {
    event: "sn_p0_20_eligible_alert_incident_coverage",
    mode: "read_only",
    match_strategy: "source_event_id_eq_parser_zabbix_event_id",
    sn_query: "contact_type=monitoring^caller_id=zabbix_monitoring^descriptionLIKEeventid=",
    fallback: "none",
    eligible_severities: [...ELIGIBLE_SEVERITIES],
    excluded_from_denominator: ["information", "warning"],
    min_age_minutes: MIN_AGE_MINUTES,
    window_hours: windowHours,
    total_eligible: total,
    matched,
    unmatched,
    errors,
    match_pct: pct(matched, total),
    by_severity: severityStats.map(({ key, ...rest }) => ({ severity: key, ...rest })),
    by_customer: customerStats.map(({ key, ...rest }) => ({ customer: key, ...rest })),
    alert_age_minutes: {
      avg: mean(alertAges),
      p50: median(alertAges),
      p95: percentile(alertAges, 95),
      max: alertAges.length ? Number(Math.max(...alertAges).toFixed(1)) : null,
    },
    lag_first_seen_to_opened_minutes: {
      sample: lags.length,
      avg: mean(lags),
      p50: median(lags),
      p95: percentile(lags, 95),
      min: lags.length ? Number(Math.min(...lags).toFixed(1)) : null,
      max: lags.length ? Number(Math.max(...lags).toFixed(1)) : null,
    },
    unmatched_high_average_examples: unmatchedHighAverage,
    zero_match_severities: zeroMatchSeverities,
    zero_match_customers: zeroMatchCustomers,
    answer: {
      clients_or_severities_with_zero_incidents:
        zeroMatchSeverities.length > 0 || zeroMatchCustomers.length > 0,
      zero_match_severities: zeroMatchSeverities,
      zero_match_customers_sample: zeroMatchCustomers.slice(0, 30),
      zero_match_customers_total: zeroMatchCustomers.length,
    },
  };
}

async function resolveAlert(alert, { snConfig, now }) {
  const started = Date.now();
  try {
    const result = await fetchIncidentsBySourceEventId(alert.source_event_id, { config: snConfig });
    const incident = result.incidents?.[0] || null;
    return {
      ...alert,
      matched: Boolean(result.matched && incident),
      incident_number: incident?.number || null,
      incident_opened_at: incident?.opened_at || null,
      incident_sys_id: incident?.sys_id || null,
      candidates_returned: result.candidates_returned ?? result.incidents?.length ?? 0,
      latency_ms: Date.now() - started,
      error: null,
      age_minutes: ageMinutes(alert.first_seen_at, now),
      lag_minutes: lagMinutes(alert.first_seen_at, incident?.opened_at),
    };
  } catch (error) {
    return {
      ...alert,
      matched: false,
      incident_number: null,
      incident_opened_at: null,
      incident_sys_id: null,
      candidates_returned: 0,
      latency_ms: Date.now() - started,
      error: error instanceof ServiceNowClientError
        ? error.code
        : sanitizeServiceNowError(error),
      age_minutes: ageMinutes(alert.first_seen_at, now),
      lag_minutes: null,
    };
  }
}

async function runWindow({
  windowHours,
  dbConfig,
  primaryDataSourceName,
  snConfig,
  concurrency,
  now,
  limit,
}) {
  const alerts = await fetchEligibleAlerts({
    windowHours,
    dbConfig,
    primaryDataSourceName,
    now,
    limit,
  });

  // Dedup por source_event_id (mantém o mais recente first_seen_at — já ordenado desc).
  const seen = new Set();
  const unique = [];
  for (const alert of alerts) {
    if (seen.has(alert.source_event_id)) continue;
    seen.add(alert.source_event_id);
    unique.push(alert);
  }

  const rows = await mapPool(unique, concurrency, (alert) => resolveAlert(alert, { snConfig, now }));
  const report = buildEligibleCoverageReport({ windowHours, now, rows });
  return {
    ...report,
    primary_data_source: primaryDataSourceName,
    unique_source_event_ids: unique.length,
    concurrency,
    checked_at: now.toISOString(),
  };
}

async function main() {
  const windows = String(argValue("windows", "24,48"))
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  const concurrency = Math.min(8, Math.max(1, Number.parseInt(argValue("concurrency", "4"), 10) || 4));
  const limit = Math.min(10000, Math.max(1, Number.parseInt(argValue("limit", "5000"), 10) || 5000));

  const snConfig = getServiceNowConfig();
  if (!snConfig.configured) {
    console.error(JSON.stringify({
      event: "sn_p0_20_failed",
      error: "servicenow_not_configured",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  let dbConfig;
  try {
    dbConfig = getOneViewDbConfig();
  } catch (error) {
    console.error(JSON.stringify({
      event: "sn_p0_20_failed",
      error: error?.code || error?.message || "oneview_db_config_incomplete",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const primaryDataSourceName = getPrimaryDataSourceName();
  const now = new Date();
  const reports = [];

  try {
    for (const windowHours of (windows.length ? windows : [24, 48])) {
      const report = await runWindow({
        windowHours,
        dbConfig,
        primaryDataSourceName,
        snConfig,
        concurrency,
        now,
        limit,
      });
      reports.push(report);
    }

    console.log(JSON.stringify({
      event: "sn_p0_20_eligible_alert_incident_coverage",
      mode: "read_only",
      fallback: "none",
      windows: reports,
    }, null, 2));
  } finally {
    resetOneViewDbPoolForTests();
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: "sn_p0_20_failed",
      error: sanitizeServiceNowError(error),
    }, null, 2));
    resetOneViewDbPoolForTests();
    process.exitCode = 1;
  });
}
