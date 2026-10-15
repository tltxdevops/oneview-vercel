/**
 * OV-P0-307 — resumo operacional seguro para impressão/cópia no drawer de alerta.
 * Sem UUIDs internos, auditoria de identidade ou tags técnicas.
 */

import { buildAlertOperationalTimeline } from "./oneview-alert-timeline.ts";
import {
  extractServiceNowIncidentNumbersForAlertEpisode,
  extractServiceNowRefsFromAlertTags,
  filterOperationalAlertTags,
  SERVICENOW_PROD_BASE_URL,
} from "./oneview-inc-correlation.ts";
import { primaryPersistedOperatorTag } from "./oneview-operator-display.ts";
import { buildAlertRecurrenceSignal, formatRecurrenceWhen } from "./oneview-recurrence-signal.ts";
import type {
  AlertHistoryItem,
  AlertRelatedIncident,
  FetchAlertRelatedIncidentsParams,
  OneViewAlert,
} from "./oneview-api.ts";
import { sourceAckRowKind, sourceAckRowLabel } from "./oneview-alert-source-ack.ts";

const ORIGIN_UNAVAILABLE = "Indisponível na origem";
const UNKNOWN_CLIENT = "Cliente não identificado";
const MISSING_HOST = "Host não informado";
const PRINT_FOOTER = "Gerado pelo OneView — uso operacional interno";
const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";
const INCIDENT_NUMBER = /^INC\d+$/i;
const TERMINAL_INCIDENT_STATES = new Set([
  "6", "7", "8",
  "resolved", "closed", "cancelled", "canceled",
  "resolvido", "encerrado", "cancelado",
]);

const SEVERITY_LABELS: Record<string, string> = {
  "0": "Not classified",
  "1": "Information",
  "2": "Warning",
  "3": "Average",
  "4": "High",
  "5": "Disaster",
  not_classified: "Not classified",
  information: "Information",
  warning: "Warning",
  average: "Average",
  high: "High",
  critical: "High",
  disaster: "Disaster",
};

export type AlertOperationalShareDocument = {
  plainText: string;
  html: string;
};

export type AlertOperationalShareInput = {
  alert: OneViewAlert;
  historyItems?: AlertHistoryItem[];
  relatedIncidents?: AlertRelatedIncident[] | null;
  generatedAt?: Date;
  clientCommunication?: AlertClientCommunication | null;
};

export type AlertClientSeverityIcon = "🔴" | "🟠" | "🟡" | "🔵" | "⚪";

export type AlertClientCommunication = {
  statusIcon: AlertClientSeverityIcon;
  unitHost: string;
  problem: string;
  equipment: string;
  occurredAt: string;
  action: string;
  nextSteps: string;
  followUp: string;
  incidentNumber: string | null;
  messageType: "alert" | "resolved";
};

export type AlertClientCommunicationEdits = Partial<
  Pick<AlertClientCommunication, "action" | "nextSteps" | "followUp">
>;

type ShareLine = { label: string; value: string };

