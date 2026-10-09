import type { OneViewAlert } from "@/lib/oneview-api";

export type AlertSourceAckPhase = "idle" | "confirming" | "submitting" | "success" | "error";
export type AlertSourceAckVisualState = "pending" | "acknowledged" | "resolved";
export type SourceAckRowKind = "acknowledged" | "pending" | "none";
export type SourceAckTerminalStatus = "confirmed" | "failed" | "cancelled";
export type OneViewAckStatus = "none" | "pending" | "processing" | "success" | "cancelled" | "failed";

export function oneViewAckStatusLabel(status: OneViewAckStatus | string | null | undefined): string {
  if (["pending", "processing"].includes(String(status))) return "Pendente";
  if (status === "success") return "Reconhecido";
  if (status === "cancelled") return "Cancelado";
  if (status === "failed") return "Falhou";
  return "NÃ£o reconhecido";
}

export function sourceAckIsPending(alert: OneViewAlert | null | undefined): boolean {
  return !alert?.acknowledged_source && ["pending", "processing"].includes(String(alert?.source_ack_status || ""));
}

export function sourceAckTerminalStatus(alert: OneViewAlert | null | undefined): SourceAckTerminalStatus | null {
  if (alert?.acknowledged_source) return "confirmed";
  const status = String(alert?.source_ack_status || "");
  if (status === "failed" || status === "cancelled") return status;
  return null;
}

export function sourceAckTerminalMessage(status: SourceAckTerminalStatus): string {
  if (status === "confirmed") return "Reconhecido";
  if (status === "cancelled") return "Reconhecimento cancelado: o alerta foi resolvido antes da confirmação na origem.";
  return "O reconhecimento no Zabbix não foi concluído.";
}

export type SourceAckRowAlert = {
  acknowledged_source?: boolean;
  status_source?: string | null;
  status_internal?: string | null;
  resolved_at?: string | null;
  source_ack?: { acknowledged?: boolean } | null;
};

export function isSourceResolvedAlert(alert: SourceAckRowAlert | null | undefined): boolean {
  if (!alert) return false;
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

export function sourceAckActorName(alert: OneViewAlert | null | undefined): string | null {
  const candidates = [
    alert?.source_ack?.actor_name,
    alert?.acknowledged_source_by,
    alert?.acknowledged_by,
  ];
  for (const value of candidates) {
    const actor = String(value || "").trim();
    if (!actor || /^\d+$/.test(actor)) continue;
    if (/worker|oneview|sistema|system|reconcil/i.test(actor)) continue;
    return actor;
  }
  return null;
}

export function sourceAckVisualState(alert: OneViewAlert | null | undefined): AlertSourceAckVisualState {
  if (!alert) return "pending";
  if (isSourceResolvedAlert(alert)) return "resolved";
  if (alert.source_ack) return alert.source_ack.acknowledged ? "acknowledged" : "pending";
  if (alert.acknowledged_source) return "acknowledged";
  return "pending";
}

/** Origin ACK column: never "Pendente" for a resolved alert. OneView ACK stays separate. */
export function sourceAckRowKind(alert: SourceAckRowAlert | null | undefined): SourceAckRowKind {
  if (!alert) return "none";
  if (alert.acknowledged_source || alert.source_ack?.acknowledged) return "acknowledged";
  if (isSourceResolvedAlert(alert)) return "none";
  return "pending";
}

export function sourceAckRowLabel(kind: SourceAckRowKind): string {
  if (kind === "acknowledged") return "Reconhecido";
  if (kind === "pending") return "Pendente";
  return "Sem ACK";
}

export function sourceAckRowBadgeStatus(
  kind: SourceAckRowKind,
): "incident-resolved" | "incident-waiting" | "incident-closed" {
  if (kind === "acknowledged") return "incident-resolved";
  if (kind === "pending") return "incident-waiting";
  return "incident-closed";
}

export function sourceAckRowTone(kind: SourceAckRowKind): "success" | "warning" | "neutral" {
  if (kind === "acknowledged") return "success";
  if (kind === "pending") return "warning";
  return "neutral";
}

export function sourceAckTooltip(alert: OneViewAlert | null | undefined): string {
  const state = sourceAckVisualState(alert);
  if (state === "resolved") return "Alerta já resolvido";
  if (state === "acknowledged") {
    const actor = sourceAckActorName(alert);
    return actor ? `Reconhecido por ${actor}` : "Reconhecido por origem";
  }
  return "Reconhecer no Zabbix";
}

export function sourceAckCanOpen(alert: OneViewAlert | null | undefined): boolean {
  return sourceAckVisualState(alert) === "pending" && !sourceAckIsPending(alert);
}
