/**
 * GET /api/oneview/alerts/search-suggest — autocomplete read-only (PostgreSQL).
 */
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  SAFE_CUSTOMER_NAME_SQL,
  SAFE_CUSTOMER_KEY_SQL,
  buildAlertListQuery,
  getOneViewConfig,
  getOneViewDbPool,
  queryRows,
} from "./oneview-db.js";
import { searchReadModelIncidentSuggestions } from "./oneview-incidents-read-model.js";
import { mergeRankedSuggestions } from "./oneview-search-suggest-rank.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_SEARCH = /^[a-zA-Z0-9._:@/\- ]{1,80}$/;
const INC_PREFIX_RE = /^INC\d*$/i;

const HOST_EXPR = "coalesce(a.host_visible_name, a.host_technical_name, a.host_name, '')";
const CUSTOMER_EXPR = `coalesce(nullif(btrim(${SAFE_CUSTOMER_NAME_SQL}), ''), nullif(btrim(a.customer_name), ''), nullif(btrim(a.client_name), ''), '')`;
const PROBLEM_EXPR = "coalesce(a.problem_name, a.trigger_description, '')";

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
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(parsed, 1), 15);
}

function scopeFromReq(req) {
  const scopeReq = {
    query: { ...req.query, search: undefined, q: undefined, limit: undefined, page: "1", page_size: "1" },
  };
  const built = buildAlertListQuery(scopeReq);
  return { built, fromJoin: "from alerts a left join data_sources d on d.id = a.data_source_id" };
}

export async function searchAlertReadModelSuggestions(req, config) {
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

  const { built, fromJoin } = scopeFromReq(req);
  const params = [...built.params, `%${q}%`];
  const like = `$${params.length}`;
  const scopeWhere = built.whereSql || "where true";
  const textMatch = `(
    ${CUSTOMER_EXPR} ilike ${like}
    or ${HOST_EXPR} ilike ${like}
    or ${PROBLEM_EXPR} ilike ${like}
    or coalesce(a.service_name, '') ilike ${like}
    or coalesce(a.client_name, '') ilike ${like}
  )`;

  const runBucket = async (kind, labelExpr, hintField, cap, customerKeyExpr = null) => {
    const customerKeySql = customerKeyExpr ? `, ${customerKeyExpr} as customer_key` : "";
    const customerKeyGroupSql = customerKeyExpr ? `, ${customerKeyExpr}` : "";
    const rows = await queryRows(
      config,
      `
        select ${labelExpr} as label,
               max(${hintField}) as hint_detail,
               max(a.last_seen_at) as last_seen
               ${customerKeySql}
          ${fromJoin}
         ${scopeWhere}
           and ${labelExpr} <> ''
           and ${textMatch}
         group by ${labelExpr}${customerKeyGroupSql}
         order by max(a.last_seen_at) desc nulls last
         limit $${params.length + 1}`,
      [...params, cap],
    );
    return rows.map((row) => {
      const label = String(row.label || "").trim();
      if (!label) return null;
      const detail = String(row.hint_detail || "").trim();
      return {
        kind,
        value: label,
        label,
        customer_key: kind === "customer" ? String(row.customer_key || "").trim() || null : null,
        hint: detail ? `${kind === "customer" ? "Cliente" : kind === "host" ? "Host" : "Problema"} · ${detail}` : undefined,
      };
    }).filter(Boolean);
  };

  const [customers, hosts, problems] = await Promise.all([
    runBucket("customer", CUSTOMER_EXPR, HOST_EXPR, 6, SAFE_CUSTOMER_KEY_SQL),
    runBucket("host", HOST_EXPR, CUSTOMER_EXPR, 6),
    runBucket("problem", PROBLEM_EXPR, HOST_EXPR, 4),
  ]);

  const suggestions = mergeRankedSuggestions([...customers, ...hosts, ...problems], q, limit);
  return { suggestions };
}

export function createAlertsSearchSuggestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  configProvider = getOneViewConfig,
  suggest = searchAlertReadModelSuggestions,
} = {}) {
  return async function alertsSearchSuggestHandler(req, res) {
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
      return sendJson(res, 200, { ...payload, data_source: "database", checked_at: new Date().toISOString() });
    } catch (error) {
      if (error?.code === "invalid_query") {
        return sendJson(res, 400, { error: "invalid_query", data_source: "database" });
      }
      return sendJson(res, 503, { error: "database_unavailable", data_source: "database" });
    }
  };
}

export default createAlertsSearchSuggestHandler();
