import { query } from "../_lib/db.js";
import { ALERT_FIELDS } from "../_lib/alerts.js";
import { requireAuth } from "../_lib/auth.js";
import { getId, handleError, methodNotAllowed, sendJson } from "../_lib/http.js";
import { getOperationalDataSourceNames } from "../_lib/oneview-scope.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const id = getId(req);
    const result = await query(
      `select ${ALERT_FIELDS}
         from alerts
        where id = $1
          and data_source_id = (
            select id from data_sources where name = any($2::text[])
          )`,
      [id, getOperationalDataSourceNames()],
    );
    if (!result.rows[0]) return sendJson(res, 404, { error: "alert_not_found" });
    return sendJson(res, 200, result.rows[0]);
  } catch (error) {
    return handleError(res, error);
  }
}
