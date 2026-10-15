import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, CheckCircle2, ChevronDown, Clock3, Eye, History, Info, Repeat2 } from "lucide-react";
import {
  CLASSIFICATION_PENDING_LABEL,
  ClientIdentity,
  canonicalHostName,
  displayHostField,
  isNonCustomerOperationalScope,
  normalizeOperationalScope,
  operationalClientLabel,
} from "@/components/oneview/ClientIdentity";
import { AlertOperationalShareActions } from "@/components/oneview/AlertOperationalShareActions";
import { AlertOperatorLinkControls } from "@/components/oneview/AlertOperatorLinkControls";
import { AlertSourceAckAction } from "@/components/oneview/AlertSourceAckAction";
import { AlertRecurrenceSignal } from "@/components/oneview/AlertRecurrenceSignal";
import { AlertSameProblemContext } from "@/components/oneview/AlertRecurrenceInvestigation";
import {
  AlertRelatedIncidentsSection,
  relatedIncidentToOneViewIncident,
} from "@/components/oneview/AlertRelatedIncidentsSection";
import { IncidentActions } from "@/components/oneview/IncidentActions";
import { IncidentDetailDrawer } from "@/components/oneview/IncidentDetailDrawer";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { OneViewErrorBoundary } from "@/components/oneview/OneViewErrorBoundary";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AlertHistoryItem,
  AlertRelatedIncident,
  OneViewAlert,
  OneViewIncident,
  type AcknowledgeAlertResponse,
  type ServiceNowIncidentClaimResponse,
  fetchAlerts,
  formatOneViewSeverityLabel,
} from "@/lib/oneview-api";
import {
  oneViewAckStatusLabel,
  sourceAckIsPending,
  sourceAckRowKind,
  sourceAckRowLabel,
  sourceAckRowTone,
  type SourceAckTerminalStatus,
} from "@/lib/oneview-alert-source-ack";
import {
  buildAlertClientCommunication,
  type AlertClientCommunicationEdits,
} from "@/lib/oneview-alert-operational-share";
import { buildAlertArtifactFromOneViewAlert } from "@/lib/oneview-alert-artifact";
import { filterOperationalAlertTags } from "@/lib/oneview-inc-correlation";
import { type AlertTimelineServiceNowReference } from "@/lib/oneview-alert-timeline";
import { primaryPersistedOperatorTag } from "@/lib/oneview-operator-display";
import {
  formatZabbixSourceAudit,
  zabbixSourceDisplayName,
} from "@/lib/oneview-zabbix-source";

export type AlertDetailDrawerTab = "summary" | "history" | "technical";

const ORIGIN_UNAVAILABLE = "Indisponível na origem";
const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";

function formatDateTime(value?: string | null) {
  if (!value) return ORIGIN_UNAVAILABLE;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ORIGIN_UNAVAILABLE
    : date.toLocaleString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE });
}

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Duração indisponível";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

function customerSourceLabel(value?: string | null) {
  const labels: Record<string, string> = {
    tag: "Tag",
    host_group: "Grupo do host",
    datasource_fallback: "Fallback da fonte",
    unclassified: "unclassified",
  };
  const key = String(value || "").trim();
  if (!key) return "Enriquecimento pendente";
  return labels[key] ?? key;
}

function confidenceLabel(value?: string | null) {
  if (value === "high") return "Alta";
  if (value === "low") return "Baixa";
  if (value === "medium") return "Média";
  return "Não classificado";
}

function isResolvedAlert(alert: OneViewAlert) {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function originStatusLabel(value?: string | null) {
  const status = String(value || "").trim().toLowerCase();
  if (["cancelled", "canceled"].includes(status)) return "Cancelado";
  if (status === "active") return "Ativo";
  if (status === "resolved") return "Resolvido";
  return status || ORIGIN_UNAVAILABLE;
}

function safeActorName(value?: string | null) {
  const actor = String(value || "").trim();
  if (!actor || /^\d+$/.test(actor)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(actor)) return null;
  return actor;
}

function collectOperationalTags(alert: OneViewAlert) {
  return filterOperationalAlertTags([
    ...(alert.event_tags ?? []),
    ...(alert.trigger_tags ?? []),
    ...(alert.host_tags ?? []),
    ...((alert as OneViewAlert & { template_tags?: OneViewAlert["event_tags"] }).template_tags ?? []),
  ]);
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words font-semibold", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
}

function formatDate(value?: string | null) {
  if (!value) return "Data indisponível";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Data indisponível"
    : date.toLocaleDateString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE });
}

