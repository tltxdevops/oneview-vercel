/**
 * SN-P0-13B — Audit de sysparm_query com eventids já presentes no ServiceNow.
 * 1) Lê amostra SN (monitoring + zabbix monitoring) e parseia eventid da description.
 * 2) Para cada eventid conhecido, testa strategies de lookup.
 * Sem host fallback. Sem frontend.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGet,
  serviceNowGetAll,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  normalizeServiceNowIncident,
  parseZabbixFieldsFromDescription,
  SERVICENOW_INCIDENT_FIELDS_CSV,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const FIELDS = [
  "sys_id", "number", "short_description", "description", "state",
  "priority", "opened_at", "sys_updated_on", "caller_id", "contact_type",
].join(",");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function resolveZabbixCallerId(config) {
  return String(argValue("caller-id", "") || config.zabbixMonitoringCallerId || "").trim();
}

/** Preenchidos em main() a partir de env/--caller-id (SN-P0-33). */
let ZABBIX_CALLER_ID = "";
let BASE = "";

const SAMPLE_SIZE = Math.min(12, Math.max(4, Number.parseInt(argValue("sample", "8"), 10) || 8));

function classifyLifecycle(shortDescription) {
  const text = String(shortDescription || "");
  if (/\[RESOLVED\]/i.test(text) || /🟢/.test(text)) return "RESOLVED";
  if (/\[PROBLEM\]/i.test(text) || /🔴/.test(text)) return "PROBLEM";
  return "OTHER";
}

function exactEventIdInDescription(description, eventId) {
  return String(parseZabbixFieldsFromDescription(description).zabbix_event_id || "") === String(eventId);
}

function buildStrategies(eventId) {
  const id = String(eventId);
  return [
    {
      id: "descriptionLIKE_raw_id",
      query: `${BASE}^descriptionLIKE${id}^ORDERBYDESCsys_updated_on`,
    },
    {
      id: "descriptionLIKE_id_original",
      query: `${BASE}^descriptionLIKEID original do problema: ${id}^ORDERBYDESCsys_updated_on`,
    },
    {
      id: "descriptionLIKE_eventid_eq",
      query: `${BASE}^descriptionLIKEeventid=${id}^ORDERBYDESCsys_updated_on`,
    },
    {
      id: "descriptionLIKE_amp_eventid",
      query: `${BASE}^descriptionLIKE&eventid=${id}^ORDERBYDESCsys_updated_on`,
    },
    {
      id: "descriptionLIKE_question_eventid",
      query: `${BASE}^descriptionLIKE?eventid=${id}^ORDERBYDESCsys_updated_on`,
    },
    {
      id: "NQ_id_original_OR_eventid_eq",
      query: [
        `${BASE}^descriptionLIKEID original do problema: ${id}`,
        `NQcontact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}^descriptionLIKEeventid=${id}`,
        "ORDERBYDESCsys_updated_on",
      ].join("^"),
    },
    {
      id: "NQ_raw_OR_eventid_eq",
      query: [
        `${BASE}^descriptionLIKE${id}`,
        `NQcontact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}^descriptionLIKEeventid=${id}`,
        "ORDERBYDESCsys_updated_on",
      ].join("^"),
    },
  ];
}

async function runQuery(config, query, limit = 50) {
  const started = Date.now();
  try {
    const page = await serviceNowGet("incident", {
      config,
      sysparm_query: query,
      sysparm_fields: FIELDS,
      sysparm_limit: limit,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
    });
    return {
      ok: true,
      latency_ms: Date.now() - started,
      returned: page.count,
      x_total_count: Number.isFinite(page.totalCount) ? page.totalCount : null,
      records: page.records,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      returned: 0,
      x_total_count: null,
      records: [],
      error: error instanceof ServiceNowClientError ? error.code : sanitizeServiceNowError(error),
    };
  }
}

function analyze(records, eventId) {
  const rows = records.map((raw) => {
    const item = normalizeServiceNowIncident(raw);
    return {
      number: item.number,
      sys_id: item.sys_id,
      lifecycle: classifyLifecycle(item.short_description),
      exact: exactEventIdInDescription(item.description, eventId),
      parsed: item.zabbix_event_id,
      short: String(item.short_description || "").slice(0, 90),
      state_display: extractServiceNowDisplay(raw?.state),
    };
  });
  const exact = rows.filter((r) => r.exact);
  const fp = rows.filter((r) => !r.exact);
  const byNumber = new Map();
  for (const row of exact) byNumber.set(row.number, (byNumber.get(row.number) || 0) + 1);
  const duplicates = [...byNumber.entries()].filter(([, n]) => n > 1).map(([number, n]) => ({ number, n }));
  const life = { PROBLEM: 0, RESOLVED: 0, OTHER: 0 };
  for (const row of exact) life[row.lifecycle] += 1;
  return {
    exact_match_count: exact.length,
    false_positive_count: fp.length,
    duplicate_incident_numbers: duplicates,
    lifecycle_counts: life,
    problem_and_resolved_same_eventid: life.PROBLEM > 0 && life.RESOLVED > 0,
    exact_examples: exact.slice(0, 6),
    false_positive_examples: fp.slice(0, 2),
  };
}

