"""Theo automation state

Revision ID: 0006_theo_automation_state
Revises: 0005_final_architecture
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0006_theo_automation_state"
down_revision: str | None = "0005_final_architecture"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "theo_automation_state",
    sa.Column("automation_key", sa.String(length=80), nullable=False),
    sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.PrimaryKeyConstraint("automation_key"),
  )
  op.execute("ALTER TABLE public.theo_automation_state OWNER TO oneview_owner")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.theo_automation_state FROM PUBLIC")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.theo_automation_state FROM oneview_worker")
  op.execute("REVOKE ALL PRIVILEGES ON TABLE public.theo_automation_state FROM oneview_actions")
  op.execute("GRANT SELECT ON TABLE public.theo_automation_state TO oneview_worker")
  op.execute("GRANT SELECT ON TABLE public.theo_automation_state TO oneview_actions")
  op.execute(
    """
    INSERT INTO public.theo_automation_state (automation_key, enabled, activated_at)
    VALUES ('alert_high_disaster', false, NULL)
    ON CONFLICT (automation_key) DO NOTHING
    """
  )


def downgrade() -> None:
  op.drop_table("theo_automation_state")
