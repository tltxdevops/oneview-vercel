"""Add a per-datasource full reconciliation interval.

Revision ID: 0010_full_reconciliation_interval
Revises: 0009_servicenow_task_slas
Create Date: 2026-10-06

The scheduler reads these columns. It does not branch on datasource name.
NULL full_reconciliation_interval_seconds keeps today's sync interval.
The homologation update below is datasource data: teletex-http and zurich
move to a 5 minute full reconciliation. castrolanda and every other
datasource stay unset until an operator changes the row.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0010_full_reconciliation_interval"
down_revision: str | None = "0009_servicenow_task_slas"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.add_column(
    "data_sources",
    sa.Column("full_reconciliation_interval_seconds", sa.Integer(), nullable=True),
  )
  op.add_column(
    "data_sources",
    sa.Column("last_fast_event_at", sa.DateTime(timezone=True), nullable=True),
  )
  op.create_check_constraint(
    "ck_data_sources_full_reconciliation_interval_min",
    "data_sources",
    "full_reconciliation_interval_seconds IS NULL OR full_reconciliation_interval_seconds >= 15",
  )
  op.execute(
    """
    UPDATE data_sources
    SET full_reconciliation_interval_seconds = 300
    WHERE name IN ('teletex-http', 'zurich')
    """
  )


def downgrade() -> None:
  op.drop_constraint(
    "ck_data_sources_full_reconciliation_interval_min",
    "data_sources",
    type_="check",
  )
  op.drop_column("data_sources", "last_fast_event_at")
  op.drop_column("data_sources", "full_reconciliation_interval_seconds")
