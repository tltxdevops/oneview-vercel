-- OneView BFF: consultas read-only equivalentes ao código local.
-- Sem credenciais, connection string, IDs reais ou valores operacionais.
-- Execute somente com a role read-only e revise EXPLAIN ANALYZE antes de usar em produção.

-- ================================================================
-- dashboard-summary
-- O endpoint executa estas consultas em paralelo.
-- ================================================================

PREPARE oneview_dashboard_total AS
SELECT count(*)::int AS value FROM alerts;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_total;

PREPARE oneview_dashboard_active AS
SELECT count(*)::int AS value FROM v_active_alerts;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_active;

PREPARE oneview_dashboard_severity AS
SELECT severity, count(*)::int AS count
FROM v_active_alerts
GROUP BY severity
ORDER BY count DESC, severity ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_severity;

PREPARE oneview_dashboard_status AS
SELECT status_internal, count(*)::int AS count
FROM v_active_alerts
GROUP BY status_internal
ORDER BY count DESC, status_internal ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_status;

PREPARE oneview_dashboard_customer AS
SELECT coalesce(customer_name, 'Cliente não classificado') AS client_name,
       count(*)::int AS count
FROM alerts
WHERE status_source = 'active' AND resolved_at IS NULL
GROUP BY coalesce(customer_name, 'Cliente não classificado')
ORDER BY count DESC, client_name ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_customer;

PREPARE oneview_dashboard_service AS
SELECT coalesce(service_name, '-') AS service_name,
       coalesce(environment, 'internal') AS environment,
       count(*)::int AS count
FROM v_active_alerts
GROUP BY coalesce(service_name, '-'), coalesce(environment, 'internal')
ORDER BY count DESC, service_name ASC
LIMIT 20;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_service;

PREPARE oneview_dashboard_top_hosts AS
SELECT host_name, active_alerts::int AS count
FROM v_alert_top_hosts
LIMIT 10;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_top_hosts;

PREPARE oneview_dashboard_unacknowledged AS
SELECT count(*)::int AS value FROM v_alert_unacknowledged;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_unacknowledged;

PREPARE oneview_dashboard_longest AS
SELECT id,
       coalesce(customer_name, 'Cliente não classificado') AS client_name,
       host_name, problem_name, severity, duration_seconds::int, first_seen_at
FROM alerts
WHERE status_source = 'active' AND resolved_at IS NULL
ORDER BY duration_seconds DESC NULLS LAST
LIMIT 10;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_longest;

PREPARE oneview_dashboard_ack_metrics AS
SELECT avg_ack_time_seconds::int AS avg_ack_time_seconds FROM v_alert_ack_metrics;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_ack_metrics;

PREPARE oneview_dashboard_normalization_metrics AS
SELECT avg_normalization_time_seconds::int AS avg_normalization_time_seconds
FROM v_alert_normalization_metrics;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_dashboard_normalization_metrics;

-- ================================================================
-- alerts-list-count: contrato padrão status=active.
-- ================================================================

PREPARE oneview_alerts_list_count AS
SELECT count(*)::int AS total
FROM alerts a
JOIN data_sources d ON d.id = a.data_source_id
WHERE a.status_source = 'active' AND a.resolved_at IS NULL;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_alerts_list_count;

-- ================================================================
-- alerts-list-page: contrato padrão, last_seen_at DESC, 50 itens.
-- $1 = page_size (máximo 100); $2 = offset.
-- ================================================================

PREPARE oneview_alerts_list_page(integer, integer) AS
SELECT
  a.id, a.data_source_id, d.name AS datasource_name, a.client_name,
  a.customer_name, a.customer_key, a.customer_source, a.customer_confidence,
  a.source_event_id, a.source_problem_id, a.source_trigger_id, a.source_host_id,
  a.host_name, a.host_visible_name, a.host_technical_name, a.service_name,
  a.problem_name, a.severity, a.status_source, a.status_internal,
  a.acknowledged_source, a.acknowledged_internal, a.acknowledged_at,
  (SELECT ack.status
     FROM alert_acknowledgements ack
    WHERE ack.alert_id = a.id AND ack.status IN ('pending','processing')
    ORDER BY ack.requested_at DESC, ack.id DESC
    LIMIT 1) AS ack_request_status,
  a.suppressed, a.suppressed_until, a.maintenance_status,
  a.first_seen_at, a.last_seen_at, a.resolved_at, a.duration_seconds,
  a.created_at, a.updated_at
FROM alerts a
JOIN data_sources d ON d.id = a.data_source_id
WHERE a.status_source = 'active' AND a.resolved_at IS NULL
ORDER BY a.last_seen_at DESC, a.last_seen_at DESC, a.id DESC
LIMIT $1 OFFSET $2;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_alerts_list_page(50, 0);

-- ================================================================
-- operations-health
-- ================================================================

