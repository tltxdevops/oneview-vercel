import { query } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";
import { handleError, methodNotAllowed, sendJson } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const [workers, dataSources] = await Promise.all([
      query(`
        select worker_id, status, hostname, version, started_at, last_seen_at,
               last_cycle_at, last_cycle_duration_ms, is_alive, last_error
        from v_worker_health
        order by last_seen_at desc
      `),
      query(`
        select id, name, client_name, status, sync_enabled, last_worker_id,
               last_worker_heartbeat_at, last_sync_at, last_success_at,
               last_sync_duration_ms, failure_count, cooldown_until
        from v_datasource_health
        order by client_name, name
      `),
    ]);
    return sendJson(res, 200, {
      ok: true,
      workers: workers.rows,
      data_sources: dataSources.rows,
    });
  } catch (error) {
    return handleError(res, error);
  }
}
