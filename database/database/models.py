from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database.base import Base


def utcnow() -> datetime:
  return datetime.now(timezone.utc)


def new_id() -> str:
  return str(uuid4())


class DataSource(Base):
  __tablename__ = "data_sources"
  __table_args__ = (
    CheckConstraint("status in ('active','inactive','error')", name="ck_data_sources_status"),
    CheckConstraint("environment in ('internal','external')", name="ck_data_sources_environment"),
    CheckConstraint("sync_interval_seconds >= 15", name="ck_data_sources_sync_interval_min"),
    CheckConstraint(
      "full_reconciliation_interval_seconds IS NULL OR full_reconciliation_interval_seconds >= 15",
      name="ck_data_sources_full_reconciliation_interval_min",
    ),
    CheckConstraint("rate_limit_per_minute > 0", name="ck_data_sources_rate_limit_positive"),
    CheckConstraint("failure_count >= 0", name="ck_data_sources_failure_count_nonnegative"),
    Index("ix_data_sources_health", "status", "sync_enabled", "display_order"),
    Index("ix_data_sources_schedule", "sync_enabled", "status", "next_sync_at"),
    Index("ix_data_sources_cooldown_until", "cooldown_until"),
    Index("ix_data_sources_worker_heartbeat", "last_worker_heartbeat_at"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  name: Mapped[str] = mapped_column(String(120), nullable=False)
  client_name: Mapped[str] = mapped_column(String(120), nullable=False)
  type: Mapped[str] = mapped_column(String(40), nullable=False, default="zabbix")
  environment: Mapped[str] = mapped_column(String(20), nullable=False, default="internal")
  api_url: Mapped[str] = mapped_column(Text, nullable=False)
  token_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
  problem_group_filter: Mapped[str | None] = mapped_column(String(255))
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
  sync_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
  sync_interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
  full_reconciliation_interval_seconds: Mapped[int | None] = mapped_column(Integer)
  via_vpn: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
  observation: Mapped[str | None] = mapped_column(Text)
  last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_sync_status: Mapped[str | None] = mapped_column(String(20))
  last_sync_error: Mapped[str | None] = mapped_column(Text)
  last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_error: Mapped[str | None] = mapped_column(Text)
  failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  sync_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  sync_lock_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  sync_lock_owner: Mapped[str | None] = mapped_column(String(120))
  next_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_worker_id: Mapped[str | None] = mapped_column(String(120))
  last_worker_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_sync_duration_ms: Mapped[int | None] = mapped_column(Integer)
  last_fast_event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  rate_limit_per_minute: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
  display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

  alerts: Mapped[list["Alert"]] = relationship(back_populates="data_source")
  sync_logs: Mapped[list["SyncLog"]] = relationship(back_populates="data_source")


class Alert(Base):
  __tablename__ = "alerts"
  __table_args__ = (
    UniqueConstraint("data_source_id", "source_event_id", name="uq_alerts_data_source_event"),
    UniqueConstraint("data_source_id", "source_dedup_key", name="uq_alerts_data_source_dedup_key"),
    Index("ix_alerts_status_internal", "status_internal"),
    Index("ix_alerts_client_name", "client_name"),
    Index("ix_alerts_severity", "severity"),
    Index("ix_alerts_acknowledged_internal", "acknowledged_internal"),
    Index("ix_alerts_acknowledged_source", "acknowledged_source"),
    Index("ix_alerts_service_name", "service_name"),
    Index("ix_alerts_host_group", "host_group"),
    Index("ix_alerts_data_source_fingerprint", "data_source_id", "fingerprint"),
    Index("ix_alerts_source_problem_id", "source_problem_id"),
    Index("ix_alerts_source_host_id", "source_host_id"),
    Index("ix_alerts_active_client_severity_status", "client_name", "severity", "status_internal"),
    Index("ix_alerts_active_data_source_last_seen", "data_source_id", "last_seen_at"),
    Index("ix_alerts_active_duration", "duration_seconds"),
    Index("ix_alerts_active_first_seen", "first_seen_at"),
    Index("ix_alerts_active_last_seen", "last_seen_at"),
    CheckConstraint(
      "status_internal in ('new','viewed','in_progress','acknowledged','observing','normalized','hidden')",
      name="ck_alerts_status_internal",
    ),
    CheckConstraint("status_source in ('active','resolved','suppressed','unknown')", name="ck_alerts_status_source"),
    CheckConstraint("duration_seconds >= 0", name="ck_alerts_duration_nonnegative"),
    CheckConstraint("occurrence_count >= 1", name="ck_alerts_occurrence_positive"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  data_source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"), nullable=False, index=True)
  client_name: Mapped[str] = mapped_column(String(120), nullable=False)
  source_type: Mapped[str] = mapped_column(String(40), nullable=False, default="zabbix")
  source_event_id: Mapped[str | None] = mapped_column(String(80), index=True)
  source_problem_id: Mapped[str | None] = mapped_column(String(80))
  source_trigger_id: Mapped[str | None] = mapped_column(String(80), index=True)
  source_host_id: Mapped[str | None] = mapped_column(String(80))
  host_name: Mapped[str | None] = mapped_column(String(255), index=True)
  host_ip: Mapped[str | None] = mapped_column(String(80))
  host_group: Mapped[str | None] = mapped_column(String(255))
  service_name: Mapped[str | None] = mapped_column(String(255))
  problem_name: Mapped[str] = mapped_column(Text, nullable=False)
  severity: Mapped[str] = mapped_column(String(40), nullable=False)
  status_source: Mapped[str] = mapped_column(String(40), nullable=False, default="active")
  status_internal: Mapped[str] = mapped_column(String(40), nullable=False, default="new")
  acknowledged_source: Mapped[bool] = mapped_column(nullable=False, default=False)
  acknowledged_internal: Mapped[bool] = mapped_column(nullable=False, default=False)
  first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  fingerprint: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
  source_dedup_key: Mapped[str] = mapped_column(String(255), nullable=False)
  occurrence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
  last_reopened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  acknowledged_source_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  acknowledged_internal_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  normalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  payload_normalized: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
  payload_raw: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

  data_source: Mapped[DataSource] = relationship(back_populates="alerts")
  history: Mapped[list["AlertHistory"]] = relationship(back_populates="alert")
  notes: Mapped[list["AlertNote"]] = relationship(back_populates="alert")
  assignments: Mapped[list["AlertAssignment"]] = relationship(back_populates="alert")
  acknowledgements: Mapped[list["AlertAcknowledgement"]] = relationship(back_populates="alert")


class AlertHistory(Base):
  __tablename__ = "alert_history"
  __table_args__ = (
    Index("ix_alert_history_created_at", "created_at"),
    Index("ix_alert_history_correlation_id", "correlation_id"),
    Index("ix_alert_history_request_id", "request_id"),
    Index("ix_alert_history_entity", "entity_type", "entity_id"),
    Index("ix_alert_history_actor", "actor_type", "actor_id", "actor_name"),
    Index("ix_alert_history_action_created", "action_type", "created_at"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  alert_id: Mapped[str] = mapped_column(ForeignKey("alerts.id"), nullable=False, index=True)
  action_type: Mapped[str] = mapped_column(String(60), nullable=False)
  previous_status: Mapped[str | None] = mapped_column(String(40))
  new_status: Mapped[str | None] = mapped_column(String(40))
  message: Mapped[str | None] = mapped_column(Text)
  operator_name: Mapped[str | None] = mapped_column(String(120))
  source: Mapped[str] = mapped_column(String(40), nullable=False, default="oneview")
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  actor_type: Mapped[str] = mapped_column(String(40), nullable=False, default="user")
  actor_id: Mapped[str | None] = mapped_column(String(120))
  actor_name: Mapped[str | None] = mapped_column(String(120))
  action_source: Mapped[str] = mapped_column(String(40), nullable=False, default="oneview")
  entity_type: Mapped[str] = mapped_column(String(40), nullable=False, default="alert")
  entity_id: Mapped[str] = mapped_column(String(36), nullable=False)
  before_data: Mapped[dict | None] = mapped_column(JSON)
  after_data: Mapped[dict | None] = mapped_column(JSON)
  metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

  alert: Mapped[Alert] = relationship(back_populates="history")


class AlertNote(Base):
  __tablename__ = "alert_notes"
  __table_args__ = (Index("ix_alert_notes_created_at", "created_at"),)

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  alert_id: Mapped[str] = mapped_column(ForeignKey("alerts.id"), nullable=False, index=True)
  message: Mapped[str] = mapped_column(Text, nullable=False)
  operator_name: Mapped[str | None] = mapped_column(String(120))
  source: Mapped[str] = mapped_column(String(40), nullable=False, default="oneview")
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  actor_type: Mapped[str] = mapped_column(String(40), nullable=False, default="user")
  actor_id: Mapped[str | None] = mapped_column(String(120))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

  alert: Mapped[Alert] = relationship(back_populates="notes")


class AlertAssignment(Base):
  __tablename__ = "alert_assignments"
  __table_args__ = (Index("ix_alert_assignments_assigned_at", "assigned_at"),)

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  alert_id: Mapped[str] = mapped_column(ForeignKey("alerts.id"), nullable=False, index=True)
  operator_name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="assigned", index=True)
  source: Mapped[str] = mapped_column(String(40), nullable=False, default="oneview")
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  actor_type: Mapped[str] = mapped_column(String(40), nullable=False, default="user")
  actor_id: Mapped[str | None] = mapped_column(String(120))
  assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

  alert: Mapped[Alert] = relationship(back_populates="assignments")


class AlertAcknowledgement(Base):
  __tablename__ = "alert_acknowledgements"
  __table_args__ = (
    Index("ix_alert_acknowledgements_status", "status"),
    Index("ix_alert_acknowledgements_data_source_id", "data_source_id"),
    Index("ix_alert_acknowledgements_requested_at", "requested_at"),
    Index("ix_alert_acknowledgements_idempotency_key", "idempotency_key"),
    CheckConstraint(
      "status in ('pending','processing','success','failed','cancelled')",
      name="ck_alert_acknowledgements_status",
    ),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  alert_id: Mapped[str] = mapped_column(ForeignKey("alerts.id"), nullable=False, index=True)
  data_source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"), nullable=False)
  acknowledgement_type: Mapped[str] = mapped_column(String(20), nullable=False, default="internal")
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
  source_event_id: Mapped[str | None] = mapped_column(String(80))
  message: Mapped[str | None] = mapped_column(Text)
  operator_name: Mapped[str | None] = mapped_column(String(120))
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  actor_type: Mapped[str] = mapped_column(String(40), nullable=False, default="user")
  actor_id: Mapped[str | None] = mapped_column(String(120))
  idempotency_key: Mapped[str | None] = mapped_column(String(255))
  attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  external_response: Mapped[dict | None] = mapped_column(JSON)
  result_payload: Mapped[dict | None] = mapped_column(JSON)
  last_error: Mapped[str | None] = mapped_column(Text)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

  alert: Mapped[Alert] = relationship(back_populates="acknowledgements")


class MaintenanceWindow(Base):
  __tablename__ = "maintenance_windows"
  __table_args__ = (
    Index("ix_maintenance_windows_window", "starts_at", "ends_at"),
    Index("ix_maintenance_windows_status", "status"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  data_source_id: Mapped[str | None] = mapped_column(ForeignKey("data_sources.id"), index=True)
  client_name: Mapped[str | None] = mapped_column(String(120))
  name: Mapped[str] = mapped_column(String(160), nullable=False)
  starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
  observation: Mapped[str | None] = mapped_column(Text)
  created_by: Mapped[str | None] = mapped_column(String(120))
  updated_by: Mapped[str | None] = mapped_column(String(120))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class SyncLog(Base):
  __tablename__ = "sync_logs"
  __table_args__ = (
    Index("ix_sync_logs_data_source_started", "data_source_id", "started_at"),
    Index("ix_sync_logs_status_started", "status", "started_at"),
    Index("ix_sync_logs_correlation_id", "correlation_id"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  data_source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"), nullable=False, index=True)
  status: Mapped[str] = mapped_column(String(20), nullable=False)
  sync_type: Mapped[str] = mapped_column(String(40), nullable=False, default="automatic")
  triggered_by: Mapped[str | None] = mapped_column(String(120))
  worker_id: Mapped[str | None] = mapped_column(String(120))
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
  started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  duration_ms: Mapped[int | None] = mapped_column(Integer)
  fetched_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  upserted_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  updated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  resolved_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  error: Mapped[str | None] = mapped_column(Text)
  technical_error: Mapped[str | None] = mapped_column(Text)
  error_code: Mapped[str | None] = mapped_column(String(80))
  payload: Mapped[dict | None] = mapped_column(JSON)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

  data_source: Mapped[DataSource] = relationship(back_populates="sync_logs")


class SyncError(Base):
  __tablename__ = "sync_errors"
  __table_args__ = (
    Index("ix_sync_errors_occurred_at", "occurred_at"),
    Index("ix_sync_errors_correlation_id", "correlation_id"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  sync_log_id: Mapped[str | None] = mapped_column(ForeignKey("sync_logs.id"), index=True)
  data_source_id: Mapped[str] = mapped_column(ForeignKey("data_sources.id"), nullable=False, index=True)
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  worker_id: Mapped[str | None] = mapped_column(String(120))
  error_type: Mapped[str] = mapped_column(String(80), nullable=False)
  message: Mapped[str] = mapped_column(Text, nullable=False)
  technical_error: Mapped[str | None] = mapped_column(Text)
  details: Mapped[dict | None] = mapped_column(JSON)
  occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class IntegrationOutbox(Base):
  __tablename__ = "integration_outbox"
  __table_args__ = (
    Index("ix_integration_outbox_status", "status"),
    Index("ix_integration_outbox_action_type", "action_type"),
    Index("ix_integration_outbox_available_at", "available_at"),
    Index("ix_integration_outbox_alert_id", "alert_id"),
    Index("ix_integration_outbox_data_source_id", "data_source_id"),
    Index("ix_integration_outbox_claim", "status", "next_attempt_at", "priority", "created_at"),
    Index("ix_integration_outbox_locked", "locked_at", "locked_by"),
    Index("ix_integration_outbox_idempotency_key", "idempotency_key", unique=True),
    Index("ix_integration_outbox_correlation_id", "correlation_id"),
    Index("ix_integration_outbox_lock_expires", "lock_expires_at"),
    CheckConstraint(
      "status in ('pending','processing','success','failed','cancelled')",
      name="ck_integration_outbox_status",
    ),
    CheckConstraint("attempts >= 0 and max_attempts >= 1 and attempts <= max_attempts", name="ck_integration_outbox_attempts"),
    CheckConstraint("priority >= 0", name="ck_integration_outbox_priority"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  aggregate_type: Mapped[str] = mapped_column(String(40), nullable=False)
  aggregate_id: Mapped[str] = mapped_column(String(36), nullable=False)
  data_source_id: Mapped[str | None] = mapped_column(ForeignKey("data_sources.id"))
  alert_id: Mapped[str | None] = mapped_column(ForeignKey("alerts.id"))
  action_type: Mapped[str] = mapped_column(String(60), nullable=False)
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
  priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
  payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
  result_payload: Mapped[dict | None] = mapped_column(JSON)
  attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
  available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  locked_by: Mapped[str | None] = mapped_column(String(120))
  lock_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_error: Mapped[str | None] = mapped_column(Text)
  idempotency_key: Mapped[str | None] = mapped_column(String(255))
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  created_by: Mapped[str | None] = mapped_column(String(120))
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class AuditLog(Base):
  __tablename__ = "audit_logs"
  __table_args__ = (
    Index("ix_audit_logs_action", "action"),
    Index("ix_audit_logs_entity", "entity_type", "entity_id"),
    Index("ix_audit_logs_alert_id", "alert_id"),
    Index("ix_audit_logs_data_source_id", "data_source_id"),
    Index("ix_audit_logs_created_at", "created_at"),
    Index("ix_audit_logs_correlation_id", "correlation_id"),
    Index("ix_audit_logs_request_id", "request_id"),
    Index("ix_audit_logs_actor", "actor_type", "actor_id", "actor_name"),
    Index("ix_audit_logs_action_created", "action", "created_at"),
  )

  id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
  actor_name: Mapped[str | None] = mapped_column(String(120))
  actor_type: Mapped[str] = mapped_column(String(40), nullable=False, default="user")
  actor_id: Mapped[str | None] = mapped_column(String(120))
  action: Mapped[str] = mapped_column(String(80), nullable=False)
  action_source: Mapped[str] = mapped_column(String(40), nullable=False, default="vercel_api")
  entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
  entity_id: Mapped[str] = mapped_column(String(36), nullable=False)
  data_source_id: Mapped[str | None] = mapped_column(ForeignKey("data_sources.id"))
  alert_id: Mapped[str | None] = mapped_column(ForeignKey("alerts.id"))
  correlation_id: Mapped[str | None] = mapped_column(String(80))
  request_id: Mapped[str | None] = mapped_column(String(80))
  before_data: Mapped[dict | None] = mapped_column(JSON)
  after_data: Mapped[dict | None] = mapped_column(JSON)
  metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)
  ip_address: Mapped[str | None] = mapped_column(String(80))
  user_agent: Mapped[str | None] = mapped_column(Text)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class WorkerHeartbeat(Base):
  __tablename__ = "worker_heartbeats"
  __table_args__ = (
    CheckConstraint("status in ('starting','running','idle','error','stopped')", name="ck_worker_heartbeats_status"),
    Index("ix_worker_heartbeats_status", "status"),
    Index("ix_worker_heartbeats_last_seen", "last_seen_at"),
  )

  worker_id: Mapped[str] = mapped_column(String(120), primary_key=True)
  status: Mapped[str] = mapped_column(String(20), nullable=False, default="running")
  hostname: Mapped[str | None] = mapped_column(String(255))
  process_id: Mapped[int | None] = mapped_column(Integer)
  version: Mapped[str | None] = mapped_column(String(80))
  started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  last_cycle_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  last_cycle_duration_ms: Mapped[int | None] = mapped_column(Integer)
  last_error: Mapped[str | None] = mapped_column(Text)
  metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)
  created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
  updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
