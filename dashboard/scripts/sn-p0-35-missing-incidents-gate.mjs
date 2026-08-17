/**
 * SN-P0-35 — ServiceNow Missing Incidents Gate (read-only audit).
 * Compara A/B/C na instância efetivamente configurada em SERVICENOW_BASE_URL.
 * Nunca imprime username/password. Sem POST/PATCH/DELETE. Sem alterar env.
 *
 * Uso: node scripts/sn-p0-35-missing-incidents-gate.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  serviceNowGet,
  serviceNowStats,
  sanitizeServiceNowError,
} from "../api/_lib/servicenow-client.js";
import {
  buildIncidentSysparmQuery,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";
import { SERVICENOW_INCIDENT_FIELDS_CSV } from "../api/_lib/servicenow-normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const CALLER_B = "aa62f29f47477610082e3d02e26d4358";
const OPENED_FROM = "2026-08-01";
const OPENED_TO = "2026-08-12";
const QUERY_B_FILTER =
  `caller_id=${CALLER_B}`
  + `^opened_at>=${OPENED_FROM} 00:00:00`
  + `^opened_at<=${OPENED_TO} 23:59:59`;
const QUERY_B = `${QUERY_B_FILTER}^ORDERBYDESCopened_at`;
const QUERY_C_FILTER = "contact_type=monitoring";

const SAMPLE_TARGET = 40;
const PAGE_LIMIT = 100;

function loadDotEnvLocal() {
  const envPath = path.join(root, ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function hostnameOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "(invalid_base_url)";
  }
}

function isProdHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h.includes("service-now.com") && !h.includes("dev") && !h.includes("test") && !h.includes("sandbox");
}

function extractNumber(row) {
  const raw = row?.number;
  if (raw && typeof raw === "object") return String(raw.value || raw.display_value || "").trim();
  return String(raw || "").trim();
}

function extractField(row, key) {
  const raw = row?.[key];
  if (raw && typeof raw === "object") {
    return {
      value: String(raw.value ?? "").trim() || null,
      display: String(raw.display_value ?? raw.value ?? "").trim() || null,
    };
  }
  const text = String(raw ?? "").trim();
  return { value: text || null, display: text || null };
}

async function countQuery(config, sysparm_query) {
  const stats = await serviceNowStats("incident", {
    config,
    sysparm_query: sysparm_query || undefined,
    sysparm_count: "true",
  });
  const n = Number(stats?.totalCount);
  if (Number.isFinite(n)) return n;
  // fallback: page 1
  const page = await serviceNowGet("incident", {
    config,
    sysparm_query,
    sysparm_fields: "sys_id,number",
    sysparm_limit: 1,
    sysparm_offset: 0,
    sysparm_display_value: "all",
  });
  return Number.isFinite(page.totalCount) ? page.totalCount : null;
}

async function fetchAllPages(config, sysparm_query, { maxRecords = 5000, fields = "sys_id,number,caller_id,contact_type,opened_at,state,assigned_to" } = {}) {
  const rows = [];
  let offset = 0;
  let totalCount = null;
  while (rows.length < maxRecords) {
    const page = await serviceNowGet("incident", {
      config,
      sysparm_query,
      sysparm_fields: fields,
      sysparm_limit: PAGE_LIMIT,
      sysparm_offset: offset,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
    });
    if (totalCount == null && Number.isFinite(page.totalCount)) totalCount = page.totalCount;
    const batch = page.records || [];
    rows.push(...batch);
    if (!batch.length) break;
    offset += batch.length;
    if (Number.isFinite(totalCount) && offset >= totalCount) break;
    if (batch.length < PAGE_LIMIT) break;
  }
  return { rows, totalCount: totalCount ?? rows.length };
}

function classifyExclusion(row, { queryCHasContactType, queryCHasCaller, queryCOpenedFrom, queryCOpenedTo }) {
  const reasons = [];
  const contact = extractField(row, "contact_type");
  const caller = extractField(row, "caller_id");
  const state = extractField(row, "state");
  const assigned = extractField(row, "assigned_to");
  const opened = extractField(row, "opened_at");

  if (queryCHasContactType && contact.value && contact.value !== "monitoring") {
    reasons.push({
      predicate: "contact_type",
      detail: `contact_type=${contact.value || "(empty)"} (display=${contact.display || "—"}) ≠ monitoring`,
    });
  }
  if (queryCHasContactType && !contact.value) {
    reasons.push({
      predicate: "contact_type",
      detail: "contact_type vazio/ausente; BFF exige contact_type=monitoring",
    });
  }
  if (queryCHasCaller && caller.value && caller.value !== CALLER_B) {
    reasons.push({
      predicate: "caller_id",
      detail: `caller_id=${caller.value} fora do filtro C`,
    });
  }
  if (queryCOpenedFrom || queryCOpenedTo) {
    const openedAt = opened.value || "";
    if (queryCOpenedFrom && openedAt && openedAt < `${queryCOpenedFrom}`) {
      reasons.push({ predicate: "data", detail: `opened_at ${openedAt} < ${queryCOpenedFrom}` });
    }
    if (queryCOpenedTo && openedAt && openedAt > `${queryCOpenedTo} 23:59:59`) {
      reasons.push({ predicate: "data", detail: `opened_at ${openedAt} > ${queryCOpenedTo} 23:59:59` });
    }
  }

  // Default C has no state/assigned filters — note only if present for context
  if (!reasons.length) {
    reasons.push({
      predicate: "outro",
      detail: `Não excluído por contact_type/caller/data óbvios; state=${state.value || "—"} assigned_to=${assigned.value || "(empty)"} opened_at=${opened.value || "—"}. Verificar ACL/paginação/ambiente.`,
    });
  }
  return {
    number: extractNumber(row),
    contact_type: contact,
    caller_id: caller,
    state,
    assigned_to: assigned,
    opened_at: opened.value,
    reasons,
  };
}

async function lookupByNumber(config, number) {
  const page = await serviceNowGet("incident", {
    config,
    sysparm_query: `number=${number}`,
    sysparm_fields: "sys_id,number,caller_id,contact_type,opened_at,state",
    sysparm_limit: 5,
    sysparm_offset: 0,
    sysparm_display_value: "all",
  });
  return {
    number,
    found: (page.records || []).length > 0,
    count: page.records?.length || 0,
    totalCount: page.totalCount,
  };
}

async function main() {
  loadDotEnvLocal();
  const config = getServiceNowConfig();
  const hostname = hostnameOf(config.baseUrl);
  const prodLike = isProdHost(hostname);

  const bffDefaultFilters = parseIncidentFilters({ query: {} });
  const queryC = buildIncidentSysparmQuery(bffDefaultFilters);

  const report = {
    card: "SN-P0-35",
    audited_at: new Date().toISOString(),
    effective: {
      hostname,
      base_url_scheme_host: config.baseUrl ? `${new URL(config.baseUrl).protocol}//${hostname}` : null,
      configured: config.configured,
      incidents_enabled: String(process.env.SERVICENOW_INCIDENTS_ENABLED || "").toLowerCase() === "true",
      zabbix_caller_env_configured: Boolean(config.zabbixMonitoringCallerId),
      is_prod_hostname: prodLike,
      note: prodLike
        ? "Hostname parece PROD."
        : "Hostname efetivo NÃO é PROD (contém dev/test/sandbox ou não classificado como PROD). Comparação A/B/C roda na instância configurada; gate PROD bloqueado sem troca de env.",
    },
    bff_contract: {
      endpoint: "GET /api/oneview/incidents → Table API GET /api/now/table/incident",
      sysparm_query_default_literal: queryC,
      sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
      sysparm_limit_default_page: bffDefaultFilters.page_size,
      sysparm_offset_page1: 0,
      sysparm_display_value: "all",
      order: "ORDERBYDESCsys_updated_on^ORDERBYsys_id",
      implicit_required: ["contact_type=monitoring"],
      caller_id_default_required: false,
      contact_type_still_required: true,
    },
    queries: {
      A: "(sem sysparm_query — todos os incidentes visíveis à ACL da conta)",
      B: QUERY_B,
      C: queryC,
    },
    totals: { A: null, B: null, C: null },
    missing_B_to_C: {
      sampled_from_B: 0,
      missing_count: 0,
      present_count: 0,
      items: [],
    },
    number_lookup: [],
    blocked: null,
    error: null,
  };

  if (!config.configured) {
    report.blocked = "servicenow_not_configured";
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  if (!prodLike) {
    report.blocked = "effective_host_is_not_prod";
    report.prod_gate = {
      required_for_card: "MESMA instância PROD",
      effective_hostname: hostname,
      action: "Não alterar env neste card. Rodar A/B/C na instância configurada para documentar divergência de query; PROD exige credenciais/host PROD em sessão futura.",
    };
  }

  try {
    const [totalA, totalB, totalC] = await Promise.all([
      countQuery(config, ""),
      countQuery(config, QUERY_B_FILTER),
      countQuery(config, QUERY_C_FILTER),
    ]);
    report.totals.A = totalA;
    report.totals.B = totalB;
    report.totals.C = totalC;

    // Fetch B sample (with order) for missing analysis
    const bData = await fetchAllPages(config, QUERY_B, { maxRecords: Math.max(SAMPLE_TARGET, 100) });
    const bNumbers = [];
    const bByNumber = new Map();
    for (const row of bData.rows) {
      const num = extractNumber(row);
      if (!num || bByNumber.has(num)) continue;
      bByNumber.set(num, row);
      bNumbers.push(num);
      if (bNumbers.length >= SAMPLE_TARGET) break;
    }
    report.missing_B_to_C.sampled_from_B = bNumbers.length;

    const missingItems = [];
    const present = [];
    for (const number of bNumbers) {
      const cHit = await serviceNowGet("incident", {
        config,
        sysparm_query: `${QUERY_C_FILTER}^number=${number}`,
        sysparm_fields: "sys_id,number,caller_id,contact_type,opened_at,state,assigned_to",
        sysparm_limit: 5,
        sysparm_offset: 0,
        sysparm_display_value: "all",
        sysparm_exclude_reference_link: "true",
      });
      const foundInC = (cHit.records || []).length > 0;
      if (foundInC) {
        present.push(number);
        continue;
      }
      const row = bByNumber.get(number);
      missingItems.push(classifyExclusion(row, {
        queryCHasContactType: true,
        queryCHasCaller: false,
        queryCOpenedFrom: null,
        queryCOpenedTo: null,
      }));
    }

    report.missing_B_to_C.missing_count = missingItems.length;
    report.missing_B_to_C.present_count = present.length;
    report.missing_B_to_C.items = missingItems;

    // number= lookup independent of list pagination (first up to 8 missing + 2 present)
    const lookupTargets = [
      ...missingItems.slice(0, 8).map((item) => item.number),
      ...present.slice(0, 2),
    ].filter(Boolean);
    for (const number of lookupTargets) {
      report.number_lookup.push(await lookupByNumber(config, number));
    }

    // Reason histogram
    const hist = {};
    for (const item of missingItems) {
      for (const reason of item.reasons) {
        hist[reason.predicate] = (hist[reason.predicate] || 0) + 1;
      }
    }
    report.missing_B_to_C.reason_histogram = hist;
  } catch (error) {
    report.error = {
      code: error?.code || error?.name || "error",
      message: sanitizeServiceNowError(error),
      status: error?.status ?? null,
    };
    process.exitCode = 1;
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
