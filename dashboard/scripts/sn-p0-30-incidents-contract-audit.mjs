/**
 * SN-P0-30 — Auditoria GET /api/oneview/incidents vs ServiceNow DEV.
 * Somente GET. Não imprime senha/token. Entrega divergências.
 *
 * Uso: node scripts/sn-p0-30-incidents-contract-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIncidentSysparmQuery,
  fetchIncidentsPage,
  parseIncidentFilters,
} from "../api/_lib/oneview-incidents.js";
import {
  getServiceNowConfig,
  serviceNowGet,
  serviceNowStats,
  sanitizeServiceNowError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
  SERVICENOW_INCIDENT_FIELDS,
  SERVICENOW_INCIDENT_FIELDS_CSV,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

const divergences = [];
const notes = [];

function addDivergence(id, detail) {
  divergences.push({ id, ...detail });
}

function requestMock(query = {}) {
  return { method: "GET", query, headers: {} };
}

async function snCount(query) {
  const result = await serviceNowGet("incident", {
    sysparm_query: query,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_offset: 0,
    sysparm_display_value: "false",
  });
  return Number.isFinite(result.totalCount) ? result.totalCount : result.count;
}

async function snSample(query, limit = 3) {
  const result = await serviceNowGet("incident", {
    sysparm_query: query,
    sysparm_fields: SERVICENOW_INCIDENT_FIELDS_CSV,
    sysparm_limit: limit,
    sysparm_offset: 0,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });
  return {
    total: Number.isFinite(result.totalCount) ? result.totalCount : result.count,
    records: result.records || [],
    xTotalCount: result.totalCount,
  };
}

function summarizeItem(item) {
  return {
    number: item.number,
    state: item.state,
    state_display: item.state_display,
    priority: item.priority,
    priority_display: item.priority_display,
    company: item.company,
    company_display: item.company_display,
    assigned_to: item.assigned_to,
    assigned_to_display: item.assigned_to_display,
    caller_id: item.caller_id,
    caller_id_display: item.caller_id_display,
  };
}

function displayOk(item) {
  const checks = [];
  if (item.state != null && !item.state_display) checks.push("state_display_missing");
  if (item.priority != null && !item.priority_display) checks.push("priority_display_missing");
  if (item.company && !item.company_display) checks.push("company_display_missing");
  if (item.assigned_to && !item.assigned_to_display) checks.push("assigned_to_display_missing");
  if (item.caller_id && !item.caller_id_display) checks.push("caller_id_display_missing");
  return checks;
}

async function auditFilterCase(name, queryParams) {
  const filters = parseIncidentFilters(requestMock(queryParams));
  const sysparm = buildIncidentSysparmQuery(filters);
  const [bff, sn] = await Promise.all([
    fetchIncidentsPage(filters, { includeCounts: false }),
    snSample(sysparm, 3),
  ]);

  const bffTotal = bff.pagination.total_items;
  const snTotal = sn.total;
  const caseReport = {
    name,
    queryParams,
    sysparm_query: sysparm,
    x_total_count: sn.xTotalCount,
    bff_total_items: bffTotal,
    sn_total: snTotal,
    examples: (bff.items || []).slice(0, 3).map(summarizeItem),
    display_issues: (bff.items || []).flatMap((item, idx) =>
      displayOk(item).map((code) => ({ index: idx, number: item.number, code })),
    ),
  };

  if (bffTotal !== snTotal) {
    addDivergence(`filter_count_mismatch:${name}`, {
      queryParams,
      sysparm_query: sysparm,
      bff_total_items: bffTotal,
      sn_x_total_count: snTotal,
    });
  }

  // number exact: se filtrou number, todos os exemplos devem casar
  if (filters.number) {
    const bad = (bff.items || []).filter((item) => String(item.number || "").toUpperCase() !== String(filters.number).toUpperCase());
    if (bad.length) {
      addDivergence(`number_not_exact:${name}`, {
        expected: filters.number,
        got: bad.map((item) => item.number),
      });
    }
  }

  if (filters.assigned_to) {
    const bad = (bff.items || []).filter((item) => item.assigned_to !== filters.assigned_to);
    if (bad.length) {
      addDivergence(`assigned_to_value_mismatch:${name}`, {
        expected: filters.assigned_to,
        got: bad.map((item) => ({ number: item.number, assigned_to: item.assigned_to })),
      });
    }
  }

  if (filters.caller_id) {
    const bad = (bff.items || []).filter((item) => item.caller_id !== filters.caller_id);
    if (bad.length) {
      addDivergence(`caller_id_value_mismatch:${name}`, {
        expected: filters.caller_id,
        got: bad.map((item) => ({ number: item.number, caller_id: item.caller_id })),
      });
    }
  }

  if (caseReport.display_issues.length) {
    addDivergence(`display_value:${name}`, { issues: caseReport.display_issues.slice(0, 10) });
  }

  // Base: caller nunca default
  if (/caller_id=/.test(sysparm) && !filters.caller_id) {
    addDivergence(`caller_default_injected:${name}`, { sysparm_query: sysparm });
  }
  if (!sysparm.includes("contact_type=monitoring")) {
    addDivergence(`missing_contact_type_base:${name}`, { sysparm_query: sysparm });
  }

  return caseReport;
}

async function auditPagination() {
  const filters = parseIncidentFilters(requestMock({ page: "1", page_size: "10" }));
  const page1 = await fetchIncidentsPage(filters, { includeCounts: false });
  const filters2 = parseIncidentFilters(requestMock({ page: "2", page_size: "10" }));
  const page2 = await fetchIncidentsPage(filters2, { includeCounts: false });

  const ids1 = new Set((page1.items || []).map((item) => item.sys_id || item.number));
  const ids2 = (page2.items || []).map((item) => item.sys_id || item.number);
  const overlap = ids2.filter((id) => ids1.has(id));
  if (overlap.length) {
    addDivergence("pagination_overlap_page1_page2", { overlap: overlap.slice(0, 10) });
  }
  if ((page1.items || []).length === 10 && page1.pagination.total_items > 10 && (page2.items || []).length === 0) {
    addDivergence("pagination_page2_empty_unexpected", {
      total_items: page1.pagination.total_items,
    });
  }

  // Contagem SN direta vs BFF
  const snTotal = await snCount(buildIncidentSysparmQuery(filters));
  if (page1.pagination.total_items !== snTotal) {
    addDivergence("pagination_total_vs_sn", {
      bff_total_items: page1.pagination.total_items,
      sn_x_total_count: snTotal,
    });
  }
}

async function auditFacets() {
  const filters = parseIncidentFilters(requestMock({ page_size: "25" }));
  const payload = await fetchIncidentsPage(filters, { includeCounts: false });
  const facets = payload.facets || {};

  if (!Array.isArray(facets.callers)) {
    addDivergence("facets_missing_callers", {});
  }
  if (!Array.isArray(facets.assignees)) {
    addDivergence("facets_missing_assignees", {});
  }
  if (!Array.isArray(facets.companies)) {
    addDivergence("facets_missing_companies", {
      note: "BFF não expõe facets.companies (Aggregate group_by company)",
    });
  }
  if (!Array.isArray(facets.states)) {
    addDivergence("facets_missing_states", {
      note: "BFF não expõe facets.states",
    });
  }
  if (!Array.isArray(facets.priorities)) {
    addDivergence("facets_missing_priorities", {
      note: "BFF não expõe facets.priorities",
    });
  }

  // assignees: value estável (sys_id) + display_value
  for (const facet of facets.assignees || []) {
    if (!facet.value || facet.value === "(null)") {
      addDivergence("assignee_facet_invalid_value", { facet });
      break;
    }
    if (!facet.display_value && !facet.label) {
      addDivergence("assignee_facet_missing_display", { value: facet.value });
      break;
    }
    // sys_id-like (32 hex) preferred; allow non-empty stable id
    if (facet.value.length < 8) {
      addDivergence("assignee_facet_unstable_value", { value: facet.value, label: facet.label });
      break;
    }
  }

  // callers should prefer stable sys_id; check display consistency
  for (const facet of facets.callers || []) {
    if (!facet.value) {
      addDivergence("caller_facet_invalid_value", { facet });
      break;
    }
    if (!("display_value" in facet) && !facet.label) {
      addDivergence("caller_facet_missing_label", { value: facet.value });
      break;
    }
  }

  // Cross-check assignee aggregate vs BFF facet counts (sample top)
  try {
    const baseQuery = buildIncidentSysparmQuery({
      ...filters,
      assigned_to: null,
      unassigned: false,
      state: null,
      number: null,
    }, { skipOrder: true });
    const stats = await serviceNowStats("incident", {
      sysparm_count: true,
      sysparm_group_by: "assigned_to",
      sysparm_query: baseQuery,
    });
    const snRows = stats.rows || [];
    const snMap = new Map();
    for (const row of snRows) {
      const field = (row.groupby_fields || []).find((g) => g.field === "assigned_to");
      const value = String(field?.value || "").trim();
      if (!value || value === "(null)") continue;
      const count = Number(row?.stats?.count ?? row?.stats?.count?.value ?? NaN);
      if (Number.isFinite(count)) snMap.set(value, count);
    }
    for (const facet of (facets.assignees || []).slice(0, 5)) {
      const snCountValue = snMap.get(facet.value);
      if (snCountValue != null && snCountValue !== facet.count) {
        addDivergence("assignee_facet_count_mismatch", {
          value: facet.value,
          bff_count: facet.count,
          sn_count: snCountValue,
        });
      }
    }
  } catch (error) {
    notes.push({ note: "assignee_aggregate_crosscheck_skipped", detail: sanitizeServiceNowError(error) });
  }
}

async function auditFieldsUsage() {
  // Campos pedidos pelo BFF vs uso no FE Chamados/Monitoring (estático).
  const usedHints = [
    "sys_id", "number", "short_description", "description", "state", "priority",
    "caller_id", "contact_type", "assignment_group", "assigned_to", "company",
    "opened_at", "resolved_at", "closed_at", "sys_created_on", "sys_updated_on",
    "correlation_id", "u_hostname_zabbix", "u_ip_zabbix",
  ];
  const unused = SERVICENOW_INCIDENT_FIELDS.filter((field) => !usedHints.includes(field));
  if (unused.length) {
    addDivergence("sysparm_fields_unused", { unused });
  }
  // Confirma CSV = lista canônica
  if (SERVICENOW_INCIDENT_FIELDS_CSV.split(",").length !== SERVICENOW_INCIDENT_FIELDS.length) {
    addDivergence("sysparm_fields_csv_mismatch", {});
  }
}

async function seedSamples() {
  // Pegar exemplos reais do universo monitoring para filtros individuais.
  const base = await snSample("contact_type=monitoring^ORDERBYDESCsys_updated_on", 25);
  const withAssignee = base.records.find((r) => extractServiceNowValue(r.assigned_to));
  const withCaller = base.records.find((r) => extractServiceNowValue(r.caller_id));
  const withCompany = base.records.find((r) => extractServiceNowDisplay(r.company) || extractServiceNowValue(r.company));
  const withNumber = base.records.find((r) => extractServiceNowValue(r.number));
  return {
    number: extractServiceNowValue(withNumber?.number),
    assigned_to: extractServiceNowValue(withAssignee?.assigned_to),
    assigned_to_display: extractServiceNowDisplay(withAssignee?.assigned_to),
    caller_id: extractServiceNowValue(withCaller?.caller_id),
    company: extractServiceNowDisplay(withCompany?.company) || extractServiceNowValue(withCompany?.company),
    state: extractServiceNowValue(base.records[0]?.state) || "2",
    priority: extractServiceNowValue(base.records[0]?.priority) || "3",
    base_total: base.total,
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.log(JSON.stringify({ ok: false, error: "servicenow_not_configured" }, null, 2));
    process.exit(2);
  }

  const seeds = await seedSamples();
  notes.push({
    note: "seeds",
    number: seeds.number,
    assigned_to: seeds.assigned_to ? `${seeds.assigned_to.slice(0, 8)}…` : null,
    caller_id: seeds.caller_id ? `${seeds.caller_id.slice(0, 8)}…` : null,
    company: seeds.company,
    state: seeds.state,
    priority: seeds.priority,
    monitoring_total: seeds.base_total,
  });

  // Empty filters: no caller default
  const emptyFilters = parseIncidentFilters(requestMock({}));
  if (emptyFilters.caller_id != null) {
    addDivergence("parse_default_caller", { caller_id: emptyFilters.caller_id });
  }
  if (emptyFilters.contact_type !== "monitoring") {
    addDivergence("parse_contact_type_not_monitoring", { contact_type: emptyFilters.contact_type });
  }

  const cases = [
    ["baseline", {}],
    ["number", seeds.number ? { number: seeds.number } : null],
    ["search_text", { search: "ICMP" }],
    ["search_inc_exact", seeds.number ? { search: String(seeds.number).toLowerCase() } : null],
    ["company", seeds.company ? { company: String(seeds.company).slice(0, 40) } : null],
    ["state", { state: seeds.state }],
    ["priority", { priority: seeds.priority }],
    ["assigned_to", seeds.assigned_to ? { assigned_to: seeds.assigned_to } : null],
    ["caller_id", seeds.caller_id ? { caller_id: seeds.caller_id } : null],
    ["unassigned", { unassigned: "true" }],
    ["opened_range", { opened_from: "2026-01-01", opened_to: "2026-12-31" }],
    ["page_size", { page: "1", page_size: "5" }],
    ["combined", {
      state: seeds.state,
      priority: seeds.priority,
      ...(seeds.company ? { company: String(seeds.company).slice(0, 40) } : {}),
      ...(seeds.assigned_to ? { assigned_to: seeds.assigned_to } : {}),
      page_size: "10",
    }],
  ].filter((entry) => entry[1] != null);

  const caseReports = [];
  for (const [name, params] of cases) {
    try {
      caseReports.push(await auditFilterCase(name, params));
    } catch (error) {
      addDivergence(`case_error:${name}`, { detail: sanitizeServiceNowError(error) });
    }
  }

  try {
    await auditPagination();
  } catch (error) {
    addDivergence("pagination_error", { detail: sanitizeServiceNowError(error) });
  }

  try {
    await auditFacets();
  } catch (error) {
    addDivergence("facets_error", { detail: sanitizeServiceNowError(error) });
  }

  await auditFieldsUsage();

  // search INC exact promote
  if (seeds.number) {
    const promoted = parseIncidentFilters(requestMock({ search: String(seeds.number).toLowerCase() }));
    if (promoted.number?.toUpperCase() !== String(seeds.number).toUpperCase() || promoted.search != null) {
      addDivergence("search_inc_not_promoted_to_number", {
        search_in: seeds.number,
        number: promoted.number,
        search: promoted.search,
      });
    }
  }

  const output = {
    ok: divergences.length === 0,
    ticket: "SN-P0-30",
    checked_at: new Date().toISOString(),
    base_url_host: (() => {
      try { return new URL(config.baseUrl).host; } catch { return "unknown"; }
    })(),
    divergence_count: divergences.length,
    divergences,
    notes,
    // Amostras resumidas só das cases com mismatch potencial
    sample_cases: caseReports.map((c) => ({
      name: c.name,
      sysparm_query: c.sysparm_query,
      x_total_count: c.x_total_count,
      bff_total_items: c.bff_total_items,
      examples: c.examples,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(divergences.length ? 1 : 0);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: "audit_failed",
    detail: sanitizeServiceNowError(error),
  }, null, 2));
  process.exit(2);
});
