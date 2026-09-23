/**
 * GET /api/oneview/incidents/search-suggest — autocomplete read-only (PostgreSQL read model).
 */
import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  isServiceNowIncidentsEnabled,
  parseIncidentFilters,
} from "./oneview-incidents.js";
import { searchReadModelIncidentSuggestions } from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_SEARCH = /^[a-zA-Z0-9._:@/\- ]{1,80}$/;
const DEFAULT_SUGGEST_LIMIT = 8;
const MAX_SUGGEST_LIMIT = 15;

function oneQuery(req, key) {
  const value = req?.query?.[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function cleanOptional(value) {
  const output = String(value ?? "").trim();
  return output || null;
}

function asSuggestLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SUGGEST_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_SUGGEST_LIMIT);
}

function parseSuggestQuery(req) {
  const qRaw = cleanOptional(oneQuery(req, "q"));
  if (!qRaw || qRaw.length < 2) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  if (!SAFE_SEARCH.test(qRaw)) {
    const error = new Error("invalid_query");
    error.code = "invalid_query";
    throw error;
  }
  const filters = parseIncidentFilters(req);
  return {
    filters,
    q: qRaw,
    limit: asSuggestLimit(oneQuery(req, "limit")),
  };
}

export function createIncidentSearchSuggestHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  featureFlagProvider = isServiceNowIncidentsEnabled,
  suggest = searchReadModelIncidentSuggestions,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function incidentSearchSuggestHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

    const auth = await authorize(req, res);
    if (!auth) return;

    if (!featureFlagProvider()) {
      return sendJson(res, 403, { error: "servicenow_incidents_disabled", data_source: "postgresql" });
    }

    let params;
    try {
      params = parseSuggestQuery(req);
    } catch {
      return sendJson(res, 400, { error: "invalid_query", data_source: "postgresql" });
    }

    try {
      const payload = await suggest(params.filters, { q: params.q, limit: params.limit });
      logger({
        event: "oneview_request",
        route: "/api/oneview/incidents/search-suggest",
        data_source: "postgresql",
        duration_ms: Math.max(Date.now() - startedAt, 0),
        suggestions: payload.suggestions?.length ?? 0,
      });
      return sendJson(res, 200, {
        ...payload,
        q: params.q,
        data_source: "postgresql",
        checked_at: new Date().toISOString(),
      });
    } catch (error) {
      logger({
        event: "oneview_incidents_search_suggest_error",
        route: "/api/oneview/incidents/search-suggest",
        error: "database_unavailable",
        detail: String(error?.message || "database_unavailable").slice(0, 160),
        duration_ms: Math.max(Date.now() - startedAt, 0),
      });
      return sendJson(res, 503, { error: "database_unavailable", data_source: "postgresql" });
    }
  };
}

export default createIncidentSearchSuggestHandler();