function text(value?: string | null, fallback = ORIGIN_UNAVAILABLE): string {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function formatDateTime(value?: string | null): string {
  if (!value) return ORIGIN_UNAVAILABLE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? ORIGIN_UNAVAILABLE : date.toLocaleString("pt-BR");
}

export function formatAlertClientDateTime(value?: string | null): string {
  if (!value) return ORIGIN_UNAVAILABLE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ORIGIN_UNAVAILABLE;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: OPERATIONAL_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")}/${part("month")}/${part("year")} - ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function alertClientSeverityIcon(severity?: string | null): AlertClientSeverityIcon {
  const value = String(severity || "").trim().toLowerCase();
  if (["disaster", "high", "critical", "5", "4"].includes(value)) return "🔴";
  if (["average", "3"].includes(value)) return "🟠";
  if (["warning", "2"].includes(value)) return "🟡";
  if (["information", "info", "1"].includes(value)) return "🔵";
  return "⚪";
}

function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Duração indisponível";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

function formatSeverity(value?: string | null): string {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return SEVERITY_LABELS[raw.toLowerCase()] || raw;
}

function isResolvedAlert(alert: OneViewAlert): boolean {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function isMissingHostLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized
    || normalized === "host protegido"
    || normalized === "host nao informado"
    || normalized === "host não informado"
    || normalized === "host nao identificado"
    || normalized === "host não identificado";
}

function clientLabel(alert: OneViewAlert): string {
  const name = String(alert.customer_name || "").trim();
  if (name && name.toLowerCase() !== "unclassified" && name.toLowerCase() !== "cliente não classificado") {
    return name;
  }
  const scopeLabel = String(alert.operational_scope_label || "").trim();
  if (scopeLabel) return scopeLabel;
  return UNKNOWN_CLIENT;
}

function hostVisible(alert: OneViewAlert): string {
  for (const candidate of [alert.host_visible_name, alert.host_name, alert.host_technical_name]) {
    const value = String(candidate || "").trim();
    if (value && !isMissingHostLabel(value)) return value;
  }
  return MISSING_HOST;
}

function hostTechnical(alert: OneViewAlert): string {
  const value = String(alert.host_technical_name || "").trim();
  if (!value || isMissingHostLabel(value)) return "Não informado";
  return value;
}

function safeHostIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || ["-", "[redacted]", "[ip_protegido]"].includes(candidate.toLowerCase())) return null;

  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return null;
    if (first === 100 && second >= 64 && second <= 127) return null;
    if (first === 169 && second === 254) return null;
    if (first === 172 && second >= 16 && second <= 31) return null;
    if (first === 192 && second === 168) return null;
    return candidate;
  }

  const normalizedIpv6 = candidate.toLowerCase();
  if (/^[0-9a-f:]+$/i.test(normalizedIpv6) && normalizedIpv6.includes(":")) {
    if (normalizedIpv6 === "::1" || normalizedIpv6.startsWith("fe8") || normalizedIpv6.startsWith("fe9")
      || normalizedIpv6.startsWith("fea") || normalizedIpv6.startsWith("feb")
      || normalizedIpv6.startsWith("fc") || normalizedIpv6.startsWith("fd")) return null;
    return candidate;
  }

  return null;
}

function interfaceFromAlertTags(alert: Pick<OneViewAlert, "event_tags" | "trigger_tags" | "host_tags">): string | null {
  const tags = [...(alert.event_tags ?? []), ...(alert.trigger_tags ?? []), ...(alert.host_tags ?? [])];
  for (const tag of tags) {
    const name = String(tag.tag || "").trim().toLowerCase();
    const value = String(tag.value || "").trim();
    if (!value) continue;
    if (name === "interface" || name === "if" || name === "ifname" || name === "net.if") return value;
  }
  return null;
}

function collectOperationalTags(alert: OneViewAlert): Array<{ tag: string; value: string }> {
  const extra = (alert as OneViewAlert & { template_tags?: OneViewAlert["event_tags"] }).template_tags;
  return filterOperationalAlertTags([
    ...(alert.event_tags ?? []),
    ...(alert.trigger_tags ?? []),
    ...(alert.host_tags ?? []),
    ...(extra ?? []),
  ]);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function incidentNumberLink(number?: string | null): string | null {
  const value = String(number || "").trim().toUpperCase();
  if (!/^INC\d+$/.test(value)) return null;
  return `${SERVICENOW_PROD_BASE_URL}/incident.do?sysparm_query=${encodeURIComponent(`number=${value}`)}`;
}

function displayIncidentValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const textValue = String(value ?? "").trim();
    if (textValue && textValue !== "—" && textValue.toLowerCase() !== "undefined") return textValue;
  }
  return ORIGIN_UNAVAILABLE;
}

export function buildAlertRelatedIncidentsFetchParams(
  alert: OneViewAlert,
  historyItems: AlertHistoryItem[] = [],
): FetchAlertRelatedIncidentsParams | null {
  const tagRefs = extractServiceNowRefsFromAlertTags(alert);
  const historyNumbers = extractServiceNowIncidentNumbersForAlertEpisode(historyItems, {
    sourceEventId: alert.source_event_id,
    episodeStartedAt: alert.first_seen_at,
  })
    .filter((number) => !tagRefs.numbers.includes(number));
  const sourceEventId = String(alert.source_event_id || "").trim();
  if (!sourceEventId && !tagRefs.sysIds.length && !tagRefs.numbers.length && !historyNumbers.length) {
    return null;
  }
  return {
    sourceEventId: sourceEventId || null,
    incidentNumbers: historyNumbers,
    tagIncidentNumbers: tagRefs.numbers,
    incidentSysIds: tagRefs.sysIds,
  };
}

