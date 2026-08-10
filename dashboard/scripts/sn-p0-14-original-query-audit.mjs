/**
 * SN-P0-14 — Auditar query original (somente GET read-only).
 *
 * Compara:
 *   A) sem sysparm_query
 *   B) sysparm_query=2df773e59708b25047febd76f053afc8
 *   C) sysparm_query=contact_type=monitoring
 *   D) contact_type=monitoring como parâmetro direto (não sysparm_query)
 *
 * Uso:
 *   node scripts/sn-p0-14-original-query-audit.mjs
 *
 * Sem alterar código produtivo.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
} from "../api/_lib/servicenow-client.js";
import { extractServiceNowValue } from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const ORIGINAL_QUERY_TOKEN = "2df773e59708b25047febd76f053afc8";
const LIMIT = 3;
const FIELDS = "sys_id,number,short_description,contact_type,caller_id,sys_updated_on";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function runVariant(config, { id, label, params }) {
  const url = new URL(`/api/now/table/incident`, `${config.baseUrl}/`);
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
    const status = response.status;
    const xTotalRaw = response.headers.get("x-total-count");
    const x_total_count =
      xTotalRaw != null && xTotalRaw !== "" ? Number.parseInt(xTotalRaw, 10) : null;

    let body = null;
    let parse_error = null;
    try {
      body = await response.json();
    } catch (error) {
      parse_error = sanitizeServiceNowError(error);
    }

    const records = Array.isArray(body?.result) ? body.result : [];
    const first_three_numbers = records.slice(0, 3).map((row) => extractServiceNowValue(row?.number));

    return {
      id,
      label,
      request_params: params,
      status,
      ok: response.ok,
      latency_ms,
      x_total_count: Number.isFinite(x_total_count) ? x_total_count : null,
      returned: records.length,
      first_three_numbers,
      error: response.ok ? null : `http_${status}`,
      parse_error,
    };
  } catch (error) {
    return {
      id,
      label,
      request_params: params,
      status: null,
      ok: false,
      latency_ms: Date.now() - started,
      x_total_count: null,
      returned: 0,
      first_three_numbers: [],
      error: sanitizeServiceNowError(error),
      parse_error: null,
    };
  }
}

function sameUniverse(a, b) {
  if (!a?.ok || !b?.ok) {
    return {
      comparable: false,
      same_x_total_count: false,
      same_first_three_numbers: false,
      reason: "one_or_both_failed",
    };
  }
  const sameTotal =
    a.x_total_count != null
    && b.x_total_count != null
    && a.x_total_count === b.x_total_count;
  const sameNumbers =
    JSON.stringify(a.first_three_numbers) === JSON.stringify(b.first_three_numbers);
  return {
    comparable: true,
    same_x_total_count: sameTotal,
    same_first_three_numbers: sameNumbers,
    same_universe: sameTotal && sameNumbers,
    a_x_total_count: a.x_total_count,
    b_x_total_count: b.x_total_count,
    a_first_three_numbers: a.first_three_numbers,
    b_first_three_numbers: b.first_three_numbers,
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.log(JSON.stringify({ ok: false, error: "servicenow_not_configured" }, null, 2));
    process.exit(2);
  }

  const common = {
    sysparm_fields: FIELDS,
    sysparm_limit: String(LIMIT),
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  };

  const variants = [
    {
      id: "A",
      label: "sem sysparm_query",
      params: { ...common },
    },
    {
      id: "B",
      label: `sysparm_query=${ORIGINAL_QUERY_TOKEN}`,
      params: { ...common, sysparm_query: ORIGINAL_QUERY_TOKEN },
    },
    {
      id: "C",
      label: "sysparm_query=contact_type=monitoring",
      params: { ...common, sysparm_query: "contact_type=monitoring" },
    },
    {
      id: "D",
      label: "contact_type=monitoring como parâmetro direto",
      params: { ...common, contact_type: "monitoring" },
    },
  ];

  const results = [];
  for (const variant of variants) {
    results.push(await runVariant(config, variant));
  }

  const byId = Object.fromEntries(results.map((row) => [row.id, row]));

  console.log(JSON.stringify({
    ok: true,
    card: "SN-P0-14",
    table: "incident",
    note: "Somente GET. Sem alteração de código produtivo.",
    results: results.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      x_total_count: row.x_total_count,
      first_three_numbers: row.first_three_numbers,
      latency_ms: row.latency_ms,
      returned: row.returned,
      error: row.error,
    })),
    a_vs_b_same_universe: sameUniverse(byId.A, byId.B),
    observations: [
      "A = universo sem filtro encoded query.",
      "B = token legado em sysparm_query (parece sys_id / filtro salvo, não encoded query).",
      "C = filtro canônico contact_type=monitoring via sysparm_query.",
      "D = contact_type como querystring solta (fora do contrato Table API sysparm_*).",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: sanitizeServiceNowError(error),
  }, null, 2));
  process.exit(2);
});
