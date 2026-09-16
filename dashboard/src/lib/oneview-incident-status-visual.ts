export type IncidentStatusTone = "info" | "warning" | "success" | "neutral";

export type IncidentStatusVisual = {
  label: string;
  tone: IncidentStatusTone;
  className: string;
};

export const ONEVIEW_INCIDENT_STATUS_VISUAL: Record<string, IncidentStatusVisual> = {
  "1": {
    label: "Novo",
    tone: "info",
    className: "ov-status-incident-new",
  },
  "2": {
    label: "Em andamento",
    tone: "info",
    className: "ov-status-incident-progress",
  },
  "3": {
    label: "Em espera",
    tone: "warning",
    className: "ov-status-incident-waiting",
  },
  "6": {
    label: "Resolvido",
    tone: "success",
    className: "ov-status-incident-resolved",
  },
  "7": {
    label: "Fechado",
    tone: "neutral",
    className: "ov-status-incident-closed",
  },
  "8": {
    label: "Cancelado",
    tone: "neutral",
    className: "ov-status-incident-cancelled",
  },
};

const UNKNOWN_INCIDENT_STATUS: IncidentStatusVisual = {
  label: "Estado não informado",
  tone: "neutral",
  className: "border-border bg-muted text-muted-foreground",
};

export function oneViewIncidentStatusVisual(state: string | number | null | undefined, display?: string | null): IncidentStatusVisual {
  const key = String(state ?? "").trim();
  const known = ONEVIEW_INCIDENT_STATUS_VISUAL[key];
  if (known) return known;
  const label = String(display || key).trim();
  return label ? { ...UNKNOWN_INCIDENT_STATUS, label } : UNKNOWN_INCIDENT_STATUS;
}
