"""database governance

Revision ID: 0003_database_governance
Revises: 0002_oneview_worker_outbox
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0003_database_governance"
down_revision: str | None = "0002_oneview_worker_outbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


jsonb = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
  op.add_column("alerts", sa.Column("source_dedup_key", sa.String(length=255), nullable=True))
  op.add_column("alerts", sa.Column("occurrence_count", sa.Integer(), nullable=False, server_default="1"))
  op.add_column("alerts", sa.Column("last_reopened_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("alerts", sa.Column("acknowledged_source_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("alerts", sa.Column("acknowledged_internal_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("alerts", sa.Column("normalized_at", sa.DateTime(timezone=True), nullable=True))
  op.execute(
    """
    update alerts
    set source_dedup_key = coalesce(nullif(source_event_id, ''), nullif(fingerprint, ''), id)
    where source_dedup_key is null
    """
  )
  op.alter_column("alerts", "source_dedup_key", existing_type=sa.String(length=255), nullable=False)
  op.alter_column("alerts", "source_event_id", existing_type=sa.String(length=80), nullable=True)
  op.create_unique_constraint("uq_alerts_data_source_dedup_key", "alerts", ["data_source_id", "source_dedup_key"])
  op.create_index(
    "ix_alerts_active_client_severity_status",
    "alerts",
    ["client_name", "severity", "status_internal"],
    unique=False,
    postgresql_where=sa.text("status_source = 'active' and resolved_at is null"),
  )
  op.create_index(
    "ix_alerts_active_data_source_last_seen",
    "alerts",
    ["data_source_id", "last_seen_at"],
    unique=False,
    postgresql_where=sa.text("status_source = 'active' and resolved_at is null"),
  )
  op.create_index(
    "ix_alerts_active_duration",
    "alerts",
    ["duration_seconds"],
    unique=False,
    postgresql_where=sa.text("status_source = 'active' and resolved_at is null"),
  )
  op.create_index(
    "ix_alerts_active_first_seen",
    "alerts",
    ["first_seen_at"],
    unique=False,
    postgresql_where=sa.text("status_source = 'active' and resolved_at is null"),
  )
  op.create_index(
    "ix_alerts_active_last_seen",
    "alerts",
    ["last_seen_at"],
    unique=False,
    postgresql_where=sa.text("status_source = 'active' and resolved_at is null"),
  )
  op.create_index("ix_alerts_acknowledged_internal", "alerts", ["acknowledged_internal"], unique=False)
  op.create_index("ix_alerts_acknowledged_source", "alerts", ["acknowledged_source"], unique=False)
  op.create_index("ix_alerts_service_name", "alerts", ["service_name"], unique=False)
  op.create_index("ix_alerts_host_group", "alerts", ["host_group"], unique=False)
  op.create_index("ix_alerts_data_source_fingerprint", "alerts", ["data_source_id", "fingerprint"], unique=False)
  op.create_index("ix_alerts_source_problem_id", "alerts", ["source_problem_id"], unique=False)
  op.create_index("ix_alerts_source_host_id", "alerts", ["source_host_id"], unique=False)
  op.create_check_constraint(
    "ck_alerts_status_internal",
    "alerts",
    "status_internal in ('new','viewed','in_progress','acknowledged','observing','normalized','hidden')",
  )
  op.create_check_constraint(
    "ck_alerts_status_source",
    "alerts",
    "status_source in ('active','resolved','suppressed','unknown')",
  )

  op.add_column("alert_history", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("alert_history", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("alert_history", sa.Column("actor_type", sa.String(length=40), nullable=True))
  op.add_column("alert_history", sa.Column("actor_id", sa.String(length=120), nullable=True))
  op.add_column("alert_history", sa.Column("actor_name", sa.String(length=120), nullable=True))
  op.add_column("alert_history", sa.Column("action_source", sa.String(length=40), nullable=True))
  op.add_column("alert_history", sa.Column("entity_type", sa.String(length=40), nullable=True))
  op.add_column("alert_history", sa.Column("entity_id", sa.String(length=36), nullable=True))
  op.add_column("alert_history", sa.Column("before_data", jsonb, nullable=True))
  op.add_column("alert_history", sa.Column("after_data", jsonb, nullable=True))
  op.add_column("alert_history", sa.Column("metadata", jsonb, nullable=True))
  op.execute(
    """
    update alert_history
    set actor_type = coalesce(actor_type, 'user'),
        actor_name = coalesce(actor_name, operator_name),
        action_source = coalesce(action_source, source),
        entity_type = coalesce(entity_type, 'alert'),
        entity_id = coalesce(entity_id, alert_id)
    """
  )
  op.alter_column("alert_history", "actor_type", existing_type=sa.String(length=40), nullable=False)
  op.alter_column("alert_history", "action_source", existing_type=sa.String(length=40), nullable=False)
  op.alter_column("alert_history", "entity_type", existing_type=sa.String(length=40), nullable=False)
  op.alter_column("alert_history", "entity_id", existing_type=sa.String(length=36), nullable=False)
  op.create_index("ix_alert_history_created_at", "alert_history", ["created_at"], unique=False)
  op.create_index("ix_alert_history_correlation_id", "alert_history", ["correlation_id"], unique=False)
  op.create_index("ix_alert_history_request_id", "alert_history", ["request_id"], unique=False)
  op.create_index("ix_alert_history_entity", "alert_history", ["entity_type", "entity_id"], unique=False)
  op.create_index("ix_alert_history_actor", "alert_history", ["actor_type", "actor_id", "actor_name"], unique=False)
  op.create_index("ix_alert_history_action_created", "alert_history", ["action_type", "created_at"], unique=False)

  op.add_column("alert_notes", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("alert_notes", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("alert_notes", sa.Column("actor_type", sa.String(length=40), nullable=False, server_default="user"))
  op.add_column("alert_notes", sa.Column("actor_id", sa.String(length=120), nullable=True))
  op.create_index("ix_alert_notes_created_at", "alert_notes", ["created_at"], unique=False)

  op.add_column("alert_assignments", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("alert_assignments", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("alert_assignments", sa.Column("actor_type", sa.String(length=40), nullable=False, server_default="user"))
  op.add_column("alert_assignments", sa.Column("actor_id", sa.String(length=120), nullable=True))
  op.create_index("ix_alert_assignments_assigned_at", "alert_assignments", ["assigned_at"], unique=False)

  op.add_column("alert_acknowledgements", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("alert_acknowledgements", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("alert_acknowledgements", sa.Column("actor_type", sa.String(length=40), nullable=False, server_default="user"))
  op.add_column("alert_acknowledgements", sa.Column("actor_id", sa.String(length=120), nullable=True))
  op.add_column("alert_acknowledgements", sa.Column("idempotency_key", sa.String(length=255), nullable=True))
  op.add_column("alert_acknowledgements", sa.Column("result_payload", jsonb, nullable=True))
  op.create_index("ix_alert_acknowledgements_requested_at", "alert_acknowledgements", ["requested_at"], unique=False)
  op.create_index("ix_alert_acknowledgements_idempotency_key", "alert_acknowledgements", ["idempotency_key"], unique=False)
  op.create_check_constraint(
    "ck_alert_acknowledgements_status",
    "alert_acknowledgements",
    "status in ('pending','processing','success','failed','cancelled')",
  )

  op.add_column("integration_outbox", sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("integration_outbox", sa.Column("idempotency_key", sa.String(length=255), nullable=True))
  op.add_column("integration_outbox", sa.Column("result_payload", jsonb, nullable=True))
  op.add_column("integration_outbox", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("integration_outbox", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.execute("update integration_outbox set next_attempt_at = available_at where next_attempt_at is null")
  op.alter_column("integration_outbox", "next_attempt_at", existing_type=sa.DateTime(timezone=True), nullable=False)
  op.create_index(
    "ix_integration_outbox_claim",
    "integration_outbox",
    ["status", "next_attempt_at", "priority", "created_at"],
    unique=False,
  )
  op.create_index("ix_integration_outbox_locked", "integration_outbox", ["locked_at", "locked_by"], unique=False)
  op.create_index("ix_integration_outbox_idempotency_key", "integration_outbox", ["idempotency_key"], unique=True)
  op.create_index("ix_integration_outbox_correlation_id", "integration_outbox", ["correlation_id"], unique=False)
  op.create_check_constraint(
    "ck_integration_outbox_status",
    "integration_outbox",
    "status in ('pending','processing','success','failed','cancelled')",
  )

  op.add_column("sync_logs", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("sync_logs", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("sync_logs", sa.Column("created_count", sa.Integer(), nullable=False, server_default="0"))
  op.add_column("sync_logs", sa.Column("updated_count", sa.Integer(), nullable=False, server_default="0"))
  op.add_column("sync_logs", sa.Column("resolved_count", sa.Integer(), nullable=False, server_default="0"))
  op.add_column("sync_logs", sa.Column("technical_error", sa.Text(), nullable=True))
  op.create_index("ix_sync_logs_data_source_started", "sync_logs", ["data_source_id", "started_at"], unique=False)
  op.create_index("ix_sync_logs_status_started", "sync_logs", ["status", "started_at"], unique=False)
  op.create_index("ix_sync_logs_correlation_id", "sync_logs", ["correlation_id"], unique=False)

  op.add_column("sync_errors", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("sync_errors", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("sync_errors", sa.Column("worker_id", sa.String(length=120), nullable=True))
  op.add_column("sync_errors", sa.Column("technical_error", sa.Text(), nullable=True))
  op.create_index("ix_sync_errors_occurred_at", "sync_errors", ["occurred_at"], unique=False)
  op.create_index("ix_sync_errors_correlation_id", "sync_errors", ["correlation_id"], unique=False)

  op.add_column("audit_logs", sa.Column("correlation_id", sa.String(length=80), nullable=True))
  op.add_column("audit_logs", sa.Column("request_id", sa.String(length=80), nullable=True))
  op.add_column("audit_logs", sa.Column("actor_id", sa.String(length=120), nullable=True))
  op.add_column("audit_logs", sa.Column("action_source", sa.String(length=40), nullable=False, server_default="vercel_api"))
  op.add_column("audit_logs", sa.Column("before_data", jsonb, nullable=True))
  op.add_column("audit_logs", sa.Column("after_data", jsonb, nullable=True))
  op.create_index("ix_audit_logs_created_at", "audit_logs", ["created_at"], unique=False)
  op.create_index("ix_audit_logs_correlation_id", "audit_logs", ["correlation_id"], unique=False)
  op.create_index("ix_audit_logs_request_id", "audit_logs", ["request_id"], unique=False)
  op.create_index("ix_audit_logs_actor", "audit_logs", ["actor_type", "actor_id", "actor_name"], unique=False)
  op.create_index("ix_audit_logs_action_created", "audit_logs", ["action", "created_at"], unique=False)

  op.add_column("maintenance_windows", sa.Column("created_by", sa.String(length=120), nullable=True))
  op.add_column("maintenance_windows", sa.Column("updated_by", sa.String(length=120), nullable=True))
  op.create_index("ix_maintenance_windows_window", "maintenance_windows", ["starts_at", "ends_at"], unique=False)
  op.create_index("ix_maintenance_windows_status", "maintenance_windows", ["status"], unique=False)

  op.create_index("ix_data_sources_health", "data_sources", ["status", "sync_enabled", "display_order"], unique=False)
  op.create_check_constraint(
    "ck_data_sources_status",
    "data_sources",
    "status in ('active','inactive','error')",
  )
  op.create_check_constraint(
    "ck_data_sources_environment",
    "data_sources",
    "environment in ('internal','external')",
  )

  op.execute(
    """
    create or replace view v_active_alerts as
    select
      a.id,
      a.data_source_id,
      d.name as data_source_name,
      d.environment,
      d.via_vpn,
      a.client_name,
      a.host_name,
      a.host_ip,
      a.host_group,
      a.service_name,
      a.problem_name,
      a.severity,
      a.status_source,
      a.status_internal,
      a.acknowledged_source,
      a.acknowledged_internal,
      a.first_seen_at,
      a.last_seen_at,
      a.duration_seconds,
      a.source_event_id,
      a.source_problem_id,
      a.source_trigger_id,
      a.source_host_id,
      a.fingerprint
    from alerts a
    join data_sources d on d.id = a.data_source_id
    where a.status_source = 'active'
      and a.resolved_at is null
    """
  )
  op.execute(
    """
    create or replace view v_alert_metrics as
    select 'active_total' as metric_type, null::text as metric_key, count(*)::bigint as metric_value
    from v_active_alerts
    union all
    select 'severity', severity, count(*)::bigint from v_active_alerts group by severity
    union all
    select 'status_internal', status_internal, count(*)::bigint from v_active_alerts group by status_internal
    union all
    select 'client', client_name, count(*)::bigint from v_active_alerts group by client_name
    union all
    select 'service_environment', coalesce(service_name, '-') || '|' || coalesce(environment, '-'), count(*)::bigint
    from v_active_alerts
    group by coalesce(service_name, '-') || '|' || coalesce(environment, '-')
    """
  )
  op.execute(
    """
    create or replace view v_datasource_health as
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
  op.execute(
    """
    create or replace view v_alert_history_timeline as
    select id, alert_id, 'history'::text as event_kind, action_type as event_type, actor_name, message, created_at, metadata
    from alert_history
    union all
    select id, alert_id, 'note', 'note_added', operator_name, message, created_at, null::jsonb
    from alert_notes
    union all
    select id, alert_id, 'assignment', status, operator_name, null::text, assigned_at, null::jsonb
    from alert_assignments
    union all
    select id, alert_id, 'acknowledgement', status, operator_name, message, requested_at, result_payload
    from alert_acknowledgements
    """
  )


