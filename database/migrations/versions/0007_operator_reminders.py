"""Operator circuit reminders.

Revision ID: 0007_operator_reminders
Revises: 0006_theo_automation_state
Create Date: 2026-09-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0007_operator_reminders"
down_revision: str | None = "0006_theo_automation_state"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "operator_reminders",
    sa.Column(
      "id",
      postgresql.UUID(as_uuid=False),
      nullable=False,
      server_default=sa.text("gen_random_uuid()"),
    ),
    sa.Column("circuit_key", sa.Text(), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("source_host_id", sa.Text(), nullable=True),
    sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
    sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'scheduled'")),
    sa.Column("created_by", sa.Text(), nullable=False),
    sa.Column("created_by_name", sa.Text(), nullable=True),
    sa.Column("initial_alert_id", sa.String(length=36), nullable=True),
    sa.Column("initial_incident_sys_id", sa.Text(), nullable=True),
    sa.Column("initial_incident_number", sa.Text(), nullable=True),
    sa.Column(
      "context_snapshot",
      postgresql.JSONB(astext_type=sa.Text()),
      nullable=False,
      server_default=sa.text("'{}'::jsonb"),
    ),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("skipped_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("skip_reason", sa.Text(), nullable=True),
    sa.Column("last_error", sa.Text(), nullable=True),
    sa.CheckConstraint(
      "status in ('scheduled','processing','sent','cancelled','skipped','failed')",
      name="ck_operator_reminders_status",
    ),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"]),
    sa.PrimaryKeyConstraint("id"),
  )
  op.create_index(
    "ix_operator_reminders_status_scheduled_for",
    "operator_reminders",
    ["status", "scheduled_for"],
    unique=False,
  )
  op.create_index(
    "ix_operator_reminders_data_source_circuit_key",
    "operator_reminders",
    ["data_source_id", "circuit_key"],
    unique=False,
  )
  op.create_index(
    "uq_operator_reminders_active_data_source_circuit",
    "operator_reminders",
    ["data_source_id", "circuit_key"],
    unique=True,
    postgresql_where=sa.text("status in ('scheduled','processing')"),
  )
  op.execute("ALTER TABLE public.operator_reminders OWNER TO oneview_owner")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM PUBLIC")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_worker")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_app")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_actions")
  op.execute("GRANT SELECT, INSERT, UPDATE ON TABLE public.operator_reminders TO oneview_app")
  op.execute("GRANT SELECT, INSERT, UPDATE ON TABLE public.operator_reminders TO oneview_actions")


def downgrade() -> None:
  op.drop_table("operator_reminders")
