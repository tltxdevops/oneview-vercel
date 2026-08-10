/**
 * SN-P0-16 / SN-P0-17 / SN-P0-21 — incidentes ServiceNow no drawer do alerta.
 * Gate operacional por severity:
 *   - average/high/disaster: unmatched → "Nenhum incidente relacionado localizado"
 *   - warning/information: unmatched não é apresentado como erro/ausência
 * Erro SN: "ServiceNow indisponível" (seção isolada; não quebra o drawer).
 */
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import {
  AlertRelatedIncident,
  fetchAlertRelatedIncidents,
} from "@/lib/oneview-api";
import { isServiceNowIncidentsUiEnabled } from "@/lib/servicenow-features";

/** Severidades automaticamente elegíveis a incidente (SN-P0-20/21). */
export const INCIDENT_ELIGIBLE_SEVERITIES = Object.freeze([
  "average",
  "high",
  "disaster",
] as const);

export type IncidentEligibleSeverity = (typeof INCIDENT_ELIGIBLE_SEVERITIES)[number];

export function normalizeAlertSeverity(value?: string | null): string {
  return String(value || "").trim().toLowerCase();
}

export function isIncidentEligibleSeverity(severity?: string | null): boolean {
  const normalized = normalizeAlertSeverity(severity);
  return (INCIDENT_ELIGIBLE_SEVERITIES as readonly string[]).includes(normalized);
}

function displayValue(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && text !== "—" && text.toLowerCase() !== "undefined" && text.toLowerCase() !== "nan") {
      return text;
    }
  }
  return "—";
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function IncidentCard({ item }: { item: AlertRelatedIncident }) {
  return (
    <article className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-sm font-semibold">{displayValue(item.number)}</p>
        <Badge variant="outline">{displayValue(item.state_display, item.state)}</Badge>
        <Badge variant="secondary">{displayValue(item.priority_display, item.priority)}</Badge>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Grupo</dt>
          <dd className="font-medium">{displayValue(item.assignment_group_display, item.assignment_group)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Responsável</dt>
          <dd className="font-medium">{displayValue(item.assigned_to_display, item.assigned_to)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Atualização</dt>
          <dd>{formatDateTime(item.sys_updated_on)}</dd>
        </div>
      </dl>
      {item.servicenow_url ? (
        <ServiceNowDevLink href={item.servicenow_url} size="sm" className="sm:w-auto" fullWidth />
      ) : (
        <p className="text-xs text-muted-foreground">Link do ServiceNow indisponível.</p>
      )}
    </article>
  );
}

type AlertRelatedIncidentsSectionProps = {
  sourceEventId?: string | null;
  /** Severity do alerta — gate de mensagem de ausência (SN-P0-21). */
  severity?: string | null;
};

export function AlertRelatedIncidentsSection({
  sourceEventId,
  severity,
}: AlertRelatedIncidentsSectionProps) {
  const enabled = isServiceNowIncidentsUiEnabled();
  const eligible = isIncidentEligibleSeverity(severity);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [incidents, setIncidents] = useState<AlertRelatedIncident[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setChecked(false);
      setIncidents([]);
      setError(null);
      return;
    }

    const eventId = String(sourceEventId || "").trim();
    if (!eventId) {
      setLoading(false);
      setChecked(true);
      setIncidents([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setChecked(false);
    setIncidents([]);
    setError(null);

    fetchAlertRelatedIncidents(eventId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setIncidents(Array.isArray(response.incidents) ? response.incidents : []);
        setChecked(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setIncidents([]);
        setChecked(true);
        setError("ServiceNow indisponível");
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, sourceEventId]);

  if (!enabled) return null;

  const hasIncidents = incidents.length > 0;
  const showEmptyEligible = checked && !hasIncidents && !error && eligible;
  // Warning/Information: unmatched não aparece como ausência/erro — some a seção.
  const hideNonEligibleEmpty = checked && !hasIncidents && !error && !eligible && !loading;

  if (hideNonEligibleEmpty) return null;

  return (
    <section aria-label="Chamado ServiceNow" className="space-y-3">
      <h3 className="text-sm font-semibold">Chamado ServiceNow</h3>
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : hasIncidents ? (
        <div className="space-y-3">
          {incidents.map((item) => (
            <IncidentCard key={item.sys_id || item.number || JSON.stringify(item)} item={item} />
          ))}
        </div>
      ) : showEmptyEligible ? (
        <p className="text-sm text-muted-foreground">Nenhum incidente relacionado localizado</p>
      ) : null}
    </section>
  );
}
