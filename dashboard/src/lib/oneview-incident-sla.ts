import type { OneViewIncidentSlaSummary } from "@/lib/oneview-api";

function compactDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(Math.abs(milliseconds) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remaining = minutes % 60;
  if (days) return `${days} d${hours ? ` ${hours} h` : ""}`;
  if (hours) return `${hours} h${remaining ? ` ${remaining} min` : ""}`;
  return `${remaining} min`;
}

export function incidentSlaLabel(sla?: OneViewIncidentSlaSummary | null, now = Date.now()) {
  if (!sla || sla.availability === "missing") return "SLA indisponível";
  if (sla.availability === "disabled") return "SLA desabilitado";
  if (sla.availability === "stale") return "SLA desatualizado";
  if (sla.state === "paused") return "Pausado";
  if (sla.state === "completed") return "Cumprido";
  if (sla.state === "cancelled") return "Cancelado";
  const deadline = Date.parse(String(sla.deadline_at || ""));
  if (!Number.isFinite(deadline)) return sla.has_breached ? "Estourado" : "Prazo indisponível";
  if (sla.has_breached || deadline <= now) return `Estourado há ${compactDuration(now - deadline)}`;
  return `Falta ${compactDuration(deadline - now)}`;
}
