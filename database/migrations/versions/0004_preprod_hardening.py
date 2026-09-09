"""preprod hardening

Revision ID: 0004_preprod_hardening
Revises: 0003_database_governance
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0004_preprod_hardening"
down_revision: str | None = "0003_database_governance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


jsonb = postgresql.JSONB(astext_type=sa.Text())


TIMESTAMP_DEFAULTS = {
  "data_sources": ("created_at", "updated_at"),
  "alerts": ("created_at", "updated_at"),
  "alert_history": ("created_at",),
  "alert_notes": ("created_at", "updated_at"),
  "alert_assignments": ("assigned_at", "created_at", "updated_at"),
  "alert_acknowledgements": ("requested_at", "created_at", "updated_at"),
  "maintenance_windows": ("created_at", "updated_at"),
  "sync_logs": ("started_at", "created_at"),
  "sync_errors": ("occurred_at", "created_at"),
  "integration_outbox": ("available_at", "next_attempt_at", "created_at", "updated_at"),
  "audit_logs": ("created_at",),
}


def _set_timestamp_defaults() -> None:
  for table_name, columns in TIMESTAMP_DEFAULTS.items():
    for column_name in columns:
      op.alter_column(
        table_name,
        column_name,
        existing_type=sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
      )


def _drop_timestamp_defaults() -> None:
  for table_name, columns in TIMESTAMP_DEFAULTS.items():
    for column_name in columns:
      op.alter_column(
        table_name,
        column_name,
        existing_type=sa.DateTime(timezone=True),
        server_default=None,
      )


def upgrade() -> None:
  _set_timestamp_defaults()

  op.add_column("data_sources", sa.Column("sync_lock_expires_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("next_sync_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("last_worker_id", sa.String(length=120), nullable=True))
  op.add_column("data_sources", sa.Column("last_worker_heartbeat_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("last_sync_duration_ms", sa.Integer(), nullable=True))
  op.add_column("data_sources", sa.Column("rate_limit_per_minute", sa.Integer(), nullable=False, server_default="60"))
  op.create_index("ix_data_sources_schedule", "data_sources", ["sync_enabled", "status", "next_sync_at"], unique=False)
  op.create_index("ix_data_sources_cooldown_until", "data_sources", ["cooldown_until"], unique=False)
  op.create_index("ix_data_sources_worker_heartbeat", "data_sources", ["last_worker_heartbeat_at"], unique=False)
  op.create_check_constraint("ck_data_sources_sync_interval_min", "data_sources", "sync_interval_seconds >= 15")
  op.create_check_constraint("ck_data_sources_rate_limit_positive", "data_sources", "rate_limit_per_minute > 0")
  op.create_check_constraint("ck_data_sources_failure_count_nonnegative", "data_sources", "failure_count >= 0")

  op.add_column("integration_outbox", sa.Column("lock_expires_at", sa.DateTime(timezone=True), nullable=True))
  op.create_index("ix_integration_outbox_lock_expires", "integration_outbox", ["lock_expires_at"], unique=False)
  op.create_check_constraint("ck_integration_outbox_attempts", "integration_outbox", "attempts >= 0 and max_attempts >= 1 and attempts <= max_attempts")
  op.create_check_constraint("ck_integration_outbox_priority", "integration_outbox", "priority >= 0")

  op.create_check_constraint("ck_sync_logs_counts_nonnegative", "sync_logs", "fetched_count >= 0 and upserted_count >= 0 and created_count >= 0 and updated_count >= 0 and resolved_count >= 0")
  op.create_check_constraint("ck_sync_logs_duration_nonnegative", "sync_logs", "duration_ms is null or duration_ms >= 0")

  op.create_check_constraint("ck_alerts_duration_nonnegative", "alerts", "duration_seconds >= 0")
  op.create_check_constraint("ck_alerts_occurrence_positive", "alerts", "occurrence_count >= 1")

  op.create_table(
    "worker_heartbeats",
    sa.Column("worker_id", sa.String(length=120), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False, server_default="running"),
    sa.Column("hostname", sa.String(length=255), nullable=True),
    sa.Column("process_id", sa.Integer(), nullable=True),
    sa.Column("version", sa.String(length=80), nullable=True),
    sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("last_cycle_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_cycle_duration_ms", sa.Integer(), nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.Column("metadata", jsonb, nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.CheckConstraint("status in ('starting','running','idle','error','stopped')", name="ck_worker_heartbeats_status"),
    sa.PrimaryKeyConstraint("worker_id"),
  )
  op.create_index("ix_worker_heartbeats_status", "worker_heartbeats", ["status"], unique=False)
  op.create_index("ix_worker_heartbeats_last_seen", "worker_heartbeats", ["last_seen_at"], unique=False)

  op.execute(
    """
    create or replace view v_worker_health as
    select
      worker_id,
      status,
      hostname,
      process_id,
      version,
      started_at,
      last_seen_at,
      last_cycle_at,
      last_cycle_duration_ms,
      last_error,
      case
        when last_seen_at >= now() - interval '2 minutes' then true
        else false
      end as is_alive,
      metadata
    from worker_heartbeats
    """
  )
  op.execute(
    """
    create or replace view v_outbox_backlog as
    select
      status,
      action_type,
      count(*)::bigint as total,
      min(created_at) as oldest_created_at,
      min(next_attempt_at) as next_attempt_at
    from integration_outbox
    group by status, action_type
    """
  )
  op.execute("drop view if exists v_datasource_health")
  op.execute(
    """
    create view v_datasource_health as
    select
      d.id,
      d.name,
      d.client_name,
      d.environment,
      d.via_vpn,
      d.status,
      d.sync_enabled,
      d.sync_interval_seconds,
      d.next_sync_at,
      d.cooldown_until,
      d.last_worker_id,
      d.last_worker_heartbeat_at,
      d.last_sync_at,
      d.last_success_at,
      d.last_error,
      d.failure_count,
      d.last_sync_duration_ms,
      count(a.id) filter (where a.status_source = 'active' and a.resolved_at is null) as active_alerts,
      count(o.id) filter (where o.status in ('pending','processing')) as pending_outbox
    from data_sources d
    left join alerts a on a.data_source_id = d.id
    left join integration_outbox o on o.data_source_id = d.id
    group by d.id
    """
  )


def downgrade() -> None:
  op.execute("drop view if exists v_outbox_backlog")
  op.execute("drop view if exists v_worker_health")
  op.execute("drop view if exists v_datasource_health")
  op.execute(
    """
    create view v_datasource_health as
    select
      d.id,
      d.name,
      d.client_name,
      d.environment,
      d.via_vpn,
      d.status,
      d.sync_enabled,
      d.sync_interval_seconds,
      d.last_sync_at,
      d.last_success_at,
      d.last_error,
      d.failure_count,
      count(a.id) filter (where a.status_source = 'active' and a.resolved_at is null) as active_alerts,
      count(o.id) filter (where o.status in ('pending','processing')) as pending_outbox
    from data_sources d
    left join alerts a on a.data_source_id = d.id
    left join integration_outbox o on o.data_source_id = d.id
    group by d.id
    """
  )
  op.drop_index("ix_worker_heartbeats_last_seen", table_name="worker_heartbeats")
  op.drop_index("ix_worker_heartbeats_status", table_name="worker_heartbeats")
  op.drop_table("worker_heartbeats")

  op.drop_constraint("ck_alerts_occurrence_positive", "alerts", type_="check")
  op.drop_constraint("ck_alerts_duration_nonnegative", "alerts", type_="check")
  op.drop_constraint("ck_sync_logs_duration_nonnegative", "sync_logs", type_="check")
  op.drop_constraint("ck_sync_logs_counts_nonnegative", "sync_logs", type_="check")
  op.drop_constraint("ck_integration_outbox_priority", "integration_outbox", type_="check")
  op.drop_constraint("ck_integration_outbox_attempts", "integration_outbox", type_="check")
  op.drop_index("ix_integration_outbox_lock_expires", table_name="integration_outbox")
  op.drop_column("integration_outbox", "lock_expires_at")

  op.drop_constraint("ck_data_sources_failure_count_nonnegative", "data_sources", type_="check")
  op.drop_constraint("ck_data_sources_rate_limit_positive", "data_sources", type_="check")
  op.drop_constraint("ck_data_sources_sync_interval_min", "data_sources", type_="check")
  op.drop_index("ix_data_sources_worker_heartbeat", table_name="data_sources")
  op.drop_index("ix_data_sources_cooldown_until", table_name="data_sources")
  op.drop_index("ix_data_sources_schedule", table_name="data_sources")
  op.drop_column("data_sources", "rate_limit_per_minute")
  op.drop_column("data_sources", "last_sync_duration_ms")
  op.drop_column("data_sources", "last_worker_heartbeat_at")
  op.drop_column("data_sources", "last_worker_id")
  op.drop_column("data_sources", "cooldown_until")
  op.drop_column("data_sources", "next_sync_at")
  op.drop_column("data_sources", "sync_lock_expires_at")

  _drop_timestamp_defaults()
