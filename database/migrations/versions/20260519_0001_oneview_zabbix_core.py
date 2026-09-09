"""oneview zabbix core

Revision ID: 20260519_0001
Revises:
Create Date: 2026-05-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260519_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "data_sources",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("name", sa.String(length=120), nullable=False),
    sa.Column("type", sa.String(length=40), nullable=False),
    sa.Column("environment", sa.String(length=20), nullable=False),
    sa.Column("api_url", sa.Text(), nullable=False),
    sa.Column("token_encrypted", sa.Text(), nullable=False),
    sa.Column("problem_group_filter", sa.String(length=255), nullable=True),
    sa.Column("status", sa.String(length=20), nullable=False),
    sa.Column("observation", sa.Text(), nullable=True),
    sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("last_sync_status", sa.String(length=20), nullable=True),
    sa.Column("last_sync_error", sa.Text(), nullable=True),
    sa.Column("display_order", sa.Integer(), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint("id"),
  )

  op.create_table(
    "alerts",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("client_name", sa.String(length=120), nullable=False),
    sa.Column("source_type", sa.String(length=40), nullable=False),
    sa.Column("source_event_id", sa.String(length=80), nullable=False),
    sa.Column("source_problem_id", sa.String(length=80), nullable=True),
    sa.Column("source_trigger_id", sa.String(length=80), nullable=True),
    sa.Column("source_host_id", sa.String(length=80), nullable=True),
    sa.Column("host_name", sa.String(length=255), nullable=True),
    sa.Column("host_ip", sa.String(length=80), nullable=True),
    sa.Column("host_group", sa.String(length=255), nullable=True),
    sa.Column("service_name", sa.String(length=255), nullable=True),
    sa.Column("problem_name", sa.Text(), nullable=False),
    sa.Column("severity", sa.String(length=40), nullable=False),
    sa.Column("status_source", sa.String(length=40), nullable=False),
    sa.Column("status_internal", sa.String(length=40), nullable=False),
    sa.Column("acknowledged_source", sa.Boolean(), nullable=False),
    sa.Column("acknowledged_internal", sa.Boolean(), nullable=False),
    sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("duration_seconds", sa.Integer(), nullable=False),
    sa.Column("fingerprint", sa.String(length=255), nullable=False),
    sa.Column("payload_normalized", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column("payload_raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
    sa.UniqueConstraint("data_source_id", "source_event_id", name="uq_alerts_data_source_event"),
  )
  op.create_index(op.f("ix_alerts_data_source_id"), "alerts", ["data_source_id"], unique=False)
  op.create_index(op.f("ix_alerts_fingerprint"), "alerts", ["fingerprint"], unique=False)
  op.create_index(op.f("ix_alerts_host_name"), "alerts", ["host_name"], unique=False)
  op.create_index(op.f("ix_alerts_source_event_id"), "alerts", ["source_event_id"], unique=False)
  op.create_index(op.f("ix_alerts_source_trigger_id"), "alerts", ["source_trigger_id"], unique=False)

  op.create_table(
    "alert_history",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("alert_id", sa.String(length=36), nullable=False),
    sa.Column("action_type", sa.String(length=60), nullable=False),
    sa.Column("previous_status", sa.String(length=40), nullable=True),
    sa.Column("new_status", sa.String(length=40), nullable=True),
    sa.Column("message", sa.Text(), nullable=True),
    sa.Column("operator_name", sa.String(length=120), nullable=True),
    sa.Column("source", sa.String(length=40), nullable=False),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index(op.f("ix_alert_history_alert_id"), "alert_history", ["alert_id"], unique=False)

  op.create_table(
    "maintenance_windows",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=True),
    sa.Column("client_name", sa.String(length=120), nullable=True),
    sa.Column("name", sa.String(length=160), nullable=False),
    sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False),
    sa.Column("observation", sa.Text(), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index(op.f("ix_maintenance_windows_data_source_id"), "maintenance_windows", ["data_source_id"], unique=False)

  op.create_table(
    "sync_logs",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("status", sa.String(length=20), nullable=False),
    sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("fetched_count", sa.Integer(), nullable=False),
    sa.Column("upserted_count", sa.Integer(), nullable=False),
    sa.Column("error", sa.Text(), nullable=True),
    sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index(op.f("ix_sync_logs_data_source_id"), "sync_logs", ["data_source_id"], unique=False)


def downgrade() -> None:
  op.drop_index(op.f("ix_sync_logs_data_source_id"), table_name="sync_logs")
  op.drop_table("sync_logs")
  op.drop_index(op.f("ix_maintenance_windows_data_source_id"), table_name="maintenance_windows")
  op.drop_table("maintenance_windows")
  op.drop_index(op.f("ix_alert_history_alert_id"), table_name="alert_history")
  op.drop_table("alert_history")
  op.drop_index(op.f("ix_alerts_source_trigger_id"), table_name="alerts")
  op.drop_index(op.f("ix_alerts_source_event_id"), table_name="alerts")
  op.drop_index(op.f("ix_alerts_host_name"), table_name="alerts")
  op.drop_index(op.f("ix_alerts_fingerprint"), table_name="alerts")
  op.drop_index(op.f("ix_alerts_data_source_id"), table_name="alerts")
  op.drop_table("alerts")
  op.drop_table("data_sources")
