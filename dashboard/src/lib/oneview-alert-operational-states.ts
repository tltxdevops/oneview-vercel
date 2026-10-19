import type { AlertRelatedIncident, OneViewAlert } from "./oneview-api";
import { problemIsResolved } from "./oneview-api";
import { oneViewIncidentStatusVisual } from "./oneview-incident-status-visual";

const CLOSED_INCIDENT_STATES = new Set(["6", "7", "8"]);
const OPEN_INCIDENT_STATES = new Set(["1", "2", "3"]);

export type AlertOperationalDivergence =
  | "incident_closed_alert_active"
  | "incident_open_alert_recovered"
  | "recovery_pending_reconciliation";

export type AlertOperationalDivergenceView = {
  kind: AlertOperationalDivergence;
  message: string;
};

export function zabbixAlertOperationalStateLabel(alert: Pick<
  OneViewAlert,
  | "status_source"
  | "resolved_at"
  | "acknowledged_source"
  | "suppression"
  | "operational_queue"
>): string {
  if (problemIsResolved(alert)) return "Recuperado";
  if (alert.operational_queue === "suppressed" || alert.suppression?.state === "active") return "Suprimido";
  if (alert.acknowledged_source) return "Reconhecido";
  const source = String(alert.status_source || "").trim().toLowerCase();
  if (source === "active") return "Ativo";
  if (source) return source;
  return "Indisponível";
}

export function servicenowIncidentStateLabel(incident?: Pick<AlertRelatedIncident, "state" | "state_display"> | null) {
  if (!incident) return null;
  return oneViewIncidentStatusVisual(incident.state, incident.state_display).label;
}

function incidentIsClosed(state?: string | null) {
  return CLOSED_INCIDENT_STATES.has(String(state || "").trim());
}

function incidentIsOpen(state?: string | null) {
  return OPEN_INCIDENT_STATES.has(String(state || "").trim());
}

function provenZabbixRecovery(alert: Pick<OneViewAlert, "source_recovery_event_id" | "recovery_evidence">) {
  const recoveryId = String(alert.source_recovery_event_id || "").trim();
  if (!recoveryId || /^0+$/.test(recoveryId)) return false;
  return alert.recovery_evidence === "proven";
}

export function describeAlertOperationalDivergences(
  alert: OneViewAlert,
  incident?: Pick<AlertRelatedIncident, "state" | "number"> | null,
): AlertOperationalDivergenceView[] {
  const items: AlertOperationalDivergenceView[] = [];
  const alertActive = !problemIsResolved(alert);
  const alertRecovered = problemIsResolved(alert);

  if (incident?.state && alertActive && incidentIsClosed(incident.state)) {
    items.push({
      kind: "incident_closed_alert_active",
      message: `Chamado ${incident.number || ""} encerrado no ServiceNow, mas o alerta Zabbix segue ativo na origem.`,
    });
  }

  if (incident?.state && alertRecovered && incidentIsOpen(incident.state)) {
    items.push({
      kind: "incident_open_alert_recovered",
      message: `Alerta recuperado no Zabbix, mas o chamado ${incident.number || ""} permanece aberto no ServiceNow.`,
    });
  }

  if (provenZabbixRecovery(alert) && alertActive) {
    const datasource = String(alert.datasource_name || "fonte").trim();
    const eventId = String(alert.source_event_id || alert.id || "").trim();
    items.push({
      kind: "recovery_pending_reconciliation",
      message: `Recovery confirmado no Zabbix (${datasource} · event ${eventId}), pendente de reconciliação no banco — sem alteração automática.`,
    });
  }

  return items;
}
