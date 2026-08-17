/**
 * OV-P0-111 — Alert ↔ Incident correlation gate (GET-only).
 * Amostra 100 alertas recentes com tags explícitas __zbx_servicenow_*.
 * Sem fallback por host. Sem write. Sem commit/deploy.
 *
 *   node scripts/ov-p0-111-alert-incident-correlation-gate.mjs
 *   node scripts/ov-p0-111-alert-incident-correlation-gate.mjs --limit=100
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyExplicitServiceNowCorrelation,
  EXPLICIT_SN_CORRELATION_CLASS,
  fetchIncidentsByExactNumbers,
  fetchIncidentsByExactSysIds,
  inspectExplicitServiceNowTags,
  parseSysIdFromServiceNowLink,
} from "../api/_lib/oneview-inc-correlation.js";
import {
  getOneViewDbPool,
  resetOneViewDbPoolForTests,
} from "../api/_lib/oneview-db.js";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
} from "../api/_lib/servicenow-client.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const SN_TAG_KEYS = [
  "__zbx_servicenow_sys_id",
  "__zbx_servicenow_number",
  "__zbx_servicenow_link",
];

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
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

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const TAG_EXISTS_SQL = SN_TAG_KEYS.map((_, index) => {
  const param = `$${index + 1}`;
  return `(
    exists (
      select 1 from jsonb_array_elements(coalesce(a.event_tags, '[]'::jsonb)) t
      where lower(coalesce(t->>'tag', t->>'name', '')) = ${param}
        and btrim(coalesce(t->>'value', '')) <> ''
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(a.trigger_tags, '[]'::jsonb)) t
      where lower(coalesce(t->>'tag', t->>'name', '')) = ${param}
        and btrim(coalesce(t->>'value', '')) <> ''
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(a.host_tags, '[]'::jsonb)) t
      where lower(coalesce(t->>'tag', t->>'name', '')) = ${param}
        and btrim(coalesce(t->>'value', '')) <> ''
    )
  )`;
}).join(" or ");

const SAMPLE_SQL = `
  select
    a.id,
    a.source_event_id,
    a.problem_name,
    a.severity,
    a.last_seen_at,
    a.event_tags,
    a.trigger_tags,
    a.host_tags
  from alerts a
  where ${TAG_EXISTS_SQL}
  order by a.last_seen_at desc nulls last
  limit $${SN_TAG_KEYS.length + 1}
`;

export function summarizeCorrelationRows(rows) {
  const counts = Object.create(null);
  for (const value of Object.values(EXPLICIT_SN_CORRELATION_CLASS)) counts[value] = 0;
  const causeCounts = Object.create(null);
  const fieldRecovery = { state: 0, priority: 0, assigned_to: 0, resolved: 0 };
  const examples = {
    correlated_exact: [],
    mismatch: [],
    missing_in_servicenow: [],
    malformed_tag: [],
    correlated_by_sys_id_only: [],
    correlated_by_number_only: [],
  };

  for (const row of rows) {
    const key = row.classification;
    counts[key] = (counts[key] || 0) + 1;
    for (const cause of row.causes || []) {
      causeCounts[cause] = (causeCounts[cause] || 0) + 1;
    }
    if (row.resolved) {
      fieldRecovery.resolved += 1;
      if (row.resolved.fields_recovered?.state) fieldRecovery.state += 1;
      if (row.resolved.fields_recovered?.priority) fieldRecovery.priority += 1;
      if (row.resolved.fields_recovered?.assigned_to) fieldRecovery.assigned_to += 1;
    }
    const bucket = examples[key];
    if (bucket && bucket.length < 5) {
      bucket.push({
        alert_id: row.alert_id,
        source_event_id: row.source_event_id,
        classification: key,
        has_sys_id: row.has_sys_id,
        has_number: row.has_number,
        has_link: row.has_link,
        sys_id_exists: row.sys_id_exists,
        number_exists: row.number_exists,
        same_incident: row.same_incident,
        link_opens_same_incident: row.link_opens_same_incident,
        number: row.valid_numbers?.[0] || row.resolved?.number || null,
        sys_id: row.valid_sys_ids?.[0] || row.resolved?.sys_id || null,
        causes: row.causes,
        state: row.resolved?.state_display || row.resolved?.state || null,
        priority: row.resolved?.priority_display || row.resolved?.priority || null,
        assigned_to: row.resolved?.assigned_to_display || null,
      });
    }
  }

  const total = rows.length;
  const exact = counts.correlated_exact || 0;
  const usable = exact
    + (counts.correlated_by_sys_id_only || 0)
    + (counts.correlated_by_number_only || 0);
  const mismatch = counts.mismatch || 0;
  const topCauses = Object.entries(causeCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([cause, count]) => ({ cause, count, pct: pct(count, total) }));

  return {
    total,
    counts,
    pct: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, pct(count, total)])),
    exact_pct: pct(exact, total),
    usable_explicit_pct: pct(usable, total),
    mismatch_pct: pct(mismatch, total),
    field_recovery: {
      resolved: fieldRecovery.resolved,
      state_pct: pct(fieldRecovery.state, fieldRecovery.resolved),
      priority_pct: pct(fieldRecovery.priority, fieldRecovery.resolved),
      assigned_to_pct: pct(fieldRecovery.assigned_to, fieldRecovery.resolved),
    },
    top_causes: topCauses,
    examples,
  };
}

function uiDecision(summary) {
  if (!summary.total) {
    return {
      ready_for_ui: false,
      verdict: "blocked_no_sample",
      reason: "Nenhum alerta com tag explícita __zbx_servicenow_* na amostra.",
    };
  }
  if (summary.mismatch_pct > 2) {
    return {
      ready_for_ui: false,
      verdict: "not_ready_mismatch",
      reason: `Divergência ${summary.mismatch_pct}% acima do limiar de 2%.`,
    };
  }
  if (summary.usable_explicit_pct >= 90 && summary.mismatch_pct <= 2) {
    return {
      ready_for_ui: true,
      verdict: "ready",
      reason: `Referência explícita sustentou ${summary.usable_explicit_pct}% da amostra (exata ${summary.exact_pct}%) com mismatch ${summary.mismatch_pct}%.`,
    };
  }
  return {
    ready_for_ui: false,
    verdict: "not_ready_coverage",
    reason: `Cobertura utilizável ${summary.usable_explicit_pct}% (exata ${summary.exact_pct}%) abaixo de 90%.`,
  };
}

async function loadSample(limit) {
  const pool = getOneViewDbPool();
  const result = await pool.query(SAMPLE_SQL, [...SN_TAG_KEYS, limit]);
  return result.rows || [];
}

async function fillLookups(inspects, config) {
  const bySysId = new Map();
  const byNumber = new Map();
  const sysIds = [];
  const numbers = [];
  const seenSys = new Set();
  const seenNum = new Set();
  for (const inspect of inspects) {
    for (const id of [...inspect.valid_sys_ids, ...inspect.link_sys_ids]) {
      if (!id || seenSys.has(id)) continue;
      seenSys.add(id);
      sysIds.push(id);
    }
    for (const number of inspect.valid_numbers) {
      if (!number || seenNum.has(number)) continue;
      seenNum.add(number);
      numbers.push(number);
    }
  }

  for (const group of chunk(sysIds, 40)) {
    const page = await fetchIncidentsByExactSysIds(group, { config, maxRecords: 50 });
    const found = new Set();
    for (const incident of page.incidents || []) {
      const id = String(incident.sys_id || "").toLowerCase();
      if (!id) continue;
      bySysId.set(id, incident);
      found.add(id);
    }
    for (const id of group) {
      if (!bySysId.has(id)) bySysId.set(id, null);
    }
  }

  for (const group of chunk(numbers, 40)) {
    const page = await fetchIncidentsByExactNumbers(group, { config, maxRecords: 50 });
    const found = new Set((page.incidents || []).map((item) => String(item.number || "").toUpperCase()));
    for (const incident of page.incidents || []) {
      const number = String(incident.number || "").toUpperCase();
      if (number) byNumber.set(number, incident);
    }
    for (const number of group) {
      if (!byNumber.has(number)) byNumber.set(number, null);
    }
    void found;
  }

  return {
    bySysId,
    byNumber,
    unique_sys_ids: sysIds.length,
    unique_numbers: numbers.length,
  };
}

function sanitizeRow(alert, classified, inspect) {
  const linkHosts = (inspect.raw_link_tags || [])
    .map((link) => parseSysIdFromServiceNowLink(link)?.host)
    .filter(Boolean);
  return {
    alert_id: alert.id,
    source_event_id: alert.source_event_id || null,
    last_seen_at: alert.last_seen_at ? new Date(alert.last_seen_at).toISOString() : null,
    severity: alert.severity || null,
    problem: String(alert.problem_name || "").slice(0, 80) || null,
    link_hosts: [...new Set(linkHosts)],
    ...classified,
  };
}

async function main() {
  const limit = Math.min(200, Math.max(1, Number.parseInt(argValue("limit", "100"), 10) || 100));
  const report = {
    card: "OV-P0-111",
    sample_limit: limit,
    credentials_printed: false,
    host_fallback: false,
  };

  try {
    const snConfig = getServiceNowConfig();
    report.servicenow_host = hostOnly(snConfig.baseUrl);
    report.servicenow_configured = snConfig.configured;
    if (!snConfig.configured) {
      report.status = "servicenow_not_configured";
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 2;
      return;
    }

    const alerts = await loadSample(limit);
    report.sample_returned = alerts.length;
    if (!alerts.length) {
      const summary = summarizeCorrelationRows([]);
      report.status = "no_explicit_tags";
      report.summary = summary;
      report.decision = uiDecision(summary);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 2;
      return;
    }

    const inspects = alerts.map((alert) => inspectExplicitServiceNowTags(alert));
    const lookups = await fillLookups(inspects, snConfig);
    const rows = alerts.map((alert, index) => {
      const inspect = inspects[index];
      const classified = classifyExplicitServiceNowCorrelation({
        inspect,
        bySysId: lookups.bySysId,
        byNumber: lookups.byNumber,
      });
      return sanitizeRow(alert, classified, inspect);
    });

    const summary = summarizeCorrelationRows(rows);
    report.status = "ok";
    report.lookups = {
      unique_sys_ids: lookups.unique_sys_ids,
      unique_numbers: lookups.unique_numbers,
    };
    report.summary = summary;
    report.decision = uiDecision(summary);
    report.rows = rows;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = "error";
    report.error = sanitizeServiceNowError(error);
    report.code = error?.code || error?.name || "error";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await resetOneViewDbPoolForTests().catch(() => undefined);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main();
}
