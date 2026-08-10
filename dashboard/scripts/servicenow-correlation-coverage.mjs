/**
 * SN-P0-09 — Coverage de correlação real incidente ↔ alerta (somente leitura).
 *
 * Query:
 *   contact_type=monitoring^caller_id=<zabbix monitoring>
 * Amostra: até 500 incidentes.
 * Match estrito: zabbix_event_id ↔ alerts.source_event_id (findAlertBySourceEventId).
 * Sem writes. Sem fallback por host/texto.
 *
 * Uso:
 *   node scripts/servicenow-correlation-coverage.mjs
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
  normalizeServiceNowIncident,
  SERVICENOW_INCIDENT_FIELDS_CSV,
} from "../api/_lib/servicenow-normalize.js";
import {
  findAlertBySourceEventId,
  getOneViewDbConfig,
  resetOneViewDbPoolForTests,
} from "../api/_lib/oneview-db.js";
import { getPrimaryDataSourceName } from "../api/_lib/oneview-scope.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const ZABBIX_CALLER_ID = "aa62f29f47477610082e3d02e26d4358";
const QUERY = `contact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}`;
const MAX_RECORDS = 500;
const UNMATCHED_EXAMPLES = 20;
const LOOKUP_CONCURRENCY = 8;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

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

function truncate(value, max = 120) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function ageHours(openedAt, now = new Date()) {
  if (!openedAt) return null;
  const opened = new Date(openedAt.includes("T") ? openedAt : openedAt.replace(" ", "T") + "Z");
  if (Number.isNaN(opened.getTime())) return null;
  return Math.max(0, (now.getTime() - opened.getTime()) / 3_600_000);
}

export function ageBucket(hours) {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return "unknown";
  if (hours < 24) return "lt_24h";
  if (hours < 24 * 7) return "1_7d";
  if (hours < 24 * 30) return "7_30d";
  if (hours < 24 * 90) return "30_90d";
  return "gt_90d";
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

function clientLabel(raw, normalized) {
  return extractServiceNowDisplay(raw?.company)
    || normalized.company
    || "(sem cliente)";
}

/**
 * @param {object} opts
 * @param {Array<{raw: object, incident: object, matched: boolean, alert: object|null}>} opts.rows
 * @param {Date} [opts.now]
 */
export function buildCorrelationCoverageReport({
  rows,
  now = new Date(),
  xTotalCount = null,
  truncated = false,
  durationMs = 0,
  baseHost = null,
  primaryDataSourceName = null,
} = {}) {
  const analyzed = rows.length;
  const withEventId = rows.filter((row) => row.incident.zabbix_event_id);
  const withoutEventId = analyzed - withEventId.length;
  const matched = withEventId.filter((row) => row.matched);
  const unmatched = withEventId.filter((row) => !row.matched);
  const matchDenom = withEventId.length;

  const byClientMap = new Map();
  for (const row of withEventId) {
    const client = clientLabel(row.raw, row.incident);
    const current = byClientMap.get(client) || { client, with_event_id: 0, matched: 0, unmatched: 0 };
    current.with_event_id += 1;
    if (row.matched) current.matched += 1;
    else current.unmatched += 1;
    byClientMap.set(client, current);
  }

  const by_client = [...byClientMap.values()]
    .map((item) => ({
      ...item,
      match_pct: pct(item.matched, item.with_event_id),
    }))
    .sort((a, b) => b.with_event_id - a.with_event_id || a.client.localeCompare(b.client));

  const unmatchedAges = unmatched
    .map((row) => ageHours(row.incident.opened_at, now))
    .filter((value) => value !== null);

  const ageBuckets = {
    lt_24h: 0,
    "1_7d": 0,
    "7_30d": 0,
    "30_90d": 0,
    gt_90d: 0,
    unknown: 0,
  };
  for (const row of unmatched) {
    const hours = ageHours(row.incident.opened_at, now);
    ageBuckets[ageBucket(hours)] += 1;
  }

  const unmatched_examples = unmatched.slice(0, UNMATCHED_EXAMPLES).map((row) => ({
    number: row.incident.number,
    company: clientLabel(row.raw, row.incident),
    opened_at: row.incident.opened_at,
    age_hours: (() => {
      const hours = ageHours(row.incident.opened_at, now);
      return hours === null ? null : Number(hours.toFixed(1));
    })(),
    age_bucket: ageBucket(ageHours(row.incident.opened_at, now)),
    zabbix_event_id: row.incident.zabbix_event_id,
    short_description: truncate(row.incident.short_description),
  }));

  return {
    event: "servicenow_correlation_coverage_sn_p0_09",
    mode: "read_only",
    match_strategy: "zabbix_event_id_eq_source_event_id",
    fallback: "none",
    query: QUERY,
    caller_display: "zabbix monitoring",
    base_host: baseHost,
    primary_data_source: primaryDataSourceName,
    sample_size: analyzed,
    x_total_count: xTotalCount,
    truncated,
    duration_ms: durationMs,
    incidentes_analisados: analyzed,
    com_eventid: withEventId.length,
    sem_eventid: withoutEventId,
    matched: matched.length,
    unmatched: unmatched.length,
    match_pct: pct(matched.length, matchDenom),
    unmatched_examples,
    by_client,
    unmatched_temporal: {
      count: unmatched.length,
      age_hours: {
        min: unmatchedAges.length ? Number(Math.min(...unmatchedAges).toFixed(1)) : null,
        median: median(unmatchedAges),
        p90: percentile(unmatchedAges, 90),
        max: unmatchedAges.length ? Number(Math.max(...unmatchedAges).toFixed(1)) : null,
      },
      age_buckets: ageBuckets,
      note: "Idade do incidente SN (opened_at → agora). Sem fallback temporal por host/texto.",
    },
  };
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
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run());
  await Promise.all(runners);
  return results;
}