async function seedEventIds(config) {
  const page = await serviceNowGetAll("incident", {
    config,
    sysparm_query: `${BASE}^ORDERBYDESCsys_updated_on^ORDERBYsys_id`,
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: 100,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
    maxRecords: 300,
  });

  const byEvent = new Map();
  for (const raw of page.records) {
    const item = normalizeServiceNowIncident(raw);
    const eventId = item.zabbix_event_id;
    if (!eventId) continue;
    if (!byEvent.has(eventId)) {
      byEvent.set(eventId, {
        source_event_id: eventId,
        seed_incidents: [],
        lifecycles: new Set(),
      });
    }
    const entry = byEvent.get(eventId);
    const life = classifyLifecycle(item.short_description);
    entry.lifecycles.add(life);
    entry.seed_incidents.push({
      number: item.number,
      lifecycle: life,
      sys_updated_on: item.sys_updated_on,
    });
  }

  const all = [...byEvent.values()];
  // Prefer eventids that already show PROBLEM+RESOLVED in the seed page
  all.sort((a, b) => {
    const aPair = a.lifecycles.has("PROBLEM") && a.lifecycles.has("RESOLVED") ? 1 : 0;
    const bPair = b.lifecycles.has("PROBLEM") && b.lifecycles.has("RESOLVED") ? 1 : 0;
    if (bPair !== aPair) return bPair - aPair;
    return b.seed_incidents.length - a.seed_incidents.length;
  });

  return {
    x_total_count: page.totalCount,
    scanned: page.records.length,
    with_eventid: all.length,
    sample: all.slice(0, SAMPLE_SIZE),
  };
}

