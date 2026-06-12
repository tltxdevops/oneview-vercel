export const ALERT_FIELDS = `
  id, data_source_id, client_name, source_type, source_event_id,
  source_problem_id, source_trigger_id, source_host_id, host_name, host_ip,
  host_group, service_name, problem_name, severity, status_source,
  status_internal, acknowledged_source, acknowledged_internal, first_seen_at,
  last_seen_at, resolved_at, duration_seconds, fingerprint, source_dedup_key,
  occurrence_count, last_reopened_at, acknowledged_source_at, acknowledged_internal_at,
  normalized_at, payload_normalized, created_at, updated_at
`;

export async function getAlert(client, id) {
  const result = await client.query(`select ${ALERT_FIELDS} from alerts where id = $1`, [id]);
  return result.rows[0] || null;
}
