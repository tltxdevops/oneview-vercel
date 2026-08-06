import type { FetchAlertsParams, OneViewSeverity } from "@/lib/oneview-api";

/** OV-P0-34: presets de risco da aba Alertas do Histórico. */
export const HISTORY_RISK_PRESETS = [
  { value: "all", label: "Todos" },
  { value: "current", label: "Riscos atuais" },
  { value: "current_ack", label: "Riscos atuais com ACK" },
  { value: "closed_ack", label: "Riscos encerrados com ACK" },
  { value: "no_ack", label: "Sem ACK" },
] as const;

export type HistoryRiskPreset = (typeof HISTORY_RISK_PRESETS)[number]["value"];

export const RISK_SEVERITIES: OneViewSeverity[] = ["disaster", "high"];

export function isRiskSummaryPreset(preset: HistoryRiskPreset) {
  return preset === "current" || preset === "current_ack" || preset === "closed_ack";
}

export function applyHistoryRiskPreset(
  params: FetchAlertsParams,
  preset: HistoryRiskPreset,
): FetchAlertsParams {
  if (preset === "all") return params;
  if (preset === "no_ack") {
    return {
      ...params,
      acknowledgedSource: false,
    };
  }
  if (preset === "current") {
    return {
      ...params,
      status: "active",
      severities: [...RISK_SEVERITIES],
      sort: "severity",
      order: "desc",
      sortSecondary: "duration",
    };
  }
  if (preset === "current_ack") {
    return {
      ...params,
      status: "active",
      severities: [...RISK_SEVERITIES],
      acknowledgedSource: true,
      sort: "severity",
      order: "desc",
      sortSecondary: "duration",
    };
  }
  return {
    ...params,
    status: "resolved",
    severities: [...RISK_SEVERITIES],
    acknowledgedSource: true,
    sort: "severity",
    order: "desc",
    sortSecondary: "resolved_at",
  };
}

/** Tempo até ACK = acknowledged_at - first_seen_at; só com ambos válidos. */
export function timeToAckSeconds(alert: {
  first_seen_at?: string | null;
  acknowledged_at?: string | null;
  acknowledged_source_at?: string | null;
}): number | null {
  const firstRaw = alert.first_seen_at;
  const ackRaw = alert.acknowledged_source_at || alert.acknowledged_at;
  if (!firstRaw || !ackRaw) return null;
  const firstMs = Date.parse(firstRaw);
  const ackMs = Date.parse(ackRaw);
  if (!Number.isFinite(firstMs) || !Number.isFinite(ackMs)) return null;
  return Math.max(0, Math.floor((ackMs - firstMs) / 1000));
}
