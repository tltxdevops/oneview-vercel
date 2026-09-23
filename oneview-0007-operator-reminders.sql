BEGIN;

-- Running upgrade 0006_theo_automation_state -> 0007_operator_reminders

CREATE TABLE operator_reminders (
    id UUID DEFAULT gen_random_uuid() NOT NULL, 
    circuit_key TEXT NOT NULL, 
    data_source_id VARCHAR(36) NOT NULL, 
    source_host_id TEXT, 
    scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL, 
    status TEXT DEFAULT 'scheduled' NOT NULL, 
    created_by TEXT NOT NULL, 
    created_by_name TEXT, 
    initial_alert_id VARCHAR(36), 
    initial_incident_sys_id TEXT, 
    initial_incident_number TEXT, 
    context_snapshot JSONB DEFAULT '{}'::jsonb NOT NULL, 
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
    sent_at TIMESTAMP WITH TIME ZONE, 
    cancelled_at TIMESTAMP WITH TIME ZONE, 
    skipped_at TIMESTAMP WITH TIME ZONE, 
    skip_reason TEXT, 
    last_error TEXT, 
    PRIMARY KEY (id), 
    CONSTRAINT ck_operator_reminders_status CHECK (status in ('scheduled','processing','sent','cancelled','skipped','failed')), 
    FOREIGN KEY(data_source_id) REFERENCES data_sources (id)
);

CREATE INDEX ix_operator_reminders_status_scheduled_for ON operator_reminders (status, scheduled_for);

CREATE INDEX ix_operator_reminders_data_source_circuit_key ON operator_reminders (data_source_id, circuit_key);

CREATE UNIQUE INDEX uq_operator_reminders_active_data_source_circuit ON operator_reminders (data_source_id, circuit_key) WHERE status in ('scheduled','processing');

ALTER TABLE public.operator_reminders OWNER TO oneview_owner;

REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM PUBLIC;

REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_worker;

REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_app;

REVOKE ALL PRIVILEGES ON TABLE public.operator_reminders FROM oneview_actions;

GRANT SELECT, INSERT, UPDATE ON TABLE public.operator_reminders TO oneview_app;

GRANT SELECT, INSERT, UPDATE ON TABLE public.operator_reminders TO oneview_actions;

UPDATE alembic_version SET version_num='0007_operator_reminders' WHERE alembic_version.version_num = '0006_theo_automation_state';

COMMIT;

