"""Persist ServiceNow Task SLA read model.

Revision ID: 0009_servicenow_task_slas
Revises: 0008_operator_reminder_subject
Create Date: 2026-09-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0009_servicenow_task_slas"
down_revision: str | None = "0008_operator_reminder_subject"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "servicenow_task_slas",
    sa.Column("sys_id", sa.String(length=32), primary_key=True),
    sa.Column("task_sys_id", sa.String(length=32), nullable=False),
    sa.Column("task_number", sa.String(length=40), nullable=True),
    sa.Column("sla_sys_id", sa.String(length=32), nullable=True),
    sa.Column("sla_name", sa.Text(), nullable=True),
    sa.Column("stage", sa.String(length=40), nullable=True),
    sa.Column("active", sa.Boolean(), nullable=True),
    sa.Column("has_breached", sa.Boolean(), nullable=True),
    sa.Column("start_time", sa.DateTime(timezone=True), nullable=True),
    sa.Column("end_time", sa.DateTime(timezone=True), nullable=True),
    sa.Column("planned_end_time", sa.DateTime(timezone=True), nullable=True),
    sa.Column("original_breach_time", sa.DateTime(timezone=True), nullable=True),
    sa.Column("time_left", sa.Text(), nullable=True),
    sa.Column("business_time_left", sa.Text(), nullable=True),
    sa.Column("percentage", sa.Numeric(12, 4), nullable=True),
    sa.Column("business_percentage", sa.Numeric(12, 4), nullable=True),
    sa.Column("sys_updated_on", sa.DateTime(timezone=True), nullable=False),
    sa.Column("raw_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    schema="public",
  )
  op.create_index("ix_servicenow_task_slas_task", "servicenow_task_slas", ["task_sys_id"], schema="public")
  op.create_index(
    "ix_servicenow_task_slas_deadline",
    "servicenow_task_slas",
    ["active", "planned_end_time"],
    schema="public",
  )
  op.create_index(
    "ix_servicenow_task_slas_watermark",
    "servicenow_task_slas",
    ["sys_updated_on", "sys_id"],
    schema="public",
  )
  op.execute("ALTER TABLE public.servicenow_task_slas OWNER TO oneview_owner")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.servicenow_task_slas FROM PUBLIC")
  op.execute(
    """
    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'oneview_vercel_readonly') then
        grant select on table public.servicenow_task_slas to oneview_vercel_readonly;
      end if;
      if exists (select 1 from pg_roles where rolname = 'oneview_worker') then
        grant select, insert, update, delete on table public.servicenow_task_slas to oneview_worker;
      end if;
    end $$
    """
  )


def downgrade() -> None:
  op.drop_table("servicenow_task_slas", schema="public")
