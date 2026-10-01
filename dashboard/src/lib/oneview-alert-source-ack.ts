import type { OneViewAlert } from "@/lib/oneview-api";

export type AlertSourceAckPhase = "idle" | "confirming" | "submitting" | "success" | "error";
export type AlertSourceAckVisualState = "pending" | "acknowledged" | "resolved";

export function isSourceResolvedAlert(alert: OneViewAlert | null | undefined): boolean {
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
  return sourceAckVisualState(alert) === "pending";
}
