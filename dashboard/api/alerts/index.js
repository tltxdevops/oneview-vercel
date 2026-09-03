import { query } from "../_lib/db.js";
import { ALERT_FIELDS } from "../_lib/alerts.js";
import { requireAuth } from "../_lib/auth.js";
import { asInt, handleError, methodNotAllowed, sendJson } from "../_lib/http.js";
import { getOperationalDataSourceNames, splitAlertCustomerFilter } from "../_lib/oneview-scope.js";

// Read-only identity normalization. It intentionally mirrors the canonical
// OneView alerts contract: casing/whitespace only, never datasource fallback.
const LEGACY_SAFE_CUSTOMER_KEY_SQL = `case
  when a.customer_name is null
    or btrim(a.customer_name) = ''
    or lower(btrim(a.customer_name)) in ('cliente não classificado', 'cliente nao classificado', 'cliente não identificado', 'cliente nao identificado')
    or lower(coalesce(a.customer_source, '')) = 'datasource_fallback'
    or lower(coalesce(a.customer_key, '')) = 'unclassified'
  then 'unclassified'
  else lower(btrim(a.customer_name))
end`;

function queryValues(query, key) {
  const raw = query?.[key];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function buildLegacyAlertsScope(query = {}) {
  const where = ["data_source_id in (select id from data_sources where name = any($1::text[]))"];
  const values = [getOperationalDataSourceNames()];
  const addFilter = (sql, value) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  const split = splitAlertCustomerFilter(queryValues(query, "customer"));
  const datasources = [...new Set([...queryValues(query, "datasource"), ...split.datasources])];

  if (split.customers.length) addFilter(`${LEGACY_SAFE_CUSTOMER_KEY_SQL} = any(?::text[])`, split.customers);
  if (datasources.length) {
    addFilter("data_source_id in (select id from data_sources where name = any(?::text[]))", datasources);
  }
  return { where, values, customers: split.customers, datasources };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const scope = buildLegacyAlertsScope(req.query);
    const { where, values } = scope;
    const addFilter = (sql, value) => {
      values.push(value);
      where.push(sql.replace("?", `$${values.length}`));
    };

    if (req.query.client_name) addFilter("client_name = ?", req.query.client_name);
    if (req.query.severity) addFilter("severity = ?", req.query.severity);
    if (req.query.status_internal) addFilter("status_internal = ?", req.query.status_internal);
    if (req.query.host) addFilter("host_name ilike ?", `%${req.query.host}%`);
    if (req.query.service) addFilter("service_name ilike ?", `%${req.query.service}%`);
    if (typeof req.query.acknowledged !== "undefined") {
      const acknowledged = String(req.query.acknowledged) === "true";
      addFilter("(acknowledged_internal = ? or acknowledged_source = ?)", acknowledged);
      values.push(acknowledged);
      where[where.length - 1] = where[where.length - 1].replace("?", `$${values.length}`);
    }

    const limit = asInt(req.query.limit, 100, { min: 1, max: 1000 });
    const offset = asInt(req.query.offset, 0, { min: 0, max: 100000 });
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    const totalResult = await query(`select count(*)::int as total from alerts a ${whereSql}`, values);
    const listResult = await query(
      `
        select ${ALERT_FIELDS}
        from alerts a
        ${whereSql}
        order by first_seen_at desc
        limit $${values.length + 1}
        offset $${values.length + 2}
      `,
      [...values, limit, offset],
    );

    const total = totalResult.rows[0]?.total || 0;
    return sendJson(res, 200, {
      items: listResult.rows,
      total,
      pagination: {
        limit,
        offset,
        total_items: total,
        has_next: offset + listResult.rows.length < total,
      },
      filters: { customers: scope.customers, datasources: scope.datasources },
    });
  } catch (error) {
    return handleError(res, error);
  }
}