function QuickFact({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
  onClick,
  pressed = false,
  ariaLabel,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "success" | "warning";
  onClick?: () => void;
  pressed?: boolean;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span className={cn(
          "shrink-0",
          tone === "success" && "text-emerald-600",
          tone === "warning" && "text-amber-600",
        )} aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {onClick ? (
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", pressed && "rotate-180")} aria-hidden="true" />
        ) : null}
      </div>
      <p className="mt-1 truncate text-sm font-semibold text-foreground" title={value}>{value}</p>
      {detail ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={detail}>{detail}</p> : null}
    </>
  );
  const className = cn(
    "min-w-0 rounded-lg border border-border/70 bg-muted/20 p-3 text-left",
    onClick && "cursor-pointer transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    pressed && "border-foreground/25 bg-muted/35",
  );
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button type="button" className={className} onClick={onClick} aria-expanded={pressed} aria-label={ariaLabel}>
      {body}
    </button>
  );
}

type RecurrenceTimelineEpisode = {
  id: string;
  startedAt: string | null;
  resolvedAt: string | null;
  durationSeconds: number | null;
  active: boolean;
  current: boolean;
  acknowledgedBy: string | null;
  incidentNumber: string | null;
  incidentSysId: string | null;
  incidentUrl: string | null;
};

function recurrenceEpisodeFromAlert(item: OneViewAlert, currentId: string): RecurrenceTimelineEpisode {
  return {
    id: item.id,
    startedAt: item.first_seen_at || null,
    resolvedAt: item.resolved_at || null,
    durationSeconds: item.duration_seconds ?? null,
    active: !isResolvedAlert(item),
    current: item.id === currentId,
    acknowledgedBy: safeActorName(item.acknowledged_source_by || item.acknowledged_by),
    incidentNumber: item.servicenow_reference?.number || null,
    incidentSysId: item.servicenow_reference?.sys_id || null,
    incidentUrl: item.servicenow_reference?.url || null,
  };
}

export type AlertDetailDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  alert: OneViewAlert | null;
  historyItems?: AlertHistoryItem[];
  isLoading?: boolean;
  error?: string | null;
  description?: string;
  defaultTab?: AlertDetailDrawerTab;
  alertsQueueHref?: string | null;
  auditEmphasis?: boolean;
  onSourceAckRequestAccepted?: (alert: OneViewAlert, result: AcknowledgeAlertResponse) => void | Promise<void>;
  onSourceAcknowledged?: (alert: OneViewAlert, status: SourceAckTerminalStatus) => void | Promise<void>;
  onIncidentClaimed?: (result?: ServiceNowIncidentClaimResponse) => void;
  liveStateUnavailable?: boolean;
};

/**
 * OV-P0-80 / OV-P0-108 — Drawer único de detalhe.
 * Preview permanece visível durante refresh; skeleton só em blocos ainda vazios.
 */
