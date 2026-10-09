import { query } from "../_lib/db.js";
import { requireAuth } from "../_lib/auth.js";
import { handleError, methodNotAllowed, sendJson } from "../_lib/http.js";
import { getOperationalDataSourceNames } from "../_lib/oneview-scope.js";

const ACTIVE_WHERE = "status_source = 'active' and resolved_at is null";
const SCOPE_CTE = `
  with scoped_alerts as (
    select a.*, d.environment
    from alerts a
    join data_sources d on d.id = a.data_source_id
    where d.name = any($1::text[])
  )
`;

async function rows(sql) {
  const result = await query(`${SCOPE_CTE} ${sql}`, [getOperationalDataSourceNames()]);
  return result.rows;
}

async function scalar(sql, fallback = 0) {
  const result = await query(`${SCOPE_CTE} ${sql}`, [getOperationalDataSourceNames()]);
  return result.rows[0]?.value ?? fallback;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!(await requireAuth(req, res, { role: "viewer" }))) return;

  try {
    const [
      activeTotal,
      bySeverity,
      byStatus,
      byClient,
      byService,
      topHosts,
      unacknowledgedTotal,
      longestDuration,
      avgAckTimeSeconds,
      avgNormalizationTimeSeconds,
    ] = await Promise.all([
      scalar(`select count(*)::int as value from scoped_alerts where ${ACTIVE_WHERE}`),
      rows(`
        select severity, count(*)::int as count
        from scoped_alerts
        where ${ACTIVE_WHERE}
        group by severity
        order by count desc, severity
      `),
      rows(`
        select status_internal, count(*)::int as count
        from scoped_alerts
        where ${ACTIVE_WHERE}
        group by status_internal
        order by count desc, status_internal
      `),
      rows(`
        select client_name, count(*)::int as count
        from scoped_alerts
        where ${ACTIVE_WHERE}
        group by client_name
        order by count desc, client_name
      `),
      rows(`
        select coalesce(a.service_name, '-') as service_name, a.environment, count(*)::int as count
        from scoped_alerts a
        where a.status_source = 'active' and a.resolved_at is null
        group by coalesce(a.service_name, '-'), a.environment
        order by count desc, service_name
        limit 20
      `),
      rows(`
        select coalesce(host_name, '-') as host_name, count(*)::int as count
        from scoped_alerts
        where ${ACTIVE_WHERE}
        group by coalesce(host_name, '-')
        order by count desc, host_name
        limit 10
      `),
      scalar(`
        select count(*)::int as value
        from scoped_alerts
        where ${ACTIVE_WHERE}
          and acknowledged_source = false
      `),
      rows(`
        select id, client_name, host_name, problem_name, severity,
               floor(extract(epoch from (now() - first_seen_at)))::int as duration_seconds, first_seen_at
        from scoped_alerts
        where ${ACTIVE_WHERE}
          and first_seen_at is not null and first_seen_at <= now()
        order by floor(extract(epoch from (now() - first_seen_at))) desc
        limit 10
      `),
      scalar(`
        , first_ack as (
          select alert_id, min(created_at) as ack_at
          from alert_history
          where new_status = 'acknowledged' or action_type in ('ack_requested', 'acknowledged')
          group by alert_id
        )
        select coalesce(avg(extract(epoch from (first_ack.ack_at - alerts.first_seen_at))), 0)::int as value
        from scoped_alerts alerts
        join first_ack on first_ack.alert_id = alerts.id
        where first_ack.ack_at >= alerts.first_seen_at
          and (alerts.resolved_at is null or alerts.resolved_at >= alerts.first_seen_at)
      `),
      scalar(`
        select coalesce(avg(extract(epoch from (resolved_at - first_seen_at))), 0)::int as value
        from scoped_alerts
        where (status_source = 'resolved' or status_internal = 'normalized')
          and first_seen_at is not null
          and resolved_at is not null
          and resolved_at >= first_seen_at
      `),
    ]);

    return sendJson(res, 200, {
      active_total: activeTotal,
      by_severity: bySeverity,
      by_status: byStatus,
      by_client: byClient,
      by_service: byService,
      top_hosts: topHosts,
      unacknowledged_total: unacknowledgedTotal,
      longest_duration: longestDuration,
      avg_ack_time_seconds: avgAckTimeSeconds,
      avg_normalization_time_seconds: avgNormalizationTimeSeconds,
    });
  } catch (error) {
    return handleError(res, error);
  }
}
