/**
 * OV-P0-138C — reproducible alert -> incident read-model audit.
 * Read-only PostgreSQL. No ServiceNow HTTP, no host fallback, no writes to DB.
 *
 * node scripts/ov-p0-138-correlation-artifact.mjs
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyExplicitServiceNowCorrelation,
  EXPLICIT_SN_CORRELATION_CLASS,
  inspectExplicitServiceNowTags,
} from "../api/_lib/oneview-inc-correlation.js";
import { getOneViewDbPool, resetOneViewDbPoolForTests } from "../api/_lib/oneview-db.js";
import { getPrimaryDataSourceName } from "../api/_lib/oneview-scope.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(rootDir, ".runtime");
const missingArtifact = path.join(runtimeDir, "ov-p0-138-missing-incidents.json");
const summaryArtifact = path.join(runtimeDir, "ov-p0-138-summary.json");
const explicitTagKeys = ["__zbx_servicenow_sys_id", "__zbx_servicenow_number"];

loadLocalEnv(path.join(rootDir, ".env.local"));
if (!process.env.ONEVIEW_DB_QUERY_TIMEOUT_MS) process.env.ONEVIEW_DB_QUERY_TIMEOUT_MS = "30000";

const explicitTagsSql = ["event_tags", "trigger_tags", "host_tags"].map((column) => `
  exists (
    select 1
      from jsonb_array_elements(coalesce(a.${column}, '[]'::jsonb)) tag
     where lower(coalesce(tag->>'tag', tag->>'name', '')) = any($2::text[])
       and btrim(coalesce(tag->>'value', '')) <> ''
  )
`).join(" or ");

const statusBuckets = Object.freeze([
  { key: "active_old", status: "active", recency: "old", initialLimit: 50 },
  { key: "active_recent", status: "active", recency: "recent", initialLimit: 50 },
  { key: "resolved_old", status: "resolved", recency: "old", initialLimit: 50 },
  { key: "resolved_recent", status: "resolved", recency: "recent", initialLimit: 50 },
]);

const refillOrder = Object.freeze(["resolved_recent", "active_recent", "resolved_old"]);

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapIncident(row) {
  if (!row) return null;
  const sys_id = String(row.sys_id || "").trim().toLowerCase() || null;
  const number = String(row.number || "").trim().toUpperCase() || null;
  return sys_id || number ? { sys_id, number } : null;
}

function publicClass(classification) {
  if (
    classification === EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_EXACT
    || classification === EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_SYS_ID_ONLY
    || classification === EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_NUMBER_ONLY
  ) return "EXACT";
  if (classification === EXPLICIT_SN_CORRELATION_CLASS.MISMATCH) return "MISMATCH";
  if (classification === EXPLICIT_SN_CORRELATION_CLASS.MALFORMED_TAG) return "MISSING_TAG";
  return "INC_NOT_FOUND";
}

function alertStatus(row) {
  return row.resolved_at ? "resolved" : "active";
}

function strictExplicitInspection(alert) {
  const inspection = inspectExplicitServiceNowTags(alert);
  // OV-P0-138C: somente as duas tags explícitas; ignora __zbx_servicenow_link.
  return { ...inspection, link_sys_ids: [], raw_link_tags: [] };
}

function sampleOrderSql() {
  return `
    order by
      coalesce(a.last_seen_at, a.resolved_at, a.first_seen_at) desc nulls last,
      a.id asc
  `;
}

async function fetchBucket(pool, bucket, referenceAt, limit) {
  const activeClause = bucket.status === "active" ? "a.resolved_at is null" : "a.resolved_at is not null";
  const timestamp = "coalesce(a.resolved_at, a.last_seen_at, a.first_seen_at)";
  const recencyClause = bucket.recency === "recent"
    ? `${timestamp} >= $3::timestamptz - interval '168 hours'`
    : `${timestamp} < $3::timestamptz - interval '168 hours'`;
  const result = await pool.query(
    `
    select
      a.id::text as alert_id,
      a.source_event_id::text as source_event_id,
      a.first_seen_at,
      a.last_seen_at,
      a.resolved_at,
      a.event_tags,
      a.trigger_tags,
      a.host_tags
      from alerts a
      join data_sources d on d.id = a.data_source_id
     where d.name = $1
       and (${explicitTagsSql})
       and ${activeClause}
       and ${recencyClause}
    ${sampleOrderSql()}
     limit $4
    `,
    [getPrimaryDataSourceName(), explicitTagKeys, referenceAt, limit],
  );
  return result.rows || [];
}

async function selectSample(pool, referenceAt) {
  const byBucket = new Map();
  for (const bucket of statusBuckets) {
    byBucket.set(bucket.key, await fetchBucket(pool, bucket, referenceAt, bucket.initialLimit));
  }

  const selected = new Map();
  for (const bucket of statusBuckets) {
    for (const row of byBucket.get(bucket.key) || []) selected.set(row.alert_id, { ...row, bucket: bucket.key });
  }

  let refillIndex = 0;
  while (selected.size < 200) {
    const key = refillOrder[refillIndex % refillOrder.length];
    refillIndex += 1;
    const bucket = statusBuckets.find((item) => item.key === key);
    const rows = byBucket.get(key) || [];
    const extra = await fetchBucket(pool, bucket, referenceAt, rows.length + 1);
    const next = extra.find((row) => !selected.has(row.alert_id));
    if (!next) {
      if (refillIndex > refillOrder.length * 250) break;
      continue;
    }
    byBucket.set(key, extra);
    selected.set(next.alert_id, { ...next, bucket: key });
  }

  if (selected.size !== 200) throw new Error(`sample_size_unavailable:${selected.size}`);
  return [...selected.values()];
}

async function readModelMaps(pool, alerts) {
  const inspected = alerts.map((alert) => strictExplicitInspection(alert));
  const sysIds = [...new Set(inspected.flatMap((item) => item.valid_sys_ids || []))];
  const numbers = [...new Set(inspected.flatMap((item) => item.valid_numbers || []))];
  const bySysId = new Map();
  const byNumber = new Map();

  if (sysIds.length) {
    const result = await pool.query(
      "select sys_id, number from servicenow_incidents where lower(sys_id::text) = any($1::text[])",
      [sysIds],
    );
    for (const row of result.rows || []) {
      const incident = mapIncident(row);
      if (incident?.sys_id) bySysId.set(incident.sys_id, incident);
    }
  }
  if (numbers.length) {
    const result = await pool.query(
      "select sys_id, number from servicenow_incidents where upper(number::text) = any($1::text[])",
      [numbers],
    );
    for (const row of result.rows || []) {
      const incident = mapIncident(row);
      if (incident?.number) byNumber.set(incident.number, incident);
    }
  }
  for (const sysId of sysIds) if (!bySysId.has(sysId)) bySysId.set(sysId, null);
  for (const number of numbers) if (!byNumber.has(number)) byNumber.set(number, null);
  return { inspected, bySysId, byNumber };
}

function missingItem(row, inspection) {
  return {
    alert_id: String(row.alert_id),
    source_event_id: row.source_event_id || null,
    sys_id: inspection.valid_sys_ids?.[0] || null,
    number: inspection.valid_numbers?.[0] || null,
    alert_status: alertStatus(row),
    first_seen_at: iso(row.first_seen_at),
    last_seen_at: iso(row.last_seen_at),
  };
}

async function main() {
  const pool = getOneViewDbPool();
  try {
    const [{ rows: referenceRows }, { rows: syncRows }] = await Promise.all([
      pool.query("select max(last_seen_at) as reference_at from alerts"),
      pool.query("select max(last_success_at) as last_success_at from servicenow_sync_state"),
    ]);
    const referenceAt = iso(referenceRows[0]?.reference_at);
    const lastSuccessAt = iso(syncRows[0]?.last_success_at);
    if (!referenceAt) throw new Error("alerts_reference_timestamp_missing");

    const alerts = await selectSample(pool, referenceAt);
    const { inspected, bySysId, byNumber } = await readModelMaps(pool, alerts);
    const counts = Object.fromEntries(["EXACT", "SYNC_LAG", "MISSING_TAG", "INC_NOT_FOUND", "ALERT_NOT_FOUND", "MISMATCH"].map((key) => [key, 0]));
    const missing = [];

    for (let index = 0; index < alerts.length; index += 1) {
      const row = alerts[index];
      const inspection = inspected[index];
      const classified = classifyExplicitServiceNowCorrelation({ inspect: inspection, bySysId, byNumber });
      let kind = publicClass(classified.classification);
      if (kind === "INC_NOT_FOUND" && lastSuccessAt && iso(row.last_seen_at) > lastSuccessAt) kind = "SYNC_LAG";
      counts[kind] += 1;
      if (kind === "INC_NOT_FOUND") missing.push(missingItem(row, inspection));
    }

    missing.sort((left, right) => left.alert_id.localeCompare(right.alert_id));
    const payload = JSON.stringify(missing, null, 2) + "\n";
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const byBucket = Object.fromEntries(statusBuckets.map((bucket) => [
      bucket.key,
      alerts.filter((row) => row.bucket === bucket.key).length,
    ]));
    const summary = {
      card: "OV-P0-138C",
      methodology: {
        total: alerts.length,
        reference_at: referenceAt,
        recent_window_hours: 168,
        primary_data_source: getPrimaryDataSourceName(),
        explicit_tags_only: explicitTagKeys,
        host_fallback: false,
        serviceNow_http: false,
        database_write: false,
        buckets: byBucket,
      },
      read_model_last_success_at: lastSuccessAt,
      counts,
      missing_incidents_artifact: path.basename(missingArtifact),
      artifact_count: missing.length,
      sha256,
    };

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(missingArtifact, payload, "utf8");
    await fs.writeFile(summaryArtifact, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({ ...summary, artifact: missingArtifact }, null, 2));
  } finally {
    await resetOneViewDbPoolForTests().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ card: "OV-P0-138C", error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