def downgrade() -> None:
  op.execute("drop view if exists v_alert_history_timeline")
  op.execute("drop view if exists v_datasource_health")
  op.execute("drop view if exists v_alert_metrics")
  op.execute("drop view if exists v_active_alerts")

  op.drop_constraint("ck_data_sources_environment", "data_sources", type_="check")
  op.drop_constraint("ck_data_sources_status", "data_sources", type_="check")
  op.drop_index("ix_data_sources_health", table_name="data_sources")

  op.drop_index("ix_maintenance_windows_status", table_name="maintenance_windows")
  op.drop_index("ix_maintenance_windows_window", table_name="maintenance_windows")
  op.drop_column("maintenance_windows", "updated_by")
  op.drop_column("maintenance_windows", "created_by")

  op.drop_index("ix_audit_logs_action_created", table_name="audit_logs")
  op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
  op.drop_index("ix_audit_logs_request_id", table_name="audit_logs")
  op.drop_index("ix_audit_logs_correlation_id", table_name="audit_logs")
  op.drop_index("ix_audit_logs_created_at", table_name="audit_logs")
  op.drop_column("audit_logs", "after_data")
  op.drop_column("audit_logs", "before_data")
  op.drop_column("audit_logs", "action_source")
  op.drop_column("audit_logs", "actor_id")
  op.drop_column("audit_logs", "request_id")
  op.drop_column("audit_logs", "correlation_id")

  op.drop_index("ix_sync_errors_correlation_id", table_name="sync_errors")
  op.drop_index("ix_sync_errors_occurred_at", table_name="sync_errors")
  op.drop_column("sync_errors", "technical_error")
  op.drop_column("sync_errors", "worker_id")
  op.drop_column("sync_errors", "request_id")
  op.drop_column("sync_errors", "correlation_id")

  op.drop_index("ix_sync_logs_correlation_id", table_name="sync_logs")
  op.drop_index("ix_sync_logs_status_started", table_name="sync_logs")
  op.drop_index("ix_sync_logs_data_source_started", table_name="sync_logs")
  op.drop_column("sync_logs", "technical_error")
  op.drop_column("sync_logs", "resolved_count")
  op.drop_column("sync_logs", "updated_count")
  op.drop_column("sync_logs", "created_count")
  op.drop_column("sync_logs", "request_id")
  op.drop_column("sync_logs", "correlation_id")

  op.drop_constraint("ck_integration_outbox_status", "integration_outbox", type_="check")
  op.drop_index("ix_integration_outbox_correlation_id", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_idempotency_key", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_locked", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_claim", table_name="integration_outbox")
  op.drop_column("integration_outbox", "request_id")
  op.drop_column("integration_outbox", "correlation_id")
  op.drop_column("integration_outbox", "result_payload")
  op.drop_column("integration_outbox", "idempotency_key")
  op.drop_column("integration_outbox", "next_attempt_at")

  op.drop_constraint("ck_alert_acknowledgements_status", "alert_acknowledgements", type_="check")
  op.drop_index("ix_alert_acknowledgements_idempotency_key", table_name="alert_acknowledgements")
  op.drop_index("ix_alert_acknowledgements_requested_at", table_name="alert_acknowledgements")
  op.drop_column("alert_acknowledgements", "result_payload")
  op.drop_column("alert_acknowledgements", "idempotency_key")
  op.drop_column("alert_acknowledgements", "actor_id")
  op.drop_column("alert_acknowledgements", "actor_type")
  op.drop_column("alert_acknowledgements", "request_id")
  op.drop_column("alert_acknowledgements", "correlation_id")

  op.drop_index("ix_alert_assignments_assigned_at", table_name="alert_assignments")
  op.drop_column("alert_assignments", "actor_id")
  op.drop_column("alert_assignments", "actor_type")
  op.drop_column("alert_assignments", "request_id")
  op.drop_column("alert_assignments", "correlation_id")

  op.drop_index("ix_alert_notes_created_at", table_name="alert_notes")
  op.drop_column("alert_notes", "actor_id")
  op.drop_column("alert_notes", "actor_type")
  op.drop_column("alert_notes", "request_id")
  op.drop_column("alert_notes", "correlation_id")

  op.drop_index("ix_alert_history_action_created", table_name="alert_history")
  op.drop_index("ix_alert_history_actor", table_name="alert_history")
  op.drop_index("ix_alert_history_entity", table_name="alert_history")
  op.drop_index("ix_alert_history_request_id", table_name="alert_history")
  op.drop_index("ix_alert_history_correlation_id", table_name="alert_history")
  op.drop_index("ix_alert_history_created_at", table_name="alert_history")
  op.drop_column("alert_history", "metadata")
  op.drop_column("alert_history", "after_data")
  op.drop_column("alert_history", "before_data")
  op.drop_column("alert_history", "entity_id")
  op.drop_column("alert_history", "entity_type")
  op.drop_column("alert_history", "action_source")
  op.drop_column("alert_history", "actor_name")
  op.drop_column("alert_history", "actor_id")
  op.drop_column("alert_history", "actor_type")
  op.drop_column("alert_history", "request_id")
  op.drop_column("alert_history", "correlation_id")

  op.drop_constraint("ck_alerts_status_source", "alerts", type_="check")
  op.drop_constraint("ck_alerts_status_internal", "alerts", type_="check")
  op.drop_index("ix_alerts_source_host_id", table_name="alerts")
  op.drop_index("ix_alerts_source_problem_id", table_name="alerts")
  op.drop_index("ix_alerts_data_source_fingerprint", table_name="alerts")
  op.drop_index("ix_alerts_host_group", table_name="alerts")
  op.drop_index("ix_alerts_service_name", table_name="alerts")
  op.drop_index("ix_alerts_acknowledged_source", table_name="alerts")
  op.drop_index("ix_alerts_acknowledged_internal", table_name="alerts")
  op.drop_index("ix_alerts_active_last_seen", table_name="alerts")
  op.drop_index("ix_alerts_active_first_seen", table_name="alerts")
  op.drop_index("ix_alerts_active_duration", table_name="alerts")
  op.drop_index("ix_alerts_active_data_source_last_seen", table_name="alerts")
  op.drop_index("ix_alerts_active_client_severity_status", table_name="alerts")
  op.drop_constraint("uq_alerts_data_source_dedup_key", "alerts", type_="unique")
  op.alter_column("alerts", "source_event_id", existing_type=sa.String(length=80), nullable=False)
  op.drop_column("alerts", "normalized_at")
  op.drop_column("alerts", "acknowledged_internal_at")
  op.drop_column("alerts", "acknowledged_source_at")
  op.drop_column("alerts", "last_reopened_at")
  op.drop_column("alerts", "occurrence_count")
  op.drop_column("alerts", "source_dedup_key")
