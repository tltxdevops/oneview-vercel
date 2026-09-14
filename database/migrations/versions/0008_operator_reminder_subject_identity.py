"""Expand operator reminders with operational subject identity.

Revision ID: 0008_operator_reminder_subject
Revises: 0007_operator_reminders
Create Date: 2026-09-14

Downgrade intentionally aborts when alert_subject rows exist. It never deletes or
rewrites reminders to manufacture a circuit identity. The audit_logs grant is not
revoked on downgrade because it predates this revision as a manual operational grant.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0008_operator_reminder_subject"
down_revision: str | None = "0007_operator_reminders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.add_column(
    "operator_reminders",
    sa.Column("subject_type", sa.String(length=24), nullable=False, server_default=sa.text("'circuit'")),
    schema="public",
  )
  op.add_column(
    "operator_reminders",
    sa.Column("subject_key", sa.String(length=512), nullable=True),
    schema="public",
  )
  op.add_column(
    "operator_reminders",
    sa.Column("source_trigger_id", sa.String(length=80), nullable=True),
    schema="public",
  )
  op.alter_column(
    "operator_reminders",
    "circuit_key",
    existing_type=sa.Text(),
    nullable=True,
    schema="public",
  )
  op.execute(
    """
    update public.operator_reminders
       set subject_type = 'circuit',
           subject_key = 'circuit:' || circuit_key
     where circuit_key is not null
       and subject_key is null
    """
  )
  op.create_check_constraint(
    "ck_operator_reminders_subject_type",
    "operator_reminders",
    "subject_type in ('circuit','alert_subject')",
    schema="public",
  )
  op.create_check_constraint(
    "ck_operator_reminders_subject_shape",
    "operator_reminders",
    "(subject_type = 'circuit' and circuit_key is not null "
    "and (subject_key is null or subject_key = 'circuit:' || circuit_key)) or "
    "(subject_type = 'alert_subject' and circuit_key is null and subject_key is not null "
    "and source_host_id is not null and source_trigger_id is not null "
    "and subject_key = 'alert:' || source_host_id || ':' || source_trigger_id)",
    schema="public",
  )
  op.create_index(
    "ix_operator_reminders_data_source_subject",
    "operator_reminders",
    ["data_source_id", "subject_type", "subject_key"],
    unique=False,
    schema="public",
  )
  op.create_index(
    "uq_operator_reminders_active_data_source_subject",
    "operator_reminders",
    ["data_source_id", "subject_type", "subject_key"],
    unique=True,
    schema="public",
    postgresql_where=sa.text("subject_key is not null and status in ('scheduled','processing')"),
  )
  # Existing (data_source_id, circuit_key) active unique index remains throughout rollout.
  op.execute("GRANT INSERT ON TABLE public.audit_logs TO oneview_actions")


def downgrade() -> None:
  op.execute(
    """
    do $$
    begin
      if exists (
        select 1
          from public.operator_reminders
         where subject_type = 'alert_subject'
            or circuit_key is null
      ) then
        raise exception using
          errcode = '23514',
          message = 'cannot downgrade: operator_reminders contains alert_subject rows without canonical circuit_key';
      end if;
    end
    $$
    """
  )
  op.drop_index("uq_operator_reminders_active_data_source_subject", table_name="operator_reminders", schema="public")
  op.drop_index("ix_operator_reminders_data_source_subject", table_name="operator_reminders", schema="public")
  op.drop_constraint("ck_operator_reminders_subject_shape", "operator_reminders", type_="check", schema="public")
  op.drop_constraint("ck_operator_reminders_subject_type", "operator_reminders", type_="check", schema="public")
  op.alter_column(
    "operator_reminders",
    "circuit_key",
    existing_type=sa.Text(),
    nullable=False,
    schema="public",
  )
  op.drop_column("operator_reminders", "source_trigger_id", schema="public")
  op.drop_column("operator_reminders", "subject_key", schema="public")
  op.drop_column("operator_reminders", "subject_type", schema="public")
