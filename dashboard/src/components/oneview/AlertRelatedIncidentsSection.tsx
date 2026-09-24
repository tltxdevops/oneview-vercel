/**
 * SN-P0-16 / SN-P0-27 / OV-P0-108 — incidentes ServiceNow no drawer do alerta.
 * Prioridade: __zbx_servicenow_sys_id → __zbx_servicenow_number → INC histórico → event_id → none.
 * Sem fallback por host. Skeleton só no bloco ainda não carregado.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import {
  AlertHistoryItem,
  AlertRelatedIncident,
  AlertRelatedIncidentsRelationSource,
  OneViewAlert,
  OneViewIncident,
  fetchAlertRelatedIncidents,
} from "@/lib/oneview-api";
import {
  extractServiceNowIncidentNumbersFromHistory,
  extractServiceNowRefsFromAlertTags,
} from "@/lib/oneview-inc-correlation";
import type { AlertTimelineServiceNowReference } from "@/lib/oneview-alert-timeline";

const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";
const TIMELINE_EXPLICIT_RELATION_SOURCES = new Set<AlertRelatedIncidentsRelationSource>([
  "zabbix_servicenow_sys_id",
  "zabbix_servicenow_number",
  "zabbix_event_id",
]);

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
  return "Indisponível na origem";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Indisponível na origem";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Indisponível na origem"
    : date.toLocaleString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE });
}

function timelineReference(
  relationSource: AlertRelatedIncidentsRelationSource | null,
  incidents: AlertRelatedIncident[],
): AlertTimelineServiceNowReference | null {
  if (!relationSource || !TIMELINE_EXPLICIT_RELATION_SOURCES.has(relationSource)) return null;
  const incident = incidents[0];
  if (!incident) return null;
  const number = String(incident.number || "").trim() || null;
  const sysId = String(incident.sys_id || "").trim() || null;
  if (!number && !sysId) return null;
  return { number, sys_id: sysId, url: incident.servicenow_url || null };
}

function relationSourceLabel(source?: AlertRelatedIncidentsRelationSource | null) {
  if (source === "zabbix_servicenow_sys_id") return "Referência sys_id Zabbix";
  if (source === "zabbix_servicenow_number") return "Referência INC Zabbix";
  if (source === "zabbix_inc_reference") return "Referência INC no histórico";
  if (source === "zabbix_event_id") return "Event ID Zabbix";
  if (source === "operational_host") return "Host MAPS (ServiceNow)";
  return null;
}

export function relatedIncidentToOneViewIncident(item: AlertRelatedIncident): OneViewIncident {
  return {
    sys_id: item.sys_id,
    identity_conflict: Boolean(item.identity_conflict),
    number: item.number,
    short_description: item.short_description ?? null,
    state: item.state,
    priority: item.priority,
    caller_id: null,
    contact_type: null,
    assignment_group: item.assignment_group,
    assigned_to: item.assigned_to,
    company: item.company ?? null,
    opened_at: null,
    resolved_at: null,
    closed_at: null,
    sys_created_on: null,
    sys_updated_on: item.sys_updated_on,
    correlation_id: null,
    state_display: item.state_display,
    priority_display: item.priority_display,
    assignment_group_display: item.assignment_group_display,
    assigned_to_display: item.assigned_to_display,
    company_display: item.company_display,
    zabbix_event_id: item.zabbix_event_id,
    servicenow_url: item.servicenow_url,
  } as OneViewIncident;
}

function IncidentCard({
  item,
  onOpenIncidentDetail,
}: {
  item: AlertRelatedIncident;
  onOpenIncidentDetail?: (incident: AlertRelatedIncident) => void;
}) {
  const identityConflict = Boolean(item.identity_conflict);
  const url = identityConflict ? null : buildProductionServiceNowIncidentLink(item.sys_id);
  const number = displayValue(item.number);
  const description = String(item.short_description || "").trim();
  return (
    <article className="space-y-3 rounded-md border border-border/70 p-3" aria-label="Chamado relacionado">
      <div className="flex flex-wrap items-center gap-2">
        {url && number !== "Indisponível na origem" ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-mono text-sm font-semibold text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {number}
            <span aria-hidden className="text-[10px] leading-none">↗</span>
          </a>
        ) : (
          <p className="font-mono text-sm font-semibold">
            {number}
          </p>
        )}
        <Badge variant="outline">{displayValue(item.state_display, item.state)}</Badge>
        <Badge variant="secondary">{displayValue(item.priority_display, item.priority)}</Badge>
      </div>
      {description ? (
        <p className="truncate text-sm font-semibold" title={description}>{description}</p>
      ) : null}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Estado</dt>
          <dd className="mt-0.5 font-semibold">{displayValue(item.state_display, item.state)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Prioridade</dt>
          <dd className="mt-0.5 font-semibold">{displayValue(item.priority_display, item.priority)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Analista</dt>
          <dd className="mt-0.5 font-semibold">{displayValue(item.assigned_to_display, item.assigned_to)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Grupo</dt>
          <dd className="mt-0.5 font-semibold">{displayValue(item.assignment_group_display, item.assignment_group)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Última atualização</dt>
          <dd className="mt-0.5 font-semibold">{formatDateTime(item.sys_updated_on)}</dd>
        </div>
      </dl>
      {identityConflict ? (
        <p className="text-xs text-destructive">Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.</p>
      ) : null}
      {onOpenIncidentDetail ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full sm:w-auto"
          onClick={(event) => {
            event.stopPropagation();
            onOpenIncidentDetail(item);
          }}
        >
          Ver detalhe no OneView
        </Button>
      ) : null}
      {url ? (
        <ServiceNowDevLink sysId={item.sys_id} size="sm" className="sm:w-auto" fullWidth />
      ) : (
        <p className="text-xs text-muted-foreground">Link do ServiceNow indisponível.</p>
      )}
    </article>
  );
}

type AlertRelatedIncidentsSectionProps = {
  sourceEventId?: string | null;
  severity?: string | null;
  historyItems?: AlertHistoryItem[] | null;
  alert?: Pick<
    OneViewAlert,
    | "source_ack"
    | "acknowledged_source_by"
    | "acknowledged_by"
    | "event_tags"
    | "trigger_tags"
    | "host_tags"
    | "servicenow_reference"
    | "datasource_name"
    | "host_technical_name"
    | "host_name"
    | "host_visible_name"
    | "problem_name"
    | "first_seen_at"
  > | null;
  onOpenIncidentDetail?: (incident: AlertRelatedIncident) => void;
  onTimelineServiceNowReferenceChange?: (reference: AlertTimelineServiceNowReference | null) => void;
};

export function AlertRelatedIncidentsSection({
  sourceEventId,
  severity,
  historyItems = [],
  alert = null,
  onOpenIncidentDetail,
  onTimelineServiceNowReferenceChange,
}: AlertRelatedIncidentsSectionProps) {
  const eligible = isIncidentEligibleSeverity(severity);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [incidents, setIncidents] = useState<AlertRelatedIncident[]>([]);
  const [relationSource, setRelationSource] = useState<AlertRelatedIncidentsRelationSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const requestKeyRef = useRef<string>("");

  const tagRefs = useMemo(
    () => extractServiceNowRefsFromAlertTags(alert),
    [alert],
  );

  const historyNumbers = useMemo(() => {
    return extractServiceNowIncidentNumbersFromHistory(historyItems, [alert?.source_ack?.comment])
      .filter((number) => !tagRefs.numbers.includes(number));
  }, [alert, historyItems, tagRefs.numbers]);

  const mapsBridge = useMemo(() => {
    const datasource = String(alert?.datasource_name || "").trim().toLowerCase();
    if (datasource !== "maps") return null;
    const host = String(
      alert?.host_technical_name || alert?.host_name || alert?.host_visible_name || "",
    ).trim();
    const problem = String(alert?.problem_name || "").trim();
    if (!host) return null;
    return { mapsDatasource: "maps", mapsHost: host, mapsProblemName: problem || null };
  }, [alert]);

  const correlationKey = [
    String(sourceEventId || "").trim(),
    tagRefs.sysIds.join(","),
    tagRefs.numbers.join(","),
    historyNumbers.join(","),
    String(alert?.first_seen_at || "").trim(),
    mapsBridge?.mapsHost || "",
    mapsBridge?.mapsProblemName || "",
  ].join("|");

  useEffect(() => {
    const eventId = String(sourceEventId || "").trim();
    if (
      !eventId
      && !tagRefs.sysIds.length
      && !tagRefs.numbers.length
      && !historyNumbers.length
      && !mapsBridge?.mapsHost
    ) {
      setLoading(false);
      setChecked(true);
      setIncidents([]);
      setRelationSource("none");
      setError(null);
      setStale(false);
      onTimelineServiceNowReferenceChange?.(null);
      return;
    }

    if (requestKeyRef.current !== correlationKey) {
      // Só limpa resultado quando a correlação muda (evita flicker em refresh).
      setIncidents([]);
      setRelationSource(null);
      setChecked(false);
      setStale(false);
      requestKeyRef.current = correlationKey;
    }

    // Correlação não recebe fallback do cache: refresh falho não pode tratar
    // uma resposta anterior como relação atual.
    let active = true;
    const controller = new AbortController();
    // A timeline não mantém vínculo anterior enquanto confirma este refresh.
    onTimelineServiceNowReferenceChange?.(null);
    setLoading(true);
    setError(null);
    setStale(false);

    fetchAlertRelatedIncidents(
      {
        sourceEventId: eventId || null,
        alertEpisodeStartedAt: alert?.first_seen_at || null,
        incidentNumbers: historyNumbers,
        tagIncidentNumbers: tagRefs.numbers,
        incidentSysIds: tagRefs.sysIds,
        mapsDatasource: mapsBridge?.mapsDatasource || null,
        mapsHost: mapsBridge?.mapsHost || null,
        mapsProblemName: mapsBridge?.mapsProblemName || null,
      },
      controller.signal,
    )
      .then((response) => {
        if (!active) return;
        const nextIncidents = Array.isArray(response.incidents) ? response.incidents : [];
        const nextRelationSource = response.relation_source || (response.matched ? "zabbix_event_id" : "none");
        setIncidents(nextIncidents);
        setRelationSource(nextRelationSource);
        onTimelineServiceNowReferenceChange?.(timelineReference(nextRelationSource, nextIncidents));
        setChecked(true);
        setStale(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setRelationSource("none");
        setChecked(true);
        setError("ServiceNow indisponível");
        setStale(true);
        onTimelineServiceNowReferenceChange?.(null);
        void err;
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; controller.abort(); };
  }, [sourceEventId, correlationKey, tagRefs.sysIds, tagRefs.numbers, historyNumbers, alert?.first_seen_at, onTimelineServiceNowReferenceChange]);

  const hasIncidents = incidents.length > 0;
  const showEmptyEligible = checked && !hasIncidents && !error && eligible && !loading;
  const hideNonEligibleEmpty = checked && !hasIncidents && !error && !eligible && !loading;

  if (hideNonEligibleEmpty) return null;

  const sourceLabel = relationSourceLabel(relationSource);

  return (
    <section aria-label="Chamado relacionado" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Chamado relacionado</h3>
        {hasIncidents && sourceLabel ? (
          <Badge variant="outline" className="text-[10px]">{sourceLabel}</Badge>
        ) : null}
      </div>
      {hasIncidents ? (
        <div className="space-y-3">
          {incidents.map((item) => (
            <IncidentCard
              key={item.sys_id || item.number || JSON.stringify(item)}
              item={item}
              onOpenIncidentDetail={onOpenIncidentDetail}
            />
          ))}
          {loading ? <p className="text-[11px] text-muted-foreground">Atualizando…</p> : null}
          {stale ? <p className="text-xs text-amber-700">Dados de correlação desatualizados. Atualize novamente para confirmar.</p> : null}
        </div>
      ) : error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : loading ? (
        <div className="space-y-2" aria-label="Carregando detalhe do chamado">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : showEmptyEligible ? (
        <p className="text-sm text-muted-foreground">Sem chamado relacionado</p>
      ) : null}
    </section>
  );
}
