/**
 * OV-P0-308 — modelo e builders do artefato visual de alerta (PNG).
 */
import {
  formatDurationSeconds,
  formatOneViewSeverityLabel,
  type CanonicalLink,
  type CanonicalLinkAlert,
  type CanonicalLinkIncident,
  type IncidentRelatedAlert,
  type OneViewAlert,
  type OneViewIncident,
} from "@/lib/oneview-api";
import { operationalClientLabel } from "@/components/oneview/ClientIdentity";

export type AlertArtifactModel = {
  customerName: string;
  hostName: string;
  problemName: string;
  severity: string;
  severityLabel: string;
  stateLabel: string;
  startedAtLabel: string;
  durationLabel: string;
  incidentNumber: string | null;
  assignmentGroup: string | null;
  assignee: string | null;
  generatedAtLabel: string;
  brandLabel: string;
};

function formatWhen(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function elapsedFromStarted(startedAt?: string | null): string {
  if (!startedAt) return "Duração indisponível";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "Duração indisponível";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return formatDurationSeconds(seconds);
}

export function buildAlertArtifactFromOneViewAlert(
  alert: OneViewAlert,
  incident?: Partial<Pick<CanonicalLinkIncident, "number" | "assignment_group_display" | "assignment_group" | "assigned_to_display" | "assigned_to">> | null,
  generatedAt: Date = new Date(),
): AlertArtifactModel {
  const resolved = Boolean(alert.resolved_at);
  return {
    customerName: operationalClientLabel({
      key: alert.customer_key,
      name: alert.customer_name,
      operational_scope: alert.operational_scope,
      operational_scope_label: alert.operational_scope_label,
    }),
    hostName: String(alert.host_visible_name || alert.host_name || alert.host_technical_name || "Host não informado").trim(),
    problemName: String(alert.problem_name || alert.trigger_description || "Alerta sem descrição").trim(),
    severity: String(alert.severity || "not_classified"),
    severityLabel: formatOneViewSeverityLabel(alert.severity),
    stateLabel: resolved ? "Resolvido" : "Ativo",
    startedAtLabel: formatWhen(alert.first_seen_at || alert.started_at),
    durationLabel: formatDurationSeconds(alert.duration_seconds) !== "Duração indisponível"
      ? formatDurationSeconds(alert.duration_seconds)
      : elapsedFromStarted(alert.first_seen_at || alert.started_at),
    incidentNumber: incident?.number || alert.servicenow_reference?.number || null,
    assignmentGroup: incident?.assignment_group_display || incident?.assignment_group || null,
    assignee: incident?.assigned_to_display || incident?.assigned_to || null,
    generatedAtLabel: generatedAt.toLocaleString("pt-BR"),
    brandLabel: "OneView · Resumo operacional",
  };
}

export function buildAlertArtifactFromIncidentRelatedAlert(
  related: IncidentRelatedAlert,
  incident: Partial<
    Pick<
      OneViewIncident,
      | "number"
      | "assignment_group_display"
      | "assignment_group"
      | "assigned_to_display"
      | "assigned_to"
    >
  >,
  generatedAt: Date = new Date(),
): AlertArtifactModel {
  const resolved = String(related.status || "").trim().toLowerCase() === "resolved";
  return {
    customerName: String(related.customer || "Cliente não identificado").trim(),
    hostName: String(related.host || "Host não informado").trim(),
    problemName: String(related.problem || "Alerta sem descrição").trim(),
    severity: String(related.severity || "not_classified"),
    severityLabel: formatOneViewSeverityLabel(related.severity),
    stateLabel: resolved ? "Resolvido" : "Ativo",
    startedAtLabel: formatWhen(related.first_seen_at || related.created_at),
    durationLabel: elapsedFromStarted(related.first_seen_at || related.created_at),
    incidentNumber: incident.number,
    assignmentGroup: incident.assignment_group_display || incident.assignment_group,
    assignee: incident.assigned_to_display || incident.assigned_to,
    generatedAtLabel: generatedAt.toLocaleString("pt-BR"),
    brandLabel: "OneView · Resumo operacional",
  };
}

export function buildAlertArtifactFromCanonicalLink(
  link: Pick<CanonicalLink, "customer_name" | "host_name" | "active_alerts" | "active_since_at">,
  alert: CanonicalLinkAlert,
  incident: Pick<CanonicalLinkIncident, "number" | "assignment_group_display" | "assignment_group" | "assigned_to_display" | "assigned_to">,
  generatedAt: Date = new Date(),
): AlertArtifactModel {
  const failing = Number(link.active_alerts || 0) > 0;
  return {
    customerName: String(link.customer_name || "Cliente não identificado").trim(),
    hostName: String(link.host_name || "Host não informado").trim(),
    problemName: String(alert.problem_name || alert.trigger_description || "Alerta sem descrição").trim(),
    severity: String(alert.severity || "not_classified"),
    severityLabel: formatOneViewSeverityLabel(alert.severity),
    stateLabel: failing ? "Em falha" : "Normalizado",
    startedAtLabel: formatWhen(alert.started_at || link.active_since_at),
    durationLabel: failing ? elapsedFromStarted(alert.started_at || link.active_since_at) : "—",
    incidentNumber: incident.number,
    assignmentGroup: incident.assignment_group_display || incident.assignment_group,
    assignee: incident.assigned_to_display || incident.assigned_to,
    generatedAtLabel: generatedAt.toLocaleString("pt-BR"),
    brandLabel: "OneView · Resumo operacional",
  };
}

export function defaultAlertAttachmentFileName(incidentNumber?: string | null): string {
  const number = String(incidentNumber || "incident").replace(/[^a-z0-9]+/gi, "").slice(0, 32) || "incident";
  return `oneview-alerta-${number.toLowerCase()}.png`;
}
