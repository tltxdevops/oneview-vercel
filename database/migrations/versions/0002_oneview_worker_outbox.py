"""oneview worker outbox

Revision ID: 0002_oneview_worker_outbox
Revises: 20260519_0001
Create Date: 2026-05-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0002_oneview_worker_outbox"
down_revision: str | None = "20260519_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


jsonb = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
  op.add_column("data_sources", sa.Column("client_name", sa.String(length=120), nullable=True))
  op.execute("UPDATE data_sources SET client_name = name WHERE client_name IS NULL")
  op.alter_column("data_sources", "client_name", existing_type=sa.String(length=120), nullable=False)
  op.add_column(
    "data_sources",
    sa.Column("sync_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
  )
  op.add_column(
    "data_sources",
    sa.Column("sync_interval_seconds", sa.Integer(), nullable=False, server_default="60"),
  )
  op.add_column(
    "data_sources",
    sa.Column("via_vpn", sa.Boolean(), nullable=False, server_default=sa.text("false")),
  )
  op.add_column("data_sources", sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("last_error", sa.Text(), nullable=True))
  op.add_column(
    "data_sources",
    sa.Column("failure_count", sa.Integer(), nullable=False, server_default="0"),
  )
  op.add_column("data_sources", sa.Column("sync_locked_at", sa.DateTime(timezone=True), nullable=True))
  op.add_column("data_sources", sa.Column("sync_lock_owner", sa.String(length=120), nullable=True))
  op.create_index("ix_data_sources_status", "data_sources", ["status"], unique=False)
  op.create_index("ix_data_sources_sync_enabled", "data_sources", ["sync_enabled"], unique=False)

  op.create_index("ix_alerts_status_internal", "alerts", ["status_internal"], unique=False)
  op.create_index("ix_alerts_client_name", "alerts", ["client_name"], unique=False)
  op.create_index("ix_alerts_severity", "alerts", ["severity"], unique=False)

  op.create_table(
    "alert_notes",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("alert_id", sa.String(length=36), nullable=False),
    sa.Column("message", sa.Text(), nullable=False),
    sa.Column("operator_name", sa.String(length=120), nullable=True),
    sa.Column("source", sa.String(length=40), nullable=False, server_default="oneview"),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_alert_notes_alert_id", "alert_notes", ["alert_id"], unique=False)

  op.create_table(
    "alert_assignments",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("alert_id", sa.String(length=36), nullable=False),
    sa.Column("operator_name", sa.String(length=120), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False, server_default="assigned"),
    sa.Column("source", sa.String(length=40), nullable=False, server_default="oneview"),
    sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_alert_assignments_alert_id", "alert_assignments", ["alert_id"], unique=False)
  op.create_index("ix_alert_assignments_operator_name", "alert_assignments", ["operator_name"], unique=False)
  op.create_index("ix_alert_assignments_status", "alert_assignments", ["status"], unique=False)

  op.add_column(
    "sync_logs",
    sa.Column("sync_type", sa.String(length=40), nullable=False, server_default="automatic"),
  )
  op.add_column("sync_logs", sa.Column("triggered_by", sa.String(length=120), nullable=True))
  op.add_column("sync_logs", sa.Column("worker_id", sa.String(length=120), nullable=True))
  op.add_column("sync_logs", sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"))
  op.add_column("sync_logs", sa.Column("duration_ms", sa.Integer(), nullable=True))
  op.add_column("sync_logs", sa.Column("error_code", sa.String(length=80), nullable=True))
  op.add_column(
    "sync_logs",
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
  )

  op.create_table(
    "sync_errors",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("sync_log_id", sa.String(length=36), nullable=True),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("error_type", sa.String(length=80), nullable=False),
    sa.Column("message", sa.Text(), nullable=False),
    sa.Column("details", jsonb, nullable=True),
    sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.ForeignKeyConstraint(["sync_log_id"], ["sync_logs.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_sync_errors_data_source_id", "sync_errors", ["data_source_id"], unique=False)
  op.create_index("ix_sync_errors_sync_log_id", "sync_errors", ["sync_log_id"], unique=False)

  op.create_table(
    "integration_outbox",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("aggregate_type", sa.String(length=40), nullable=False),
    sa.Column("aggregate_id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=True),
    sa.Column("alert_id", sa.String(length=36), nullable=True),
    sa.Column("action_type", sa.String(length=60), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
    sa.Column("priority", sa.Integer(), nullable=False, server_default="100"),
    sa.Column("payload", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
    sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="5"),
    sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("locked_by", sa.String(length=120), nullable=True),
    sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.Column("created_by", sa.String(length=120), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_integration_outbox_status", "integration_outbox", ["status"], unique=False)
  op.create_index("ix_integration_outbox_action_type", "integration_outbox", ["action_type"], unique=False)
  op.create_index("ix_integration_outbox_available_at", "integration_outbox", ["available_at"], unique=False)
  op.create_index("ix_integration_outbox_alert_id", "integration_outbox", ["alert_id"], unique=False)
  op.create_index("ix_integration_outbox_data_source_id", "integration_outbox", ["data_source_id"], unique=False)

  op.create_table(
    "alert_acknowledgements",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("alert_id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("acknowledgement_type", sa.String(length=20), nullable=False, server_default="internal"),
    sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
    sa.Column("source_event_id", sa.String(length=80), nullable=True),
    sa.Column("message", sa.Text(), nullable=True),
    sa.Column("operator_name", sa.String(length=120), nullable=True),
    sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
    sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("external_response", jsonb, nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_alert_acknowledgements_alert_id", "alert_acknowledgements", ["alert_id"], unique=False)
  op.create_index("ix_alert_acknowledgements_status", "alert_acknowledgements", ["status"], unique=False)
  op.create_index(
    "ix_alert_acknowledgements_data_source_id",
    "alert_acknowledgements",
    ["data_source_id"],
    unique=False,
  )

  op.create_table(
    "audit_logs",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("actor_name", sa.String(length=120), nullable=True),
    sa.Column("actor_type", sa.String(length=40), nullable=False, server_default="user"),
    sa.Column("action", sa.String(length=80), nullable=False),
    sa.Column("entity_type", sa.String(length=40), nullable=False),
    sa.Column("entity_id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=True),
    sa.Column("alert_id", sa.String(length=36), nullable=True),
    sa.Column("metadata", jsonb, nullable=True),
    sa.Column("ip_address", sa.String(length=80), nullable=True),
    sa.Column("user_agent", sa.Text(), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index("ix_audit_logs_action", "audit_logs", ["action"], unique=False)
  op.create_index("ix_audit_logs_entity", "audit_logs", ["entity_type", "entity_id"], unique=False)
  op.create_index("ix_audit_logs_alert_id", "audit_logs", ["alert_id"], unique=False)
  op.create_index("ix_audit_logs_data_source_id", "audit_logs", ["data_source_id"], unique=False)


def downgrade() -> None:
  op.drop_index("ix_audit_logs_data_source_id", table_name="audit_logs")
  op.drop_index("ix_audit_logs_alert_id", table_name="audit_logs")
  op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
  op.drop_index("ix_audit_logs_action", table_name="audit_logs")
  op.drop_table("audit_logs")

  op.drop_index("ix_alert_acknowledgements_data_source_id", table_name="alert_acknowledgements")
  op.drop_index("ix_alert_acknowledgements_status", table_name="alert_acknowledgements")
  op.drop_index("ix_alert_acknowledgements_alert_id", table_name="alert_acknowledgements")
  op.drop_table("alert_acknowledgements")

  op.drop_index("ix_integration_outbox_data_source_id", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_alert_id", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_available_at", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_action_type", table_name="integration_outbox")
  op.drop_index("ix_integration_outbox_status", table_name="integration_outbox")
  op.drop_table("integration_outbox")

  op.drop_index("ix_sync_errors_sync_log_id", table_name="sync_errors")
  op.drop_index("ix_sync_errors_data_source_id", table_name="sync_errors")
  op.drop_table("sync_errors")

  op.drop_column("sync_logs", "created_at")
  op.drop_column("sync_logs", "error_code")
  op.drop_column("sync_logs", "duration_ms")
  op.drop_column("sync_logs", "attempt")
  op.drop_column("sync_logs", "worker_id")
  op.drop_column("sync_logs", "triggered_by")
  op.drop_column("sync_logs", "sync_type")

  op.drop_index("ix_alert_assignments_status", table_name="alert_assignments")
  op.drop_index("ix_alert_assignments_operator_name", table_name="alert_assignments")
  op.drop_index("ix_alert_assignments_alert_id", table_name="alert_assignments")
  op.drop_table("alert_assignments")

  op.drop_index("ix_alert_notes_alert_id", table_name="alert_notes")
  op.drop_table("alert_notes")

  op.drop_index("ix_alerts_severity", table_name="alerts")
  op.drop_index("ix_alerts_client_name", table_name="alerts")
  op.drop_index("ix_alerts_status_internal", table_name="alerts")

  op.drop_index("ix_data_sources_sync_enabled", table_name="data_sources")
  op.drop_index("ix_data_sources_status", table_name="data_sources")
  op.drop_column("data_sources", "sync_lock_owner")
  op.drop_column("data_sources", "sync_locked_at")
  op.drop_column("data_sources", "failure_count")
  op.drop_column("data_sources", "last_error")
  op.drop_column("data_sources", "last_success_at")
  op.drop_column("data_sources", "via_vpn")
  op.drop_column("data_sources", "sync_interval_seconds")
  op.drop_column("data_sources", "sync_enabled")
  op.drop_column("data_sources", "client_name")
