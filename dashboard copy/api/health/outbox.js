import { query } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";
import { handleError, methodNotAllowed, sendJson } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const [backlog, totals] = await Promise.all([
      query("select status, action_type, total, oldest_created_at, next_attempt_at from v_outbox_backlog order by status, action_type"),
      query(`
        select
          count(*) filter (where status = 'pending')::int as pending,
          count(*) filter (where status = 'processing')::int as processing,
          count(*) filter (where status = 'failed')::int as failed,
          count(*) filter (where status = 'success')::int as success,
          count(*) filter (where status = 'cancelled')::int as cancelled
        from integration_outbox
      `),
    ]);
    return sendJson(res, 200, {
      ok: true,
      totals: totals.rows[0],
      backlog: backlog.rows,
    });
  } catch (error) {
    return handleError(res, error);
  }
}
