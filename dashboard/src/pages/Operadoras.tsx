import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, ChevronDown, Link as LinkIcon, Loader2, RotateCcw, Search } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableToolbar } from "@/components/oneview/ConfigurableTableTools";
import { useOneViewCommittedSearch } from "@/components/oneview/OneViewTableSearchField";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import { IncidentDetailActions } from "@/components/oneview/IncidentDetailActions";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { buildAlertArtifactFromCanonicalLink } from "@/lib/oneview-alert-artifact";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { OneViewKpiCard, OneViewSemanticStatusBadge, SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { OneViewIncidentStatusBadge } from "@/components/badges/OneViewIncidentStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cancelOperatorReminder, createOperatorReminder, fetchCanonicalLinkDetail, fetchCanonicalLinks, fetchIncidentDetail, fetchOperatorReminderDeepLink, fetchOperatorReminderFeed, fetchOperatorReminders, getCachedOperatorReminders, OneViewApiError, operatorReminderIdentity, updateOperatorReminder, type CanonicalLink, type CanonicalLinkDetail, type CanonicalLinkIncident, type CanonicalLinksResponse, type OneViewIncident, type OperatorReminder, type OperatorReminderFeed, type OperatorReminderFeedItem, type OperatorReminderInboxLink } from "@/lib/oneview-api";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import { cn } from "@/lib/utils";
import { oneViewIncidentStatusVisual } from "@/lib/oneview-incident-status-visual";
import { OV_FILTER_CHIP, OV_FILTER_CONTROL, OV_TABLE_HEAD } from "@/lib/oneview-operational-ui";
import { useAuthContext } from "@/context/AuthContext";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { dashboardWidgetsForPage } from "@/lib/oneview-dashboard-layout";

const ALL = "all";
const REFRESH_MS = 10_000;
const REMINDERS_REFRESH_MS = 30_000;
const RECENT_EPISODE_PREVIEW = 5;
const DETAIL_CACHE_TTL_MS = 60_000;
let drawerOpenedAt = 0;
const LINK_TABLE_COLUMNS = [
  { id: "link_local", label: "Link / local", required: true },
  { id: "situation", label: "Situação" },
  { id: "latest_alert", label: "Último alerta" },
  { id: "current_incident", label: "Chamado atual" },
  { id: "follow_up", label: "Acompanhamento" },
  { id: "link_type", label: "Tipo do link", defaultVisible: false },
  { id: "carrier", label: "Operadora", defaultVisible: false },
  { id: "datasource", label: "Fonte Zabbix", defaultVisible: false },
  { id: "severity", label: "Severidade", defaultVisible: false },
  { id: "classification", label: "Classificação", defaultVisible: false },
] as const;
type LinkTableColumnId = typeof LINK_TABLE_COLUMNS[number]["id"];
const OPERATOR_DASHBOARD_WIDGETS = dashboardWidgetsForPage("operators").filter((widget) => widget.id !== "operators-filters");
type QueueTab = "open" | "normalized" | "all";
type OperationalSituation = "all" | "failure_without_incident" | "failure_with_open_incident" | "failure_with_closed_incident" | "normalized_with_open_incident" | "normalized_without_open_incident";
type ActivityPeriod = "all" | "1h" | "4h" | "24h" | "7d";
type PageView = "queue" | "reminders";
type ReminderScope = "all" | "mine";
type ReminderView = "scheduled" | "sent" | "skipped" | "failed" | "cancelled" | "all";
type ReminderPeriod = "all" | "30m" | "1h" | "4h" | "8h" | "24h" | "7d" | "custom";
type ReminderIncidentFilter = "all" | "with" | "without";
type ReminderSort = "default" | "recent" | "oldest";
type ReminderDeepLinkInput = { id: string; link: OperatorReminderInboxLink };

function isAbortError(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError" || /signal is aborted|aborted without reason/i.test(cause.message);
}

const text = (value: unknown, empty = "Não informada na origem") => String(value || "").trim() || empty;
function reminderLinkPlaceholder(input: ReminderDeepLinkInput, snapshot: Record<string, unknown> = {}): CanonicalLink {
  const link = input.link;
  return {
    id: link.circuit_key || link.source_host_id || "reminder-link",
    circuit_key: link.circuit_key,
    data_source_id: link.data_source_id,
    datasource: link.data_source_id,
    source_host_id: link.source_host_id || "",
    host_name: snapshotText(snapshot, "circuit", "host_name") || null,
    customer_name: snapshotText(snapshot, "customer", "name") || "Cliente não informado",
    customer_key: snapshotText(snapshot, "customer", "key") || "unclassified",
    service_name: snapshotText(snapshot, "link", "service_name") || snapshotText(snapshot, "alert", "problem_name") || "Link indisponível",
    state: "attention",
    active_alerts: 0,
    unack_alerts: 0,
    high_alerts: 0,
    disaster_alerts: 0,
    average_alerts: 0,
    warning_alerts: 0,
    incident_count: null,
    operational_subject: {
      subject_type: link.subject_type,
      subject_key: link.subject_key || "",
      circuit_key: link.circuit_key,
      data_source_id: link.data_source_id,
      source_host_id: link.source_host_id,
      source_trigger_id: link.source_trigger_id,
      fallback_subject_keys: [],
    },
  } as CanonicalLink;
}
const optionList = (items: Array<{ value: string; label: string }> | undefined, allLabel = "Todos") => [
  { value: ALL, label: allLabel },
  ...(items || []),
];

function stateLabel(value: CanonicalLink["state"]) {
  return ({ critical: "Crítico", alert: "Alerta", attention: "Atenção", normal: "Normal" })[value];
}

function StateBadge({ state }: { state: CanonicalLink["state"] }) {
  if (state === "critical") return <OneViewSemanticStatusBadge status="monitoring-down" label={stateLabel(state)} />;
  if (state === "normal") return <OneViewSemanticStatusBadge status="monitoring-normalized" label={stateLabel(state)} />;
  return (
    <Badge variant="secondary">
      {stateLabel(state)}
    </Badge>
  );
}

function ResolutionBadge({ link }: { link: CanonicalLink }) {
  if (link.resolution_status === "resolved") return null;
  return <OneViewSemanticStatusBadge status="classification-pending" label="Pendente de classificação" />;
}

function linkTypeLabel(link: CanonicalLink) {
  if (link.resolution_status !== "resolved") return "Não classificado";
  if (link.link_type === "public-internet") return "Internet pública";
  if (link.link_type === "sd-wan") return "SD-WAN";
  if (link.link_type === "uplink") return link.uplink_key || "Uplink";
  return text(link.link_type || link.classification, "Não informado");
}

function failureDuration(link: CanonicalLink) {
  if (!link.active_since_at) return "Tempo indisponível";
  const startedAt = new Date(link.active_since_at).getTime();
  if (!Number.isFinite(startedAt)) return "Tempo indisponível";
  const elapsed = Math.max(0, Date.now() - startedAt);
  const hours = Math.floor(elapsed / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}`;
  return `${minutes}min`;
}

function refreshTime(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function timestampLabel(value: string | null | undefined) {
  if (!value) return "Horário indisponível";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário indisponível";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function latestAlertLabel(value: string | null | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  const date = new Date(value); const now = new Date();
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  return date.toDateString() === now.toDateString() ? time : `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date)} ${time}`;
}

function localLabel(link: CanonicalLink) { return text(link.site_name || link.site_key || link.host_name, "Local não informado"); }
function linkLabel(link: CanonicalLink) {
  const pending = /pendente de classifica/i.test(String(link.service_name || ""));
  const label = pending
    ? text(link.current_alert?.problem_name || link.latest_alert?.problem_name || link.current_alert?.trigger_description || link.latest_alert?.trigger_description || link.host_name, "Link sem identificação")
    : text(link.service_name, "Link sem identificação");
  if (link.member_key) return `${label} · SD-WAN member ${link.member_key}`;
  if (link.uplink_key && !label.toLowerCase().includes(link.uplink_key.toLowerCase())) return `${label} · ${link.uplink_key}`;
  return label;
}

function incidentAssignee(incident: CanonicalLinkIncident) {
  return text(incident.assigned_to_display || incident.assigned_to, "Responsável não informado");
}

function CurrentIncident({ link }: { link: CanonicalLink }) {
  if (link.incident_correlation_status === "degraded") return <p className="text-xs text-muted-foreground">Chamados não verificados</p>;
  if (link.current_incident) return <div className="space-y-0.5 text-xs"><p className="flex flex-wrap items-center gap-1.5 font-medium"><span>{link.current_incident.number || "INC"}</span><OneViewIncidentStatusBadge state={link.current_incident.state} display={link.current_incident.state_display} /></p><p className="truncate text-muted-foreground">Responsável: {incidentAssignee(link.current_incident)}</p><p className="text-muted-foreground">Aberto {timestampLabel(link.current_incident.opened_at)}</p></div>;
  if (link.latest_incident) return <div className="space-y-0.5 text-xs"><p className="flex flex-wrap items-center gap-1.5"><span>{link.latest_incident.number || "INC"}</span><OneViewIncidentStatusBadge state={link.latest_incident.state} display={link.latest_incident.state_display} /></p><p className="truncate text-muted-foreground">Último responsável: {incidentAssignee(link.latest_incident)}</p><p className="text-muted-foreground">Sem chamado aberto</p></div>;
  return <p className="text-xs text-muted-foreground">Sem chamado</p>;
}

function divergenceLabel(link: CanonicalLink) {
  const incident = link.current_incident || link.latest_incident;
  const state = oneViewIncidentStatusVisual(incident?.state, incident?.state_display).label;
  if (link.divergence_type === "a") return `Alerta ativo com chamado ${state}`;
  if (link.divergence_type === "b") return `Normalizado com chamado ${state}`;
  return "Não";
}

function DivergenceHint({ link }: { link: CanonicalLink }) {
  if (link.divergence_type) return <OneViewSemanticStatusBadge status="divergence" label={divergenceLabel(link)} />;
  return null;
}

function MonitoringStatus({ link }: { link: CanonicalLink }) {
  const failing = Boolean(link.active_alerts);
  return (
    <div className="min-w-0 space-y-1">
      <OneViewSemanticStatusBadge status={failing ? "monitoring-down" : "monitoring-normalized"} label={failing ? `Em falha há ${failureDuration(link)}` : "Normalizado"} />
      <div className="flex flex-wrap items-center gap-1">
        {link.max_severity ? <SeverityBadge severity={link.max_severity} /> : null}
        <DivergenceHint link={link} />
      </div>
    </div>
  );
}

function FollowUp({ link }: { link: CanonicalLink }) {
  return link.resolution_status !== "resolved" ? <OneViewSemanticStatusBadge status="classification-pending" /> : <span className="text-muted-foreground">—</span>;
}
function queueReminderKey(dataSourceId: string, subjectType: string | null | undefined, subjectKey: string | null | undefined) {
  return subjectType && subjectKey ? `${dataSourceId}:${subjectType}:${subjectKey}` : null;
}
function queueReminderForLink(link: CanonicalLink, reminders: Map<string, OperatorReminderFeedItem>) {
  const subject = link.operational_subject;
  const keys = [queueReminderKey(link.data_source_id, subject?.subject_type, subject?.subject_key), ...(subject?.fallback_subject_keys || []).map((key) => queueReminderKey(link.data_source_id, "alert_subject", key))];
  return keys.map((key) => key ? reminders.get(key) : null).find(Boolean) || getCachedOperatorReminders(link)?.[0] || null;
}
function ReminderQuickAction({ link, reminder, onOpen }: { link: CanonicalLink; reminder: OperatorReminderFeedItem | OperatorReminder | null; onOpen: (link: CanonicalLink) => void }) {
  const stable = Boolean(link.operational_subject?.subject_key);
  const enabled = stable && Number(link.active_alerts) > 0;
  const label = reminder?.status === "processing" ? "Processando" : reminder?.status === "scheduled" ? `Agendado ${timestampLabel(reminder.scheduled_for)}` : "Lembrar";
  return <div className="min-w-0 space-y-1"><Button type="button" size="sm" variant="outline" className="h-7 max-w-full px-2 text-xs" title="Agendar ou administrar lembrete" disabled={!enabled} onClick={(event) => { event.stopPropagation(); onOpen(link); }}>{label}</Button>{reminder ? <p className="truncate text-[11px] text-muted-foreground" title={text(reminder.created_by_name, "Operador não identificado")}>Lembrete de {text(reminder.created_by_name, "Operador não identificado")}</p> : null}</div>;
}
function RecurrenceHint({ link }: { link: CanonicalLink }) {
  const count = Number(link.occurrences_24h || 0);
  if (!link.is_recurrent || count < 2) return null;
  return <OneViewSemanticStatusBadge status="recurrence" label={`${count} quedas / 24h`} />;
}
function RecurrencePanel({ link }: { link: CanonicalLink | CanonicalLinkDetail }) {
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null);
  const recent = "recent_episodes" in link ? link.recent_episodes || [] : [];
  const total = Number(link.total_recent_episodes || recent.length || 0);
  const visible = showAllRecent ? recent : recent.slice(0, RECENT_EPISODE_PREVIEW);
  const canExpand = recent.length > RECENT_EPISODE_PREVIEW || total > recent.length;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Recorrência</h3>
      <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
        <Field label="24h" value={`${Number(link.occurrences_24h || 0)} quedas`} />
        <Field label="7d" value={`${Number(link.occurrences_7d || 0)} quedas`} />
        <Field label="Última recuperação" value={timestampLabel(link.last_recovery_at)} />
        <Field label="Última nova falha" value={timestampLabel(link.last_failure_at)} />
      </div>
      {recent.length ? (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Ocorrências recentes</p>
          {visible.map((item, index) => {
            const key = `${item.started_at || "start"}-${index}`;
            const expanded = expandedEpisode === key;
            return <div key={key} className="rounded-md border border-border/50 px-2 py-1.5">
              <button type="button" className="w-full text-left" aria-expanded={expanded} onClick={() => setExpandedEpisode((value) => value === key ? null : key)}>
                <p>{item.active ? "●" : "○"} {timestampLabel(item.started_at)}{item.resolved_at ? ` → ${timestampLabel(item.resolved_at)}` : " → em falha"}</p>
                {item.incident_number ? <p className="flex flex-wrap items-center gap-1.5"><span>{item.incident_number}</span><OneViewIncidentStatusBadge state={item.incident_state} /></p> : <p>Sem chamado correlacionado</p>}
                <span className="text-primary">{expanded ? "Recolher detalhes" : "Ver detalhes"}</span>
              </button>
              {expanded ? <div className="mt-2 grid gap-2 border-t border-border/50 pt-2 sm:grid-cols-2"><Field label="Início" value={timestampLabel(item.started_at)} /><Field label="Fim" value={item.resolved_at ? timestampLabel(item.resolved_at) : "Em falha"} /><Field label="Duração" value={item.duration_seconds == null ? "Não informado" : `${Math.floor(item.duration_seconds / 60)} min`} /><Field label="Estado" value={item.active ? "Em falha" : "Normalizado"} /><Field label="Alerta / trigger" value={item.alert_titles?.join(" · ") || item.source_trigger_ids?.join(", ") || "Não informado"} /><Field label="Severidade" value={item.severities?.join(", ") || "Não informada"} /><Field label="INC correlacionado" value={item.incident_number || "Sem chamado correlacionado"} /><Field label="Estado do INC" value={item.incident_state || "Não informado"} />{item.incident_sys_id ? <div className="sm:col-span-2"><IncidentDetailPanel incident={{ sys_id: item.incident_sys_id, number: item.incident_number || "INC" }} /></div> : null}</div> : null}
            </div>;
          })}
          {canExpand ? (
            <Button type="button" size="sm" variant="outline" className="mt-1 h-7" onClick={() => setShowAllRecent((value) => !value)}>
              {showAllRecent ? "Mostrar menos" : `Ver mais (${total})`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-full min-w-0")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ColumnHeaderFilter({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn(OV_FILTER_CONTROL, "mt-1 h-7 w-full min-w-0 text-[11px]")} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const OPERATIONAL_SITUATION_FILTER_OPTIONS = [
  { value: ALL, label: "Todas" },
  { value: "failure_without_incident", label: "Falha sem chamado" },
  { value: "failure_with_open_incident", label: "Falha com chamado aberto" },
  { value: "failure_with_closed_incident", label: "Falha com chamado encerrado" },
  { value: "normalized_with_open_incident", label: "Normalizado com chamado aberto" },
  { value: "normalized_without_open_incident", label: "Normalizado sem chamado" },
] as const;

const CHAMADO_FILTER_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "no", label: "Sem chamado" },
  { value: "yes", label: "Com chamado" },
];

const INCIDENT_STATE_FILTER_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "1", label: "Novo" },
  { value: "2", label: "Em andamento" },
  { value: "3", label: "Em espera" },
  { value: "6", label: "Resolvido" },
  { value: "7", label: "Fechado" },
  { value: "8", label: "Cancelado" },
];

const ACTIVITY_PERIOD_FILTER_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const SEVERITY_FILTER_OPTIONS = [
  { value: ALL, label: "Todas" },
  { value: "disaster", label: "Disaster" },
  { value: "high", label: "High" },
  { value: "average", label: "Average" },
  { value: "warning", label: "Warning" },
];

function LinkTableColumnHeader({
  column,
  facets,
  operationalSituation,
  activityPeriod,
  chamadoChip,
  incidentState,
  datasource,
  severity,
  classification,
  carrier,
  onOperationalSituationChange,
  onActivityPeriodChange,
  onChamadoChange,
  onIncidentStateChange,
  onDatasourceChange,
  onSeverityChange,
  onClassificationChange,
  onCarrierChange,
}: {
  column: { id: LinkTableColumnId; label: string };
  facets: CanonicalLinksResponse["facets"] | undefined;
  operationalSituation: OperationalSituation;
  activityPeriod: ActivityPeriod;
  chamadoChip: string;
  incidentState: string;
  datasource: string;
  severity: string;
  classification: string;
  carrier: string;
  onOperationalSituationChange: (value: OperationalSituation) => void;
  onActivityPeriodChange: (value: ActivityPeriod) => void;
  onChamadoChange: (value: string) => void;
  onIncidentStateChange: (value: string) => void;
  onDatasourceChange: (value: string) => void;
  onSeverityChange: (value: string) => void;
  onClassificationChange: (value: string) => void;
  onCarrierChange: (value: string) => void;
}) {
  const filter = (() => {
    if (column.id === "situation") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por situação"
          value={operationalSituation}
          options={[...OPERATIONAL_SITUATION_FILTER_OPTIONS]}
          onChange={(value) => onOperationalSituationChange(value as OperationalSituation)}
        />
      );
    }
    if (column.id === "latest_alert") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por período de alerta"
          value={activityPeriod}
          options={ACTIVITY_PERIOD_FILTER_OPTIONS}
          onChange={(value) => onActivityPeriodChange(value as ActivityPeriod)}
        />
      );
    }
    if (column.id === "current_incident") {
      return (
        <div className="space-y-1">
          <ColumnHeaderFilter
            ariaLabel="Filtrar por chamado"
            value={chamadoChip}
            options={CHAMADO_FILTER_OPTIONS}
            onChange={onChamadoChange}
          />
          {chamadoChip === "yes" ? (
            <ColumnHeaderFilter
              ariaLabel="Filtrar por status do chamado"
              value={incidentState}
              options={INCIDENT_STATE_FILTER_OPTIONS}
              onChange={onIncidentStateChange}
            />
          ) : null}
        </div>
      );
    }
    if (column.id === "datasource") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por fonte Zabbix"
          value={datasource}
          options={optionList(facets?.datasources).map((item) => ({
            ...item,
            label: item.value === ALL ? item.label : zabbixSourceDisplayName(item.label),
          }))}
          onChange={onDatasourceChange}
        />
      );
    }
    if (column.id === "severity") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por severidade"
          value={severity}
          options={SEVERITY_FILTER_OPTIONS}
          onChange={onSeverityChange}
        />
      );
    }
    if (column.id === "classification") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por classificação"
          value={classification}
          options={optionList(facets?.classifications, "Todas")}
          onChange={onClassificationChange}
        />
      );
    }
    if (column.id === "carrier") {
      return (
        <ColumnHeaderFilter
          ariaLabel="Filtrar por operadora"
          value={carrier}
          options={[
            { value: ALL, label: "Todas" },
            { value: "unknown", label: "Não informada na origem" },
          ]}
          onChange={onCarrierChange}
        />
      );
    }
    return null;
  })();

  return (
    <TableHead key={column.id} className={cn(OV_TABLE_HEAD, "align-top")}>
      <div className="space-y-0.5">
        <span className="block">{column.label}</span>
        {filter}
      </div>
    </TableHead>
  );
}

function ChipGroup({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div aria-label={ariaLabel} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-muted-foreground">{label}</span>
      {options.map(([option, optionLabel]) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={value === option ? "default" : "outline"}
          className={OV_FILTER_CHIP}
          onClick={() => onChange(option)}
        >
          {optionLabel}
        </Button>
      ))}
    </div>
  );
}

function MobileLinkCard({ item, reminder, onOpen }: { item: CanonicalLink; reminder: OperatorReminderFeedItem | OperatorReminder | null; onOpen: (item: CanonicalLink) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full space-y-3 border-b border-border/60 px-3 py-3 text-left last:border-b-0 hover:bg-muted/35"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{text(item.customer_name)} · {localLabel(item)}</p>
          <p className="truncate text-xs text-muted-foreground">{linkLabel(item)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1"><ResolutionBadge link={item} /></div>
      </div>
      <MonitoringStatus link={item} />
      <div className="grid grid-cols-2 gap-2 text-xs"><div><p className="text-muted-foreground">Último alerta</p><p className="font-medium">{latestAlertLabel(item.latest_alert_at)}</p></div><div><p className="text-muted-foreground">Chamado</p><CurrentIncident link={item} /></div></div>
      <div className="flex items-center justify-between gap-2">
        <FollowUp link={item} />
        <div className="flex min-w-0 flex-col items-end gap-1"><RecurrenceHint link={item} />{reminder ? <p className="max-w-48 truncate text-[11px] text-muted-foreground">Lembrete de {text(reminder.created_by_name, "Operador não identificado")}</p> : null}</div>
      </div>
    </button>
  );
}

export default function OperadorasPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const reminderDeepLinkRef = useRef<string | null>(null);
  const { user } = useAuthContext();
  const dashboard = useOneViewDashboardLayout({
    page: "operators",
    actorId: user?.id || user?.email,
    widgets: OPERATOR_DASHBOARD_WIDGETS,
  });
  const linkTableColumns = useOneViewTableColumns({ tableId: "operator-links", actorId: user?.id || user?.email, definitions: LINK_TABLE_COLUMNS });
  const operatorQueuePageSize = dashboard.layout.widgets.find((item) => item.id === "operators-queue")?.itemLimit ?? 50;
  const [payload, setPayload] = useState<CanonicalLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastSuccessfulRefreshAt, setLastSuccessfulRefreshAt] = useState<string | null>(null);
  const [customer, setCustomer] = useState(ALL);
  const [datasource, setDatasource] = useState(ALL);
  const [classification, setClassification] = useState(ALL);
  const [state, setState] = useState(ALL);
  const [ack, setAck] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);
  const [incident, setIncident] = useState(ALL);
  const [incidentState, setIncidentState] = useState(ALL);
  const [carrier, setCarrier] = useState(ALL);
  const [tab, setTab] = useState<QueueTab>("open");
  const [view, setView] = useState<PageView>("queue");
  const [resolvedWindow, setResolvedWindow] = useState("today");
  const [sort, setSort] = useState("recent");
  const [divergence, setDivergence] = useState<"a" | "b" | "any" | "">("");
  const [recurrence, setRecurrence] = useState<"all" | "recurrent">("all");
  const [operationalSituation, setOperationalSituation] = useState<OperationalSituation>("all");
  const [activityPeriod, setActivityPeriod] = useState<ActivityPeriod>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CanonicalLink | null>(null);
  const [reminderRequest, setReminderRequest] = useState<string | null>(null);
  const [queueReminders, setQueueReminders] = useState<Map<string, OperatorReminderFeedItem>>(() => new Map());
  const [detail, setDetail] = useState<CanonicalLinkDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [linkSearchLoading, setLinkSearchLoading] = useState(false);
  const [reminderDeepLink, setReminderDeepLink] = useState<ReminderDeepLinkInput | null>(null);
  const [reminderUnavailable, setReminderUnavailable] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const requestDone = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setPage(1);
  }, [operatorQueuePageSize]);
  const requestVersion = useRef(0);
  const queueRemindersRequestVersion = useRef(0);
  const queueRemindersInFlight = useRef(false);
  const hasPayload = useRef(false);
  const selectedId = useRef<string | null>(null);
  const detailCache = useRef(new Map<string, { value: CanonicalLinkDetail; expiresAt: number }>());
  const detailRequests = useRef(new Map<string, Promise<CanonicalLinkDetail>>());
  const reminderDeepLinkRequest = useRef<AbortController | null>(null);
  const reminderDeepLinkVersion = useRef(0);
  const linkSearchIntent = useRef<{ id: number; value: string } | null>(null);
  const linkSearchIntentId = useRef(0);
  const commitLinkSearch = useCallback((value: string) => {
    if (value === search) return;
    linkSearchIntent.current = { id: ++linkSearchIntentId.current, value };
    setLinkSearchLoading(true);
    setPage(1);
    setSearch(value);
  }, [search]);
  const { commitNow: commitLinkSearchNow, cancelPending: cancelLinkSearch } = useOneViewCommittedSearch(
    searchDraft,
    commitLinkSearch,
  );

  const load = useCallback(async (mode: "initial" | "quiet" | "manual" = "initial") => {
    if (mode === "quiet" && request.current && !request.current.signal.aborted) return;
    const version = ++requestVersion.current;
    const previous = request.current;
    if (previous) {
      previous.abort();
      await requestDone.current?.catch(() => undefined);
    }
    if (version !== requestVersion.current) return;
    const controller = new AbortController();
    const searchIntent = linkSearchIntent.current?.value === search ? linkSearchIntent.current : null;
    request.current = controller;
    let finishRequest: (() => void) | null = null;
    requestDone.current = new Promise<void>((resolve) => { finishRequest = resolve; });
    if (!hasPayload.current) {
      setLoading(true);
      setInitialError(null);
    } else setRefreshing(true);
    try {
      const result = await fetchCanonicalLinks({
        customer,
        datasource,
        classification,
        state,
        ack,
        severity,
        incident,
        incident_state: incidentState === ALL ? undefined : incidentState,
        carrier,
        tab,
        resolved_window: resolvedWindow,
        sort,
        divergence: divergence || undefined,
        recurrence: recurrence === "recurrent" ? "recurrent" : undefined,
        operational_situation: operationalSituation === ALL ? undefined : operationalSituation,
        activity_period: activityPeriod === ALL ? undefined : activityPeriod,
        search,
        page,
        page_size: operatorQueuePageSize,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setPayload(result);
        hasPayload.current = true;
        setLastSuccessfulRefreshAt(new Date().toISOString());
        setInitialError(null);
        setRefreshError(null);
        setLoading(false);
        if (mode !== "quiet") {
          const now = Date.now();
          for (const [key, cached] of detailCache.current) {
            if (cached.expiresAt <= now) detailCache.current.delete(key);
          }
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && !isAbortError(cause)) {
        if (hasPayload.current) setRefreshError("Não foi possível atualizar agora.");
        else setInitialError(cause instanceof Error ? cause.message : "Não foi possível carregar os links.");
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        requestDone.current = null;
        setRefreshing(false);
        if (!controller.signal.aborted && !hasPayload.current) setLoading(false);
      }
      if (searchIntent && linkSearchIntent.current?.id === searchIntent.id) {
        linkSearchIntent.current = null;
        setLinkSearchLoading(false);
      }
      finishRequest?.();
    }
  }, [ack, activityPeriod, carrier, classification, customer, datasource, divergence, incident, incidentState, operationalSituation, operatorQueuePageSize, page, recurrence, resolvedWindow, search, severity, sort, state, tab]);

  const cachedDetail = (key: string) => {
    const cached = detailCache.current.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      detailCache.current.delete(key);
      return undefined;
    }
    return cached.value;
  };

  const loadDetail = useCallback(async (link: CanonicalLink) => {
    const key = `${link.id}:${link.data_source_id}:${link.source_host_id}`;
    const cached = cachedDetail(key);
    if (cached && selectedId.current === key) {
      setDetail(cached);
      setDetailError(null);
      setDetailLoading(false);
    }
    let pending = detailRequests.current.get(key);
    if (!pending) {
      pending = fetchCanonicalLinkDetail(link);
      detailRequests.current.set(key, pending);
    }
    if (selectedId.current === key && !cached) {
      setDetailLoading(true);
      setDetailError(null);
    }
    try {
      const result = await pending;
      detailCache.current.set(key, { value: result, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS });
      if (selectedId.current === key) {
        setDetail(result);
        setDetailError(null);
      }
    } catch (cause) {
      if (selectedId.current === key) setDetailError(cause instanceof Error ? cause.message : "Não foi possível carregar o detalhe.");
    } finally {
      if (detailRequests.current.get(key) === pending) detailRequests.current.delete(key);
      if (selectedId.current === key) setDetailLoading(false);
    }
  }, []);

  const openLink = useCallback((link: CanonicalLink) => {
    reminderDeepLinkVersion.current += 1;
    reminderDeepLinkRequest.current?.abort();
    reminderDeepLinkRequest.current = null;
    const key = `${link.id}:${link.data_source_id}:${link.source_host_id}`;
    selectedId.current = key;
    drawerOpenedAt = performance.now();
    // Open the drawer first; defer heavy detail state work off the click INP path.
    startTransition(() => {
      setSelected(link);
      setDetail(cachedDetail(key) || null);
      setDetailError(null);
      setDetailLoading(!cachedDetail(key));
      setReminderDeepLink(null);
      setReminderUnavailable(null);
    });
    void loadDetail(link);
  }, [loadDetail]);

  const openReminderDeepLink = useCallback(async (input: ReminderDeepLinkInput) => {
    const version = ++reminderDeepLinkVersion.current;
    reminderDeepLinkRequest.current?.abort();
    const controller = new AbortController();
    reminderDeepLinkRequest.current = controller;
    selectedId.current = `reminder:${input.id}`;
    drawerOpenedAt = performance.now();
    startTransition(() => {
      setSelected(reminderLinkPlaceholder(input));
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      setReminderDeepLink(input);
      setReminderUnavailable(null);
    });
    try {
      const result = await fetchOperatorReminderDeepLink(input, controller.signal);
      if (controller.signal.aborted || version !== reminderDeepLinkVersion.current) return;
      if (result.status === "available" && result.link) {
        selectedId.current = `${result.link.id}:${result.link.data_source_id}:${result.link.source_host_id}`;
        setSelected(result.link);
        setDetail(result.link);
        setDetailError(null);
      } else {
        setSelected(reminderLinkPlaceholder(input, result.reminder.context_snapshot));
        setDetail(null);
        setDetailError(null);
        setReminderUnavailable("Este link não está mais ativo no inventário atual. Os dados abaixo pertencem ao lembrete original.");
      }
    } catch (cause) {
      if (!controller.signal.aborted && version === reminderDeepLinkVersion.current) {
        setDetailError(cause instanceof Error ? cause.message : "Não foi possível localizar o link deste lembrete.");
      }
    } finally {
      if (reminderDeepLinkRequest.current === controller) reminderDeepLinkRequest.current = null;
      if (!controller.signal.aborted && version === reminderDeepLinkVersion.current) setDetailLoading(false);
    }
  }, []);

  const closeLink = useCallback(() => {
    reminderDeepLinkVersion.current += 1;
    reminderDeepLinkRequest.current?.abort();
    reminderDeepLinkRequest.current = null;
    selectedId.current = null;
    setReminderRequest(null);
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setReminderDeepLink(null);
    setReminderUnavailable(null);
  }, []);

  const openReminder = useCallback((link: CanonicalLink) => {
    setReminderRequest(`${link.id}:${link.data_source_id}:${link.source_host_id}:${Date.now()}`);
    openLink(link);
  }, [openLink]);

  const loadQueueReminders = useCallback(async () => {
    if (queueRemindersInFlight.current) return;
    queueRemindersInFlight.current = true;
    const version = ++queueRemindersRequestVersion.current;
    try {
      const feed = await fetchOperatorReminderFeed({ status: ["scheduled", "processing"], limit: 100 });
      if (version !== queueRemindersRequestVersion.current) return;
      const next = new Map<string, OperatorReminderFeedItem>();
      for (const item of feed.items) {
        const key = queueReminderKey(item.data_source_id, item.subject_type, item.subject_key);
        if (key) next.set(key, item);
      }
      setQueueReminders(next);
    } catch {
      // Preserva o último snapshot; a lista principal mantém seu próprio estado de erro/freshness.
    } finally {
      queueRemindersInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const ds = searchParams.get("ds")?.trim();
    const host = searchParams.get("host")?.trim();
    if (!ds || !host) return;
    const reminderId = searchParams.get("reminder_id")?.trim() || "";
    const circuit = searchParams.get("circuit")?.trim() || null;
    const subjectType = searchParams.get("subject_type")?.trim();
    const subjectKey = searchParams.get("subject_key")?.trim() || null;
    const trigger = searchParams.get("trigger")?.trim() || null;
    const fingerprint = [reminderId, ds, host, circuit, subjectType, subjectKey, trigger].join(":");
    if (reminderDeepLinkRef.current === fingerprint) return;
    reminderDeepLinkRef.current = fingerprint;
    const operationalSubject = subjectType === "circuit" || subjectType === "alert_subject"
      ? {
        subject_type: subjectType,
        subject_key: subjectKey || "",
        circuit_key: circuit,
        data_source_id: ds,
        source_host_id: host,
        source_trigger_id: trigger,
      }
      : undefined;
    const link = {
      id: circuit || host,
      circuit_key: circuit,
      data_source_id: ds,
      source_host_id: host,
      operational_subject: operationalSubject,
    } as CanonicalLink;
    if (reminderId) {
      if (subjectType === "circuit" || subjectType === "alert_subject") {
        void openReminderDeepLink({ id: reminderId, link: { circuit_key: circuit, data_source_id: ds, source_host_id: host, subject_type: subjectType, subject_key: subjectKey, source_trigger_id: trigger } });
      } else {
        const invalid = { id: reminderId, link: { circuit_key: circuit, data_source_id: ds, source_host_id: host, subject_type: "circuit" as const, subject_key: subjectKey, source_trigger_id: null } };
        selectedId.current = `reminder:${reminderId}`;
        setSelected(reminderLinkPlaceholder(invalid));
        setDetail(null);
        setDetailLoading(false);
        setDetailError("Não foi possível validar a identidade deste lembrete.");
        setReminderDeepLink(null);
        setReminderUnavailable(null);
      }
    } else {
      openLink(link);
    }
    const next = new URLSearchParams(searchParams);
    for (const key of ["reminder_id", "ds", "host", "circuit", "subject_type", "subject_key", "trigger", "reminder_link"]) {
      next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }, [openLink, openReminderDeepLink, searchParams, setSearchParams]);

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; request.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (view !== "queue") return;
    void loadQueueReminders();
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void loadQueueReminders();
    }, REMINDERS_REFRESH_MS);
    return () => {
      window.clearInterval(id);
      queueRemindersRequestVersion.current += 1;
    };
  }, [loadQueueReminders, view]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden || view !== "queue") return;
      void load("quiet");
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden || view !== "queue") return;
      void load("quiet");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, view]);

  const items = payload?.items || [];
  const totals = payload?.totals;
  const setFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };
  const activeFilterCount = [customer, datasource, classification, state, ack, severity, incident, incidentState, carrier, operationalSituation, activityPeriod]
    .filter((value) => value !== ALL).length + (search.trim() ? 1 : 0) + (recurrence === "recurrent" ? 1 : 0) + (divergence ? 1 : 0);
  const panelFilterCount = [state, ack]
    .filter((value) => value !== ALL).length;
  const topbarRightSection = useMemo(() => {
    const checkedAt = payload?.checked_at;
    const checkedAtLabel = checkedAt ? (() => {
      const date = new Date(checkedAt);
      return Number.isNaN(date.getTime()) ? null : date.toLocaleString("pt-BR");
    })() : null;
    if (!checkedAtLabel && !refreshing) return null;
    return (
      <span className="inline-flex whitespace-nowrap text-xs text-muted-foreground">
        {checkedAtLabel ? <>Última consulta: {checkedAtLabel}</> : null}
        {refreshing ? <span title="Atualização em segundo plano" aria-label="Atualização em segundo plano" className="ml-1 inline-flex items-center"><Loader2 className="h-3 w-3 animate-spin opacity-50" /></span> : null}
      </span>
    );
  }, [payload?.checked_at, refreshing]);
  const linkSearchActivity = searchDraft !== search ? "pending" : linkSearchLoading ? "searching" : "idle";
  const visibleLinkColumnIds = linkTableColumns.visibleColumns.map((column) => column.id);
  const chamadoChip = incident === ALL && incidentState === ALL ? ALL : incident;
  const customerOptions = useMemo(() => [
    { key: ALL, name: "Todos" },
    ...(payload?.facets.customers || []).map((item) => ({ key: item.value, name: item.label })),
  ], [payload?.facets.customers]);
  const selectedCustomerKeys = customer === ALL ? [] : [customer];
  const selectedCustomerLabel = customer === ALL
    ? "TODOS"
    : (customerOptions.find((item) => item.key === customer)?.name || customer).toUpperCase();
  const kpis = useMemo(() => [
    { label: "Em falha", value: totals?.operational.open, tone: "danger" as const, tab: "open" as QueueTab, incident: ALL, recurrence: "all" as const, divergence: "" as const, situation: "all" as OperationalSituation },
    { label: "Sem chamado", value: totals?.operational.without_incident, tone: "danger" as const, tab: "open" as QueueTab, incident: ALL, recurrence: "all" as const, divergence: "" as const, situation: "failure_without_incident" as OperationalSituation },
    { label: "Com chamado aberto", value: totals?.operational.with_open_incident, tone: "info" as const, tab: "all" as QueueTab, incident: ALL, recurrence: "all" as const, divergence: "" as const, situation: "failure_with_open_incident" as OperationalSituation },
    { label: "Recorrentes", value: totals?.operational.recurrent, tone: "recurrence" as const, tab: "all" as QueueTab, incident: ALL, recurrence: "recurrent" as const, divergence: "" as const, situation: "all" as OperationalSituation },
    { label: "Divergências", value: totals?.operational.divergences, tone: "warning" as const, tab: "all" as QueueTab, incident: ALL, recurrence: "all" as const, divergence: "any" as const, situation: "all" as OperationalSituation },
  ], [totals]);
  const clearFilters = () => {
    cancelLinkSearch();
    linkSearchIntent.current = null;
    setLinkSearchLoading(false);
    setCustomer(ALL);
    setDatasource(ALL);
    setClassification(ALL);
    setState(ALL);
    setAck(ALL);
    setSeverity(ALL);
    setIncident(ALL);
    setIncidentState(ALL);
    setCarrier(ALL);
    setDivergence("");
    setRecurrence("all");
    setOperationalSituation("all");
    setActivityPeriod("all");
    setSearchDraft("");
    setSearch("");
    setPage(1);
  };

  useEffect(() => {
    if (panelFilterCount > 0) setFiltersOpen(true);
  }, [panelFilterCount]);

  return (
    <AppLayout
      clientSelect={<SectionAccentTitle level={1}>Links</SectionAccentTitle>}
      topbarRightSection={topbarRightSection}
      onRefresh={() => void load("manual")}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      wallboard={dashboard.isWallboard}
    >
      <div className="min-w-0 space-y-3">
        <nav aria-label="Visões da página de links" className="ov-segmented-control flex min-w-0 gap-1 overflow-x-auto">
          {([
            ["open", "Em falha"], ["normalized", "Normalizados"], ["all", "Todos"],
          ] as Array<[QueueTab, string]>).map(([value, label]) => (
            <Button key={value} type="button" size="sm" variant={view === "queue" && tab === value ? "default" : "ghost"} className="shrink-0" onClick={() => { setView("queue"); setTab(value); setPage(1); }}>{label}</Button>
          ))}
          <span aria-hidden className="mx-1 w-px shrink-0 self-stretch bg-border/70" />
          <Button type="button" size="sm" variant={view === "reminders" ? "default" : "ghost"} className="shrink-0" onClick={() => setView("reminders")}>
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            Lembretes
          </Button>
        </nav>

        {view === "reminders" ? <OperatorRemindersPanel onOpenCircuit={openLink} /> : <ConfigurableDashboard controller={dashboard}>
        <ConfigurableDashboardWidget id="operators-summary">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {kpis.map(({ tab: targetTab, divergence: targetDivergence, incident: targetIncident, recurrence: targetRecurrence, situation: targetSituation, label, value, tone }) => (
            <OneViewKpiCard
              key={label}
              label={label}
              value={typeof value === "number" ? value.toLocaleString("pt-BR") : "—"}
              tone={tone ?? "neutral"}
              onClick={() => {
                setView("queue");
                setTab(targetTab);
                setIncident(targetIncident);
                setIncidentState(ALL);
                setRecurrence(targetRecurrence);
                setDivergence(targetDivergence || "");
                setOperationalSituation(targetSituation);
                setPage(1);
              }}
            />
          ))}
        </div>

        {tab === "all" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>{totals?.links ?? 0} links monitorados</span>
            <span>{totals?.known_carriers ?? 0} com operadora identificada</span>
            <span>{totals?.pending_classification ?? 0} pendentes de classificação</span>
          </div>
        ) : null}
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="operators-filters">
        <section aria-label="Filtros de links" className="ov-panel space-y-3 p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ClientFilterCombobox
              open={customerFilterOpen}
              onOpenChange={setCustomerFilterOpen}
              options={customerOptions}
              selectedKeys={selectedCustomerKeys}
              selectedLabel={selectedCustomerLabel}
              onToggle={(key) => {
                setCustomer(key === ALL || key === customer ? ALL : key);
                setCustomerFilterOpen(false);
                setPage(1);
              }}
              countNoun="neste filtro"
            />
            <Button type="button" variant={filtersOpen ? "default" : "outline"} size="sm" className="h-8" onClick={() => setFiltersOpen((open) => !open)}>
              <ChevronDown className={cn("mr-1.5 h-3.5 w-3.5 transition-transform", filtersOpen && "rotate-180")} />
              Mais filtros
              {panelFilterCount > 0 ? <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">{panelFilterCount}</Badge> : null}
            </Button>
            {activeFilterCount > 0 ? (
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={clearFilters}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Limpar
              </Button>
            ) : null}
          </div>

          <div aria-label="Filtros operacionais principais" className="grid gap-3 border-t border-border/60 pt-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex min-h-8 items-center">
              <ChipGroup
                label="Chamado"
                ariaLabel="Filtro de chamado"
                value={chamadoChip}
                options={[[ALL, "Todos"], ["no", "Sem chamado"], ["yes", "Com chamado"]]}
                onChange={(value) => { setIncident(value); setIncidentState(ALL); setPage(1); }}
              />
            </div>
            <Filter label="Situação" value={operationalSituation} options={[{ value: ALL, label: "Todas" }, { value: "failure_without_incident", label: "Falha sem chamado" }, { value: "failure_with_open_incident", label: "Falha com chamado aberto" }, { value: "failure_with_closed_incident", label: "Falha com chamado encerrado" }, { value: "normalized_with_open_incident", label: "Normalizado com chamado aberto" }, { value: "normalized_without_open_incident", label: "Normalizado sem chamado" }]} onChange={(value) => { setOperationalSituation(value as OperationalSituation); setPage(1); }} />
            <Filter label="Status INC" value={incidentState} options={[{ value: ALL, label: "Todos" }, { value: "1", label: "Novo" }, { value: "2", label: "Em andamento" }, { value: "3", label: "Em espera" }, { value: "6", label: "Resolvido" }, { value: "7", label: "Fechado" }, { value: "8", label: "Cancelado" }]} onChange={(value) => { setIncidentState(value); if (value !== ALL) setIncident("yes"); setPage(1); }} />
            <div className="flex min-h-8 items-center">
              <ChipGroup
                label="Recorrência"
                ariaLabel="Filtro de recorrência"
                value={recurrence}
                options={[["all", "Todos"], ["recurrent", "Recorrentes"]]}
                onChange={(value) => { setRecurrence(value === "recurrent" ? "recurrent" : "all"); setPage(1); }}
              />
            </div>
            <div className="flex min-h-8 items-center md:col-span-2">
              <ChipGroup
                label="Período"
                ariaLabel="Filtro de período"
                value={activityPeriod}
                options={[[ALL, "Todos"], ["1h", "1h"], ["4h", "4h"], ["24h", "24h"], ["7d", "7d"]]}
                onChange={(value) => { setActivityPeriod(value as ActivityPeriod); setPage(1); }}
              />
            </div>
          </div>

          {filtersOpen ? (
            <div aria-label="Mais filtros" className="border-t border-border/60 pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Filtros complementares</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  <Filter
                    label="Estado"
                    value={state}
                    options={[
                      { value: ALL, label: "Todos" },
                      { value: "critical", label: "Crítico" },
                      { value: "alert", label: "Alerta" },
                      { value: "attention", label: "Atenção" },
                      { value: "normal", label: "Normal" },
                    ]}
                    onChange={setFilter(setState)}
                  />
                  <Filter label="ACK" value={ack} options={[{ value: ALL, label: "Todos" }, { value: "pending", label: "Pendente" }, { value: "none", label: "Sem pendência" }]} onChange={setFilter(setAck)} />
                  <Filter label="Ordenação" value={sort} options={[{ value: "recent", label: "Mais recente" }, { value: "oldest", label: "Mais antigo" }, { value: "duration", label: "Maior duração" }, { value: "severity", label: "Maior severidade" }]} onChange={setFilter(setSort)} />
              </div>
            </div>
          ) : null}
        </section>

        {initialError && !payload ? <OperationalErrorBanner message={initialError} onRetry={() => void load("manual")} /> : null}
        {refreshError && payload ? (
          <div role="status" className="ov-callout-warning flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
            <span>{refreshError} {lastSuccessfulRefreshAt ? `Última atualização bem-sucedida: ${refreshTime(lastSuccessfulRefreshAt)}.` : ""}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void load("manual")} disabled={loading}>Tentar novamente</Button>
          </div>
        ) : null}
        {payload?.integration_status?.servicenow === "degraded" ? (
          <div role="status" className="ov-callout-warning px-3 py-2 text-xs">
            Correlação ServiceNow indisponível nesta consulta; chamados não foram considerados.
          </div>
        ) : null}
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="operators-queue">
        {initialError && !payload ? <OperationalErrorBanner message={initialError} onRetry={() => void load("manual")} /> : null}
        {refreshError && payload ? <div role="status" className="ov-callout-warning mb-2 flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"><span>{refreshError} {lastSuccessfulRefreshAt ? `Última atualização bem-sucedida: ${refreshTime(lastSuccessfulRefreshAt)}.` : ""}</span><Button type="button" variant="outline" size="sm" onClick={() => void load("manual")} disabled={loading}>Tentar novamente</Button></div> : null}
        <SectionPanel
          title="Fila operacional de links"
          description="Situação atual, alertas e chamados por circuito"
          aside={<span className="text-xs text-muted-foreground">{payload?.pagination.total_items ?? 0} links</span>}
          bodyClassName="p-0"
        >
          <ConfigurableTableToolbar
            search={searchDraft}
            onSearchChange={setSearchDraft}
            onSearchSubmit={(value) => commitLinkSearchNow(value)}
            searchPlaceholder="Buscar link, host ou cliente…"
            searchLabel="Buscar na tabela de links"
            columns={linkTableColumns}
            searchActivity={linkSearchActivity}
            searchActivityQuery={search}
            activeFilterCount={Math.max(0, activeFilterCount - (search.trim() ? 1 : 0))}
            onClearFilters={clearFilters}
            filters={(
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1 text-xs text-muted-foreground">Cliente<ClientFilterCombobox open={customerFilterOpen} onOpenChange={setCustomerFilterOpen} options={customerOptions} selectedKeys={selectedCustomerKeys} selectedLabel={selectedCustomerLabel} onToggle={(key) => { setCustomer(key === ALL || key === customer ? ALL : key); setCustomerFilterOpen(false); setPage(1); }} countNoun="neste filtro" /></div>
                <Filter label="Recorrência" value={recurrence} options={[{ value: "all", label: "Todos" }, { value: "recurrent", label: "Recorrentes" }]} onChange={(value) => { setRecurrence(value === "recurrent" ? "recurrent" : "all"); setPage(1); }} />
                <Filter label="Estado" value={state} options={[{ value: ALL, label: "Todos" }, { value: "critical", label: "Crítico" }, { value: "alert", label: "Alerta" }, { value: "attention", label: "Atenção" }, { value: "normal", label: "Normal" }]} onChange={setFilter(setState)} />
                <Filter label="ACK" value={ack} options={[{ value: ALL, label: "Todos" }, { value: "pending", label: "Pendente" }, { value: "none", label: "Sem pendência" }]} onChange={setFilter(setAck)} />
                <Filter label="Ordenação" value={sort} options={[{ value: "recent", label: "Mais recente" }, { value: "oldest", label: "Mais antigo" }, { value: "duration", label: "Maior duração" }, { value: "severity", label: "Maior severidade" }]} onChange={setFilter(setSort)} />
              </div>
            )}
          />
          {loading && !payload ? (
            <div className="space-y-2 p-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
          ) : !items.length ? (
            <OperationalEmptyState
              compact
              icon={<LinkIcon className="h-5 w-5" />}
              title="Nenhum link encontrado para este filtro."
              description="Ajuste os filtros para consultar o inventário canônico."
            />
          ) : (
            <>
              <div className="divide-y divide-border/60 md:hidden">
                {items.map((item) => <MobileLinkCard key={item.id} item={item} reminder={queueReminderForLink(item, queueReminders)} onOpen={openLink} />)}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table className={cn("w-full table-fixed", visibleLinkColumnIds.length > 6 && "min-w-[70rem]")}>
                  <TableHeader>
                    <TableRow>
                      {linkTableColumns.visibleColumns.map((column) => (
                        <LinkTableColumnHeader
                          key={column.id}
                          column={column}
                          facets={payload?.facets}
                          operationalSituation={operationalSituation}
                          activityPeriod={activityPeriod}
                          chamadoChip={chamadoChip}
                          incidentState={incidentState}
                          datasource={datasource}
                          severity={severity}
                          classification={classification}
                          carrier={carrier}
                          onOperationalSituationChange={(value) => { setOperationalSituation(value); setPage(1); }}
                          onActivityPeriodChange={(value) => { setActivityPeriod(value); setPage(1); }}
                          onChamadoChange={(value) => { setIncident(value); setIncidentState(ALL); setPage(1); }}
                          onIncidentStateChange={(value) => { setIncidentState(value); if (value !== ALL) setIncident("yes"); setPage(1); }}
                          onDatasourceChange={setFilter(setDatasource)}
                          onSeverityChange={setFilter(setSeverity)}
                          onClassificationChange={setFilter(setClassification)}
                          onCarrierChange={setFilter(setCarrier)}
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} className="cursor-pointer" onClick={() => openLink(item)}>
                        {visibleLinkColumnIds.map((column) => {
                          if (column === "link_local") return <TableCell key={column} className="min-w-0"><p className="truncate text-sm font-medium">{text(item.customer_name)} · {localLabel(item)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{linkLabel(item)}</p></TableCell>;
                          if (column === "situation") return <TableCell key={column} className="min-w-0"><MonitoringStatus link={item} /></TableCell>;
                          if (column === "latest_alert") return <TableCell key={column} className="min-w-0"><p className="truncate text-sm font-medium">{latestAlertLabel(item.latest_alert_at)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{text(item.latest_alert?.problem_name || item.latest_alert?.trigger_description, "Sem alerta registrado")}</p></TableCell>;
                          if (column === "current_incident") return <TableCell key={column} className="min-w-0"><CurrentIncident link={item} /></TableCell>;
                          if (column === "follow_up") return <TableCell key={column} className="min-w-0"><div className="space-y-1"><ReminderQuickAction link={item} reminder={queueReminderForLink(item, queueReminders)} onOpen={openReminder} /><FollowUp link={item} /><RecurrenceHint link={item} /></div></TableCell>;
                          if (column === "link_type") return <TableCell key={column} className="min-w-0 truncate text-xs">{linkTypeLabel(item)}</TableCell>;
                          if (column === "carrier") return <TableCell key={column} className="min-w-0 truncate text-xs">{item.carrier_name || (item.operator_escalation ? "NÃ£o identificada" : "â€”")}</TableCell>;
                          if (column === "datasource") return <TableCell key={column} className="min-w-0 truncate text-xs">{zabbixSourceDisplayName(item.datasource)}</TableCell>;
                          if (column === "severity") return <TableCell key={column} className="min-w-0">{item.max_severity ? <SeverityBadge severity={item.max_severity} /> : "—"}</TableCell>;
                          return <TableCell key={column} className="min-w-0"><ResolutionBadge link={item} /></TableCell>;
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </SectionPanel>

        {payload?.pagination.total_pages && payload.pagination.total_pages > 1 ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">Página {payload.pagination.page} de {payload.pagination.total_pages}</p>
            <div className="flex gap-2">
              <Button className="flex-1 sm:flex-none" size="sm" variant="outline" disabled={!payload.pagination.has_previous} onClick={() => setPage((value) => value - 1)}>Anterior</Button>
              <Button className="flex-1 sm:flex-none" size="sm" variant="outline" disabled={!payload.pagination.has_next} onClick={() => setPage((value) => value + 1)}>Próxima</Button>
            </div>
          </div>
        ) : null}
        </ConfigurableDashboardWidget>
        </ConfigurableDashboard>}
      </div>

      <QueueLinkDrawer key={selected ? `${selected.id}:${selected.data_source_id}:${selected.source_host_id}` : "closed"} link={selected} detail={detail} loading={detailLoading} error={detailError} unavailableMessage={reminderUnavailable} reminderRequest={reminderRequest} onClose={closeLink} onRetry={() => reminderDeepLink ? void openReminderDeepLink(reminderDeepLink) : selected && void loadDetail(selected)} />
    </AppLayout>
  );
}

function QueueLinkDrawer({ link, detail, loading, error, unavailableMessage, reminderRequest, onClose, onRetry }: { link: CanonicalLink | null; detail: CanonicalLinkDetail | null; loading: boolean; error: string | null; unavailableMessage: string | null; reminderRequest: string | null; onClose: () => void; onRetry: () => void }) {
  const [expandedIncidentKey, setExpandedIncidentKey] = useState<string | null>(null);
  const [claimedAssignee, setClaimedAssignee] = useState<string | null>(null);
  const [incidentRefreshVersion, setIncidentRefreshVersion] = useState(0);
  const [incidentStateOverride, setIncidentStateOverride] = useState<{ state: string | null; state_display?: string | null } | null>(null);
  const view = detail || link;
  const currentIncident = detail?.current_incident || link?.current_incident;
  const latestIncident = detail?.latest_incident || link?.latest_incident;
  const currentAlert = detail?.current_alert || link?.current_alert;
  const badgeState = incidentStateOverride?.state ?? currentIncident?.state ?? null;
  const badgeDisplay = incidentStateOverride?.state_display ?? currentIncident?.state_display ?? null;
  const linkArtifact = view && currentAlert && currentIncident
    ? buildAlertArtifactFromCanonicalLink(view, currentAlert, currentIncident)
    : null;

  useEffect(() => {
    setClaimedAssignee(null);
    setIncidentRefreshVersion(0);
    setIncidentStateOverride(null);
  }, [currentIncident?.sys_id, currentIncident?.number]);

  return <Sheet open={Boolean(link)} onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" className="inset-y-0 flex h-dvh w-full max-w-none flex-col overflow-hidden p-0 sm:h-full sm:max-w-xl">{view ? <>
    <SheetHeader className="shrink-0 border-b border-border/60 px-5 py-5 pr-12 text-left"><div className="flex flex-wrap items-center gap-2"><StateBadge state={view.state} />{view.max_severity ? <SeverityBadge severity={view.max_severity} /> : null}</div><SheetTitle className="break-words text-base">{linkLabel(view)}</SheetTitle><SheetDescription>{view.customer_name} · {localLabel(view)}</SheetDescription></SheetHeader>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
      {error ? <OperationalErrorBanner message={error} onRetry={onRetry} /> : null}
      {unavailableMessage ? <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{unavailableMessage}</div> : null}
      <section><h3 className="mb-2 text-sm font-semibold">Resumo operacional</h3><div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2"><Field label="Cliente" value={text(view.customer_name)} /><Field label="Local" value={localLabel(view)} /><Field label="Link" value={linkLabel(view)} /><Field label="Monitoramento" value={view.active_alerts ? `Em falha há ${failureDuration(view)}` : "Normalizado"} /><Field label="Severidade" value={text(view.max_severity)} /><Field label="Caiu às" value={timestampLabel(view.alert_started_at || view.active_since_at)} /><Field label="Último alerta às" value={timestampLabel(view.latest_alert_at)} /><Field label="Divergência" value={divergenceLabel(view)} /></div></section>
      <CircuitReminderPanel link={view} requestOpen={reminderRequest} />
      <RecurrencePanel link={view} />
      <section><h3 className="mb-2 text-sm font-semibold">Chamado atual</h3>{currentIncident ? <IncidentSummaryCard claimedAssignee={claimedAssignee} badgeState={badgeState} badgeDisplay={badgeDisplay} incident={currentIncident} slotKey="current" expanded={expandedIncidentKey === `current:${currentIncident.sys_id || currentIncident.number}`} refreshVersion={incidentRefreshVersion} onToggle={() => { const key = `current:${currentIncident.sys_id || currentIncident.number}`; setExpandedIncidentKey((value) => value === key ? null : key); }} /> : <p className="text-sm text-muted-foreground">Nenhum chamado aberto</p>}{latestIncident && latestIncident.number !== currentIncident?.number ? <div className="mt-3"><p className="mb-2 text-xs text-muted-foreground">Último chamado relacionado</p><IncidentSummaryCard incident={latestIncident} slotKey="latest" expanded={expandedIncidentKey === `latest:${latestIncident.sys_id || latestIncident.number}`} onToggle={() => { const key = `latest:${latestIncident.sys_id || latestIncident.number}`; setExpandedIncidentKey((value) => value === key ? null : key); }} /></div> : null}</section>
      <section><h3 className="mb-2 text-sm font-semibold">Alerta atual</h3>{currentAlert ? <div className="rounded-lg border border-border/60 p-3 text-sm"><p className="font-medium">{text(currentAlert.problem_name || currentAlert.trigger_description, "Alerta sem título")}</p><p className="mt-1 text-xs text-muted-foreground">{text(currentAlert.severity)} · Início: {timestampLabel(currentAlert.started_at)} · Último alerta: {timestampLabel(currentAlert.last_seen_at || view.latest_alert_at)}</p></div> : <p className="text-sm text-muted-foreground">Sem alerta ativo</p>}</section>
      {detail ? <Accordion type="single" collapsible className="rounded-lg border border-border/60 px-3"><AccordionItem value="technical" className="border-b-0"><AccordionTrigger className="py-3 text-sm">Detalhes técnicos</AccordionTrigger><AccordionContent><div className="grid gap-3 sm:grid-cols-2"><Field label="Circuit key" value={text(detail.technical.circuit_key || detail.service_name)} /><Field label="Host Zabbix" value={`${text(detail.technical.host_name)} · ID ${text(detail.technical.source_host_id)}`} /><Field label="Trigger(s)" value={detail.technical.trigger_ids.length ? detail.technical.trigger_ids.join(", ") : "Não informado"} /><Field label="Member / uplink" value={text(detail.technical.member_key || detail.technical.uplink_key)} /><Field label="Health-check" value={text(detail.technical.healthcheck_key)} /><Field label="IP" value={text(detail.technical.endpoint_ip)} /><Field label="Fonte" value={`${zabbixSourceDisplayName(detail.technical.source)} · ${text(detail.technical.strategy)}`} /><Field label="Confiança" value={text(detail.technical.confidence)} /></div></AccordionContent></AccordionItem></Accordion> : null}
    </div>
    {currentIncident?.sys_id && currentIncident.number ? (
      <div className="sticky bottom-0 shrink-0 space-y-3 border-t border-border/70 bg-background/95 px-5 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <IncidentDetailActions
          incident={{ sys_id: currentIncident.sys_id, number: currentIncident.number, state: badgeState }}
          alertArtifact={linkArtifact}
          placement="drawer-footer"
          onClaimed={(result) => setClaimedAssignee(result.incident.assigned_to_name)}
          onWorkNoteAdded={() => setIncidentRefreshVersion((value) => value + 1)}
          onAttachmentAdded={() => setIncidentRefreshVersion((value) => value + 1)}
          onPutOnHold={(result) => {
            setIncidentStateOverride({ state: result.incident.state, state_display: "Em espera" });
            setIncidentRefreshVersion((value) => value + 1);
          }}
        />
        <ServiceNowDevLink
          href={currentIncident.servicenow_url || buildProductionServiceNowIncidentLink(currentIncident.sys_id)}
          sysId={currentIncident.sys_id}
          fullWidth
        />
      </div>
    ) : null}
  </> : null}</SheetContent></Sheet>;
}

function incidentDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function IncidentSummaryCard({ incident, slotKey, expanded, onToggle, claimedAssignee = null, badgeState, badgeDisplay, refreshVersion = 0 }: {
  incident: CanonicalLinkIncident;
  slotKey: "current" | "history" | "latest";
  expanded: boolean;
  onToggle: () => void;
  claimedAssignee?: string | null;
  badgeState?: string | null;
  badgeDisplay?: string | null;
  refreshVersion?: number;
}) {
  const detailId = `incident-detail-${slotKey}-${incident.sys_id || incident.number || "unknown"}`;
  const canExpand = Boolean(incident.sys_id);
  const resolvedBadgeState = badgeState ?? incident.state;
  const resolvedBadgeDisplay = badgeDisplay ?? incident.state_display;
  const terminal = ["6", "7", "8"].includes(String(resolvedBadgeState || "").trim());
  const assigneeLabel = terminal ? "Último responsável" : "Responsável";
  return <div className="rounded-lg border border-border/60 p-3 text-sm">
    <button
      type="button"
      className="flex w-full flex-wrap items-start justify-between gap-2 rounded-md text-left disabled:cursor-not-allowed disabled:opacity-60"
      aria-expanded={expanded}
      aria-controls={detailId}
      disabled={!canExpand}
      onClick={onToggle}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5"><b>{incident.number || "INC"}</b><OneViewIncidentStatusBadge state={resolvedBadgeState} display={resolvedBadgeDisplay} /></p>
        <p className="mt-1 text-xs text-muted-foreground">Aberto {timestampLabel(incident.opened_at)} · Atualizado {timestampLabel(incident.updated_at)}</p>
        <p className="mt-1 text-xs font-medium text-foreground/80">{assigneeLabel}: {claimedAssignee || incidentAssignee(incident)}</p>
        {incident.short_description ? <p className="mt-1 text-xs text-muted-foreground">{incident.short_description}</p> : null}
      </div>
      <span className="shrink-0 text-xs font-medium text-primary">{expanded ? "Recolher" : "Ver detalhes"}</span>
    </button>
    {expanded && incident.sys_id ? <div id={detailId}><IncidentDetailPanel incident={incident} refreshVersion={refreshVersion} /></div> : null}
  </div>;
}

function IncidentDetailPanel({ incident, refreshVersion = 0 }: { incident: Pick<CanonicalLinkIncident, "sys_id" | "number">; refreshVersion?: number }) {
  const [detail, setDetail] = useState<OneViewIncident | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchIncidentDetail(String(incident.sys_id)).then((item) => {
      if (active) setDetail(item);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o chamado.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [attempt, incident.sys_id, refreshVersion]);

  if (loading && !detail) return <div className="mt-3 space-y-2 border-t border-border/60 pt-3"><Skeleton className="h-4 w-40" /><Skeleton className="h-20 w-full" /></div>;
  if (error && !detail) return <div className="mt-3 border-t border-border/60 pt-3"><OperationalErrorBanner message={error} onRetry={() => setAttempt((value) => value + 1)} /></div>;
  if (!detail) return null;

  const group = detail.assignment_group_display || detail.assignmentGroup || detail.assignment_group;
  const assignee = detail.assigned_to_display || detail.assignedTo || detail.assigned_to;
  const caller = detail.caller_id_display || detail.caller_id;
  const company = detail.company_display || detail.customer || detail.company;
  return <section aria-label="Detalhes do chamado" className="mt-3 space-y-3 border-t border-border/60 pt-3">
    <div>
      <p className="font-semibold">Detalhes do chamado</p>
      <p className="mt-1 font-medium">{detail.number || incident.number || "INC"}</p>
      {detail.short_description ? <p className="mt-1 break-words">{detail.short_description}</p> : null}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><p className="text-xs text-muted-foreground">Status</p><div className="mt-1"><OneViewIncidentStatusBadge state={detail.state} display={detail.state_display} /></div></div>
      {detail.priority || detail.priority_display ? <Field label="Prioridade" value={text(detail.priority_display || detail.priority)} /> : null}
      {group ? <Field label="Grupo" value={group} /> : null}
      {assignee ? <Field label="Responsável" value={assignee} /> : null}
      {caller ? <Field label="Solicitante" value={caller} /> : null}
      {company ? <Field label="Empresa" value={company} /> : null}
      {detail.opened_at ? <Field label="Aberto" value={incidentDateTime(detail.opened_at)} /> : null}
      {detail.sys_updated_on ? <Field label="Atualizado" value={incidentDateTime(detail.sys_updated_on)} /> : null}
      {detail.resolved_at ? <Field label="Resolvido" value={incidentDateTime(detail.resolved_at)} /> : null}
      {detail.closed_at ? <Field label="Fechado" value={incidentDateTime(detail.closed_at)} /> : null}
    </div>
    {detail.description ? <div><p className="text-xs text-muted-foreground">Descrição</p><p className="mt-1 whitespace-pre-wrap break-words">{detail.description}</p></div> : null}
    {detail.close_notes ? <div><p className="text-xs text-muted-foreground">Notas de resolução</p><p className="mt-1 whitespace-pre-wrap break-words">{detail.close_notes}</p></div> : null}
  </section>;
}

function reminderDateTime(value?: string | null) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function reminderLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário indisponível";
  const today = new Date();
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  return date.toDateString() === today.toDateString()
    ? `Hoje às ${time}`
    : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function reminderMutationError(cause: unknown, action: "criar" | "alterar" | "cancelar") {
  if (cause instanceof OneViewApiError) {
    if (cause.status === 401) return "Sua sessão expirou. Entre novamente.";
    if (cause.status === 403) return "Você não possui permissão para esta ação.";
    if (cause.status === 409 && cause.code === "active_reminder_exists") return "Já existe um lembrete ativo para este acompanhamento.";
    if (cause.status === 409 && cause.code === "operational_subject_not_active") return "Lembrete disponível somente enquanto houver alerta ativo.";
    if (cause.status === 409 && cause.code === "unstable_operational_subject") return "Não foi possível identificar este alerta de forma estável.";
    if (cause.status === 400 || cause.status === 422) {
      return cause.code === "invalid_scheduled_for"
        ? "Escolha uma data e horário futuros."
        : `Não foi possível ${action} o lembrete: dados inválidos.`;
    }
    if (cause.status >= 500) {
      return action === "alterar"
        ? "Não foi possível alterar agora. Tente novamente."
        : action === "cancelar"
          ? "Não foi possível cancelar agora. Tente novamente."
          : "Não foi possível agendar agora. Tente novamente.";
    }
  }
  return cause instanceof Error ? cause.message : `Não foi possível ${action} o lembrete.`;
}

function snapshotText(snapshot: Record<string, unknown> | null | undefined, group: string, key: string) {
  const node = snapshot?.[group];
  if (!node || typeof node !== "object") return "";
  const value = (node as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function reminderFeedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário indisponível";
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return `Hoje · ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Amanhã · ${time}`;
  return `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date)} · ${time}`;
}

function ReminderFeedCard({ item, saving, editing, date, time, onDate, onTime, onEdit, onCloseEdit, onSave, onCancel }: {
  item: OperatorReminderFeedItem;
  saving: boolean;
  editing: boolean;
  date: string;
  time: string;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
  onEdit: () => void;
  onCloseEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const snapshot = item.context_snapshot as Record<string, unknown> | null;
  const member = snapshotText(snapshot, "link", "member_key");
  const uplink = snapshotText(snapshot, "link", "uplink_key");
  const identityLine = [snapshotText(snapshot, "customer", "name"), snapshotText(snapshot, "circuit", "host_name")].filter(Boolean).join(" · ");
  const circuitLine = [
    snapshotText(snapshot, "link", "service_name") || snapshotText(snapshot, "alert", "problem_name") || item.circuit_key,
    member ? `member ${member}` : uplink,
  ].filter(Boolean).join(" · ");
  const incidentNumber = item.initial_incident_number || snapshotText(snapshot, "incident", "number");

  return (
    <article className="space-y-2 rounded-lg border border-border/60 bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Bell className="h-4 w-4 text-muted-foreground" />
          {reminderFeedTime(item.scheduled_for)}
        </p>
        {item.mine ? <Badge variant="secondary">Criado por você</Badge> : null}
      </div>
      <div className="space-y-0.5 text-sm">
        <p className="break-words font-medium">{identityLine || item.circuit_key}</p>
        <p className="break-words text-xs text-muted-foreground">{circuitLine}</p>
        {incidentNumber ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{incidentNumber}</span>
            <OneViewIncidentStatusBadge state={snapshotText(snapshot, "incident", "state")} />
          </p>
        ) : <p className="text-xs text-muted-foreground">Sem chamado vinculado</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
        <p className="text-xs text-muted-foreground">Criado por {text(item.created_by_name, "Operador não identificado")}</p>
        {item.mine ? (
          <div className="flex gap-2">
            <Popover open={editing} onOpenChange={(next) => { if (next) onEdit(); else onCloseEdit(); }}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" disabled={saving}>Alterar</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <ReminderForm date={date} time={time} saving={saving} submitLabel="Salvar" onDate={onDate} onTime={onTime} onCancel={onCloseEdit} onSubmit={onSave} />
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>Cancelar</Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function LegacyOperatorRemindersPanel() {
  const [feed, setFeed] = useState<OperatorReminderFeed | null>(null);
  const [scope, setScope] = useState<ReminderScope>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [date, setDate] = useState(() => reminderDateTime().date);
  const [time, setTime] = useState(() => reminderDateTime().time);
  const requestVersion = useRef(0);

  const load = useCallback(async (force = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const result = await fetchOperatorReminderFeed({ force });
      if (requestVersion.current !== version) return;
      setFeed(result);
      setError(null);
    } catch (cause) {
      if (requestVersion.current === version && !isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar os lembretes.");
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    return () => { requestVersion.current += 1; };
  }, [load]);

  const items = (feed?.items || []).filter((item) => scope === "all" || item.mine);
  const counts = feed?.counts || { all: 0, mine: 0 };

  const startEdit = (item: OperatorReminderFeedItem) => {
    const initial = reminderDateTime(item.scheduled_for);
    setDate(initial.date);
    setTime(initial.time);
    setMutationError(null);
    setEditingId(item.id);
  };

  const save = async (item: OperatorReminderFeedItem) => {
    const scheduledFor = new Date(`${date}T${time}:00`);
    if (!date || !time || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now()) {
      setMutationError("Escolha uma data e horário futuros.");
      return;
    }
    setSavingId(item.id);
    setMutationError(null);
    try {
      const saved = await updateOperatorReminder(operatorReminderIdentity(item), item.id, scheduledFor.toISOString());
      setFeed((current) => current && {
        ...current,
        items: current.items.map((row) => (row.id === item.id ? { ...row, scheduled_for: saved.scheduled_for, updated_at: saved.updated_at } : row)),
      });
      setEditingId(null);
      void load(true);
    } catch (cause) {
      setMutationError(reminderMutationError(cause, "alterar"));
    } finally {
      setSavingId(null);
    }
  };

  const cancel = async (item: OperatorReminderFeedItem) => {
    setSavingId(item.id);
    setMutationError(null);
    try {
      await cancelOperatorReminder(operatorReminderIdentity(item), item.id);
      setFeed((current) => {
        if (!current) return current;
        const remaining = current.items.filter((row) => row.id !== item.id);
        return { ...current, items: remaining, counts: { all: remaining.length, mine: remaining.filter((row) => row.mine).length } };
      });
      void load(true);
    } catch (cause) {
      setMutationError(reminderMutationError(cause, "cancelar"));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <SectionPanel
      title="Lembretes"
      description="Retornos agendados pelos operadores nos circuitos monitorados"
      aside={<Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load(true)}>Atualizar</Button>}
      bodyClassName="space-y-3 p-3"
    >
      <nav aria-label="Filtro de lembretes" className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-border/70 p-1">
        {([["all", `Todos (${counts.all})`], ["mine", `Criados por mim (${counts.mine})`]] as Array<[ReminderScope, string]>).map(([value, label]) => (
          <Button key={value} type="button" size="sm" variant={scope === value ? "default" : "ghost"} className="shrink-0" onClick={() => setScope(value)}>{label}</Button>
        ))}
      </nav>

      {mutationError ? <p role="alert" className="text-xs text-destructive">{mutationError}</p> : null}
      {error && !feed ? <OperationalErrorBanner message={error} onRetry={() => void load(true)} /> : null}
      {error && feed ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Não foi possível atualizar os lembretes.</span>
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load(true)}>Tentar novamente</Button>
        </div>
      ) : null}

      {loading && !feed ? (
        <div className="space-y-2"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div>
      ) : !items.length ? (
        <OperationalEmptyState
          compact
          icon={<Bell className="h-5 w-5" />}
          title={scope === "mine" ? "Você não possui lembretes agendados." : "Nenhum lembrete agendado."}
          description="Agende um retorno pelo botão Lembrar no detalhe de um circuito com alerta ativo."
        />
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {items.map((item) => (
            <ReminderFeedCard
              key={item.id}
              item={item}
              saving={savingId === item.id}
              editing={editingId === item.id}
              date={date}
              time={time}
              onDate={setDate}
              onTime={setTime}
              onEdit={() => startEdit(item)}
              onCloseEdit={() => setEditingId(null)}
              onSave={() => void save(item)}
              onCancel={() => void cancel(item)}
            />
          ))}
        </div>
      )}
    </SectionPanel>
  );
}

const REMINDER_HISTORY_VIEWS: Array<{ value: ReminderView; label: string; statuses?: OperatorReminderFeedItem["status"][] }> = [
  { value: "scheduled", label: "Agendados", statuses: ["scheduled", "processing"] },
  { value: "sent", label: "Lembrados", statuses: ["sent"] },
  { value: "skipped", label: "Ignorados", statuses: ["skipped"] },
  { value: "failed", label: "Falhas", statuses: ["failed"] },
  { value: "cancelled", label: "Cancelados", statuses: ["cancelled"] },
  { value: "all", label: "Todos" },
];

function reminderHistoryTime(value: string | null | undefined) {
  if (!value) return "Horário indisponível";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Horário indisponível";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function reminderHistoryRange(period: ReminderPeriod, customFrom: string, customTo: string) {
  if (period === "custom") {
    const from = customFrom ? new Date(customFrom) : null;
    const to = customTo ? new Date(customTo) : null;
    return { from: from && Number.isFinite(from.getTime()) ? from.toISOString() : undefined, to: to && Number.isFinite(to.getTime()) ? to.toISOString() : undefined };
  }
  const durations: Partial<Record<ReminderPeriod, number>> = { "30m": 30 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "8h": 8 * 60 * 60_000, "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000 };
  const duration = durations[period];
  return duration ? { from: new Date(Date.now() - duration).toISOString(), to: new Date().toISOString() } : {};
}

function reminderHistoryStatus(item: OperatorReminderFeedItem) {
  if (item.status === "sent") return `Theo acionado às ${timestampLabel(item.sent_at)}`;
  if (item.status === "skipped") return item.skip_reason === "alert_resolved" ? "Alerta normalizou antes do horário" : "Lembrete ignorado por alteração no circuito";
  if (item.status === "failed") return "Falha no envio";
  if (item.status === "cancelled") return `Cancelado às ${timestampLabel(item.cancelled_at)}`;
  if (item.status === "processing") return "Processando envio pelo Theo";
  return `Agendado para ${reminderHistoryTime(item.scheduled_for)}`;
}

function reminderHistoryCircuit(item: OperatorReminderFeedItem): CanonicalLink {
  const snapshot = item.context_snapshot as Record<string, unknown> | null;
  return {
    id: item.circuit_key || item.source_host_id || "operational-subject",
    circuit_key: item.circuit_key,
    data_source_id: item.data_source_id,
    datasource: item.data_source_id,
    source_host_id: item.source_host_id || "",
    operational_subject: item.subject_key ? {
      subject_type: item.subject_type, subject_key: item.subject_key, circuit_key: item.circuit_key,
      data_source_id: item.data_source_id, source_host_id: item.source_host_id,
      source_trigger_id: item.source_trigger_id,
    } : null,
    customer_name: snapshotText(snapshot, "customer", "name"),
    customer_key: snapshotText(snapshot, "customer", "key"),
    host_name: snapshotText(snapshot, "circuit", "host_name"),
    service_name: snapshotText(snapshot, "link", "service_name"),
    link_type: snapshotText(snapshot, "link", "link_type"),
    member_key: snapshotText(snapshot, "link", "member_key"),
    uplink_key: snapshotText(snapshot, "link", "uplink_key"),
    max_severity: snapshotText(snapshot, "alert", "severity"),
    active_alerts: 0,
    state: "normal",
  } as CanonicalLink;
}

function ReminderHistoryCard({ item, saving, editing, date, time, onDate, onTime, onEdit, onCloseEdit, onSave, onCancel, onOpenCircuit }: {
  item: OperatorReminderFeedItem;
  saving: boolean;
  editing: boolean;
  date: string;
  time: string;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
  onEdit: () => void;
  onCloseEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onOpenCircuit: () => void;
}) {
  const snapshot = item.context_snapshot as Record<string, unknown> | null;
  const member = snapshotText(snapshot, "link", "member_key");
  const uplink = snapshotText(snapshot, "link", "uplink_key");
  const severity = snapshotText(snapshot, "alert", "severity");
  const identity = [snapshotText(snapshot, "customer", "name"), snapshotText(snapshot, "circuit", "host_name")].filter(Boolean).join(" · ");
  const circuit = [snapshotText(snapshot, "link", "service_name") || snapshotText(snapshot, "alert", "problem_name") || item.circuit_key, member ? `member ${member}` : uplink].filter(Boolean).join(" · ");
  const incident = item.initial_incident_number || snapshotText(snapshot, "incident", "number");
  const canMutate = item.mine && item.status === "scheduled";
  return <article className="space-y-2 rounded-lg border border-border/60 bg-card p-3 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4 text-muted-foreground" />{reminderHistoryStatus(item)}</p><p className="mt-1 text-xs text-muted-foreground">{reminderHistoryTime(item.activity_at || item.scheduled_for)}</p></div><div className="flex gap-1">{severity ? <Badge variant="outline">{severity}</Badge> : null}{item.mine ? <Badge variant="secondary">Criado por você</Badge> : null}</div></div>
    <div className="space-y-0.5 text-sm"><p className="break-words font-medium">{identity || item.circuit_key}</p><p className="break-words text-xs text-muted-foreground">{circuit}</p>{incident ? <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><span>{incident}</span><OneViewIncidentStatusBadge state={snapshotText(snapshot, "incident", "state")} /></p> : <p className="text-xs text-muted-foreground">Sem chamado vinculado</p>}</div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2"><p className="text-xs text-muted-foreground">Criado por {text(item.created_by_name, "Operador não identificado")}</p><div className="flex gap-2"><Button size="sm" variant="outline" onClick={onOpenCircuit}>Abrir acompanhamento</Button>{canMutate ? <><Popover open={editing} onOpenChange={(next) => { if (next) onEdit(); else onCloseEdit(); }}><PopoverTrigger asChild><Button size="sm" variant="outline" disabled={saving}>Alterar</Button></PopoverTrigger><PopoverContent align="end" className="w-80"><ReminderForm date={date} time={time} saving={saving} submitLabel="Salvar" onDate={onDate} onTime={onTime} onCancel={onCloseEdit} onSubmit={onSave} /></PopoverContent></Popover><Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>Cancelar</Button></> : null}</div></div>
  </article>;
}

function OperatorRemindersPanel({ onOpenCircuit }: { onOpenCircuit: (link: CanonicalLink) => void }) {
  const [feed, setFeed] = useState<OperatorReminderFeed | null>(null);
  const [view, setView] = useState<ReminderView>("scheduled");
  const [scope, setScope] = useState<ReminderScope>("all");
  const [period, setPeriod] = useState<ReminderPeriod>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [client, setClient] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);
  const [incident, setIncident] = useState<ReminderIncidentFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ReminderSort>("default");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [date, setDate] = useState(() => reminderDateTime().date);
  const [time, setTime] = useState(() => reminderDateTime().time);
  const requestVersion = useRef(0);
  const activeView = REMINDER_HISTORY_VIEWS.find((item) => item.value === view) || REMINDER_HISTORY_VIEWS[0];
  const range = useMemo(() => reminderHistoryRange(period, customFrom, customTo), [customFrom, customTo, period]);
  const requestFilters = useMemo(() => ({ status: activeView.statuses, scope, from: range.from, to: range.to, client: client === ALL ? undefined : client, severity: severity === ALL ? undefined : severity, hasIncident: incident === "all" ? undefined : incident === "with", search: search.trim() || undefined, sort: sort === "default" ? undefined : sort, limit: 50, offset }), [activeView.statuses, client, incident, offset, range.from, range.to, scope, search, severity, sort]);
  const load = useCallback(async (force = false) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try { const result = await fetchOperatorReminderFeed({ ...requestFilters, force }); if (requestVersion.current === version) { setFeed(result); setError(null); } }
    catch (cause) { if (requestVersion.current === version && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os lembretes."); }
    finally { if (requestVersion.current === version) setLoading(false); }
  }, [requestFilters]);
  useEffect(() => { void load(true); return () => { requestVersion.current += 1; }; }, [load]);
  useEffect(() => {
    if (view !== "scheduled") return undefined;
    const refresh = () => { if (!document.hidden) void load(true); };
    const id = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", refresh); };
  }, [load, view]);
  const items = feed?.items || [];
  const counts = feed?.counts || { all: 0, mine: 0, scheduled: 0, processing: 0, sent: 0, skipped: 0, failed: 0, cancelled: 0 };
  const viewCount = (value: ReminderView) => value === "scheduled" ? counts.scheduled + counts.processing : value === "all" ? counts.all : counts[value];
  const chooseView = (next: ReminderView) => { setView(next); setOffset(0); };
  const startEdit = (item: OperatorReminderFeedItem) => { const initial = reminderDateTime(item.scheduled_for); setDate(initial.date); setTime(initial.time); setMutationError(null); setEditingId(item.id); };
  const save = async (item: OperatorReminderFeedItem) => { const scheduledFor = new Date(`${date}T${time}:00`); if (!date || !time || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now()) { setMutationError("Escolha uma data e horário futuros."); return; } setSavingId(item.id); setMutationError(null); try { await updateOperatorReminder(operatorReminderIdentity(item), item.id, scheduledFor.toISOString()); setEditingId(null); void load(true); } catch (cause) { setMutationError(reminderMutationError(cause, "alterar")); } finally { setSavingId(null); } };
  const cancel = async (item: OperatorReminderFeedItem) => { setSavingId(item.id); setMutationError(null); try { await cancelOperatorReminder(operatorReminderIdentity(item), item.id); void load(true); } catch (cause) { setMutationError(reminderMutationError(cause, "cancelar")); } finally { setSavingId(null); } };
  return <SectionPanel title="Lembretes" description="Retornos agendados, enviados e históricos dos circuitos monitorados" aside={<Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load(true)}>Atualizar</Button>} bodyClassName="space-y-3 p-3">
    <nav aria-label="Visões de lembretes" className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-border/70 p-1">{REMINDER_HISTORY_VIEWS.map((item) => <Button key={item.value} type="button" size="sm" variant={view === item.value ? "default" : "ghost"} className="shrink-0" onClick={() => chooseView(item.value)}>{item.label} ({viewCount(item.value)})</Button>)}</nav>
    <div aria-label="Período dos lembretes" className="flex min-w-0 gap-1 overflow-x-auto">{(["all", "30m", "1h", "4h", "8h", "24h", "7d", "custom"] as ReminderPeriod[]).map((item) => <Button key={item} type="button" size="sm" variant={period === item ? "secondary" : "ghost"} className="shrink-0" onClick={() => { setPeriod(item); setOffset(0); }}>{item === "all" ? "Todo período" : item === "custom" ? "Personalizado" : item}</Button>)}</div>
    {period === "custom" ? <div className="grid gap-2 sm:grid-cols-2"><label className="grid gap-1 text-xs text-muted-foreground">De<Input type="datetime-local" value={customFrom} onChange={(event) => { setCustomFrom(event.target.value); setOffset(0); }} /></label><label className="grid gap-1 text-xs text-muted-foreground">Até<Input type="datetime-local" value={customTo} onChange={(event) => { setCustomTo(event.target.value); setOffset(0); }} /></label></div> : null}
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"><Filter label="Cliente" value={client} options={optionList(feed?.facets?.clients)} onChange={(value) => { setClient(value); setOffset(0); }} /><Filter label="Severidade" value={severity} options={[{ value: ALL, label: "Todas" }, { value: "disaster", label: "Disaster" }, { value: "high", label: "High" }, { value: "average", label: "Average" }, { value: "warning", label: "Warning" }]} onChange={(value) => { setSeverity(value); setOffset(0); }} /><Filter label="Chamado" value={incident} options={[{ value: "all", label: "Todos" }, { value: "with", label: "Com INC" }, { value: "without", label: "Sem INC" }]} onChange={(value) => { setIncident(value as ReminderIncidentFilter); setOffset(0); }} /><Filter label="Criador" value={scope} options={[{ value: "all", label: "Todos" }, { value: "mine", label: "Criados por mim" }]} onChange={(value) => { setScope(value as ReminderScope); setOffset(0); }} /><Filter label="Ordenação" value={sort} options={[{ value: "default", label: "Padrão da visão" }, { value: "recent", label: "Mais recentes" }, { value: "oldest", label: "Mais antigos" }]} onChange={(value) => { setSort(value as ReminderSort); setOffset(0); }} /></div>
    <div className="relative"><Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" /><Input aria-label="Buscar lembretes" className="h-8 pl-8" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} placeholder="Cliente, local, circuito ou INC" /></div>
    {mutationError ? <p role="alert" className="text-xs text-destructive">{mutationError}</p> : null}
    {error && !feed ? <OperationalErrorBanner message={error} onRetry={() => void load(true)} /> : null}
    {error && feed ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>Não foi possível atualizar os lembretes.</span><Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load(true)}>Tentar novamente</Button></div> : null}
    {loading && !feed ? <div className="space-y-2"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div> : !items.length ? <div className="space-y-2"><OperationalEmptyState compact icon={<Bell className="h-5 w-5" />} title={view === "scheduled" ? "Nenhum lembrete aguardando envio." : "Nenhum lembrete nesta visão."} description={view === "scheduled" ? "Agende um retorno pelo botão Lembrar no detalhe de um circuito com alerta ativo." : "Ajuste período ou filtros para consultar o histórico."} />{view === "scheduled" && (feed?.recent_sent_count || 0) > 0 ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 p-3 text-sm"><span>{feed?.recent_sent_count} lembrados nas últimas 4h</span><Button size="sm" variant="outline" onClick={() => { setPeriod("4h"); chooseView("sent"); }}>Ver lembrados</Button></div> : null}</div> : <div className="grid gap-2 lg:grid-cols-2">{items.map((item) => <ReminderHistoryCard key={item.id} item={item} saving={savingId === item.id} editing={editingId === item.id} date={date} time={time} onDate={setDate} onTime={setTime} onEdit={() => startEdit(item)} onCloseEdit={() => setEditingId(null)} onSave={() => void save(item)} onCancel={() => void cancel(item)} onOpenCircuit={() => onOpenCircuit(reminderHistoryCircuit(item))} />)}</div>}
    {feed?.pagination && feed.pagination.total_items > feed.pagination.limit ? <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{feed.pagination.offset + 1}–{feed.pagination.offset + items.length} de {feed.pagination.total_items}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={feed.pagination.offset === 0} onClick={() => setOffset(Math.max(0, feed.pagination!.offset - feed.pagination!.limit))}>Anterior</Button><Button size="sm" variant="outline" disabled={!feed.pagination.has_next} onClick={() => setOffset(feed.pagination!.offset + feed.pagination!.limit)}>Próxima</Button></div></div> : null}
  </SectionPanel>;
}

function CircuitReminderPanel({ link, requestOpen }: { link: CanonicalLink; requestOpen?: string | null }) {
  const reminderLink = useMemo(() => ({
    id: link.id,
    circuit_key: link.circuit_key,
    data_source_id: link.data_source_id,
    source_host_id: link.source_host_id,
    operational_subject: link.operational_subject,
  }), [link.id, link.circuit_key, link.data_source_id, link.operational_subject, link.source_host_id]);
  const identity = `${reminderLink.data_source_id}:${reminderLink.operational_subject?.subject_key || reminderLink.id}`;
  const [reminders, setReminders] = useState<OperatorReminder[]>(() => getCachedOperatorReminders(reminderLink) || []);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [date, setDate] = useState(() => reminderDateTime().date);
  const [time, setTime] = useState(() => reminderDateTime().time);
  const requestVersion = useRef(0);
  const clickStartedAt = useRef<number | null>(null);
  const drawerMetricSent = useRef(false);
  const openedRequest = useRef<string | null>(null);
  const reminder = reminders[0] || null;
  const hasOperationalSubject = Boolean(link.operational_subject?.subject_key);
  const canSchedule = Boolean(hasOperationalSubject && Number(link.active_alerts) > 0);
  const reminderUnavailableReason = !hasOperationalSubject
    ? "Não foi possível identificar este alerta de forma estável."
    : !Number(link.active_alerts)
      ? "Lembrete disponível somente enquanto houver alerta ativo."
      : null;

  const loadReminderState = useCallback(async (force = false) => {
    if (!hasOperationalSubject) {
      setLoading(false);
      setLoadFailed(false);
      setReminders([]);
      return;
    }
    const version = ++requestVersion.current;
    const cached = getCachedOperatorReminders(reminderLink);
    if (cached) setReminders(cached);
    setLoading(true);
    setLoadFailed(false);
    const startedAt = performance.now();
    let outcome = "completed";
    try {
      const items = await fetchOperatorReminders(reminderLink, { force });
      if (requestVersion.current === version) setReminders(items);
    } catch (cause) {
      outcome = "failed";
      if (requestVersion.current === version && !isAbortError(cause)) setLoadFailed(true);
    } finally {
      if (requestVersion.current === version) {
        setLoading(false);
        console.info(JSON.stringify({
          event: "oneview_reminder_ui_timing",
          metric: "reminder_get_ms",
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome,
        }));
      }
    }
  }, [hasOperationalSubject, reminderLink]);

  useEffect(() => {
    const initial = reminderDateTime();
    setDate(initial.date);
    setTime(initial.time);
    setMutationError(null);
    void loadReminderState(true);
    return () => { requestVersion.current += 1; };
  }, [identity, loadReminderState]);

  useLayoutEffect(() => {
    if (!drawerMetricSent.current && drawerOpenedAt > 0) {
      drawerMetricSent.current = true;
      console.info(JSON.stringify({
        event: "oneview_reminder_ui_timing",
        metric: "drawer_open_to_render_ms",
        duration_ms: Math.max(0, Math.round(performance.now() - drawerOpenedAt)),
      }));
    }
    if (open && clickStartedAt.current !== null) {
      console.info(JSON.stringify({
        event: "oneview_reminder_ui_timing",
        metric: "reminder_button_click_to_modal_ms",
        duration_ms: Math.max(0, Math.round(performance.now() - clickStartedAt.current)),
      }));
      clickStartedAt.current = null;
    }
  }, [open]);

  const save = async () => {
    const scheduledFor = new Date(`${date}T${time}:00`);
    if (!date || !time || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= Date.now()) {
      setMutationError("Escolha uma data e horário futuros."); return;
    }
    setSaving(true); setMutationError(null);
    try {
      const saved = reminder
        ? await updateOperatorReminder(reminderLink, reminder.id, scheduledFor.toISOString())
        : await createOperatorReminder(reminderLink, scheduledFor.toISOString());
      setReminders([saved]); setOpen(false);
    } catch (cause) {
      setMutationError(reminderMutationError(cause, reminder ? "alterar" : "criar"));
      if (cause instanceof OneViewApiError && cause.status === 409 && cause.code === "active_reminder_exists") {
        try {
          const existing = await fetchOperatorReminders(reminderLink, { force: true });
          setReminders(existing);
          setOpen(false);
        } catch {
          // Preserve the specific conflict; retry remains available through the persisted-state control.
        }
      }
    } finally { setSaving(false); }
  };
  const cancel = async () => {
    if (!reminder) return;
    setSaving(true); setMutationError(null);
    try { await cancelOperatorReminder(reminderLink, reminder.id); setReminders([]); setOpen(false); }
    catch (cause) { setMutationError(reminderMutationError(cause, "cancelar")); }
    finally { setSaving(false); }
  };
  const edit = () => { const initial = reminderDateTime(reminder?.scheduled_for); setDate(initial.date); setTime(initial.time); setOpen(true); };
  const create = () => {
    const initial = reminderDateTime();
    setDate(initial.date);
    setTime(initial.time);
    setMutationError(null);
    clickStartedAt.current = performance.now();
    setOpen(true);
  };

  useEffect(() => {
    if (!requestOpen || requestOpen === openedRequest.current || !canSchedule) return;
    openedRequest.current = requestOpen;
    const initial = reminderDateTime();
    setDate(initial.date);
    setTime(initial.time);
    setMutationError(null);
    clickStartedAt.current = performance.now();
    setOpen(true);
  }, [canSchedule, requestOpen]);

  return <section><h3 className="mb-2 text-sm font-semibold">Lembrete</h3><div className="rounded-lg border border-border/60 p-3 text-sm">
    {reminder ? <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{reminderLabel(reminder.scheduled_for)}</p><p className="mt-1 text-xs text-muted-foreground">Agendado por {text(reminder.created_by_name, "Operador não identificado")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={edit} disabled={saving}>Alterar</Button><Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={saving}>Cancelar</Button></div></div> : <div className="flex flex-wrap items-center justify-between gap-3"><div>{reminderUnavailableReason ? <p className="text-xs text-muted-foreground">{reminderUnavailableReason}</p> : null}</div><Popover open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}><PopoverTrigger asChild><Button size="sm" variant="outline" disabled={!canSchedule || saving} onClick={create}>Lembrar</Button></PopoverTrigger><PopoverContent align="end" className="w-80"><ReminderForm date={date} time={time} saving={saving} submitLabel="Agendar" onDate={setDate} onTime={setTime} onCancel={() => setOpen(false)} onSubmit={() => void save()} /></PopoverContent></Popover></div>}
    {loading ? <p className="mt-2 text-xs text-muted-foreground">Carregando lembrete…</p> : null}
    {loadFailed ? <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span>Não foi possível carregar o lembrete.</span><Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void loadReminderState(true)}>Tentar novamente</Button></div> : null}
    {mutationError ? <p role="alert" className="mt-2 text-xs text-destructive">{mutationError}</p> : null}
    {reminder ? <Popover open={open} onOpenChange={setOpen}><PopoverContent className="w-80"><ReminderForm date={date} time={time} saving={saving} submitLabel="Salvar" onDate={setDate} onTime={setTime} onCancel={() => setOpen(false)} onSubmit={() => void save()} /></PopoverContent></Popover> : null}
  </div></section>;
}

function ReminderForm({ date, time, saving, submitLabel, onDate, onTime, onCancel, onSubmit }: { date: string; time: string; saving: boolean; submitLabel: string; onDate: (value: string) => void; onTime: (value: string) => void; onCancel: () => void; onSubmit: () => void }) {
  return <div className="space-y-3"><div><p className="font-medium">Lembrar se continuar pendente</p><p className="text-xs text-muted-foreground">O horário é salvo no seu fuso local.</p></div><label className="grid gap-1 text-sm">Data<Input aria-label="Data do lembrete" type="date" value={date} onChange={(event) => onDate(event.target.value)} /></label><label className="grid gap-1 text-sm">Horário<Input aria-label="Horário do lembrete" type="time" value={time} onChange={(event) => onTime(event.target.value)} /></label><div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button><Button size="sm" onClick={onSubmit} disabled={saving}>{submitLabel}</Button></div></div>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="break-words text-sm">{value}</p></div>;
}
