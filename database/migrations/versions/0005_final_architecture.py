"""final architecture consolidation

Revision ID: 0005_final_architecture
Revises: 0004_preprod_hardening
Create Date: 2026-06-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0005_final_architecture"
down_revision: str | None = "0004_preprod_hardening"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.alter_column(
    "data_sources",
    "sync_interval_seconds",
    existing_type=sa.Integer(),
    server_default="300",
    existing_nullable=False,
  )
  op.execute("update data_sources set sync_interval_seconds = 300 where sync_interval_seconds = 60")

  op.execute(
    """
    create or replace view v_alert_top_hosts as
    select
      client_name,
      coalesce(host_name, '-') as host_name,
      coalesce(host_group, '-') as host_group,
      count(*)::bigint as active_alerts,
      max(duration_seconds)::bigint as max_duration_seconds,
      min(first_seen_at) as oldest_first_seen_at
    from v_active_alerts
    group by client_name, coalesce(host_name, '-'), coalesce(host_group, '-')
    order by active_alerts desc, max_duration_seconds desc, client_name, host_name
    """
  )
  op.execute(
    """
    create or replace view v_alert_unacknowledged as
    select *
    from v_active_alerts
    where acknowledged_source = false
      and acknowledged_internal = false
    """
  )
  op.execute(
    """
    create or replace view v_alert_longest_duration as
    select
      id,
      client_name,
      host_name,
      host_group,
      service_name,
      problem_name,
      severity,
      status_internal,
      duration_seconds,
      first_seen_at,
      last_seen_at
    from v_active_alerts
    order by duration_seconds desc, first_seen_at
    """
  )
  op.execute(
    """
    create or replace view v_alert_ack_metrics as
    with first_ack as (
      select alert_id, min(created_at) as ack_at
      from alert_history
      where new_status = 'acknowledged'
         or action_type in ('ack_requested', 'acknowledged')
      group by alert_id
    )
    select
      count(*)::bigint as acknowledged_alerts,
      coalesce(avg(extract(epoch from (first_ack.ack_at - alerts.first_seen_at))), 0)::bigint
        as avg_ack_time_seconds
    from alerts
    join first_ack on first_ack.alert_id = alerts.id
    """
  )
  op.execute(
    """
    create or replace view v_alert_normalization_metrics as
    select
      count(*)::bigint as normalized_alerts,
      coalesce(avg(extract(epoch from ((coalesce(normalized_at, resolved_at, updated_at)) - first_seen_at))), 0)::bigint
        as avg_normalization_time_seconds
    from alerts
    where status_source = 'resolved'
       or status_internal = 'normalized'
    """
  )


def downgrade() -> None:
  op.execute("drop view if exists v_alert_normalization_metrics")
  op.execute("drop view if exists v_alert_ack_metrics")
  op.execute("drop view if exists v_alert_longest_duration")
  op.execute("drop view if exists v_alert_unacknowledged")
  op.execute("drop view if exists v_alert_top_hosts")
  op.alter_column(
    "data_sources",
    "sync_interval_seconds",
    existing_type=sa.Integer(),
    server_default="60",
    existing_nullable=False,
  )
