export const DATA_SOURCE_FIELDS = `
  id, name, client_name, type, environment, api_url, problem_group_filter,
  status, sync_enabled, sync_interval_seconds, via_vpn, observation,
  last_sync_at, last_sync_status, last_sync_error, last_success_at, last_error,
  failure_count, sync_locked_at, sync_lock_owner, display_order, created_at, updated_at
`;

export function sanitizeDataSource(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    client_name: row.client_name,
    type: row.type,
    environment: row.environment,
    api_url: row.api_url,
    problem_group_filter: row.problem_group_filter,
    status: row.status,
    sync_enabled: row.sync_enabled,
    sync_interval_seconds: row.sync_interval_seconds,
    via_vpn: row.via_vpn,
    observation: row.observation,
    last_sync_at: row.last_sync_at,
    last_sync_status: row.last_sync_status,
    last_sync_error: row.last_sync_error,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    failure_count: row.failure_count,
    sync_locked_at: row.sync_locked_at,
    sync_lock_owner: row.sync_lock_owner,
    display_order: row.display_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
