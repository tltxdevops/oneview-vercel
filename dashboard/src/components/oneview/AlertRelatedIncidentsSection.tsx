/**
 * SN-P0-16 / SN-P0-27 / OV-P0-108 — incidentes ServiceNow no drawer do alerta.
 * Prioridade: __zbx_servicenow_sys_id → __zbx_servicenow_number → INC histórico → event_id → none.
 * Sem fallback por host. Skeleton só no bloco ainda não carregado.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { IncidentActions } from "@/components/oneview/IncidentActions";
import { OneViewQuietRefreshIndicator } from "@/components/oneview/OneViewDesignSystem";
import { displayIncidentField } from "@/components/oneview/OperationalIncidentsQueueList";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import type { AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import {
  AlertHistoryItem,
  AlertRelatedIncident,
  AlertRelatedIncidentsRelationSource,
  OneViewAlert,
  OneViewIncident,
  fetchAlertRelatedIncidents,
  fetchIncidentDetail,
  formatDurationSeconds,
  isOneViewAbortError,
  type ServiceNowIncidentClaimResponse,
} from "@/lib/oneview-api";
import { incidentSlaLabel } from "@/lib/oneview-incident-sla";
import {
  extractServiceNowIncidentNumbersForAlertEpisode,
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
  return null;
}

function presentValue(value?: string | null) {
  const text = String(value || "").trim();
  if (!text || text === "—" || text.toLowerCase() === "undefined" || text.toLowerCase() === "nan") return null;
  if (/^indispon/i.test(text)) return null;
  return text;
}

function assigneeLabel(item: Pick<AlertRelatedIncident, "assigned_to" | "assigned_to_display">) {
  return presentValue(item.assigned_to_display) || presentValue(item.assigned_to);
}

function IncidentDetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold">{value}</dd>
    </div>
  );
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
  enrich,
  alertArtifact,
  mutationsBlocked,
  onOpenIncidentDetail,
  onClaimed,
}: {
  item: AlertRelatedIncident;
  enrich?: boolean;
  alertArtifact?: AlertArtifactModel | null;
  mutationsBlocked?: boolean;
  onOpenIncidentDetail?: (incident: AlertRelatedIncident) => void;
  onClaimed?: (result: ServiceNowIncidentClaimResponse, incident: AlertRelatedIncident) => void;
}) {
  const identityConflict = Boolean(item.identity_conflict);
  const url = identityConflict ? null : buildProductionServiceNowIncidentLink(item.sys_id);
  const number = displayValue(item.number);
  const description = String(item.short_description || "").trim();
  const [detail, setDetail] = useState<OneViewIncident | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const sysId = String(item.sys_id || "").trim();

  useEffect(() => {
    if (!enrich || !sysId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetailLoading(true);
    void fetchIncidentDetail(sysId)
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((error: unknown) => {
        if (!active || isOneViewAbortError(error)) return;
        setDetail(null);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enrich, sysId]);

  const assigned = assigneeLabel({
    assigned_to: item.assigned_to || detail?.assigned_to,
    assigned_to_display: item.assigned_to_display || detail?.assigned_to_display,
  });
  const group = presentValue(item.assignment_group_display)
    || presentValue(item.assignment_group)
    || presentValue(detail?.assignment_group_display)
    || presentValue(detail?.assignment_group);
  const openedAt = detail?.opened_at || detail?.sys_created_on || null;
  const sla = detail?.sla_summary || detail?.slas?.[0] || null;

  return (
    <article className="rounded-lg border border-border/70 bg-muted/15 p-3" aria-label="Chamado relacionado">
      <div className="flex flex-wrap items-start justify-between gap-2">
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
            <p className="font-mono text-sm font-semibold">{number}</p>
          )}
          <Badge variant="outline" className="text-[10px]">{displayValue(item.state_display, item.state, detail?.state_display, detail?.state)}</Badge>
          <Badge variant="secondary" className="text-[10px]">{displayValue(item.priority_display, item.priority, detail?.priority_display, detail?.priority)}</Badge>
          {!assigned ? (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[10px] text-amber-800">Sem responsável</Badge>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">Atualizado em {formatDateTime(item.sys_updated_on || detail?.sys_updated_on)}</p>
      </div>
      {description ? (
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-5" title={description}>{description}</p>
      ) : null}
      {identityConflict ? (
        <p className="mt-2 text-xs text-destructive">Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.</p>
      ) : null}

      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <IncidentDetailField label="Responsável" value={assigned || "Sem responsável"} />
        <IncidentDetailField label="Grupo" value={group || displayIncidentField(item.assignment_group_display, item.assignment_group)} />
        {enrich ? (
          <>
            <IncidentDetailField label="Abertura" value={openedAt ? formatDateTime(openedAt) : detailLoading ? "Carregando…" : "Indisponível na origem"} />
            <IncidentDetailField label="Tempo aberto" value={detail?.open_duration_seconds != null ? formatDurationSeconds(detail.open_duration_seconds) : detailLoading ? "Carregando…" : "Indisponível na origem"} />
            <IncidentDetailField label="SLA" value={sla ? incidentSlaLabel(sla) : detailLoading ? "Carregando…" : "SLA indisponível"} />
          </>
        ) : null}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="min-w-0">
          {!identityConflict ? (
            <IncidentActions
              incident={{
                sys_id: item.sys_id,
                number: item.number,
                state: item.state || detail?.state,
                identity_conflict: identityConflict,
                assigned_to: item.assigned_to || detail?.assigned_to,
                assigned_to_display: assigned,
              }}
              alertArtifact={alertArtifact}
              placement="header"
              visibleActions={["claim"]}
              mutationsBlocked={mutationsBlocked}
              onClaimed={(result) => onClaimed?.(result, item)}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenIncidentDetail ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={(event) => {
                event.stopPropagation();
                onOpenIncidentDetail(item);
              }}
            >
              Ver detalhe
            </Button>
          ) : null}
          {url ? (
            <ServiceNowDevLink sysId={item.sys_id} size="sm" className="w-auto" />
          ) : (
            <span className="text-xs text-muted-foreground">ServiceNow indisponível</span>
          )}
        </div>
      </div>
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
    | "first_seen_at"
  > | null;
  onOpenIncidentDetail?: (incident: AlertRelatedIncident) => void;
  onTimelineServiceNowReferenceChange?: (reference: AlertTimelineServiceNowReference | null) => void;
  onRelatedIncidentsChange?: (incidents: AlertRelatedIncident[]) => void;
  alertArtifact?: AlertArtifactModel | null;
  mutationsBlocked?: boolean;
  onClaimed?: (result: ServiceNowIncidentClaimResponse, incident: AlertRelatedIncident) => void;
};

export function AlertRelatedIncidentsSection({
  sourceEventId,
  severity,
  historyItems = [],
  alert = null,
  onOpenIncidentDetail,
  onTimelineServiceNowReferenceChange,
  onRelatedIncidentsChange,
  alertArtifact = null,
  mutationsBlocked = false,
  onClaimed,
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
    return extractServiceNowIncidentNumbersForAlertEpisode(historyItems, {
      sourceEventId,
      episodeStartedAt: alert?.first_seen_at,
    })
      .filter((number) => !tagRefs.numbers.includes(number));
  }, [alert?.first_seen_at, historyItems, sourceEventId, tagRefs.numbers]);

  const correlationKey = [
    String(sourceEventId || "").trim(),
    tagRefs.sysIds.join(","),
    tagRefs.numbers.join(","),
    historyNumbers.join(","),
    String(alert?.first_seen_at || "").trim(),
  ].join("|");

  useEffect(() => {
    const eventId = String(sourceEventId || "").trim();
    if (
      !eventId
      && !tagRefs.sysIds.length
      && !tagRefs.numbers.length
      && !historyNumbers.length
    ) {
      setLoading(false);
      setChecked(true);
      setIncidents([]);
      setRelationSource("none");
      setError(null);
      setStale(false);
      onTimelineServiceNowReferenceChange?.(null);
      onRelatedIncidentsChange?.([]);
      return;
    }

    if (requestKeyRef.current !== correlationKey) {
      // Só limpa resultado quando a correlação muda (evita flicker em refresh).
      setIncidents([]);
      setRelationSource(null);
      setChecked(false);
      setStale(false);
      requestKeyRef.current = correlationKey;
      onRelatedIncidentsChange?.([]);
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
        onRelatedIncidentsChange?.(nextIncidents);
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
        onRelatedIncidentsChange?.([]);
        void err;
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; controller.abort(); };
  }, [sourceEventId, correlationKey, tagRefs.sysIds, tagRefs.numbers, historyNumbers, alert?.first_seen_at, onTimelineServiceNowReferenceChange, onRelatedIncidentsChange]);

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
          {incidents.map((item, index) => (
            <IncidentCard
              key={item.sys_id || item.number || JSON.stringify(item)}
              item={item}
              enrich={index === 0}
              alertArtifact={alertArtifact}
              mutationsBlocked={mutationsBlocked}
              onOpenIncidentDetail={onOpenIncidentDetail}
              onClaimed={onClaimed}
            />
          ))}
          {loading ? <OneViewQuietRefreshIndicator className="mt-1" /> : null}
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
