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
    className: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-400/40 dark:bg-sky-950/35 dark:text-sky-200",
  },
  "2": {
    label: "Em andamento",
    tone: "info",
    className: "border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-400/40 dark:bg-cyan-950/35 dark:text-cyan-200",
  },
  "3": {
    label: "Em espera",
    tone: "warning",
    className: "border-warning/40 bg-warning/10 text-amber-800 dark:text-amber-200",
  },
  "6": {
    label: "Resolvido",
    tone: "success",
    className: "border-success/40 bg-success/10 text-success",
  },
  "7": {
    label: "Fechado",
    tone: "neutral",
    className: "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/50 dark:bg-slate-900/60 dark:text-slate-200",
  },
  "8": {
    label: "Cancelado",
    tone: "neutral",
    className: "border-zinc-400 bg-zinc-100 text-zinc-800 dark:border-zinc-500/50 dark:bg-zinc-900/70 dark:text-zinc-200",
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
