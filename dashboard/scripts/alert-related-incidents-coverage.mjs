/**
 * Audit read-only: 200 alertas recentes com source_event_id → related-incidents.
 * Match estrito via fetchIncidentsBySourceEventId (parser.zabbix_event_id === source_event_id).
 * Sem writes. Sem fallback por host.
 *
 * Uso:
 *   node scripts/alert-related-incidents-coverage.mjs
 *   node scripts/alert-related-incidents-coverage.mjs --limit=200 --concurrency=4
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

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const LIMIT = Math.min(500, Math.max(1, Number.parseInt(argValue("limit", "200"), 10) || 200));
const CONCURRENCY = Math.min(8, Math.max(1, Number.parseInt(argValue("concurrency", "4"), 10) || 4));
const UNMATCHED_EXAMPLES = 20;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

async function fetchRecentAlertsWithSourceEventId(limit, dbConfig, primaryDataSourceName) {
  const pool = getOneViewDbPool(dbConfig);
  const result = await pool.query({
    text: `
      select
        a.id::text as id,
        a.source_event_id,
        coalesce(nullif(a.host_visible_name, ''), nullif(a.host_technical_name, ''), nullif(a.host_name, '')) as host,
        coalesce(nullif(a.customer_name, ''), nullif(a.client_name, '')) as customer,
        a.severity,
        a.status_source,
        a.last_seen_at
      from alerts a
      join data_sources d on d.id = a.data_source_id
      where d.name = $1
        and a.source_event_id is not null
        and btrim(a.source_event_id) <> ''
      order by a.last_seen_at desc nulls last, a.updated_at desc nulls last, a.id desc
      limit $2
    `,
    values: [primaryDataSourceName, limit],
  });
  return result.rows.map((row) => ({
    id: String(row.id || ""),
    source_event_id: String(row.source_event_id || "").trim(),
    host: row.host ? String(row.host) : null,
    customer: row.customer ? String(row.customer) : null,
    severity: row.severity ? String(row.severity) : null,
    status: row.status_source ? String(row.status_source) : null,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  }));
}

async function main() {
  const snConfig = getServiceNowConfig();
  if (!snConfig.configured) {
    console.error(JSON.stringify({
      event: "alert_related_incidents_coverage_failed",
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
      event: "alert_related_incidents_coverage_failed",
      error: error?.code || error?.message || "oneview_db_config_incomplete",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const primaryDataSourceName = getPrimaryDataSourceName();
  const startedAt = Date.now();

  let alerts;
  try {
    alerts = await fetchRecentAlertsWithSourceEventId(LIMIT, dbConfig, primaryDataSourceName);
  } catch (error) {
    console.error(JSON.stringify({
      event: "alert_related_incidents_coverage_failed",
      error: "database_unavailable",
      detail: String(error?.message || "alerts_query_failed").slice(0, 160),
    }, null, 2));
    process.exitCode = 1;
    await resetOneViewDbPoolForTests().catch(() => undefined);
    return;
  }

  const uniqueEventIds = [...new Set(alerts.map((item) => item.source_event_id).filter(Boolean))];

  const lookupByEventId = new Map();
  await mapPool(uniqueEventIds, CONCURRENCY, async (eventId) => {
    const started = Date.now();
    try {
      const result = await fetchIncidentsBySourceEventId(eventId, {
        config: snConfig,
        maxRecords: 50,
      });
      lookupByEventId.set(eventId, {
        ok: true,
        latency_ms: Date.now() - started,
        matched: Boolean(result.matched),
        incident_count: Array.isArray(result.incidents) ? result.incidents.length : 0,
        candidates_returned: result.candidates_returned ?? null,
        incidents: (result.incidents || []).slice(0, 5).map((item) => ({
          number: item.number,
          state: item.state,
          state_display: item.state_display ?? null,
          sys_updated_on: item.sys_updated_on,
        })),
        error: null,
        timeout: false,
      });
    } catch (error) {
      const code = error instanceof ServiceNowClientError
        ? error.code
        : sanitizeServiceNowError(error);
      lookupByEventId.set(eventId, {
        ok: false,
        latency_ms: Date.now() - started,
        matched: false,
        incident_count: 0,
        candidates_returned: null,
        incidents: [],
        error: code,
        timeout: code === "servicenow_timeout",
      });
    }
  });

  const rows = alerts.map((alert) => {
    const lookup = lookupByEventId.get(alert.source_event_id) || {
      ok: false,
      latency_ms: null,
      matched: false,
      incident_count: 0,
      incidents: [],
      error: "lookup_missing",
      timeout: false,
    };
    return { alert, lookup };
  });

  const matched = rows.filter((row) => row.lookup.ok && row.lookup.incident_count === 1);
  const multiple = rows.filter((row) => row.lookup.ok && row.lookup.incident_count > 1);
  const unmatched = rows.filter((row) => row.lookup.ok && row.lookup.incident_count === 0);
  const errors = rows.filter((row) => !row.lookup.ok);
  const timeouts = rows.filter((row) => row.lookup.timeout);
  const latencies = rows
    .map((row) => row.lookup.latency_ms)
    .filter((value) => Number.isFinite(value));

  const report = {
    event: "alert_related_incidents_coverage",
    mode: "read_only",
    match_strategy: "source_event_id_eq_parser_zabbix_event_id",
    fallback: "none",
    primary_data_source: primaryDataSourceName,
    sample_size: alerts.length,
    unique_source_event_ids: uniqueEventIds.length,
    concurrency: CONCURRENCY,
    duration_ms: Date.now() - startedAt,
    matched: matched.length + multiple.length,
    matched_single: matched.length,
    unmatched: unmatched.length,
    multiple_incidents: multiple.length,
    errors: errors.length,
    timeouts: timeouts.length,
    latency_ms: {
      avg: latencies.length ? Math.round(mean(latencies)) : null,
      p50: latencies.length ? percentile(latencies, 50) : null,
      p95: latencies.length ? percentile(latencies, 95) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    unmatched_examples: unmatched.slice(0, UNMATCHED_EXAMPLES).map((row) => ({
      alert_id: row.alert.id,
      source_event_id: row.alert.source_event_id,
      host: row.alert.host,
      customer: row.alert.customer,
      severity: row.alert.severity,
      status: row.alert.status,
      last_seen_at: row.alert.last_seen_at,
      latency_ms: row.lookup.latency_ms,
      candidates_returned: row.lookup.candidates_returned,
    })),
    multiple_examples: multiple.slice(0, 10).map((row) => ({
      alert_id: row.alert.id,
      source_event_id: row.alert.source_event_id,
      host: row.alert.host,
      incident_count: row.lookup.incident_count,
      incidents: row.lookup.incidents,
      latency_ms: row.lookup.latency_ms,
    })),
    error_examples: errors.slice(0, 10).map((row) => ({
      alert_id: row.alert.id,
      source_event_id: row.alert.source_event_id,
      error: row.lookup.error,
      timeout: row.lookup.timeout,
      latency_ms: row.lookup.latency_ms,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
  await resetOneViewDbPoolForTests().catch(() => undefined);
}

main().catch(async (error) => {
  console.error(JSON.stringify({
    event: "alert_related_incidents_coverage_failed",
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exitCode = 1;
  await resetOneViewDbPoolForTests().catch(() => undefined);
});
