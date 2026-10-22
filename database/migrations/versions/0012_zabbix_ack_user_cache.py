"""Cache Zabbix user identities per datasource for ACK authorship (read-only enrichment).

Revision ID: 0012_zabbix_ack_user_cache
Revises: 0011_zabbix_ack_identity_mapping
Create Date: 2026-10-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0012_zabbix_ack_user_cache"
down_revision: str | None = "0011_zabbix_ack_identity_mapping"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "zabbix_ack_user_cache",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("zabbix_userid", sa.String(length=80), nullable=False),
    sa.Column("zabbix_username", sa.String(length=255), nullable=False),
    sa.Column("display_name", sa.String(length=255), nullable=True),
    sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.CheckConstraint(
      "length(trim(zabbix_userid)) > 0 and length(trim(zabbix_username)) > 0",
      name="ck_zabbix_ack_user_cache_nonempty",
    ),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="CASCADE"),
    sa.PrimaryKeyConstraint("id"),
    sa.UniqueConstraint("data_source_id", "zabbix_userid", name="uq_zabbix_ack_user_cache_datasource_userid"),
  )
  op.create_index(
    "ix_zabbix_ack_user_cache_datasource",
    "zabbix_ack_user_cache",
    ["data_source_id"],
    unique=False,
  )


def downgrade() -> None:
  op.drop_index("ix_zabbix_ack_user_cache_datasource", table_name="zabbix_ack_user_cache")
  op.drop_table("zabbix_ack_user_cache")
