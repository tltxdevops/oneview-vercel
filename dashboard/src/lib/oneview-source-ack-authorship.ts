import type { OneViewAlert } from "@/lib/oneview-api";

export type SourceAckAuthorshipView = {
  recognizedBy: string;
  username: string | null;
  acknowledgedAt: string | null;
  originLabel: string;
  acknowledgeId: string | null;
  zabbixUserId: string | null;
  oneViewInitiatedBy: string | null;
  technicalAccount: boolean;
  authorUnresolved: boolean;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function sourceAckOriginLabel(origin: string | null | undefined): string {
  const normalized = text(origin).toLowerCase();
  if (normalized === "oneview") return "OneView";
  if (normalized === "zabbix") return "Zabbix";
  return "Origem";
}

export function buildSourceAckAuthorshipView(alert: OneViewAlert | null | undefined): SourceAckAuthorshipView | null {
  if (!alert?.acknowledged_source && !alert?.source_ack?.acknowledged) return null;
  const source = alert.source_ack;
  const recognizedBy = text(source?.actor_name) || "Autor não identificado";
  const origin = sourceAckOriginLabel(source?.origin);
  return {
    recognizedBy,
    username: source?.author_username ?? null,
    acknowledgedAt: source?.acknowledged_at || alert.acknowledged_source_at || alert.acknowledged_at || null,
    originLabel: origin,
    acknowledgeId: source?.acknowledge_id ?? null,
    zabbixUserId: source?.zabbix_userid ?? null,
    oneViewInitiatedBy: source?.oneview_initiated_by ?? alert.oneview_ack?.actor_name ?? null,
    technicalAccount: Boolean(source?.technical_account),
    authorUnresolved: Boolean(source?.author_unresolved),
  };
}

export function formatSourceAckAuthorshipSummary(view: SourceAckAuthorshipView | null): string | null {
  if (!view) return null;
  const parts = [view.recognizedBy];
  if (view.technicalAccount && view.username) parts.push(`(${view.username})`);
  return parts.join(" ");
}
