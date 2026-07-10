import { query } from "./_lib/db.js";
import { requireAuth } from "./_lib/auth.js";
import { handleError, methodNotAllowed, sendJson } from "./_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const [db, worker, outbox] = await Promise.all([
      query("select now() as database_time"),
      query("select count(*)::int as total, count(*) filter (where is_alive and status <> 'stopped')::int as alive from v_worker_health"),
      query("select count(*)::int as pending from integration_outbox where status in ('pending','processing')"),
    ]);
    return sendJson(res, 200, {
      ok: true,
      service: "oneview-api",
      database_time: db.rows[0]?.database_time,
      workers_total: worker.rows[0]?.total ?? 0,
      workers_alive: worker.rows[0]?.alive ?? 0,
      outbox_pending: outbox.rows[0]?.pending ?? 0,
    });
  } catch (error) {
    return handleError(res, error);
  }
}
