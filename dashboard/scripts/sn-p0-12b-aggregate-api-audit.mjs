/**
 * SN-P0-12B — Validar Aggregate API (/api/now/stats/incident).
 * Somente GET. Compara com KPIs atuais de /chamados (Table API + X-Total-Count).
 *
 * Uso:
 *   node scripts/sn-p0-12b-aggregate-api-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGet,
} from "../api/_lib/servicenow-client.js";
import { INCIDENT_STATE_KPI } from "../api/_lib/oneview-incidents.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const QUERY_BASE = "contact_type=monitoring";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function asInt(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

function pickStatsCount(row) {
  if (row == null || typeof row !== "object") return null;
  const candidates = [
    row?.stats?.count,
    row?.stats?.COUNT,
    row?.count,
    row?.COUNT,
  ];
  for (const value of candidates) {
    const n = asInt(value);
    if (n != null) return n;
  }
  return null;
}

function pickGroupValue(row, field) {
  if (row == null || typeof row !== "object") return null;
  if (Array.isArray(row.groupby_fields)) {
    const hit = row.groupby_fields.find((item) => String(item?.field || "") === field);
    if (hit != null && hit.value != null && hit.value !== "") {
      return String(hit.value).trim();
    }
  }
  const direct = row[field] ?? row?.groupBy?.[field];
  if (direct != null && typeof direct === "object") {
    return String(direct.value ?? direct.display_value ?? "").trim() || null;
  }
  if (direct != null) return String(direct).trim() || null;
  return null;
}

function mapGroupBy(rows, field) {
  const out = {};
  for (const row of rows) {
    const key = pickGroupValue(row, field) ?? "(null)";
    out[key] = pickStatsCount(row);
  }
  return out;
}

async function statsGet(config, params) {
  const url = new URL("/api/now/stats/incident", `${config.baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: basicAuth(config.username, config.password),
      },
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs || 15000),
    });

    const latency_ms = Date.now() - started;
    let body = null;
    let parse_error = null;
    let raw_text = null;
    try {
      raw_text = await response.text();
      body = raw_text ? JSON.parse(raw_text) : {};
    } catch (error) {
      parse_error = sanitizeServiceNowError(error);
    }

    const result = body?.result;
    const rows = Array.isArray(result) ? result : (result != null ? [result] : []);

    return {
      ok: response.ok,
      status: response.status,
      latency_ms,
      request_params: params,
      rows,
      result_rows: rows.length,
      result_sample: rows.slice(0, 12),
      parse_error,
      error: response.ok ? null : `http_${response.status}`,
      raw_preview: response.ok ? null : String(raw_text || "").slice(0, 400),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      request_params: params,
      rows: [],
      result_rows: 0,
      result_sample: [],
      parse_error: null,
      error: sanitizeServiceNowError(error),
      raw_preview: null,
    };
  }
}

async function tableCount(sysparm_query) {
  const page = await serviceNowGet("incident", {
    sysparm_query,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_display_value: "false",
  });
  return Number.isFinite(page.totalCount) ? page.totalCount : page.count;
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.log(JSON.stringify({ ok: false, card: "SN-P0-12B", error: "servicenow_not_configured" }, null, 2));
    process.exit(2);
  }

  const startedAt = Date.now();

  const probes = {
    count_total_monitoring: await statsGet(config, {
      sysparm_count: "true",
      sysparm_query: QUERY_BASE,
    }),
    group_by_state: await statsGet(config, {
      sysparm_count: "true",
      sysparm_group_by: "state",
      sysparm_query: QUERY_BASE,
    }),
    group_by_priority: await statsGet(config, {
      sysparm_count: "true",
      sysparm_group_by: "priority",
      sysparm_query: QUERY_BASE,
    }),
    assigned_to_isempty: await statsGet(config, {
      sysparm_count: "true",
      sysparm_query: `${QUERY_BASE}^assigned_toISEMPTY`,
    }),
    assigned_to_isempty_kpi: await statsGet(config, {
      sysparm_count: "true",
      sysparm_query: `${QUERY_BASE}^assigned_toISEMPTY^stateNOT IN6,7`,
    }),
  };

  const statuses = Object.values(probes).map((item) => item.status);
  const any403 = statuses.some((s) => s === 403);
  const any401 = statuses.some((s) => s === 401);
  const allOk = Object.values(probes).every((item) => item.ok);

  let chamadosKpis = null;
  let baselineError = null;
  try {
    const [total, open, in_progress, resolved, closed, unassigned_all, unassigned] = await Promise.all([
      tableCount(QUERY_BASE),
      tableCount(`${QUERY_BASE}^state=${INCIDENT_STATE_KPI.open.state}`),
      tableCount(`${QUERY_BASE}^state=${INCIDENT_STATE_KPI.in_progress.state}`),
      tableCount(`${QUERY_BASE}^state=${INCIDENT_STATE_KPI.resolved.state}`),
      tableCount(`${QUERY_BASE}^state=${INCIDENT_STATE_KPI.closed.state}`),
      tableCount(`${QUERY_BASE}^assigned_toISEMPTY`),
      tableCount(`${QUERY_BASE}^assigned_toISEMPTY^stateNOT IN6,7`),
    ]);
    chamadosKpis = {
      source: "table_api_x_total_count",
      total,
      open,
      in_progress,
      resolved,
      closed,
      unassigned_all_states: unassigned_all,
      unassigned,
    };
  } catch (error) {
    baselineError = sanitizeServiceNowError(error);
  }

  let aggregateDerived = null;
  let comparison = null;

  if (allOk) {
    const by_state = mapGroupBy(probes.group_by_state.rows, "state");
    const by_priority = mapGroupBy(probes.group_by_priority.rows, "priority");
    aggregateDerived = {
      total: pickStatsCount(probes.count_total_monitoring.rows[0]),
      open: by_state["1"] ?? null,
      in_progress: by_state["2"] ?? null,
      resolved: by_state["6"] ?? null,
      closed: by_state["7"] ?? null,
      unassigned_all_states: pickStatsCount(probes.assigned_to_isempty.rows[0]),
      unassigned: pickStatsCount(probes.assigned_to_isempty_kpi.rows[0]),
      by_state,
      by_priority,
    };

    if (chamadosKpis) {
      const keys = ["total", "open", "in_progress", "resolved", "closed", "unassigned"];
      const diffs = {};
      let all_match = true;
      for (const key of keys) {
        const table = chamadosKpis[key];
        const aggregate = aggregateDerived[key];
        const match = table === aggregate;
        if (!match) all_match = false;
        diffs[key] = { table, aggregate, match };
      }
      comparison = { all_match, diffs };
    }
  }

  const decision = any403
    ? {
      use_aggregate_for_summary: false,
      reason: "Aggregate API retornou 403 — não alterar UI; manter Table API + X-Total-Count.",
      ui_changed: false,
    }
    : any401
      ? {
        use_aggregate_for_summary: false,
        reason: "Aggregate API retornou 401 — não alterar UI.",
        ui_changed: false,
      }
      : allOk && comparison?.all_match
        ? {
          use_aggregate_for_summary: true,
          reason: "Aggregate API OK e KPIs batem com /chamados — usar Aggregate API para summary.",
          ui_changed: false,
        }
        : allOk
          ? {
            use_aggregate_for_summary: false,
            reason: "Aggregate API respondeu, mas KPIs não batem 100% — não migrar sem revisão.",
            ui_changed: false,
          }
          : {
            use_aggregate_for_summary: false,
            reason: "Aggregate API falhou em um ou mais probes — não alterar UI.",
            ui_changed: false,
          };

  console.log(JSON.stringify({
    ok: true,
    card: "SN-P0-12B",
    mode: "read_only_get",
    duration_ms: Date.now() - startedAt,
    query_base: QUERY_BASE,
    aggregate_api: {
      endpoint: "/api/now/stats/incident",
      any_403: any403,
      any_401: any401,
      all_ok: allOk,
      probes: Object.fromEntries(
        Object.entries(probes).map(([key, value]) => [key, {
          status: value.status,
          ok: value.ok,
          latency_ms: value.latency_ms,
          result_rows: value.result_rows,
          error: value.error,
          parse_error: value.parse_error,
          raw_preview: value.raw_preview,
          result_sample: value.result_sample,
          request_params: value.request_params,
        }]),
      ),
    },
    chamados_kpis_atual: chamadosKpis,
    baseline_error: baselineError,
    aggregate_derived_kpis: aggregateDerived,
    comparison,
    decision,
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    card: "SN-P0-12B",
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exit(2);
});
