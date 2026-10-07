/**
 * GET /api/oneview/history/search-suggest — autocomplete de eventos (PostgreSQL).
 */
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  buildGlobalHistoryScopeClauses,
  getOneViewConfig,
  getOneViewDbPool,
  queryRows,
} from "./oneview-db.js";
import { searchReadModelIncidentSuggestions } from "./oneview-incidents-read-model.js";
import { mergeRankedSuggestions } from "./oneview-search-suggest-rank.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_SEARCH = /^[a-zA-Z0-9._:@/\- ]{1,80}$/;
const INC_PREFIX_RE = /^INC\d*$/i;

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function cleanOptional(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function asLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 8;
  return Math.min(Math.max(parsed, 1), 15);
}

function scopeReq(req) {
  return { query: { ...req.query, search: undefined, q: undefined, limit: undefined, page: "1", page_size: "1" } };
}

export async function searchHistoryReadModelSuggestions(req, config) {
  const q = cleanOptional(oneQuery(req, "q"));
  if (!q || q.length < 2 || !SAFE_SEARCH.test(q)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  const limit = asLimit(oneQuery(req, "limit"));

  if (INC_PREFIX_RE.test(q)) {
    const incident = await searchReadModelIncidentSuggestions(
      { page: 1, page_size: 25, search: null, number: null },
      { q, limit, pool: getOneViewDbPool() },
    );
    return { suggestions: incident.suggestions ?? [] };
  }

  const { clauses, params: scopeParams } = buildGlobalHistoryScopeClauses(scopeReq(req));

  const run = async (kind, fieldSql, cap) => {
    const runParams = [...scopeParams, `%${q}%`];
    const runLike = `$${runParams.length}`;
    const runWhere = `where ${clauses.join(" and ")} and ${fieldSql} ilike ${runLike}`;
    const rows = await queryRows(
      config,
      `
        select distinct ${fieldSql} as label
          from alert_history h
          join alerts a on a.id = h.alert_id
          left join data_sources d on d.id = a.data_source_id
         ${runWhere}
         order by label asc
         limit $${runParams.length + 1}`,
      [...runParams, cap],
    );
    return rows.map((row) => {
      const label = String(row.label || "").trim();
      if (!label) return null;
      return { kind, value: label, label };
    }).filter(Boolean);
  };

  const [hosts, actors, messages] = await Promise.all([
    run("host", "coalesce(a.host_name, '')", 3),
    run("actor", "coalesce(h.actor_name, h.operator_name, '')", 3),
    run("description", "left(coalesce(h.message, ''), 120)", 3),
  ]);

  const enriched = [...hosts, ...actors, ...messages].map((item) => ({
    ...item,
    hint: item.kind === "host"
      ? "Filtrar eventos por host"
      : item.kind === "actor"
        ? "Filtrar eventos por ator"
        : "Filtrar eventos por mensagem",
  }));
  return { suggestions: mergeRankedSuggestions(enriched, q, limit) };
}

export function createHistorySearchSuggestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  configProvider = getOneViewConfig,
  suggest = searchHistoryReadModelSuggestions,
} = {}) {
  return async function historySearchSuggestHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!(await authorize(req, res))) return;

    let config;
    try {
      config = configProvider();
    } catch {
      return sendJson(res, 503, { error: "live_data_not_configured", data_source: "database" });
    }

    try {
      const payload = await suggest(req, config);
      res.setHeader("Server-Timing", `oneview_search_suggest;dur=${Date.now() - startedAt}`);
      return sendJson(res, 200, { ...payload, data_source: "database", checked_at: new Date().toISOString() });
    } catch (error) {
      res.setHeader("Server-Timing", `oneview_search_suggest;dur=${Date.now() - startedAt}`);
      if (error?.code === "invalid_query") {
        return sendJson(res, 400, { error: "invalid_query", data_source: "database" });
      }
      return sendJson(res, 503, { error: "database_unavailable", data_source: "database" });
    }
  };
}

export default createHistorySearchSuggestHandler();
