"""durable per-datasource identity mapping for delegated Zabbix ACK

Revision ID: 0011_zabbix_ack_identity_mapping
Revises: 0010_full_reconciliation_interval
Create Date: 2026-10-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "0011_zabbix_ack_identity_mapping"
down_revision: str | None = "0010_full_reconciliation_interval"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
  op.create_table(
    "zabbix_ack_identity_mappings",
    sa.Column("id", sa.String(length=36), nullable=False),
    sa.Column("data_source_id", sa.String(length=36), nullable=False),
    sa.Column("entra_oid", sa.String(length=120), nullable=False),
    sa.Column("entra_upn", sa.String(length=255), nullable=False),
    sa.Column("zabbix_userid", sa.String(length=80), nullable=False),
    sa.Column("zabbix_username", sa.String(length=255), nullable=False),
    sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("verified_by", sa.String(length=120), nullable=True),
    sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    sa.CheckConstraint("entra_oid = lower(entra_oid)", name="ck_zabbix_ack_identity_oid_lower"),
    sa.CheckConstraint("entra_upn = lower(entra_upn)", name="ck_zabbix_ack_identity_upn_lower"),
    sa.CheckConstraint(
      "length(trim(entra_oid)) > 0 and length(trim(entra_upn)) > 0 and "
      "length(trim(zabbix_userid)) > 0 and length(trim(zabbix_username)) > 0",
      name="ck_zabbix_ack_identity_nonempty",
    ),
    sa.CheckConstraint("not enabled or verified_at is not null", name="ck_zabbix_ack_identity_enabled_verified"),
    sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="CASCADE"),
    sa.PrimaryKeyConstraint("id"),
    sa.UniqueConstraint("data_source_id", "entra_oid", name="uq_zabbix_ack_identity_datasource_oid"),
    sa.UniqueConstraint("data_source_id", "entra_upn", name="uq_zabbix_ack_identity_datasource_upn"),
    sa.UniqueConstraint("data_source_id", "zabbix_userid", name="uq_zabbix_ack_identity_datasource_userid"),
  )
  op.create_index(
    "ix_zabbix_ack_identity_enabled",
    "zabbix_ack_identity_mappings",
    ["data_source_id", "enabled"],
    unique=False,
  )


def downgrade() -> None:
  op.drop_index("ix_zabbix_ack_identity_enabled", table_name="zabbix_ack_identity_mappings")
  op.drop_table("zabbix_ack_identity_mappings")