export function AlertDetailDrawer({
  open,
  onOpenChange,
  alert,
  historyItems = [],
  isLoading = false,
  error = null,
  description = "Detalhe operacional do alerta.",
  defaultTab = "summary",
  alertsQueueHref = null,
  onSourceAckRequestAccepted,
  onSourceAcknowledged,
  onIncidentClaimed,
  liveStateUnavailable = false,
}: AlertDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<AlertDetailDrawerTab>(
    ["summary", "history", "technical"].includes(defaultTab) ? defaultTab : "summary",
  );
  const [nestedIncident, setNestedIncident] = useState<OneViewIncident | null>(null);
  const [timelineServiceNowReference, setTimelineServiceNowReference] = useState<AlertTimelineServiceNowReference | null>(null);
  const [relatedIncidents, setRelatedIncidents] = useState<AlertRelatedIncident[]>([]);
  const [communicationEdits, setCommunicationEdits] = useState<AlertClientCommunicationEdits>({});
  const [recurrenceTimelineOpen, setRecurrenceTimelineOpen] = useState(false);
  const [recurrenceEpisodes, setRecurrenceEpisodes] = useState<RecurrenceTimelineEpisode[]>([]);
  const [recurrenceTimelineLoading, setRecurrenceTimelineLoading] = useState(false);
  const [recurrenceTimelineError, setRecurrenceTimelineError] = useState<string | null>(null);
  const [recurrenceTimelineTotal, setRecurrenceTimelineTotal] = useState(0);
  const handleTimelineServiceNowReferenceChange = useCallback((reference: AlertTimelineServiceNowReference | null) => {
    setTimelineServiceNowReference(reference);
  }, []);

  const claimedIncidentRef = useRef<{
    number: string;
    assignee: string | null;
    group: string | null;
    state: string | null;
    updatedOn: string | null;
  } | null>(null);

  const overlayClaimedIncident = useCallback((items: AlertRelatedIncident[]) => {
    const claimed = claimedIncidentRef.current;
    if (!claimed) return items;
    return items.map((item, index) => {
      const itemNumber = String(item.number || "").trim().toUpperCase();
      if (claimed.number && itemNumber !== claimed.number) return item;
      if (!claimed.number && index !== 0) return item;
      return {
        ...item,
        assigned_to: claimed.assignee,
        assigned_to_display: claimed.assignee,
        assignment_group: claimed.group ?? item.assignment_group,
        assignment_group_display: claimed.group ?? item.assignment_group_display,
        state: claimed.state ?? item.state,
        sys_updated_on: claimed.updatedOn ?? item.sys_updated_on,
      };
    });
  }, []);

  const handleRelatedIncidentsChange = useCallback((items: AlertRelatedIncident[]) => {
    setRelatedIncidents(overlayClaimedIncident(items));
  }, [overlayClaimedIncident]);

  const applyClaimedIncident = useCallback((result: ServiceNowIncidentClaimResponse) => {
    claimedIncidentRef.current = {
      number: String(result.incident.incident_number || "").trim().toUpperCase(),
      assignee: result.incident.assigned_to_name || null,
      group: result.incident.assignment_group_name || null,
      state: result.incident.state || null,
      updatedOn: result.incident.updated_on || null,
    };
    setRelatedIncidents((current) => overlayClaimedIncident(current));
    onIncidentClaimed?.(result);
  }, [onIncidentClaimed, overlayClaimedIncident]);

  const handleCommunicationChange = useCallback((edits: AlertClientCommunicationEdits) => {
    setCommunicationEdits((current) => ({ ...current, ...edits }));
  }, []);

  useEffect(() => {
    const next: AlertDetailDrawerTab = ["summary", "history", "technical"].includes(defaultTab)
      ? defaultTab
      : "summary";
    setActiveTab(next);
  }, [alert?.id, defaultTab]);

  useEffect(() => {
    if (!open) setNestedIncident(null);
  }, [open]);

  useEffect(() => {
    setNestedIncident(null);
  }, [alert?.id]);

  useEffect(() => {
    claimedIncidentRef.current = null;
    setTimelineServiceNowReference(null);
    setRelatedIncidents([]);
    setCommunicationEdits({});
    setRecurrenceTimelineOpen(false);
    setRecurrenceEpisodes([]);
    setRecurrenceTimelineError(null);
    setRecurrenceTimelineTotal(0);
  }, [alert?.id]);

  useEffect(() => {
    if (!open || !alert?.recurrence_key || !alert) {
      setRecurrenceTimelineLoading(false);
      return;
    }
    const controller = new AbortController();
    const currentId = alert.id;
    const recurrenceKey = alert.recurrence_key;
    const currentAlert = alert;
    setRecurrenceTimelineLoading(true);
    setRecurrenceTimelineError(null);
    fetchAlerts({
      recurrenceKey,
      status: "all",
      sort: "first_seen_at",
      order: "desc",
      page: 1,
      pageSize: 30,
      signal: controller.signal,
    }).then((response) => {
      if (controller.signal.aborted) return;
      const items = Array.isArray(response.items) ? response.items : [];
      const episodes = items.map((item) => recurrenceEpisodeFromAlert(item, currentId));
      if (!episodes.some((item) => item.current)) {
        episodes.unshift(recurrenceEpisodeFromAlert(currentAlert, currentId));
      }
      episodes.sort((left, right) => {
        const leftTime = left.startedAt ? Date.parse(left.startedAt) : 0;
        const rightTime = right.startedAt ? Date.parse(right.startedAt) : 0;
        return rightTime - leftTime;
      });
      setRecurrenceEpisodes(episodes);
      setRecurrenceTimelineTotal(Math.max(response.pagination?.total_items || 0, episodes.length));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      if (name === "AbortError") return;
      setRecurrenceEpisodes([]);
      setRecurrenceTimelineError("Não foi possível carregar as ocorrências anteriores.");
    }).finally(() => {
      if (!controller.signal.aborted) setRecurrenceTimelineLoading(false);
    });
    return () => controller.abort();
  }, [alert?.id, alert?.recurrence_key, open]);

  const customer = alert
    ? {
        key: alert.customer_key,
        name: alert.customer_name,
        source: alert.customer_source,
      }
    : null;
  const scope = alert ? normalizeOperationalScope(alert.operational_scope) : null;
  const clientName = alert
    ? operationalClientLabel({
        key: alert.customer_key,
        name: alert.customer_name,
        source: alert.customer_source,
        operational_scope: alert.operational_scope,
        operational_scope_label: alert.operational_scope_label,
      })
    : "";
  const showPending = Boolean(
    alert && (scope === "unknown" || (!scope && !alert.customer_name)),
  );
  const hostName = alert ? canonicalHostName(alert) : "—";
  const resolved = alert ? isResolvedAlert(alert) : false;
  const visualAlert = alert;
  const temporalInconsistent = alert?.temporal_integrity === "source_clock_inconsistent";
  const hostNetwork = alert?.host_network || null;
  const primaryNetworkInterface = hostNetwork?.interfaces.find((item) => item.main) || null;
  const secondaryIp = hostNetwork?.primary_ip ? null : primaryNetworkInterface?.ip || null;
  const tags = alert ? collectOperationalTags(alert) : [];
  const nestedAlertArtifact = useMemo(() => {
    if (!alert || !nestedIncident) return null;
    return buildAlertArtifactFromOneViewAlert(alert, nestedIncident);
  }, [alert, nestedIncident]);
  const ackAt = visualAlert ? (visualAlert.acknowledged_source_at || visualAlert.acknowledged_at) : null;
  const ackBy = visualAlert
    ? safeActorName(visualAlert.oneview_ack?.actor_name || visualAlert.acknowledged_source_by || visualAlert.acknowledged_by)
    : null;
  const originAckKind = sourceAckRowKind(visualAlert);
  const sourceAckLabel = sourceAckRowLabel(originAckKind);
  const operatorTag = alert ? primaryPersistedOperatorTag(alert) : null;
  const fonteZabbix = alert ? zabbixSourceDisplayName(alert.datasource_name) : "Fonte não identificada";
  const hostVisible = alert ? displayHostField(alert.host_visible_name, canonicalHostName(alert)) : ORIGIN_UNAVAILABLE;
  const hostTechnical = alert ? displayHostField(alert.host_technical_name, ORIGIN_UNAVAILABLE) : ORIGIN_UNAVAILABLE;
  const queueHref = String(alertsQueueHref || "").trim() || null;
  const communication = useMemo(
    () => alert ? buildAlertClientCommunication({ alert, relatedIncidents }, communicationEdits) : null,
    [alert, communicationEdits, relatedIncidents],
  );
  const recurrence24h = Number(alert?.recurrence_count_24h || 0);
  const recurrence7d = Number(alert?.recurrence_count_7d || 0);
  const recurrenceValue = alert?.is_recurrent || recurrence7d >= 2
    ? `${recurrence7d.toLocaleString("pt-BR")} em 7 dias`
    : "Sem recorrência";
  const recurrenceDetail = recurrence24h > 0
    ? `${recurrence24h.toLocaleString("pt-BR")} nas últimas 24 h`
    : "Nenhum episódio anterior recente";
  const incidentReference = (() => {
    const related = relatedIncidents.find((item) => item.number || item.sys_id);
    if (related) {
      return {
        number: related.number,
        sys_id: related.sys_id,
        url: related.servicenow_url || null,
        extra_count: Math.max(0, relatedIncidents.filter((item) => item.number || item.sys_id).length - 1),
      };
    }
    if (timelineServiceNowReference?.number || timelineServiceNowReference?.sys_id) {
      return {
        number: timelineServiceNowReference.number || null,
        sys_id: timelineServiceNowReference.sys_id || null,
        url: timelineServiceNowReference.url || null,
        extra_count: 0,
      };
    }
    return alert?.servicenow_reference || null;
  })();
  const claimIncident = relatedIncidents.find((item) => item.sys_id || item.number)
    || (alert?.servicenow_reference?.sys_id || alert?.servicenow_reference?.number
      ? {
          sys_id: alert.servicenow_reference.sys_id,
          number: alert.servicenow_reference.number,
          identity_conflict: false,
          assigned_to: null,
          assigned_to_display: null,
        }
      : null);
  const headerAlertArtifact = alert && claimIncident
    ? buildAlertArtifactFromOneViewAlert(alert, {
        number: claimIncident.number,
        assigned_to: claimIncident.assigned_to,
        assigned_to_display: claimIncident.assigned_to_display,
      })
    : null;
  const fallbackRecurrenceEpisodes: RecurrenceTimelineEpisode[] = alert ? [
    recurrenceEpisodeFromAlert(alert, alert.id),
    ...(alert.recurrence_previous?.occurrence_at ? [{
      id: `previous-${alert.id}`,
      startedAt: alert.recurrence_previous.occurrence_at,
      resolvedAt: alert.recurrence_previous.recovery_at,
      durationSeconds: alert.recurrence_previous.duration_seconds,
      active: !alert.recurrence_previous.recovery_at,
      current: false,
      acknowledgedBy: safeActorName(alert.recurrence_previous.acknowledged_by),
      incidentNumber: alert.recurrence_previous.incident?.number || null,
      incidentSysId: alert.recurrence_previous.incident?.sys_id || null,
      incidentUrl: alert.recurrence_previous.incident?.url || null,
    }] : []),
  ] : [];
  const visibleRecurrenceEpisodes = recurrenceEpisodes.length ? recurrenceEpisodes : fallbackRecurrenceEpisodes;
  const previousHistoryEpisodes = visibleRecurrenceEpisodes.filter((item) => !item.current);
  const previousHistoryTotal = Math.max(previousHistoryEpisodes.length, Math.max(0, recurrenceTimelineTotal - 1));
  const ackDetail = originAckKind === "acknowledged"
    ? [ackBy ? `por ${ackBy}` : null, ackAt ? formatDateTime(ackAt) : null].filter(Boolean).join(" · ") || "Confirmado na origem"
    : sourceAckIsPending(visualAlert)
      ? "Aguardando confirmação da origem"
      : originAckKind === "pending"
        ? "Sem confirmação da origem"
        : "Resolvido sem reconhecimento na origem";

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-2xl">
        <OneViewErrorBoundary scope="drawer" resetKeys={[alert?.id ?? ""]}>
        {!alert ? (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do alerta</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-6 py-5">
              {error ? <OperationalErrorBanner message={error} /> : null}
              {isLoading ? (
                <div className="space-y-3"><Skeleton className="h-28 w-full" /><Skeleton className="h-40 w-full" /></div>
              ) : (
                <p className="text-sm text-muted-foreground">Selecione um alerta para ver o detalhe.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="text-xl">Detalhe do alerta</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {visualAlert ? (
                  <AlertSourceAckAction
                    alert={visualAlert}
                    variant="button"
                    livePollEnabled={false}
                    onRequestAccepted={onSourceAckRequestAccepted}
                    onAcknowledged={onSourceAcknowledged}
                    liveStateUnavailable={liveStateUnavailable}
                    probeEnabled
                  />
                ) : null}
                {claimIncident ? (
                  <IncidentActions
                    incident={{
                      sys_id: claimIncident.sys_id,
                      number: claimIncident.number,
                      state: "state" in claimIncident ? claimIncident.state : null,
                      identity_conflict: Boolean(claimIncident.identity_conflict),
                      assigned_to: claimIncident.assigned_to,
                      assigned_to_display: claimIncident.assigned_to_display,
                    }}
                    alertArtifact={headerAlertArtifact}
                    placement="header"
                    visibleActions={["claim"]}
                    mutationsBlocked={liveStateUnavailable}
                    onClaimed={applyClaimedIncident}
                  />
                ) : null}
                <AlertOperationalShareActions
                  alert={alert}
                  communication={communication!}
                  relatedIncidents={relatedIncidents}
                  historyItems={historyItems}
                  onCommunicationChange={handleCommunicationChange}
                  liveStateUnavailable={liveStateUnavailable}
                />
              </div>
            </SheetHeader>

            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as AlertDetailDrawerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-6 mt-4 grid w-auto grid-cols-3">
                <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                <TabsTrigger value="history"><History className="mr-1.5 h-4 w-4" />Histórico</TabsTrigger>
                <TabsTrigger value="technical"><Info className="mr-1.5 h-4 w-4" />Técnico</TabsTrigger>
              </TabsList>

              {error ? <OperationalErrorBanner className="mx-6 mt-4 px-3 py-2" message={error} /> : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                <TabsContent value="summary" forceMount className="mt-4 space-y-4 data-[state=inactive]:hidden">
                  <section className="rounded-xl border border-border/70 bg-gradient-to-b from-muted/30 to-background p-4" aria-label="Cabeçalho do alerta">
                    <div className="flex min-w-0 items-start gap-3">
                      <ClientIdentity
                        customer={customer}
                        operationalScope={alert.operational_scope}
                        operationalScopeLabel={alert.operational_scope_label}
                        size="lg"
                        className="mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-base font-semibold leading-tight text-foreground">{clientName}</p>
                            <p className="mt-0.5 truncate text-sm text-muted-foreground">{hostVisible}</p>
                            {showPending ? <p className="mt-1 text-xs text-muted-foreground">{CLASSIFICATION_PENDING_LABEL}</p> : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <SeverityBadge severity={alert.severity} />
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                resolved
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-rose-200 bg-rose-50 text-rose-700",
                              )}
                            >
                              {resolved ? "Resolvido" : "Ativo"}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 border-t border-border/60 pt-3">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
                      <p className="mt-1 break-words text-sm font-semibold leading-5 text-foreground">
                        {String(alert.problem_name || alert.trigger_description || "").trim() || "Alerta sem descrição"}
                      </p>
                    </div>
                  </section>

                  <section aria-label="Situação rápida" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <QuickFact
                      icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                      label="ACK"
                      value={sourceAckLabel}
                      detail={ackDetail}
                      tone={sourceAckRowTone(originAckKind)}
                    />
                    <QuickFact
                      icon={<Clock3 className="h-3.5 w-3.5" />}
                      label="Duração"
                      value={formatDurationSeconds(alert.duration_seconds)}
                      detail={resolved ? "Episódio encerrado" : "Episódio atual"}
                    />
                    <QuickFact
                      icon={<Repeat2 className="h-3.5 w-3.5" />}
                      label="Recorrência"
                      value={recurrenceValue}
                      detail={recurrenceTimelineOpen ? "Ocultar linha do tempo" : recurrenceDetail}
                      tone={alert.is_recurrent || recurrence7d >= 2 ? "warning" : "neutral"}
                      pressed={recurrenceTimelineOpen}
                      ariaLabel={recurrenceTimelineOpen ? "Ocultar linha do tempo da recorrência" : "Mostrar linha do tempo da recorrência"}
                      onClick={() => setRecurrenceTimelineOpen((current) => !current)}
                    />
                    <QuickFact
                      icon={<Activity className="h-3.5 w-3.5" />}
                      label="Atualização"
                      value={formatTime(alert.last_seen_at)}
                      detail={`${formatDate(alert.last_seen_at)} · ${resolved ? "último evento" : "sinal mais recente"}`}
                    />
                  </section>

                  {recurrenceTimelineOpen ? (
                    <section aria-label="Linha do tempo da recorrência" className="rounded-xl border border-border/70 bg-background p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                        <div>
                          <h3 className="text-sm font-semibold">Linha do tempo da recorrência</h3>
                          <p className="mt-0.5 text-xs text-muted-foreground">Mesmo host e trigger, da mais recente para a anterior.</p>
                        </div>
                        {recurrenceTimelineTotal > visibleRecurrenceEpisodes.length ? (
                          <span className="text-[11px] text-muted-foreground">
                            {visibleRecurrenceEpisodes.length.toLocaleString("pt-BR")} de {recurrenceTimelineTotal.toLocaleString("pt-BR")}
                          </span>
                        ) : null}
                      </div>
                      {recurrenceTimelineLoading ? (
                        <p className="mt-3 text-xs text-muted-foreground">Carregando ocorrências…</p>
                      ) : null}
                      {recurrenceTimelineError ? (
                        <p className="mt-3 text-sm text-muted-foreground">{recurrenceTimelineError}</p>
                      ) : null}
                      {recurrenceTimelineLoading && !visibleRecurrenceEpisodes.length ? (
                        <div className="mt-4 space-y-3">
                          <Skeleton className="h-12 w-full" />
                          <Skeleton className="h-12 w-full" />
                        </div>
                      ) : (
                        <div className="relative ml-2 mt-4 border-l border-border" aria-label="Episódios da recorrência">
                          {visibleRecurrenceEpisodes.map((item, index) => (
                            <article key={item.id} className={cn("relative pb-5 pl-6", index === visibleRecurrenceEpisodes.length - 1 && "pb-0")}>
                              <span
                                className={cn(
                                  "absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 ring-4 ring-background",
                                  item.current ? "border-foreground bg-foreground" : item.active ? "border-rose-500 bg-rose-500" : "border-emerald-500 bg-emerald-500",
                                )}
                                aria-hidden="true"
                              />
                              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <p className="text-sm font-semibold text-foreground">
                                  {item.current ? "Esta ocorrência" : item.active ? "Em falha" : "Recuperada"}
                                </p>
                                <time className="text-[11px] text-muted-foreground">{formatDateTime(item.startedAt)}</time>
                              </div>
                              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                                {item.resolvedAt ? `Recuperado em ${formatDateTime(item.resolvedAt)}` : "Ainda sem recovery"}
                                {" · "}
                                {formatDurationSeconds(item.durationSeconds)}
                              </p>
                              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <span className="shrink-0">inc:</span>
                                {item.incidentNumber || item.incidentSysId ? (
                                  <AlertServiceNowReferenceCell
                                    reference={{
                                      number: item.incidentNumber,
                                      sys_id: item.incidentSysId,
                                      url: item.incidentUrl,
                                      extra_count: 0,
                                    }}
                                  />
                                ) : (
                                  <span>—</span>
                                )}
                              </p>
                            </article>
                          ))}
                        </div>
                      )}
                    </section>
                  ) : null}

                  <AlertRelatedIncidentsSection
                    sourceEventId={alert.source_event_id}
                    severity={alert.severity}
                    historyItems={historyItems}
                    alert={alert}
                    alertArtifact={headerAlertArtifact}
                    mutationsBlocked={liveStateUnavailable}
                    onOpenIncidentDetail={(item) => setNestedIncident(relatedIncidentToOneViewIncident(item))}
                    onTimelineServiceNowReferenceChange={handleTimelineServiceNowReferenceChange}
                    onRelatedIncidentsChange={handleRelatedIncidentsChange}
                    onClaimed={(result) => applyClaimedIncident(result)}
                  />

                  <section aria-label="Informações do alerta" className="rounded-lg border border-border/70 bg-background p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">Identificação</h3>
                      <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                        <span className="shrink-0 text-muted-foreground">inc:</span>
                        {incidentReference?.number || incidentReference?.sys_id ? (
                          <AlertServiceNowReferenceCell reference={incidentReference} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Host" value={hostVisible} />
                      <DetailField label="Equipamento" value={hostTechnical === ORIGIN_UNAVAILABLE ? hostVisible : hostTechnical} />
                      <DetailField label="Início" value={formatDateTime(alert.first_seen_at)} />
                      <DetailField label="Estado" value={resolved ? "Resolvido" : "Ativo"} />
                    </dl>
                  </section>

                  <AlertRecurrenceSignal alert={alert} />
                </TabsContent>

                <TabsContent value="history" className="mt-4 space-y-4">
                  <section aria-label="Histórico de ocorrências" className="rounded-xl border border-border/70 bg-background p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                      <div>
                        <h3 className="text-sm font-semibold">Ocorrências anteriores</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">Mesmo host e trigger, da mais recente para a mais antiga.</p>
                      </div>
                      {previousHistoryTotal > previousHistoryEpisodes.length ? (
                        <span className="text-[11px] text-muted-foreground">
                          {previousHistoryEpisodes.length.toLocaleString("pt-BR")} de {previousHistoryTotal.toLocaleString("pt-BR")}
                        </span>
                      ) : null}
                    </div>
                    {recurrenceTimelineLoading && !previousHistoryEpisodes.length ? (
                      <div className="mt-4 space-y-3">
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-20 w-full" />
                      </div>
                    ) : recurrenceTimelineError && !previousHistoryEpisodes.length ? (
                      <p className="py-10 text-center text-sm text-muted-foreground">{recurrenceTimelineError}</p>
                    ) : previousHistoryEpisodes.length ? (
                      <div className="mt-4 space-y-3">
                        {previousHistoryEpisodes.map((item) => (
                          <article key={item.id} className="rounded-lg border border-border/60 bg-muted/15 p-3">
                            <dl className="grid gap-3 text-sm sm:grid-cols-2">
                              <DetailField label="Início" value={formatDateTime(item.startedAt)} />
                              <DetailField label="Recovery" value={item.resolvedAt ? formatDateTime(item.resolvedAt) : "Ainda sem recovery"} />
                              <DetailField label="Duração" value={formatDurationSeconds(item.durationSeconds)} />
                              <DetailField label="ACK" value={item.acknowledgedBy || "—"} />
                            </dl>
                            <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[11px]">
                              <span className="shrink-0 text-muted-foreground">Chamado</span>
                              {item.incidentNumber || item.incidentSysId ? (
                                <AlertServiceNowReferenceCell
                                  reference={{
                                    number: item.incidentNumber,
                                    sys_id: item.incidentSysId,
                                    url: item.incidentUrl,
                                    extra_count: 0,
                                  }}
                                />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="py-10 text-center text-sm text-muted-foreground">
                        {alert.recurrence_key
                          ? "Nenhuma ocorrência anterior registrada."
                          : "Identidade de recorrência indisponível; nenhum agrupamento foi inferido."}
                      </p>
                    )}
                  </section>
                </TabsContent>

                <TabsContent value="technical" className="mt-4 space-y-4">
                  <section aria-label="Identidade técnica" className="space-y-2">
                    <h3 className="text-sm font-semibold">Identidade</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Cliente" value={clientName} />
                      <DetailField
                        label="Trigger/Problema"
                        value={String(alert.problem_name || alert.trigger_description || "").trim() || "Alerta sem descrição"}
                      />
                      <DetailField label="Severidade" value={formatOneViewSeverityLabel(alert.severity)} />
                      <DetailField label="Host visível" value={hostVisible} />
                      <DetailField label="Host técnico" value={hostTechnical} />
                    </dl>
                  </section>

                  <section aria-label="Estado técnico" className="space-y-2">
                    <h3 className="text-sm font-semibold">Estado e tempos</h3>
                    <AlertRecurrenceSignal alert={alert} />
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Estado da origem" value={originStatusLabel(alert.alert_status || alert.status_source)} />
                      <DetailField label="ACK origem" value={sourceAckLabel} />
                      <DetailField label="ACK OneView" value={oneViewAckStatusLabel(alert.oneview_ack?.status)} />
                      <DetailField label="Responsável" value={ackBy || "Sem responsável"} />
                      <DetailField label="Primeira ocorrência" value={formatDateTime(alert.first_seen_at)} />
                      <DetailField label="Última ocorrência" value={formatDateTime(alert.last_seen_at)} />
                      <DetailField label="Recuperação" value={formatDateTime(alert.resolved_at)} />
                    </dl>
                    {temporalInconsistent ? <p className="text-xs text-muted-foreground">Relógio da origem inconsistente.</p> : null}
                  </section>

                  <AlertSameProblemContext alert={alert} />

                  <section aria-label="Fonte" className="space-y-2">
                    <h3 className="text-sm font-semibold">Fonte</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Fonte Zabbix" value={fonteZabbix} />
                      <DetailField label="Tipo de fonte" value={String(alert.source_type || "").trim() || "Não informado"} />
                      <DetailField label="Event ID" value={String(alert.source_event_id || "").trim() || "Não informado"} mono />
                    </dl>
                  </section>

                  {alert.operator_link ? (
                    <AlertOperatorLinkControls alert={alert} mutationsBlocked={liveStateUnavailable} />
                  ) : operatorTag ? (
                    <section aria-label="Operadora" className="space-y-2">
                      <h3 className="text-sm font-semibold">Operadora</h3>
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <DetailField label="Operadora/tag" value={operatorTag.tag || operatorTag.value || ORIGIN_UNAVAILABLE} />
                        <DetailField label="Descrição" value={operatorTag.tag || ORIGIN_UNAVAILABLE} />
                        <DetailField label="Valor persistido" value={operatorTag.value || ORIGIN_UNAVAILABLE} />
                      </dl>
                    </section>
                  ) : null}

                  <section aria-label="Host técnico" className="space-y-2">
                    <h3 className="text-sm font-semibold">Host</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Nome visível" value={displayHostField(alert.host_visible_name) || hostName} />
                      <DetailField label="Nome técnico" value={displayHostField(alert.host_technical_name, ORIGIN_UNAVAILABLE)} />
                      {!hostNetwork?.interfaces.length ? <DetailField label="Rede" value={ORIGIN_UNAVAILABLE} /> : (
                        <>
                          {hostNetwork.primary_ip ? <DetailField label="IP principal" value={hostNetwork.primary_ip} mono /> : null}
                          {hostNetwork.primary_dns ? <DetailField label="DNS" value={hostNetwork.primary_dns} mono /> : null}
                          {secondaryIp ? <DetailField label="IP secundário" value={secondaryIp} mono /> : null}
                          <DetailField label="Interface" value={hostNetwork.interface_type || ORIGIN_UNAVAILABLE} />
                          {hostNetwork.port ? <DetailField label="Porta" value={hostNetwork.port} mono /> : null}
                        </>
                      )}
                    </dl>
                  </section>

                  <section aria-label="Grupos e tags" className="space-y-2">
                    <h3 className="text-sm font-semibold">Grupos e tags</h3>
                    <div>
                      <p className="text-xs text-muted-foreground">Grupos</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {alert.host_groups?.length
                          ? alert.host_groups.map((group, index) => (
                              <Badge key={`${group.id ?? group.name}-${index}`} variant="outline">
                                {String(group.name || "").trim() || "Grupo sem nome"}
                              </Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">Nenhum grupo disponível.</span>}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Tags operacionais</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {tags.length
                          ? tags.map((tag, index) => (
                              <Badge key={`${tag.tag}-${tag.value}-${index}`} variant="secondary">
                                {tag.tag}{tag.value ? `: ${tag.value}` : ""}
                              </Badge>
                            ))
                          : <span className="text-xs text-muted-foreground">Nenhuma tag disponível.</span>}
                      </div>
                    </div>
                  </section>

                  {!isNonCustomerOperationalScope(scope) ? (
                    <section aria-label="Classificação" className="space-y-2">
                      <h3 className="text-sm font-semibold">Classificação</h3>
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <DetailField label="Origem da classificação" value={customerSourceLabel(alert.customer_source)} />
                        <DetailField label="Confiança" value={confidenceLabel(alert.customer_confidence)} />
                        <DetailField label="Severidade (dado)" value={formatOneViewSeverityLabel(alert.severity)} />
                      </dl>
                    </section>
                  ) : null}

                  <section aria-label="Auditoria da identidade" className="space-y-2">
                    <h3 className="text-sm font-semibold">Auditoria da identidade</h3>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <DetailField label="Fonte da identidade do cliente" value={customerSourceLabel(alert.customer_source)} />
                      <DetailField label="Confiança" value={confidenceLabel(alert.customer_confidence)} />
                      <DetailField
                        label="Datasource"
                        value={formatZabbixSourceAudit({
                          data_source_id: alert.data_source_id,
                          datasource_name: alert.datasource_name,
                        })}
                        mono
                      />
                      <DetailField label="source_event_id" value={String(alert.source_event_id || "").trim() || ORIGIN_UNAVAILABLE} mono />
                    </dl>
                  </section>
                </TabsContent>
              </div>

              {queueHref ? (
                <div className="shrink-0 border-t border-border/60 px-6 py-3">
                  <Link
                    to={queueHref}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Ver na fila de Alertas
                  </Link>
                </div>
              ) : null}
            </Tabs>
          </div>
        )}
        </OneViewErrorBoundary>
      </SheetContent>
    </Sheet>
    <IncidentDetailDrawer
      incident={nestedIncident}
      stacked
      alertArtifact={nestedAlertArtifact}
      onOpenChange={(next) => { if (!next) setNestedIncident(null); }}
      mutationsBlocked={liveStateUnavailable}
      onActionComplete={() => onIncidentClaimed?.()}
      description="Consulta rápida sem sair do alerta."
    />
    </>
  );
}
