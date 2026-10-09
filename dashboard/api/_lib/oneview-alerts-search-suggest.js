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
const ACK_ACTOR_EXPR = "coalesce(nullif(btrim(oneview_ack.operator_name), ''), nullif(btrim(a.acknowledged_by), ''), '')";
const SUGGESTION_KINDS = new Set(["customer", "host", "problem", "actor", "number"]);

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
  return {
    built,
    fromJoin: `from alerts a
      left join data_sources d on d.id = a.data_source_id
      left join lateral (
        select ack.operator_name
          from alert_acknowledgements ack
         where ack.alert_id = a.id
           and ack.acknowledgement_type = 'source'
         order by ack.requested_at desc, ack.id desc
         limit 1
      ) oneview_ack on true`,
  };
}

export async function searchAlertReadModelSuggestions(req, config) {
  const q = cleanOptional(oneQuery(req, "q"));
  if (!q || q.length < 2 || !SAFE_SEARCH.test(q)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  const limit = asLimit(oneQuery(req, "limit"));
  const kind = cleanOptional(oneQuery(req, "kind"))?.toLowerCase() || null;
  if (kind && !SUGGESTION_KINDS.has(kind)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }

  if ((kind === "number" || !kind) && INC_PREFIX_RE.test(q)) {
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
  const runBucket = async (kind, labelExpr, matchExpr, hintField, cap, customerKeyExpr = null) => {
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
           and (${matchExpr}) ilike ${like}
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

  const [customers, hosts, problems, actors] = await Promise.all([
    !kind || kind === "customer" ? runBucket("customer", CUSTOMER_EXPR, CUSTOMER_EXPR, HOST_EXPR, 6, SAFE_CUSTOMER_KEY_SQL) : [],
    !kind || kind === "host" ? runBucket("host", HOST_EXPR, HOST_EXPR, CUSTOMER_EXPR, 6) : [],
    !kind || kind === "problem" ? runBucket("problem", PROBLEM_EXPR, PROBLEM_EXPR, HOST_EXPR, 4) : [],
    !kind || kind === "actor" ? runBucket("actor", ACK_ACTOR_EXPR, ACK_ACTOR_EXPR, CUSTOMER_EXPR, 6) : [],
  ]);

  const suggestions = mergeRankedSuggestions([...actors, ...customers, ...hosts, ...problems], q, limit);
  return { suggestions };
}

export function createAlertsSearchSuggestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  configProvider = getOneViewConfig,
  suggest = searchAlertReadModelSuggestions,
} = {}) {
  return async function alertsSearchSuggestHandler(req, res) {
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

export default createAlertsSearchSuggestHandler();
