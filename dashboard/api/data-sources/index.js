import { query } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";
import { DATA_SOURCE_FIELDS, sanitizeDataSource } from "../_lib/data-sources.js";
import { handleError, methodNotAllowed, sendJson } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    if (!(await requireAuth(req, res, { role: "viewer" }))) return;
    try {
      const result = await query(
        `select ${DATA_SOURCE_FIELDS} from data_sources order by display_order, name`,
      );
      return sendJson(res, 200, result.rows.map(sanitizeDataSource));
    } catch (error) {
      return handleError(res, error);
    }
  }

  if (req.method === "POST") {
    if (!(await requireAuth(req, res, { role: "admin" }))) return;
    return sendJson(res, 403, {
      error: "data_source_secret_management_blocked_on_vercel",
      detail: "Create or rotate Zabbix Data Sources only from the DB VM seed/rotation scripts.",
    });
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
