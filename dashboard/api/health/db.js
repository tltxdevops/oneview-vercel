import { query } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";
import { handleError, methodNotAllowed, sendJson } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const result = await query(`
      select
        now() as database_time,
        current_database() as database_name,
        current_user as database_user,
        (select count(id)::int from data_sources) as data_sources,
        (select count(*)::int from alerts) as alerts,
        (select count(*)::int from v_active_alerts) as active_alerts
    `);
    return sendJson(res, 200, {
      ok: true,
      ...result.rows[0],
    });
  } catch (error) {
    return handleError(res, error);
  }
}
