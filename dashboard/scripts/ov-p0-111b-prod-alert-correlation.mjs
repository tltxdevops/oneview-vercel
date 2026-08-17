/**
 * OV-P0-111B — Alert ↔ ServiceNow PROD correlation against the local read model.
 * Lookups: servicenow_incidents only. No live SN GET. No host fallback.
 *
 *   node scripts/ov-p0-111b-prod-alert-correlation.mjs
 *   node scripts/ov-p0-111b-prod-alert-correlation.mjs --limit=100
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyExplicitServiceNowCorrelation,
  EXPLICIT_SN_CORRELATION_CLASS,
  extractServiceNowIncidentNumbers,
  extractServiceNowIncidentNumbersFromHistory,
  inspectExplicitServiceNowTags,
} from "../api/_lib/oneview-inc-correlation.js";
import {
  getOneViewDbPool,
  resetOneViewDbPoolForTests,
} from "../api/_lib/oneview-db.js";
import { normalizeServiceNowSysId } from "../api/_lib/servicenow-client.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));
if (!process.env.ONEVIEW_DB_QUERY_TIMEOUT_MS) {
  process.env.ONEVIEW_DB_QUERY_TIMEOUT_MS = "30000";
}

const SN_TAG_KEYS = ["__zbx_servicenow_sys_id", "__zbx_servicenow_number"];

export const PUBLIC_CLASS = Object.freeze({
  [EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_EXACT]: "correlated_exact",
  [EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_SYS_ID_ONLY]: "sys_id_only",
  [EXPLICIT_SN_CORRELATION_CLASS.CORRELATED_BY_NUMBER_ONLY]: "number_only",
  [EXPLICIT_SN_CORRELATION_CLASS.MISMATCH]: "mismatch",
  [EXPLICIT_SN_CORRELATION_CLASS.MISSING_IN_SERVICENOW]: "missing",
  [EXPLICIT_SN_CORRELATION_CLASS.MALFORMED_TAG]: "missing",
});

export const RELATION_PRIORITY = Object.freeze({
  SYS_ID: "sys_id",
  NUMBER: "number",
  HISTORY: "history_comment",
  EVENT: "event_evidence",
  NONE: "none",
});

function argValue(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function pct(count, total) {
  if (!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

export function toPublicClass(classification) {
  return PUBLIC_CLASS[classification] || "missing";
}

function displayBag(row) {
  const raw = row?.display_values;
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function displayField(row, key) {
  const bag = displayBag(row);
  return bag[`${key}_display`] || bag[key] || row[`${key}_display`] || row[key] || null;
}

export function mapReadModelIncident(row) {
  if (!row) return null;
  const sysId = normalizeServiceNowSysId(row.sys_id) || String(row.sys_id || "").trim() || null;
  const number = String(row.number || "").trim().toUpperCase() || null;
  if (!sysId && !number) return null;
  return {
    sys_id: sysId,
    number,
    state: displayField(row, "state"),
    state_display: displayField(row, "state"),
    priority: displayField(row, "priority"),
    priority_display: displayField(row, "priority"),
    assigned_to: displayField(row, "assigned_to"),
    assigned_to_display: displayField(row, "assigned_to"),
    assignment_group: displayField(row, "assignment_group"),
    assignment_group_display: displayField(row, "assignment_group"),
  };
}

export function pickRelation({
  inspect,
  classified,
  historyNumbers = [],
  byHistoryNumber = new Map(),
  eventIncident = null,
} = {}) {
  const bySysIdHit = classified?.sys_id_exists ? classified.resolved : null;
  if (bySysIdHit) {
    return { source: RELATION_PRIORITY.SYS_ID, incident: bySysIdHit };
  }
  const byNumberHit = classified?.number_exists ? classified.resolved : null;
  if (byNumberHit) {
    return { source: RELATION_PRIORITY.NUMBER, incident: byNumberHit };
  }
  for (const number of historyNumbers) {
    const incident = byHistoryNumber.get(number);
    if (incident) return { source: RELATION_PRIORITY.HISTORY, incident };
  }
  if (eventIncident) {
    return { source: RELATION_PRIORITY.EVENT, incident: eventIncident };
  }
  void inspect;
  return { source: RELATION_PRIORITY.NONE, incident: null };
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

async function tableColumns(pool, table) {
  const result = await pool.query(
    `
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = $1
    `,
    [table],
  );
  return new Set((result.rows || []).map((row) => String(row.column_name)));
}

function incidentSelect(columns) {
  const wanted = [
    "sys_id",
    "number",
    "state",
    "state_display",
    "priority",
    "priority_display",
    "assigned_to",
    "assigned_to_display",
    "assignment_group",
    "assignment_group_display",
    "display_values",
    "zabbix_event_id",
    "correlation_id",
    "description",
  ];
  const fields = wanted.filter((name) => columns.has(name));
  if (!fields.includes("sys_id") || !fields.includes("number")) {
    throw new Error("servicenow_incidents_missing_identity_columns");
  }
  return fields.map((name) => `"${name}"`).join(", ");
}

export function summarizePublicRows(rows) {
  const counts = {
    correlated_exact: 0,
    sys_id_only: 0,
    number_only: 0,
    mismatch: 0,
    missing: 0,
  };
  for (const row of rows) {
    const key = row.public_class;
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.missing += 1;
  }
  const total = rows.length;
  const exact = counts.correlated_exact;
  const usable = exact + counts.sys_id_only + counts.number_only;
  return {
    TOTAL: total,
    EXACT: exact,
    SYS_ID_ONLY: counts.sys_id_only,
    NUMBER_ONLY: counts.number_only,
    MISMATCH: counts.mismatch,
    MISSING: counts.missing,
    CORRELATION_RATE: pct(exact, total),
    USABLE_RATE: pct(usable, total),
    counts,
  };
}

function examplePayload(row) {
  const incident = row.relation?.incident || null;
  return {
    alert_id: row.alert_id,
    zabbix_event: row.source_event_id || null,
    inc: incident?.number || row.valid_numbers?.[0] || null,
    sys_id: incident?.sys_id || row.valid_sys_ids?.[0] || null,
    state: incident?.state_display || incident?.state || null,
    priority: incident?.priority_display || incident?.priority || null,
    assigned_to: incident?.assigned_to_display || incident?.assigned_to || null,
    assignment_group: incident?.assignment_group_display || incident?.assignment_group || null,
    public_class: row.public_class,
    relation_source: row.relation?.source || RELATION_PRIORITY.NONE,
  };
}

async function main() {
  const limit = Math.min(200, Math.max(1, Number.parseInt(argValue("limit", "100"), 10) || 100));
  const report = {
    card: "OV-P0-111B",
    sample_limit: limit,
    host_fallback: false,
    lookup: "servicenow_incidents",
  };

  try {
    const pool = getOneViewDbPool();
    const columns = await tableColumns(pool, "servicenow_incidents");
    report.read_model_columns = [...columns].sort();
    if (!columns.size) {
      report.status = "servicenow_incidents_missing";
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 2;
      return;
    }

    const countRes = await pool.query("select count(*)::int as n from servicenow_incidents");
    report.read_model_rows = Number(countRes.rows?.[0]?.n || 0);

    const selectList = incidentSelect(columns);
    const alerts = (await pool.query(SAMPLE_SQL, [...SN_TAG_KEYS, limit])).rows || [];
    report.sample_returned = alerts.length;
    if (!alerts.length) {
      report.status = "no_explicit_tags";
      report.summary = summarizePublicRows([]);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 2;
      return;
    }

    const inspects = alerts.map((alert) => inspectExplicitServiceNowTags(alert));
    const sysIds = [];
    const numbers = [];
    const seenSys = new Set();
    const seenNum = new Set();
    for (const inspect of inspects) {
      for (const id of inspect.valid_sys_ids || []) {
        if (!id || seenSys.has(id)) continue;
        seenSys.add(id);
        sysIds.push(id);
      }
      for (const number of inspect.valid_numbers || []) {
        if (!number || seenNum.has(number)) continue;
        seenNum.add(number);
        numbers.push(number);
      }
    }

    const bySysId = new Map();
    const byNumber = new Map();
    if (sysIds.length) {
      const found = await pool.query(
        `select ${selectList} from servicenow_incidents where lower(sys_id::text) = any($1::text[])`,
        [sysIds.map((id) => id.toLowerCase())],
      );
      for (const row of found.rows || []) {
        const incident = mapReadModelIncident(row);
        if (!incident?.sys_id) continue;
        bySysId.set(incident.sys_id, incident);
      }
    }
    for (const id of sysIds) {
      if (!bySysId.has(id)) bySysId.set(id, null);
    }

    if (numbers.length) {
      const found = await pool.query(
        `select ${selectList} from servicenow_incidents where upper(number::text) = any($1::text[])`,
        [numbers],
      );
      for (const row of found.rows || []) {
        const incident = mapReadModelIncident(row);
        if (!incident?.number) continue;
        byNumber.set(incident.number, incident);
      }
    }
    for (const number of numbers) {
      if (!byNumber.has(number)) byNumber.set(number, null);
    }

    const alertIds = alerts.map((alert) => String(alert.id));
    const historyRows = (await pool.query(
      `
      select alert_id::text as alert_id, message::text as comment
        from alert_history
       where alert_id::text = any($1::text[])
      union all
      select alert_id::text as alert_id, message::text as comment
        from alert_acknowledgements
       where alert_id::text = any($1::text[])
      `,
      [alertIds],
    )).rows || [];
    const historyByAlert = new Map();
    for (const row of historyRows) {
      const alertId = String(row.alert_id);
      const list = historyByAlert.get(alertId) || [];
      list.push({ comment: row.comment, message: row.comment });
      historyByAlert.set(alertId, list);
    }

    const extraHistoryNumbers = [];
    const extraSeen = new Set(numbers);
    const historyNumbersByAlert = new Map();
    for (const alert of alerts) {
      const fromHistory = extractServiceNowIncidentNumbersFromHistory(historyByAlert.get(String(alert.id)) || []);
      historyNumbersByAlert.set(String(alert.id), fromHistory);
      for (const number of fromHistory) {
        if (extraSeen.has(number)) continue;
        extraSeen.add(number);
        extraHistoryNumbers.push(number);
      }
    }

    const byHistoryNumber = new Map();
    if (extraHistoryNumbers.length) {
      const found = await pool.query(
        `select ${selectList} from servicenow_incidents where upper(number::text) = any($1::text[])`,
        [extraHistoryNumbers],
      );
      for (const row of found.rows || []) {
        const incident = mapReadModelIncident(row);
        if (!incident?.number) continue;
        byHistoryNumber.set(incident.number, incident);
      }
    }
    for (const number of numbers) {
      if (byNumber.get(number)) byHistoryNumber.set(number, byNumber.get(number));
    }

    const eventIds = [...new Set(alerts.map((alert) => String(alert.source_event_id || "").trim()).filter(Boolean))];
    const eventClauses = [];
    if (columns.has("zabbix_event_id")) eventClauses.push("zabbix_event_id::text = any($1::text[])");
    if (columns.has("correlation_id")) eventClauses.push("correlation_id::text = any($1::text[])");
    const byEventId = new Map();
    if (eventIds.length && eventClauses.length) {
      const found = await pool.query(
        `select ${selectList} from servicenow_incidents where ${eventClauses.join(" or ")}`,
        [eventIds],
      );
      for (const row of found.rows || []) {
        const incident = mapReadModelIncident(row);
        const keys = [row.zabbix_event_id, row.correlation_id]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        for (const key of keys) {
          if (!byEventId.has(key)) byEventId.set(key, incident);
        }
      }
    }

    const rows = alerts.map((alert, index) => {
      const inspect = inspects[index];
      const classified = classifyExplicitServiceNowCorrelation({
        inspect,
        bySysId,
        byNumber,
      });
      const publicClass = toPublicClass(classified.classification);
      const relation = pickRelation({
        inspect,
        classified,
        historyNumbers: historyNumbersByAlert.get(String(alert.id)) || [],
        byHistoryNumber,
        eventIncident: byEventId.get(String(alert.source_event_id || "").trim()) || null,
      });
      return {
        alert_id: alert.id,
        source_event_id: alert.source_event_id || null,
        last_seen_at: alert.last_seen_at ? new Date(alert.last_seen_at).toISOString() : null,
        public_class: publicClass,
        classification: classified.classification,
        causes: classified.causes,
        valid_sys_ids: classified.valid_sys_ids,
        valid_numbers: classified.valid_numbers,
        sys_id_exists: classified.sys_id_exists,
        number_exists: classified.number_exists,
        same_incident: classified.same_incident,
        resolved: classified.resolved,
        relation,
      };
    });

    const summary = summarizePublicRows(rows);
    const exactExamples = rows.filter((row) => row.public_class === "correlated_exact");
    const otherExamples = rows.filter((row) => row.public_class !== "correlated_exact" && row.relation?.incident);
    const examples = [...exactExamples, ...otherExamples, ...rows]
      .filter((row, index, list) => list.findIndex((item) => item.alert_id === row.alert_id) === index)
      .slice(0, 10)
      .map(examplePayload);

    report.status = "ok";
    report.lookups = {
      unique_sys_ids: sysIds.length,
      unique_numbers: numbers.length,
      history_numbers: extraHistoryNumbers.length,
      event_ids: eventIds.length,
      event_hits: byEventId.size,
    };
    report.summary = summary;
    report.examples = examples;
    report.headline = {
      TOTAL: summary.TOTAL,
      EXACT: summary.EXACT,
      MISMATCH: summary.MISMATCH,
      MISSING: summary.MISSING,
      CORRELATION_RATE: `${summary.CORRELATION_RATE}%`,
    };
    if (!report.read_model_rows) {
      report.status = "servicenow_incidents_empty";
      process.exitCode = 2;
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = "error";
    report.error = error?.code || error?.message || "error";
    report.error_message = String(error?.message || "").slice(0, 240);
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