function summarize(strategyId, runs) {
  const ok = runs.filter((r) => r.ok);
  const exactHits = ok.filter((r) => r.exact_match_count > 0);
  const exactTotal = ok.reduce((s, r) => s + r.exact_match_count, 0);
  const fpTotal = ok.reduce((s, r) => s + r.false_positive_count, 0);
  const returnedSum = ok.reduce((s, r) => s + r.returned, 0);
  const xSum = ok.filter((r) => r.x_total_count != null).reduce((s, r) => s + r.x_total_count, 0);
  const xN = ok.filter((r) => r.x_total_count != null).length;
  const latSum = ok.reduce((s, r) => s + r.latency_ms, 0);
  const latMax = ok.reduce((m, r) => Math.max(m, r.latency_ms), 0);
  const pairs = ok.filter((r) => r.problem_and_resolved_same_eventid).length;
  const dups = ok.filter((r) => r.duplicate_incident_numbers.length > 0).length;
  const recall = runs.length ? exactHits.length / runs.length : 0;
  const precision = (exactTotal + fpTotal) ? exactTotal / (exactTotal + fpTotal) : null;
  const avgReturned = ok.length ? returnedSum / ok.length : null;
  const avgX = xN ? xSum / xN : null;
  const avgLat = ok.length ? latSum / ok.length : null;
  const score = ok.length
    ? recall * 100 + (precision ?? 0) * 40 - Math.log10(Math.max(avgReturned || 1, 1)) * 5 - ((avgLat || 0) / 1000) + (pairs > 0 ? 3 : 0)
    : -1e9;
  return {
    id: strategyId,
    score: Number(score.toFixed(2)),
    recall_eventids_with_hit: Number(recall.toFixed(3)),
    precision_page_records: precision == null ? null : Number(precision.toFixed(3)),
    avg_latency_ms: avgLat == null ? null : Math.round(avgLat),
    max_latency_ms: latMax,
    avg_returned: avgReturned == null ? null : Number(avgReturned.toFixed(2)),
    avg_x_total_count: avgX == null ? null : Number(avgX.toFixed(2)),
    eventids_with_duplicates: dups,
    problem_resolved_pairs: pairs,
    queries_failed: runs.length - ok.length,
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.log(JSON.stringify({ ok: false, error: "servicenow_not_configured" }, null, 2));
    process.exit(2);
  }

  ZABBIX_CALLER_ID = resolveZabbixCallerId(config);
  if (!ZABBIX_CALLER_ID) {
    console.log(JSON.stringify({
      ok: false,
      error: "servicenow_caller_not_configured",
      hint: "Defina SERVICENOW_ZABBIX_MONITORING_CALLER_ID ou --caller-id=",
    }, null, 2));
    process.exit(2);
  }
  BASE = `contact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}`;

  const seedStarted = Date.now();
  const seed = await seedEventIds(config);
  const seedLatency = Date.now() - seedStarted;

  // baseline control once
  const control = await runQuery(config, `${BASE}^ORDERBYDESCsys_updated_on`, 5);

  const byStrategy = new Map();
  const perEvent = [];

  for (const entry of seed.sample) {
    const eventId = entry.source_event_id;
    const eventReport = {
      source_event_id: eventId,
      seed_incident_count: entry.seed_incidents.length,
      seed_lifecycles: [...entry.lifecycles],
      strategies: [],
    };

    for (const strategy of buildStrategies(eventId)) {
      const result = await runQuery(config, strategy.query, 50);
      const analysis = result.ok
        ? analyze(result.records, eventId)
        : {
          exact_match_count: 0,
          false_positive_count: 0,
          duplicate_incident_numbers: [],
          lifecycle_counts: { PROBLEM: 0, RESOLVED: 0, OTHER: 0 },
          problem_and_resolved_same_eventid: false,
          exact_examples: [],
          false_positive_examples: [],
        };

      const run = {
        ok: result.ok,
        error: result.error,
        latency_ms: result.latency_ms,
        returned: result.returned,
        x_total_count: result.x_total_count,
        query: strategy.query,
        ...analysis,
      };
      eventReport.strategies.push({ strategy: strategy.id, ...run });

      if (!byStrategy.has(strategy.id)) byStrategy.set(strategy.id, []);
      byStrategy.get(strategy.id).push(run);
    }
    perEvent.push(eventReport);
  }

  const ranked = [...byStrategy.entries()]
    .map(([id, runs]) => summarize(id, runs))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const templates = {
    descriptionLIKE_raw_id: `${BASE}^descriptionLIKE{source_event_id}`,
    descriptionLIKE_id_original: `${BASE}^descriptionLIKEID original do problema: {source_event_id}`,
    descriptionLIKE_eventid_eq: `${BASE}^descriptionLIKEeventid={source_event_id}`,
    descriptionLIKE_amp_eventid: `${BASE}^descriptionLIKE&eventid={source_event_id}`,
    descriptionLIKE_question_eventid: `${BASE}^descriptionLIKE?eventid={source_event_id}`,
    NQ_id_original_OR_eventid_eq:
      `${BASE}^descriptionLIKEID original do problema: {source_event_id}^NQcontact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}^descriptionLIKEeventid={source_event_id}`,
    NQ_raw_OR_eventid_eq:
      `${BASE}^descriptionLIKE{source_event_id}^NQcontact_type=monitoring^caller_id=${ZABBIX_CALLER_ID}^descriptionLIKEeventid={source_event_id}`,
  };

  console.log(JSON.stringify({
    ok: true,
    card: "SN-P0-13",
    constraints: {
      contact_type: "monitoring",
      caller_id: ZABBIX_CALLER_ID,
      caller_display: "zabbix monitoring",
      eventid: "exact",
      host_fallback: false,
    },
    seed: {
      latency_ms: seedLatency,
      scanned_incidents: seed.scanned,
      x_total_count: seed.x_total_count,
      distinct_eventids_found: seed.with_eventid,
      sample_size: seed.sample.length,
      sample_eventids: seed.sample.map((s) => ({
        source_event_id: s.source_event_id,
        seed_count: s.seed_incidents.length,
        lifecycles: [...s.lifecycles],
      })),
    },
    control_baseline: {
      latency_ms: control.latency_ms,
      returned: control.returned,
      x_total_count: control.x_total_count,
      note: "sem filtro de eventid",
    },
    ranked_strategies: ranked,
    recommendation: best
      ? {
        strategy: best.id,
        proposed_sysparm_query: templates[best.id],
        metrics: best,
        required_post_filter: "parseZabbixFieldsFromDescription(description).zabbix_event_id === source_event_id",
        no_host_fallback: true,
        notes: [
          "Sempre restringir contact_type=monitoring^caller_id=<zabbix monitoring>.",
          "LIKE no ServiceNow não é regex; validar eventid exato no parser após o GET.",
          "O mesmo eventid pode gerar PROBLEM e RESOLVED (dois números INC).",
        ],
      }
      : null,
    per_event: perEvent,
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: sanitizeServiceNowError(error),
    code: error?.code || null,
  }, null, 2));
  process.exit(2);
});