PREPARE oneview_operations_health AS
SELECT
  d.id, d.name, d.client_name, d.status, d.sync_enabled,
  d.sync_interval_seconds, d.last_sync_status, d.last_sync_at,
  d.last_success_at, d.failure_count, d.last_worker_heartbeat_at,
  greatest(
    d.last_worker_heartbeat_at,
    d.last_sync_at,
    d.last_success_at,
    latest.latest_sync_at
  ) AS last_activity_at
FROM data_sources d
LEFT JOIN LATERAL (
  SELECT max(coalesce(sl.finished_at, sl.started_at, sl.created_at)) AS latest_sync_at
  FROM sync_logs sl
  WHERE sl.data_source_id = d.id
) latest ON true
ORDER BY d.display_order ASC, d.name ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_operations_health;

-- ================================================================
-- attention-required
-- $1 = minutos Desastre; $2 = Alta; $3 = Média; $4 = limite (máximo 200).
-- O endpoint usa o mesmo predicado nas quatro consultas abaixo.
-- ================================================================

PREPARE oneview_attention_severity(integer, integer, integer) AS
SELECT a.severity, count(*)::int AS count
FROM public.alerts a
WHERE a.status_source = 'active'
  AND a.resolved_at IS NULL
  AND coalesce(a.acknowledged_source, false) = false
  AND a.first_seen_at IS NOT NULL
  AND (
    (a.severity = 'disaster' AND a.first_seen_at < now() - ($1::int * interval '1 minute'))
    OR (a.severity = 'high' AND a.first_seen_at < now() - ($2::int * interval '1 minute'))
    OR (a.severity = 'average' AND a.first_seen_at < now() - ($3::int * interval '1 minute'))
  )
GROUP BY a.severity;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_attention_severity(5, 15, 30);

PREPARE oneview_attention_customer(integer, integer, integer) AS
SELECT coalesce(a.customer_name, 'Sem classificação') AS customer_name,
       count(*)::int AS count
FROM public.alerts a
WHERE a.status_source = 'active'
  AND a.resolved_at IS NULL
  AND coalesce(a.acknowledged_source, false) = false
  AND a.first_seen_at IS NOT NULL
  AND (
    (a.severity = 'disaster' AND a.first_seen_at < now() - ($1::int * interval '1 minute'))
    OR (a.severity = 'high' AND a.first_seen_at < now() - ($2::int * interval '1 minute'))
    OR (a.severity = 'average' AND a.first_seen_at < now() - ($3::int * interval '1 minute'))
  )
GROUP BY coalesce(a.customer_name, 'Sem classificação')
ORDER BY count DESC, customer_name ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_attention_customer(5, 15, 30);

PREPARE oneview_attention_datasource(integer, integer, integer) AS
SELECT d.name AS datasource_name, count(*)::int AS count
FROM public.alerts a
JOIN public.data_sources d ON d.id = a.data_source_id
WHERE a.status_source = 'active'
  AND a.resolved_at IS NULL
  AND coalesce(a.acknowledged_source, false) = false
  AND a.first_seen_at IS NOT NULL
  AND (
    (a.severity = 'disaster' AND a.first_seen_at < now() - ($1::int * interval '1 minute'))
    OR (a.severity = 'high' AND a.first_seen_at < now() - ($2::int * interval '1 minute'))
    OR (a.severity = 'average' AND a.first_seen_at < now() - ($3::int * interval '1 minute'))
  )
GROUP BY d.name
ORDER BY count DESC, datasource_name ASC;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_attention_datasource(5, 15, 30);

PREPARE oneview_attention_items(integer, integer, integer, integer) AS
SELECT
  a.id, a.customer_name, a.customer_confidence, d.name AS datasource_name,
  a.host_name, a.host_visible_name, a.problem_name, a.severity,
  a.first_seen_at, a.last_seen_at,
  floor(extract(epoch FROM (now() - a.first_seen_at)) / 60)::int AS unacknowledged_minutes
FROM public.alerts a
JOIN public.data_sources d ON d.id = a.data_source_id
WHERE a.status_source = 'active'
  AND a.resolved_at IS NULL
  AND coalesce(a.acknowledged_source, false) = false
  AND a.first_seen_at IS NOT NULL
  AND (
    (a.severity = 'disaster' AND a.first_seen_at < now() - ($1::int * interval '1 minute'))
    OR (a.severity = 'high' AND a.first_seen_at < now() - ($2::int * interval '1 minute'))
    OR (a.severity = 'average' AND a.first_seen_at < now() - ($3::int * interval '1 minute'))
  )
ORDER BY
  CASE a.severity WHEN 'disaster' THEN 1 WHEN 'high' THEN 2 WHEN 'average' THEN 3 ELSE 4 END ASC,
  unacknowledged_minutes DESC,
  a.id DESC
LIMIT $4;
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) EXECUTE oneview_attention_items(5, 15, 30, 100);

DEALLOCATE ALL;
