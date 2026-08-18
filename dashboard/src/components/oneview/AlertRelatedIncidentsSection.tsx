/**
 * SN-P0-16 / SN-P0-27 / OV-P0-108 — incidentes ServiceNow no drawer do alerta.
 * Prioridade: __zbx_servicenow_sys_id → __zbx_servicenow_number → INC histórico → event_id → none.
 * Sem fallback por host. Skeleton só no bloco ainda não carregado.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import {
  AlertHistoryItem,
  AlertRelatedIncident,
  AlertRelatedIncidentsRelationSource,
  OneViewAlert,
  fetchAlertRelatedIncidents,
} from "@/lib/oneview-api";
import {
  extractServiceNowIncidentNumbersFromHistory,
  extractServiceNowRefsFromAlertTags,
} from "@/lib/oneview-inc-correlation";

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

function relationSourceLabel(source?: AlertRelatedIncidentsRelationSource | null) {
  if (source === "zabbix_servicenow_sys_id") return "Referência sys_id Zabbix";
  if (source === "zabbix_servicenow_number") return "Referência INC Zabbix";
  if (source === "zabbix_inc_reference") return "Referência INC no histórico";
  if (source === "zabbix_event_id") return "Event ID Zabbix";
  return null;
}

function IncidentCard({
  item,
  extraCount = 0,
}: {
  item: AlertRelatedIncident;
  extraCount?: number;
}) {
  const url = item.servicenow_url || null;
  const number = displayValue(item.number);
  return (
    <article className="space-y-3 rounded-md border border-border/70 p-3" aria-label="Chamado relacionado">
      <div className="flex flex-wrap items-center gap-2">
        {url && number !== "—" ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-mono text-sm font-semibold text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {number}
            <span aria-hidden className="text-[10px] leading-none">↗</span>
            {extraCount > 0 ? <span className="text-[10px] text-muted-foreground">+{extraCount}</span> : null}
          </a>
        ) : (
          <p className="font-mono text-sm font-semibold">
            {number}
            {extraCount > 0 ? <span className="ml-1 text-[10px] font-normal text-muted-foreground">+{extraCount}</span> : null}
          </p>
        )}
        <Badge variant="outline">{displayValue(item.state_display, item.state)}</Badge>
        <Badge variant="secondary">{displayValue(item.priority_display, item.priority)}</Badge>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Estado</dt>
          <dd className="font-medium">{displayValue(item.state_display, item.state)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Prioridade</dt>
          <dd className="font-medium">{displayValue(item.priority_display, item.priority)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Responsável</dt>
          <dd className="font-medium">{displayValue(item.assigned_to_display, item.assigned_to)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Grupo</dt>
          <dd className="font-medium">{displayValue(item.assignment_group_display, item.assignment_group)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Última atualização</dt>
          <dd>{formatDateTime(item.sys_updated_on)}</dd>
        </div>
      </dl>
      {url ? (
        <ServiceNowDevLink href={url} size="sm" className="sm:w-auto" fullWidth />
      ) : (
        <p className="text-xs text-muted-foreground">Link do ServiceNow indisponível.</p>
      )}
    </article>
  );
}

function ProjectedIncidentCard({
  reference,
  loadingDetails,
}: {
  reference: NonNullable<OneViewAlert["servicenow_reference"]>;
  loadingDetails: boolean;
}) {
  return (
    <article className="space-y-3 rounded-md border border-border/70 p-3" aria-label="Chamado relacionado">
      <div className="flex flex-wrap items-center gap-2">
        <AlertServiceNowReferenceCell reference={reference} />
      </div>
      {loadingDetails ? (
        <div className="space-y-2" aria-label="Carregando detalhe do chamado">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Estado</dt>
            <dd className="font-medium">—</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Prioridade</dt>
            <dd className="font-medium">—</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Responsável</dt>
            <dd className="font-medium">—</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Grupo</dt>
            <dd className="font-medium">—</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Última atualização</dt>
            <dd>—</dd>
          </div>
        </dl>
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
  > | null;
};

export function AlertRelatedIncidentsSection({
  sourceEventId,
  severity,
  historyItems = [],
  alert = null,
}: AlertRelatedIncidentsSectionProps) {
  const eligible = isIncidentEligibleSeverity(severity);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [incidents, setIncidents] = useState<AlertRelatedIncident[]>([]);
  const [relationSource, setRelationSource] = useState<AlertRelatedIncidentsRelationSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKeyRef = useRef<string>("");

  const tagRefs = useMemo(
    () => extractServiceNowRefsFromAlertTags(alert),
    [alert],
  );

  const historyNumbers = useMemo(() => {
    const ackComment = alert?.source_ack && typeof alert.source_ack === "object"
      ? (alert.source_ack as { comment?: string | null }).comment
      : null;
    return extractServiceNowIncidentNumbersFromHistory(historyItems, [ackComment])
      .filter((number) => !tagRefs.numbers.includes(number));
  }, [alert, historyItems, tagRefs.numbers]);

  const correlationKey = [
    String(sourceEventId || "").trim(),
    tagRefs.sysIds.join(","),
    tagRefs.numbers.join(","),
    historyNumbers.join(","),
  ].join("|");

  useEffect(() => {
    const eventId = String(sourceEventId || "").trim();
    if (!eventId && !tagRefs.sysIds.length && !tagRefs.numbers.length && !historyNumbers.length) {
      setLoading(false);
      setChecked(true);
      setIncidents([]);
      setRelationSource("none");
      setError(null);
      return;
    }

    if (requestKeyRef.current !== correlationKey) {
      // Só limpa resultado quando a correlação muda (evita flicker em refresh).
      setIncidents([]);
      setRelationSource(null);
      setChecked(false);
      requestKeyRef.current = correlationKey;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchAlertRelatedIncidents(
      {
        sourceEventId: eventId || null,
        incidentNumbers: historyNumbers,
        tagIncidentNumbers: tagRefs.numbers,
        incidentSysIds: tagRefs.sysIds,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setIncidents(Array.isArray(response.incidents) ? response.incidents : []);
        setRelationSource(response.relation_source || (response.matched ? "zabbix_event_id" : "none"));
        setChecked(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRelationSource("none");
        setChecked(true);
        setError("ServiceNow indisponível");
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [sourceEventId, correlationKey, tagRefs.sysIds, tagRefs.numbers, historyNumbers]);

  const projected = alert?.servicenow_reference
    && (alert.servicenow_reference.number || alert.servicenow_reference.sys_id)
    ? alert.servicenow_reference
    : null;
  const extraCount = Number(projected?.extra_count || 0);
  const hasIncidents = incidents.length > 0;
  const showEmptyEligible = checked && !hasIncidents && !error && eligible && !loading && !projected;
  const hideNonEligibleEmpty = checked && !hasIncidents && !error && !eligible && !loading && !projected;

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
              item={{
                ...item,
                servicenow_url: item.servicenow_url || projected?.url || null,
              }}
              extraCount={index === 0 ? extraCount : 0}
            />
          ))}
          {loading ? <p className="text-[11px] text-muted-foreground">Atualizando…</p> : null}
        </div>
      ) : projected ? (
        <ProjectedIncidentCard reference={projected} loadingDetails={loading} />
      ) : error ? (
        <p className="text-sm text-muted-foreground">{error}</p>
      ) : loading ? (
        <div className="space-y-2" aria-label="Carregando detalhe do chamado">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : showEmptyEligible ? (
        <p className="text-sm text-muted-foreground">Nenhum incidente relacionado localizado</p>
      ) : null}
    </section>
  );
}
