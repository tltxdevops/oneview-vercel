import type { AlertsAckFilter } from "./alerts-query";

export type OperationalQueueTab = "pending" | "acknowledged" | "suppressed" | "history" | "unconfirmed";

const QUEUE_ACK_TABS = new Set<OperationalQueueTab>(["pending", "acknowledged"]);

export function operationalSourceAckConflictsQueue(
  view: string | undefined | null,
  filter: AlertsAckFilter,
): boolean {
  if (!view || !QUEUE_ACK_TABS.has(view as OperationalQueueTab)) return false;
  if (view === "pending" && filter === "acknowledged") return true;
  if (view === "acknowledged" && filter === "unacknowledged") return true;
  return false;
}

export function effectiveOperationalSourceAckParam(
  view: string | undefined | null,
  filter: AlertsAckFilter,
): boolean | undefined {
  if (filter === "all") return undefined;
  const wantsAck = filter === "acknowledged";
  if (operationalSourceAckConflictsQueue(view, filter)) return undefined;
  if (view === "pending" && !wantsAck) return undefined;
  if (view === "acknowledged" && wantsAck) return undefined;
  return wantsAck;
}

export function reconcileSourceAckFilterForQueue(
  view: OperationalQueueTab,
  filter: AlertsAckFilter,
): { filter: AlertsAckFilter; adjusted: boolean; message: string | null } {
  if (filter === "all") return { filter, adjusted: false, message: null };
  if (view === "pending" && filter === "acknowledged") {
    return {
      filter: "all",
      adjusted: true,
      message: "Filtro “Com ACK” removido: Pendentes já lista alertas sem ACK na origem.",
    };
  }
  if (view === "acknowledged" && filter === "unacknowledged") {
    return {
      filter: "all",
      adjusted: true,
      message: "Filtro “Sem ACK” removido: Acompanhamento já lista alertas reconhecidos na origem.",
    };
  }
  return { filter, adjusted: false, message: null };
}