function sectionPlain(title: string, lines: ShareLine[]): string {
  const body = lines.map((line) => `${line.label}: ${line.value}`).join("\n");
  return `${title}\n${body}`;
}

function sectionHtml(title: string, lines: ShareLine[]): string {
  const rows = lines
    .map((line) => `<div class="field"><dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.value)}</dd></div>`)
    .join("");
  return `<section><h2>${escapeHtml(title)}</h2><dl>${rows}</dl></section>`;
}

function uniqueIncidents(
  alert: OneViewAlert,
  relatedIncidents: AlertRelatedIncident[] | null | undefined,
): Array<{
  number: string;
  description: string;
  state: string;
  group: string;
  assignee: string;
  url: string | null;
}> {
  const out: Array<{
    number: string;
    description: string;
    state: string;
    group: string;
    assignee: string;
    url: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const item of relatedIncidents || []) {
    const number = displayIncidentValue(item.number);
    const key = number !== ORIGIN_UNAVAILABLE ? number : `row-${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      number,
      description: String(item.short_description || "").trim() || "Sem descrição",
      state: displayIncidentValue(item.state_display, item.state),
      group: displayIncidentValue(item.assignment_group_display, item.assignment_group),
      assignee: displayIncidentValue(item.assigned_to_display, item.assigned_to),
      url: incidentNumberLink(item.number),
    });
  }

  const projectedNumber = String(alert.servicenow_reference?.number || "").trim();
  if (projectedNumber && !seen.has(projectedNumber.toUpperCase()) && !seen.has(projectedNumber)) {
    out.push({
      number: projectedNumber,
      description: "Detalhe do chamado indisponível na origem",
      state: ORIGIN_UNAVAILABLE,
      group: ORIGIN_UNAVAILABLE,
      assignee: ORIGIN_UNAVAILABLE,
      url: incidentNumberLink(projectedNumber),
    });
  }

  return out;
}

function safeAnalystName(value?: string | null): string | null {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor) || /^[a-f0-9]{32}$/i.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor.slice(0, 120);
}

function canonicalCurrentIncident(
  alert: OneViewAlert,
  relatedIncidents: AlertRelatedIncident[] | null | undefined,
) {
  const valid = (relatedIncidents || []).filter((item) => {
    const number = String(item.number || "").trim();
    return !item.identity_conflict && INCIDENT_NUMBER.test(number);
  });
  const projectedNumber = String(alert.servicenow_reference?.number || "").trim().toUpperCase();
  const explicitMatch = projectedNumber
    ? valid.find((item) => String(item.number || "").trim().toUpperCase() === projectedNumber)
    : null;
  if (explicitMatch) return explicitMatch;
  return valid.length === 1 ? valid[0] : null;
}

function communicationField(value: string, maxLength: number): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isTerminalRelatedIncident(incident: AlertRelatedIncident | null | undefined): boolean {
  if (!incident) return true;
  const raw = String(incident.state || "").trim().toLowerCase();
  const display = String(incident.state_display || "").trim().toLowerCase();
  return TERMINAL_INCIDENT_STATES.has(raw) || TERMINAL_INCIDENT_STATES.has(display);
}

function canonicalAckActor(alert: OneViewAlert): string | null {
  const sourceAck = alert.source_ack;
  if (sourceAck) {
    if (!sourceAck.acknowledged) return null;
    return safeAnalystName(sourceAck.actor_name);
  }
  if (!alert.acknowledged_source) return null;
  return safeAnalystName(alert.acknowledged_source_by || alert.acknowledged_by);
}

export function resolveAlertClientFollowUp(
  alert: OneViewAlert,
  relatedIncidents: AlertRelatedIncident[] | null | undefined = null,
): string {
  const currentIncident = canonicalCurrentIncident(alert, relatedIncidents);
  if (currentIncident && !isTerminalRelatedIncident(currentIncident)) {
    const owner = safeAnalystName(currentIncident.assigned_to_display) || safeAnalystName(currentIncident.assigned_to);
    if (owner) return owner;
  }
  return canonicalAckActor(alert) || "Equipe NOC";
}

function formatClientEquipment(alert: OneViewAlert): string {
  const visibleHost = hostVisible(alert);
  const technicalHost = String(alert.host_technical_name || "").trim();
  const equipment = technicalHost && !isMissingHostLabel(technicalHost) ? technicalHost : visibleHost;
  const ip = safeHostIp(alert.host_ip);
  return ip ? `${equipment} (${ip})` : equipment;
}

export function buildAlertClientCommunication({
  alert,
  relatedIncidents = null,
}: AlertOperationalShareInput, edits: AlertClientCommunicationEdits = {}): AlertClientCommunication {
  const resolved = isResolvedAlert(alert);
  const currentIncident = canonicalCurrentIncident(alert, relatedIncidents);
  const incidentNumber = currentIncident ? String(currentIncident.number || "").trim().toUpperCase() : null;
  const visibleHost = hostVisible(alert);
  const defaultAction = resolved
    ? "Alarme normalizado."
    : incidentNumber
      ? `Aberto chamado ${incidentNumber} para acompanhamento de alerta.`
      : "Alerta em análise.";

  return {
    statusIcon: alertClientSeverityIcon(alert.severity),
    unitHost: visibleHost,
    problem: text(alert.problem_name || alert.trigger_description, "Alerta sem descrição"),
    equipment: formatClientEquipment(alert),
    occurredAt: formatAlertClientDateTime(alert.started_at || alert.first_seen_at),
    action: Object.prototype.hasOwnProperty.call(edits, "action") ? String(edits.action ?? "") : defaultAction,
    nextSteps: Object.prototype.hasOwnProperty.call(edits, "nextSteps")
      ? String(edits.nextSteps ?? "")
      : resolved ? "Acompanhamento concluído." : "Acompanhando alerta.",
    followUp: Object.prototype.hasOwnProperty.call(edits, "followUp")
      ? String(edits.followUp ?? "")
      : resolveAlertClientFollowUp(alert, relatedIncidents),
    incidentNumber,
    messageType: resolved ? "resolved" : "alert",
  };
}

export function isAlertClientCommunicationValid(value: AlertClientCommunication): boolean {
  return Boolean(
    communicationField(value.unitHost, 240)
    && communicationField(value.problem, 1_000)
    && communicationField(value.equipment, 240)
    && communicationField(value.occurredAt, 80)
    && communicationField(value.action, 240)
    && communicationField(value.nextSteps, 240)
    && communicationField(value.followUp, 120),
  );
}

export function formatAlertClientCommunication(value: AlertClientCommunication): string {
  return [
    `${value.statusIcon} ${communicationField(value.unitHost, 240)} - ${communicationField(value.problem, 1_000)}`,
    `📟 Equipamento: ${communicationField(value.equipment, 240)}`,
    `📅 Data/Hora: ${communicationField(value.occurredAt, 80)}`,
    `🛠️ Ação: ${communicationField(value.action, 240)}`,
    `🔄 Próximos Passos: ${communicationField(value.nextSteps, 240)}`,
    `🔎 Acompanhamento: ${communicationField(value.followUp, 120)}`,
  ].join("\n");
}

export function buildAlertOperationalShareDocument({
  alert,
  historyItems = [],
  relatedIncidents = null,
  generatedAt = new Date(),
}: AlertOperationalShareInput): AlertOperationalShareDocument {
  const resolved = isResolvedAlert(alert);
  const publicIp = safeHostIp(alert.host_ip);
  const iface = interfaceFromAlertTags(alert);
  const operatorTag = primaryPersistedOperatorTag(alert);
  const tags = collectOperationalTags(alert);
  const recurrence = buildAlertRecurrenceSignal(alert);
  const previous = alert.recurrence_previous;
  const timeline = buildAlertOperationalTimeline(alert, historyItems);
  const incidents = uniqueIncidents(alert, relatedIncidents);
  const generatedLabel = generatedAt.toLocaleString("pt-BR");

  const headerLines: ShareLine[] = [
    { label: "Gerado em", value: generatedLabel },
    { label: "Cliente", value: clientLabel(alert) },
    { label: "Host", value: hostVisible(alert) },
    { label: "Host técnico", value: hostTechnical(alert) },
    { label: "Trigger/Problema", value: text(alert.problem_name || alert.trigger_description, "Alerta sem descrição") },
    { label: "Severidade", value: formatSeverity(alert.severity) },
    { label: "Estado", value: resolved ? "Resolvido" : "Ativo" },
    { label: "ACK origem", value: sourceAckRowLabel(sourceAckRowKind(alert)) },
    { label: "ACK OneView", value: alert.acknowledged_internal ? "Reconhecido" : "Não reconhecido" },
  ];

  const timeLines: ShareLine[] = [
    { label: "Primeira ocorrência", value: formatDateTime(alert.first_seen_at) },
    { label: "Última ocorrência", value: formatDateTime(alert.last_seen_at) },
    { label: "Recuperação", value: formatDateTime(alert.resolved_at) },
    { label: "Duração", value: formatDurationSeconds(alert.duration_seconds) },
  ];

  const recurrenceLines: ShareLine[] = [];
  if (recurrence) {
    recurrenceLines.push(
      { label: "Sinal", value: recurrence.headline },
      { label: "Ocorrências 24 h", value: String(Number(alert.recurrence_count_24h || 0)) },
      { label: "Ocorrências 7 d", value: String(Number(alert.recurrence_count_7d || 0)) },
    );
    const previousOccurrence = formatRecurrenceWhen(recurrence.previous_occurrence_at || previous?.occurrence_at);
    const previousRecovery = formatRecurrenceWhen(recurrence.previous_recovery_at || previous?.recovery_at);
    if (previousOccurrence) recurrenceLines.push({ label: "Última ocorrência anterior", value: previousOccurrence });
    if (previousRecovery) recurrenceLines.push({ label: "Última recuperação", value: previousRecovery });
  } else if (Number(alert.recurrence_count_7d || 0) > 0 || Number(alert.recurrence_count_24h || 0) > 0) {
    recurrenceLines.push(
      { label: "Ocorrências 24 h", value: String(Number(alert.recurrence_count_24h || 0)) },
      { label: "Ocorrências 7 d", value: String(Number(alert.recurrence_count_7d || 0)) },
    );
  }
  if (previous?.duration_seconds != null) {
    recurrenceLines.push({ label: "Duração do episódio anterior", value: formatDurationSeconds(previous.duration_seconds) });
  }
  if (previous?.incident?.number) {
    recurrenceLines.push({ label: "INC do episódio anterior", value: previous.incident.number });
  }

  const contextLines: ShareLine[] = [];
  if (operatorTag) {
    contextLines.push({ label: "Operadora", value: operatorTag.value || operatorTag.tag });
  }
  if (publicIp) contextLines.push({ label: "IP", value: publicIp });
  if (iface) contextLines.push({ label: "Interface", value: iface });
  if (tags.length) {
    contextLines.push({
      label: "Tags operacionais",
      value: tags.map((tag) => (tag.value ? `${tag.tag}: ${tag.value}` : tag.tag)).join(" · "),
    });
  }

  const incidentBlocks = incidents.length
    ? incidents.map((item) => {
      const lines: ShareLine[] = [
        { label: "Número", value: item.number },
        { label: "Descrição", value: item.description },
        { label: "Estado", value: item.state },
        { label: "Grupo", value: item.group },
        { label: "Responsável", value: item.assignee },
      ];
      if (item.url) lines.push({ label: "ServiceNow", value: item.url });
      return lines;
    })
    : [[{ label: "Chamado", value: "Nenhum chamado correlacionado" }]];

  const historyLines = timeline.length
    ? timeline.map((item) => {
      const parts = [item.label, formatDateTime(item.occurred_at)];
      if (item.description) parts.push(item.description);
      if (item.comment) parts.push(`Comentário: ${item.comment}`);
      if (item.actor) parts.push(`por ${item.actor}`);
      if (item.incident_number) parts.push(item.incident_number);
      return parts.filter(Boolean).join(" · ");
    })
    : ["Nenhum evento de histórico disponível para este alerta."];

  const plainParts = [
    "Resumo operacional OneView",
    sectionPlain("Identidade", headerLines),
    sectionPlain("Tempos", timeLines),
  ];
  if (recurrenceLines.length) plainParts.push(sectionPlain("Recorrência", recurrenceLines));
  plainParts.push(
    incidentBlocks.map((lines, index) => sectionPlain(incidents.length > 1 ? `Chamado ${index + 1}` : "Chamados", lines)).join("\n\n"),
    `Histórico\n${historyLines.map((line) => `- ${line}`).join("\n")}`,
  );
  if (contextLines.length) plainParts.push(sectionPlain("Contexto", contextLines));
  plainParts.push(PRINT_FOOTER);

  const htmlSections = [
    sectionHtml("Identidade", headerLines),
    sectionHtml("Tempos", timeLines),
  ];
  if (recurrenceLines.length) htmlSections.push(sectionHtml("Recorrência", recurrenceLines));
  htmlSections.push(
    ...incidentBlocks.map((lines, index) => sectionHtml(incidents.length > 1 ? `Chamado ${index + 1}` : "Chamados", lines)),
    `<section><h2>Histórico</h2><ol>${historyLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ol></section>`,
  );
  if (contextLines.length) htmlSections.push(sectionHtml("Contexto", contextLines));

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>Resumo operacional OneView</title>
  <style>
    body { font-family: Segoe UI, system-ui, sans-serif; color: #111; margin: 24px; line-height: 1.4; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    h2 { font-size: 14px; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: .04em; }
    .meta { color: #444; font-size: 12px; margin-bottom: 16px; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
    .field dt { font-size: 11px; color: #555; }
    .field dd { margin: 2px 0 0; font-weight: 600; word-break: break-word; }
    ol { padding-left: 18px; margin: 0; }
    li { margin: 6px 0; }
    footer { margin-top: 28px; font-size: 11px; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
    @media print {
      body { margin: 12mm; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  <h1>Resumo operacional OneView</h1>
  <p class="meta">${escapeHtml(generatedLabel)}</p>
  ${htmlSections.join("\n")}
  <footer>${escapeHtml(PRINT_FOOTER)}</footer>
  <script>
    window.addEventListener("load", function () {
      window.focus();
      window.print();
    });
  </script>
</body>
</html>`;

  return {
    plainText: plainParts.join("\n\n"),
    html,
  };
}

/** Texto curto para colar em Teams/e-mail/Webex — sem rodapé interno, tags ou histórico longo. */
export function buildAlertClientSharePlainText({
  alert,
  relatedIncidents = null,
  clientCommunication = null,
}: AlertOperationalShareInput): string {
  return formatAlertClientCommunication(
    clientCommunication || buildAlertClientCommunication({ alert, relatedIncidents }),
  );
}

function printViaHiddenIframe(html: string): boolean {
  if (typeof document === "undefined") return false;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return false;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const cleanup = () => window.setTimeout(() => frame.remove(), 1_000);
  win.addEventListener("afterprint", cleanup);
  try {
    win.focus();
    win.print();
  } catch {
    frame.remove();
    return false;
  }
  return true;
}

export function openAlertOperationalSharePrint(html: string, target?: Window | null): boolean {
  if (typeof window === "undefined") return false;
  const popup = target && !target.closed ? target : window.open("", "_blank");
  if (popup) {
    try {
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      popup.focus();
      const printNow = () => {
        try { popup.print(); } catch { /* diálogo de impressão pode ser bloqueado sem falhar o documento */ }
      };
      if (popup.document.readyState === "complete") printNow();
      else popup.addEventListener("load", printNow);
      return true;
    } catch {
      try { popup.close(); } catch { /* ignore */ }
    }
  }
  return printViaHiddenIframe(html);
}
