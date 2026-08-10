/**
 * SN-P0-12 — Auditoria read-only de summary de estados (contact_type=monitoring).
 * Usa somente state do ServiceNow (não infere por short_description).
 *
 * Uso:
 *   node scripts/servicenow-state-summary-audit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getServiceNowConfig,
  sanitizeServiceNowError,
  serviceNowGet,
  ServiceNowClientError,
} from "../api/_lib/servicenow-client.js";
import {
  extractServiceNowDisplay,
  extractServiceNowValue,
} from "../api/_lib/servicenow-normalize.js";
import { loadLocalEnv } from "./_lib/local-env.mjs";

const QUERY_BASE = "contact_type=monitoring";
const KNOWN_STATES = ["1", "2", "3", "6", "7", "8"];
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(path.join(rootDir, ".env.local"));

async function countQuery(sysparm_query) {
  const page = await serviceNowGet("incident", {
    sysparm_query,
    sysparm_fields: "sys_id",
    sysparm_limit: 1,
    sysparm_display_value: "false",
  });
  return Number.isFinite(page.totalCount) ? page.totalCount : page.count;
}

async function sampleStateDisplays(limit = 200) {
  const page = await serviceNowGet("incident", {
    sysparm_query: `${QUERY_BASE}^ORDERBYDESCsys_updated_on`,
    sysparm_fields: "sys_id,number,state,assigned_to,short_description",
    sysparm_limit: limit,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
  });

  const byState = new Map();
  for (const raw of page.records || []) {
    const value = extractServiceNowValue(raw.state);
    const display = extractServiceNowDisplay(raw.state) || value || "(sem state)";
    if (!value) continue;
    const current = byState.get(value) || { state: value, display_values: new Map(), sample: 0 };
    current.sample += 1;
    current.display_values.set(display, (current.display_values.get(display) || 0) + 1);
    byState.set(value, current);
  }

  return {
    sample_size: (page.records || []).length,
    x_total_count: page.totalCount,
    displays: [...byState.values()].map((item) => ({
      state: item.state,
      sample: item.sample,
      display_values: [...item.display_values.entries()]
        .map(([display_value, count]) => ({ display_value, count }))
        .sort((a, b) => b.count - a.count),
      primary_display: [...item.display_values.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    })),
  };
}

async function main() {
  const config = getServiceNowConfig();
  if (!config.configured) {
    console.error(JSON.stringify({
      event: "servicenow_state_summary_audit_failed",
      error: "servicenow_not_configured",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  try {
    const displays = await sampleStateDisplays(300);

    const total = await countQuery(QUERY_BASE);
    const assignedEmpty = await countQuery(`${QUERY_BASE}^assigned_toISEMPTY`);
    const assignedEmptyOpenLike = await countQuery(`${QUERY_BASE}^assigned_toISEMPTY^stateNOT IN6,7`);

    const stateCounts = {};
    for (const state of KNOWN_STATES) {
      stateCounts[state] = await countQuery(`${QUERY_BASE}^state=${state}`);
    }

    // Catch unknown states present in sample but not in KNOWN_STATES.
    for (const item of displays.displays) {
      if (!(item.state in stateCounts)) {
        stateCounts[item.state] = await countQuery(`${QUERY_BASE}^state=${item.state}`);
      }
    }

    const sumKnown = Object.values(stateCounts).reduce((sum, value) => sum + value, 0);
    const otherOrMissing = Math.max(total - sumKnown, 0);

    const kpiCurrent = {
      Abertos: { definition: "state=1", count: stateCounts["1"] || 0 },
      "Em andamento": { definition: "state=2", count: stateCounts["2"] || 0 },
      Resolvidos: { definition: "stateIN6,7 (Resolved+Closed)", count: (stateCounts["6"] || 0) + (stateCounts["7"] || 0) },
      Encerrados: { definition: "state=7 (hoje embutido em Resolvidos)", count: stateCounts["7"] || 0 },
      "Não atribuídos": {
        definition: "assigned_toISEMPTY^stateNOT IN6,7",
        count: assignedEmptyOpenLike,
      },
    };

    const proposed = {
      Abertos: {
        definition: "state=1 (New)",
        count: stateCounts["1"] || 0,
        note: "Apenas New. Não inclui On Hold.",
      },
      "Em andamento": {
        definition: "state=2 (In Progress)",
        count: stateCounts["2"] || 0,
      },
      Resolvidos: {
        definition: "state=6 (Resolved)",
        count: stateCounts["6"] || 0,
        note: "Separado de Encerrados.",
      },
      Encerrados: {
        definition: "state=7 (Closed)",
        count: stateCounts["7"] || 0,
      },
      "Em espera": {
        definition: "state=3 (On Hold) — presente no SN, fora dos KPIs atuais",
        count: stateCounts["3"] || 0,
      },
    };

    const divergences = [];
    if ((stateCounts["3"] || 0) > 0) {
      divergences.push({
        code: "on_hold_not_in_kpis",
        detail: `state=3 (On Hold) tem ${stateCounts["3"]} incidentes monitoring e não entra em Abertos/Em andamento/Resolvidos.`,
      });
    }
    if ((stateCounts["7"] || 0) > 0) {
      divergences.push({
        code: "closed_merged_into_resolved_kpi",
        detail: `KPI "Resolvidos" soma state 6+7 (${(stateCounts["6"] || 0) + (stateCounts["7"] || 0)}), misturando Resolved (${stateCounts["6"] || 0}) e Closed (${stateCounts["7"] || 0}).`,
      });
    }
    if (otherOrMissing > 0) {
      divergences.push({
        code: "unknown_states_or_count_gap",
        detail: `Total monitoring=${total}; soma states conhecidos=${sumKnown}; gap=${otherOrMissing}.`,
      });
    }
    if (assignedEmpty !== assignedEmptyOpenLike) {
      divergences.push({
        code: "unassigned_includes_or_excludes_closed",
        detail: `assigned_to vazio total=${assignedEmpty}; KPI atual exclui 6,7 → ${assignedEmptyOpenLike}.`,
      });
    }

    const report = {
      event: "servicenow_state_summary_audit_sn_p0_12",
      mode: "read_only_get",
      query: QUERY_BASE,
      duration_ms: Date.now() - startedAt,
      total_monitoring: total,
      by_state: Object.entries(stateCounts)
        .map(([state, count]) => ({
          state,
          count,
          display_value: displays.displays.find((item) => item.state === state)?.primary_display || null,
        }))
        .sort((a, b) => Number(a.state) - Number(b.state)),
      state_display_sample: displays,
      assigned_to_empty: {
        all_states: assignedEmpty,
        excluding_6_7: assignedEmptyOpenLike,
      },
      kpi_chamados_atual: kpiCurrent,
      definicoes_explicitas: proposed,
      divergences,
      recommendation: divergences.some((item) => item.code === "closed_merged_into_resolved_kpi")
        ? "Separar Resolvidos (state=6) de Encerrados (state=7) nos KPIs; manter Abertos=1 e Em andamento=2."
        : "Sem correção obrigatória comprovada além de documentar On Hold fora dos KPIs.",
    };

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const code = error instanceof ServiceNowClientError
      ? error.code
      : sanitizeServiceNowError(error);
    console.error(JSON.stringify({
      event: "servicenow_state_summary_audit_failed",
      error: code,
      status: error?.status ?? null,
      duration_ms: Date.now() - startedAt,
    }, null, 2));
    process.exitCode = 1;
  }
}

main();