async function main() {
  const snConfig = getServiceNowConfig();
  if (!snConfig.configured) {
    console.error(JSON.stringify({
      event: "servicenow_correlation_coverage_failed",
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
      event: "servicenow_correlation_coverage_failed",
      error: error?.code || error?.message || "oneview_db_config_incomplete",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const primaryDataSourceName = getPrimaryDataSourceName();
  const startedAt = Date.now();
  let pageResult;
  try {
    pageResult = await serviceNowGetAll("incident", {
      config: snConfig,
      sysparm_query: `${QUERY}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`,
      sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
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
      event: "servicenow_correlation_coverage_failed",
      error: code,
      status: error?.status ?? null,
      duration_ms: Date.now() - startedAt,
      base_host: hostOnly(snConfig.baseUrl),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const normalizedPairs = (pageResult.records || []).map((raw) => ({
    raw,
    incident: normalizeServiceNowIncident(raw),
  }));

  const uniqueEventIds = [...new Set(
    normalizedPairs
      .map((pair) => pair.incident.zabbix_event_id)
      .filter(Boolean),
  )];

  const lookupByEventId = new Map();
  try {
    await mapPool(uniqueEventIds, LOOKUP_CONCURRENCY, async (eventId) => {
      const alert = await findAlertBySourceEventId(eventId, dbConfig, primaryDataSourceName);
      lookupByEventId.set(eventId, alert);
      return alert;
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "servicenow_correlation_coverage_failed",
      error: error?.code || "database_unavailable",
      detail: String(error?.message || "lookup_failed").slice(0, 120),
      duration_ms: Date.now() - startedAt,
    }, null, 2));
    process.exitCode = 1;
    await resetOneViewDbPoolForTests().catch(() => undefined);
    return;
  }

  const rows = normalizedPairs.map((pair) => {
    const eventId = pair.incident.zabbix_event_id;
    if (!eventId) {
      return { ...pair, matched: false, alert: null };
    }
    const alert = lookupByEventId.get(eventId) || null;
    return { ...pair, matched: Boolean(alert), alert };
  });

  const report = buildCorrelationCoverageReport({
    rows,
    now: new Date(),
    xTotalCount: pageResult.totalCount,
    truncated: pageResult.truncated,
    durationMs: Date.now() - startedAt,
    baseHost: hostOnly(snConfig.baseUrl),
    primaryDataSourceName,
  });

  console.log(JSON.stringify(report, null, 2));
  await resetOneViewDbPoolForTests().catch(() => undefined);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(JSON.stringify({
      event: "servicenow_correlation_coverage_failed",
      error: sanitizeServiceNowError(error),
    }, null, 2));
    process.exitCode = 1;
    await resetOneViewDbPoolForTests().catch(() => undefined);
  });
}
