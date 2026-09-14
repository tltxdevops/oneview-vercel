import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bell, ChevronDown, Link as LinkIcon, RotateCcw, Search } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cancelOperatorReminder, createOperatorReminder, fetchCanonicalLinkDetail, fetchCanonicalLinks, fetchIncidentDetail, fetchOperatorReminderFeed, fetchOperatorReminders, getCachedOperatorReminders, OneViewApiError, operatorReminderIdentity, updateOperatorReminder, type CanonicalLink, type CanonicalLinkDetail, type CanonicalLinkIncident, type CanonicalLinksResponse, type OneViewIncident, type OperatorReminder, type OperatorReminderFeed, type OperatorReminderFeedItem } from "@/lib/oneview-api";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import { cn } from "@/lib/utils";
import { OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";

const ALL = "all";
const REFRESH_MS = 10_000;
const COLUMN_STORAGE_KEY = "oneview.operadoras.columns.v1";
let drawerOpenedAt = 0;
const REQUIRED_COLUMNS = ["link_local", "situation", "latest_alert", "current_incident", "follow_up"] as const;
const OPTIONAL_COLUMNS = [
  ["link_type", "Tipo do link"], ["carrier", "Operadora"], ["datasource", "Fonte Zabbix"],
  ["severity", "Severidade"], ["classification", "Pendência de classificação"],
] as const;
type QueueTab = "open" | "without_incident" | "with_incident" | "resolved" | "all";
type PageView = "queue" | "reminders";
type ReminderScope = "all" | "mine";
type ReminderView = "scheduled" | "sent" | "skipped" | "failed" | "cancelled" | "all";
type ReminderPeriod = "all" | "30m" | "1h" | "4h" | "8h" | "24h" | "7d" | "custom";
type ReminderIncidentFilter = "all" | "with" | "without";
type ReminderSort = "default" | "recent" | "oldest";
type OptionalColumn = typeof OPTIONAL_COLUMNS[number][0];
type VisibleColumns = Record<OptionalColumn, boolean>;

function storedColumns(): VisibleColumns {
  const fallback: VisibleColumns = { link_type: false, carrier: false, datasource: false, severity: false, classification: false };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLUMN_STORAGE_KEY) || "{}") as Partial<VisibleColumns>;
    return { ...fallback, ...Object.fromEntries(OPTIONAL_COLUMNS.map(([key]) => [key, Boolean(stored[key])])) };
  } catch { return fallback; }
}

function isAbortError(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError" || /signal is aborted|aborted without reason/i.test(cause.message);
}

const text = (value: unknown, empty = "Não informada na origem") => String(value || "").trim() || empty;
const optionList = (items: Array<{ value: string; label: string }> | undefined, allLabel = "Todos") => [
  { value: ALL, label: allLabel },
  ...(items || []),
];

function stateLabel(value: CanonicalLink["state"]) {
  return ({ critical: "Crítico", alert: "Alerta", attention: "Atenção", normal: "Normal" })[value];
}

function StateBadge({ state }: { state: CanonicalLink["state"] }) {
  return (
    <Badge variant={state === "critical" ? "destructive" : state === "normal" ? "outline" : "secondary"}>
      {stateLabel(state)}
    </Badge>
  );
}

function ResolutionBadge({ link }: { link: CanonicalLink }) {
  if (link.resolution_status === "resolved") return null;
  return <Badge variant="secondary">Pendente de classificação</Badge>;
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
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${Math.max(0, hours)}h`;
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
  const label = text(link.service_name, "Link sem identificação");
  if (link.member_key) return `${label} · SD-WAN member ${link.member_key}`;
  if (link.uplink_key && !label.toLowerCase().includes(link.uplink_key.toLowerCase())) return `${label} · ${link.uplink_key}`;
  return label;
}
function incidentStateLabel(value: string | null | undefined) {
  const state = String(value || "").trim();
  return ({ "1": "Novo", "2": "Em andamento", "3": "Em espera", "6": "Resolvido", "7": "Fechado", "8": "Cancelado" })[state] || state || "Estado não informado";
}

function CurrentIncident({ link }: { link: CanonicalLink }) {
  if (link.incident_correlation_status === "degraded") return <p className="text-xs text-muted-foreground">Chamados não verificados</p>;
  if (link.current_incident) return <div className="space-y-0.5 text-xs"><p className="font-medium">{link.current_incident.number || "INC"}</p><p>{text(link.current_incident.state_display, incidentStateLabel(link.current_incident.state))}</p><p className="text-muted-foreground">Aberto {timestampLabel(link.current_incident.opened_at)}</p></div>;
  if (link.latest_incident) return <div className="space-y-0.5 text-xs"><p>Sem chamado aberto</p><p className="text-muted-foreground">Último: {link.latest_incident.number || "INC"} · {text(link.latest_incident.state_display, incidentStateLabel(link.latest_incident.state))}</p></div>;
  return <p className="text-xs text-muted-foreground">Sem chamado</p>;
}

function FollowUp({ link }: { link: CanonicalLink }) {
  return link.resolution_status !== "resolved" ? <Badge variant="secondary">Classificação pendente</Badge> : <span className="text-muted-foreground">—</span>;
}
function RecurrenceHint({ link }: { link: CanonicalLink }) {
  const count = Number(link.occurrences_24h || 0);
  if (!link.is_recurrent || count < 2) return null;
  return <Badge variant="outline">🔁 {count} ocorrências / 24h</Badge>;
}
function RecurrencePanel({ link }: { link: CanonicalLink | CanonicalLinkDetail }) {
  const recent = "recent_occurrences" in link ? link.recent_occurrences || [] : [];
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Recorrência</h3>
      <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
        <Field label="Últimas 24h" value={`${Number(link.occurrences_24h || 0)} ocorrências`} />
        <Field label="Últimos 7d" value={`${Number(link.occurrences_7d || 0)} ocorrências`} />
        <Field label="Última recuperação" value={timestampLabel(link.last_recovery_at)} />
        <Field label="Última nova falha" value={timestampLabel(link.last_failure_at)} />
      </div>
      {recent.length ? (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          {recent.map((item, index) => (
            <p key={`${item.started_at || "start"}-${index}`}>
              {timestampLabel(item.started_at)}
              {item.recovered_at ? ` → ${timestampLabel(item.recovered_at)}` : " · em falha"}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ColumnsChooser({ columns, onChange }: { columns: VisibleColumns; onChange: (column: OptionalColumn, checked: boolean) => void }) {
  return <Popover><PopoverTrigger asChild><Button type="button" size="sm" variant="outline">Colunas</Button></PopoverTrigger><PopoverContent align="end" className="w-64 space-y-3 p-3"><p className="text-sm font-medium">Colunas da fila</p><div className="space-y-2">{REQUIRED_COLUMNS.map((column) => <label key={column} className="flex items-center gap-2 text-sm"><Checkbox checked disabled aria-label={column} /><span>{({ link_local: "Link / Local", situation: "Situação", latest_alert: "Último alerta", current_incident: "Chamado atual", follow_up: "Acompanhamento" })[column]}</span></label>)}{OPTIONAL_COLUMNS.map(([column, label]) => <label key={column} className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={columns[column]} onCheckedChange={(checked) => onChange(column, checked === true)} /><span>{label}</span></label>)}</div></PopoverContent></Popover>;
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

function KpiCard({ label, value, tone = "default", onClick }: { label: string; value?: number; tone?: "default" | "danger"; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-border/70 bg-card px-3 py-3 text-left shadow-sm transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "danger" && "text-red-700 dark:text-red-300")}>
        {typeof value === "number" ? value.toLocaleString("pt-BR") : "—"}
      </p>
    </button>
  );
}

function MobileLinkCard({ item, onOpen }: { item: CanonicalLink; onOpen: (item: CanonicalLink) => void }) {
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
        <div className="flex shrink-0 flex-col items-end gap-1"><StateBadge state={item.state} /><ResolutionBadge link={item} /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs"><div><p className="text-muted-foreground">Situação</p><p className="font-medium">{item.active_alerts ? `Em falha há ${failureDuration(item)}` : stateLabel(item.state)}</p></div><div><p className="text-muted-foreground">Último alerta</p><p className="font-medium">{latestAlertLabel(item.latest_alert_at)}</p></div></div>
      <div><p className="text-xs text-muted-foreground">Chamado atual</p><CurrentIncident link={item} /></div>
      <div className="flex items-center justify-between gap-2">
        <FollowUp link={item} />
        <RecurrenceHint link={item} />
        {item.max_severity ? <SeverityBadge severity={item.max_severity} /> : null}
      </div>
    </button>
  );
}

export default function OperadorasPage() {
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
  const [carrier, setCarrier] = useState(ALL);
  const [tab, setTab] = useState<QueueTab>("open");
  const [view, setView] = useState<PageView>("queue");
  const [resolvedWindow, setResolvedWindow] = useState("today");
  const [sort, setSort] = useState("recent");
  const [divergence, setDivergence] = useState<"a" | "b" | "any" | "">("");
  const [recurrence, setRecurrence] = useState<"all" | "recurrent">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CanonicalLink | null>(null);
  const [detail, setDetail] = useState<CanonicalLinkDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [columns, setColumns] = useState<VisibleColumns>(storedColumns);
  const request = useRef<AbortController | null>(null);
  const requestDone = useRef<Promise<void> | null>(null);
  const requestVersion = useRef(0);
  const hasPayload = useRef(false);
  const selectedId = useRef<string | null>(null);
  const detailCache = useRef(new Map<string, CanonicalLinkDetail>());
  const detailRequests = useRef(new Map<string, Promise<CanonicalLinkDetail>>());

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
        carrier,
        tab,
        resolved_window: resolvedWindow,
        sort,
        divergence: divergence || undefined,
        recurrence: recurrence === "recurrent" ? "recurrent" : undefined,
        search,
        page,
        page_size: 50,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setPayload(result);
        hasPayload.current = true;
        setLastSuccessfulRefreshAt(new Date().toISOString());
        setInitialError(null);
        setRefreshError(null);
        setLoading(false);
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
      finishRequest?.();
    }
  }, [ack, carrier, classification, customer, datasource, divergence, incident, page, recurrence, resolvedWindow, search, severity, sort, state, tab]);

  const loadDetail = useCallback(async (link: CanonicalLink) => {
    const key = `${link.id}:${link.data_source_id}:${link.source_host_id}`;
    let pending = detailRequests.current.get(key);
    if (!pending) {
      pending = fetchCanonicalLinkDetail(link);
      detailRequests.current.set(key, pending);
    }
    if (selectedId.current === key && !detailCache.current.has(key)) {
      setDetailLoading(true);
      setDetailError(null);
    }
    try {
      const result = await pending;
      detailCache.current.set(key, result);
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
    const key = `${link.id}:${link.data_source_id}:${link.source_host_id}`;
    selectedId.current = key;
    drawerOpenedAt = performance.now();
    // Open the drawer first; defer heavy detail state work off the click INP path.
    startTransition(() => {
      setSelected(link);
      setDetail(detailCache.current.get(key) || null);
      setDetailError(null);
      setDetailLoading(!detailCache.current.has(key));
    });
    void loadDetail(link);
  }, [loadDetail]);

  const closeLink = useCallback(() => {
    selectedId.current = null;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; request.current?.abort(); };
  }, [load]);

  useEffect(() => {
    try { window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns)); } catch { /* browser preference is optional */ }
  }, [columns]);

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
  const activeFilterCount = [customer, datasource, classification, state, ack, severity, incident, carrier]
    .filter((value) => value !== ALL).length + (search.trim() ? 1 : 0) + (recurrence === "recurrent" ? 1 : 0);
  const customerFacets = payload?.facets.customers || [];
  const quickCustomers = ["Havan", "Protege", "Sanepar", "Tuper", "Teletex"].flatMap((name) => customerFacets.filter((item) => item.label.localeCompare(name, "pt-BR", { sensitivity: "base" }) === 0));
  const moreCustomers = customerFacets.filter((item) => !quickCustomers.some((quick) => quick.value === item.value));
  const kpis = useMemo(() => [
    { label: "Em aberto", value: totals?.operational.open, tone: "danger" as const, tab: "open" as QueueTab },
    { label: "Sem chamado", value: totals?.operational.without_open_incident, tone: "danger" as const, tab: "without_incident" as QueueTab },
    { label: "Com chamado aberto", value: totals?.operational.with_open_incident, tab: "with_incident" as QueueTab },
    { label: "Divergências", value: totals?.operational.divergences, tab: "all" as QueueTab, divergence: "any" as const },
    { label: "Resolvidos hoje", value: totals?.operational.resolved_today, tab: "resolved" as QueueTab },
  ], [totals]);
  const toggleColumn = (column: OptionalColumn, checked: boolean) => setColumns((current) => ({ ...current, [column]: checked }));

  const clearFilters = () => {
    setCustomer(ALL);
    setDatasource(ALL);
    setClassification(ALL);
    setState(ALL);
    setAck(ALL);
    setSeverity(ALL);
    setIncident(ALL);
    setCarrier(ALL);
    setDivergence("");
    setRecurrence("all");
    setSearch("");
    setPage(1);
  };

  return (
    <AppLayout
      title="Links"
      description="Visão operacional dos circuitos monitorados, seus alertas e chamados relacionados."
      onRefresh={() => void load("manual")}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      dataSource={payload ? "database" : null}
      checkedAt={payload?.checked_at}
    >
      <div className="min-w-0 space-y-3">
        <nav aria-label="Visões da página de links" className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-border/70 bg-card p-1">
          {([
            ["open", "Em aberto"], ["without_incident", "Sem chamado"], ["with_incident", "Com chamado"], ["resolved", "Resolvidos"], ["all", "Todos os links"],
          ] as Array<[QueueTab, string]>).map(([value, label]) => (
            <Button key={value} type="button" size="sm" variant={view === "queue" && tab === value ? "default" : "ghost"} className="shrink-0" onClick={() => { setView("queue"); setTab(value); setDivergence(""); setPage(1); }}>{label}</Button>
          ))}
          <span aria-hidden className="mx-1 w-px shrink-0 self-stretch bg-border/70" />
          <Button type="button" size="sm" variant={view === "reminders" ? "default" : "ghost"} className="shrink-0" onClick={() => setView("reminders")}>
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            Lembretes
          </Button>
        </nav>

        {view === "reminders" ? <OperatorRemindersPanel onOpenCircuit={openLink} /> : <>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {kpis.map(({ tab: targetTab, divergence: targetDivergence, ...item }) => <KpiCard key={item.label} {...item} onClick={() => { setView("queue"); setTab(targetTab); setDivergence(targetDivergence || ""); setPage(1); }} />)}
        </div>

        {tab === "all" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>{totals?.links ?? 0} links monitorados</span>
            <span>{totals?.known_carriers ?? 0} com operadora identificada</span>
            <span>{totals?.pending_classification ?? 0} pendentes de classificação</span>
          </div>
        ) : null}

        <div aria-label="Filtro de recorrência" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Recorrência:</span>
          <Button type="button" size="sm" variant={recurrence === "all" ? "default" : "outline"} onClick={() => { setRecurrence("all"); setPage(1); }}>Todos</Button>
          <Button type="button" size="sm" variant={recurrence === "recurrent" ? "default" : "outline"} onClick={() => { setRecurrence("recurrent"); setPage(1); }}>Recorrentes</Button>
        </div>

        <div aria-label="Filtros rápidos de cliente" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Cliente:</span>
          <Button type="button" size="sm" variant={customer === ALL ? "default" : "outline"} onClick={() => setFilter(setCustomer)(ALL)}>Todos</Button>
          {quickCustomers.map((item) => <Button key={item.value} type="button" size="sm" variant={customer === item.value ? "default" : "outline"} onClick={() => setFilter(setCustomer)(item.value)}>{item.label}</Button>)}
          {moreCustomers.length ? <details className="relative"><summary className="cursor-pointer list-none rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">Mais</summary><div className="absolute right-0 z-20 mt-1 flex w-56 flex-col gap-1 rounded-md border bg-popover p-2 shadow-md">{moreCustomers.map((item) => <Button key={item.value} type="button" size="sm" variant={customer === item.value ? "default" : "ghost"} className="justify-start" onClick={() => setFilter(setCustomer)(item.value)}>{item.label}</Button>)}</div></details> : null}
        </div>

        <section aria-label="Filtros de links" className="rounded-lg border border-border/70 bg-card p-3 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(16rem,1.35fr)_auto] xl:items-end">
            <Filter label="Cliente" value={customer} options={optionList(payload?.facets.customers)} onChange={setFilter(setCustomer)} />
            <Filter
              label="Fonte Zabbix"
              value={datasource}
              options={optionList(payload?.facets.datasources).map((item) => ({
                ...item,
                label: item.value === ALL ? item.label : zabbixSourceDisplayName(item.label),
              }))}
              onChange={setFilter(setDatasource)}
            />
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
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="links-search" className="text-xs font-medium text-muted-foreground">Busca</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="links-search"
                  className="h-8 pl-8"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                  placeholder="Link, cliente ou Host ID"
                />
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={clearFilters} disabled={!activeFilterCount}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Limpar
            </Button>
          </div>

          <details className="group mt-3 border-t border-border/60 pt-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
              Mais filtros
              {activeFilterCount > 0 ? <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{activeFilterCount}</Badge> : null}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <Filter label="Classificação" value={classification} options={optionList(payload?.facets.classifications)} onChange={setFilter(setClassification)} />
              <Filter label="Severidade" value={severity} options={[{ value: ALL, label: "Todas" }, { value: "disaster", label: "Disaster" }, { value: "high", label: "High" }, { value: "average", label: "Average" }, { value: "warning", label: "Warning" }]} onChange={setFilter(setSeverity)} />
              <Filter label="ACK" value={ack} options={[{ value: ALL, label: "Todos" }, { value: "pending", label: "Pendente" }, { value: "none", label: "Sem pendência" }]} onChange={setFilter(setAck)} />
              <Filter label="Chamado" value={incident} options={[{ value: ALL, label: "Todos" }, { value: "open", label: "Aberto" }, { value: "without_open", label: "Sem aberto" }, { value: "yes", label: "Com histórico" }, { value: "no", label: "Sem histórico" }]} onChange={setFilter(setIncident)} />
              <Filter label="Operadora" value={carrier} options={[{ value: ALL, label: "Todas" }, { value: "unknown", label: "Não informada na origem" }]} onChange={setFilter(setCarrier)} />
              <Filter label="Ordenação" value={sort} options={[{ value: "recent", label: "Mais recente" }, { value: "oldest", label: "Mais antigo" }, { value: "duration", label: "Maior duração" }, { value: "severity", label: "Maior severidade" }]} onChange={setFilter(setSort)} />
              {tab === "resolved" ? <Filter label="Resolvidos em" value={resolvedWindow} options={[{ value: "today", label: "Hoje" }, { value: "24h", label: "24 horas" }, { value: "7d", label: "7 dias" }]} onChange={setFilter(setResolvedWindow)} /> : null}
            </div>
          </details>
        </section>

        {initialError && !payload ? <OperationalErrorBanner message={initialError} onRetry={() => void load("manual")} /> : null}
        {refreshError && payload ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <span>{refreshError} {lastSuccessfulRefreshAt ? `Última atualização bem-sucedida: ${refreshTime(lastSuccessfulRefreshAt)}.` : ""}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void load("manual")} disabled={loading}>Tentar novamente</Button>
          </div>
        ) : null}
        {payload?.integration_status?.servicenow === "degraded" ? (
          <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            Correlação ServiceNow indisponível nesta consulta; chamados não foram considerados.
          </div>
        ) : null}
        {lastSuccessfulRefreshAt ? <p className="text-xs text-muted-foreground">{refreshing ? "Atualizando… · " : ""}Última atualização bem-sucedida: {refreshTime(lastSuccessfulRefreshAt)}</p> : null}

        <SectionPanel
          title="Fila operacional de links"
          description="Situação atual, alertas e chamados por circuito"
          aside={<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{refreshing ? "Atualizando…" : `${payload?.pagination.total_items ?? 0} links`}</span><ColumnsChooser columns={columns} onChange={toggleColumn} /></div>}
          bodyClassName="p-0"
        >
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
                {items.map((item) => <MobileLinkCard key={item.id} item={item} onOpen={openLink} />)}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[70rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Link / local</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead>Último alerta</TableHead>
                      <TableHead>Chamado atual</TableHead>
                      <TableHead>Acompanhamento</TableHead>
                      {columns.link_type ? <TableHead>Tipo do link</TableHead> : null}
                      {columns.carrier ? <TableHead>Operadora</TableHead> : null}
                      {columns.datasource ? <TableHead>Fonte Zabbix</TableHead> : null}
                      {columns.severity ? <TableHead>Severidade</TableHead> : null}
                      {columns.classification ? <TableHead>Classificação</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} className="cursor-pointer" onClick={() => openLink(item)}>
                        <TableCell className="max-w-[21rem]">
                          <p className="truncate text-sm font-medium">{text(item.customer_name)} · {localLabel(item)}</p>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{linkLabel(item)}</p>
                        </TableCell>
                        <TableCell className="min-w-[12rem]">
                          <div className="flex flex-wrap items-center gap-1"><StateBadge state={item.state} />{item.max_severity ? <SeverityBadge severity={item.max_severity} /> : null}</div>
                          <p className="mt-1 text-xs text-muted-foreground">{item.active_alerts ? `Em falha há ${failureDuration(item)}` : "Sem alerta ativo"}</p>
                          {item.alert_started_at ? <p className="text-xs text-muted-foreground">Caiu às {timestampLabel(item.alert_started_at)}</p> : null}
                        </TableCell>
                        <TableCell>
                          <p className="text-sm font-medium">{latestAlertLabel(item.latest_alert_at)}</p>
                          <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground">{text(item.latest_alert?.problem_name || item.latest_alert?.trigger_description, "Sem alerta registrado")}</p>
                        </TableCell>
                        <TableCell className="min-w-[12rem]"><CurrentIncident link={item} /></TableCell>
                        <TableCell><div className="space-y-1"><FollowUp link={item} /><RecurrenceHint link={item} /></div></TableCell>
                        {columns.link_type ? <TableCell className="max-w-[11rem] text-xs">{linkTypeLabel(item)}</TableCell> : null}
                        {columns.carrier ? <TableCell className="max-w-[11rem] truncate text-xs">{text(item.carrier_name)}</TableCell> : null}
                        {columns.datasource ? <TableCell className="text-xs">{zabbixSourceDisplayName(item.datasource)}</TableCell> : null}
                        {columns.severity ? <TableCell>{item.max_severity ? <SeverityBadge severity={item.max_severity} /> : "—"}</TableCell> : null}
                        {columns.classification ? <TableCell><ResolutionBadge link={item} /></TableCell> : null}
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
        </>}
      </div>

      <QueueLinkDrawer key={selected ? `${selected.id}:${selected.data_source_id}:${selected.source_host_id}` : "closed"} link={selected} detail={detail} loading={detailLoading} error={detailError} onClose={closeLink} onRetry={() => selected && void loadDetail(selected)} />
    </AppLayout>
  );
}

function QueueLinkDrawer({ link, detail, loading, error, onClose, onRetry }: { link: CanonicalLink | null; detail: CanonicalLinkDetail | null; loading: boolean; error: string | null; onClose: () => void; onRetry: () => void }) {
  const [expandedIncidentKey, setExpandedIncidentKey] = useState<string | null>(null);
  const view = detail || link;
  const currentIncident = detail?.current_incident || link?.current_incident;
  const latestIncident = detail?.latest_incident || link?.latest_incident;
  const currentAlert = detail?.current_alert || link?.current_alert;
  return <Sheet open={Boolean(link)} onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">{view ? <>
    <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12 text-left"><div className="flex flex-wrap items-center gap-2"><StateBadge state={view.state} />{view.max_severity ? <SeverityBadge severity={view.max_severity} /> : null}</div><SheetTitle className="break-words text-base">{linkLabel(view)}</SheetTitle><SheetDescription>{view.customer_name} · {localLabel(view)}</SheetDescription></SheetHeader>
    <div className="space-y-5 px-5 py-5">
      <CircuitReminderPanel link={view} />
      {error ? <OperationalErrorBanner message={error} onRetry={onRetry} /> : null}
      <section><h3 className="mb-2 text-sm font-semibold">Resumo operacional</h3><div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2"><Field label="Cliente" value={text(view.customer_name)} /><Field label="Local" value={localLabel(view)} /><Field label="Link" value={linkLabel(view)} /><Field label="Estado" value={stateLabel(view.state)} /><Field label="Severidade" value={text(view.max_severity)} /><Field label="Em falha há" value={view.active_alerts ? failureDuration(view) : "Sem alerta ativo"} /><Field label="Caiu às" value={timestampLabel(view.alert_started_at || view.active_since_at)} /><Field label="Último alerta às" value={timestampLabel(view.latest_alert_at)} /></div></section>
      <RecurrencePanel link={view} />
      {loading && !detail ? <div className="space-y-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /></div> : <>
        <section><h3 className="mb-2 text-sm font-semibold">Chamado atual</h3>{currentIncident ? <IncidentSummaryCard incident={currentIncident} slotKey="current" expanded={expandedIncidentKey === `current:${currentIncident.sys_id || currentIncident.number}`} onToggle={() => { const key = `current:${currentIncident.sys_id || currentIncident.number}`; setExpandedIncidentKey((value) => value === key ? null : key); }} /> : <p className="text-sm text-muted-foreground">Nenhum chamado aberto</p>}{latestIncident && latestIncident.number !== currentIncident?.number ? <div className="mt-3"><p className="mb-2 text-xs text-muted-foreground">Último chamado relacionado</p><IncidentSummaryCard incident={latestIncident} slotKey="latest" expanded={expandedIncidentKey === `latest:${latestIncident.sys_id || latestIncident.number}`} onToggle={() => { const key = `latest:${latestIncident.sys_id || latestIncident.number}`; setExpandedIncidentKey((value) => value === key ? null : key); }} /></div> : null}</section>
        <section><h3 className="mb-2 text-sm font-semibold">Alerta atual</h3>{currentAlert ? <div className="rounded-lg border border-border/60 p-3 text-sm"><p className="font-medium">{text(currentAlert.problem_name || currentAlert.trigger_description, "Alerta sem título")}</p><p className="mt-1 text-xs text-muted-foreground">{text(currentAlert.severity)} · Início: {timestampLabel(currentAlert.started_at)} · Último alerta: {timestampLabel(currentAlert.last_seen_at || view.latest_alert_at)}</p></div> : <p className="text-sm text-muted-foreground">Sem alerta ativo</p>}</section>
        <section><h3 className="mb-2 text-sm font-semibold">Histórico recente</h3>{detail?.incident_history.length ? <div className="space-y-2">{detail.incident_history.map((incident) => { const key = `history:${incident.sys_id || incident.number}`; return <IncidentSummaryCard key={key} incident={incident} slotKey="history" expanded={expandedIncidentKey === key} onToggle={() => setExpandedIncidentKey((value) => value === key ? null : key)} />; })}</div> : <p className="text-sm text-muted-foreground">Sem histórico disponível</p>}</section>
        {detail ? <Accordion type="single" collapsible className="rounded-lg border border-border/60 px-3"><AccordionItem value="technical" className="border-b-0"><AccordionTrigger className="py-3 text-sm">Detalhes técnicos</AccordionTrigger><AccordionContent><div className="grid gap-3 sm:grid-cols-2"><Field label="Circuit key" value={text(detail.technical.circuit_key || detail.service_name)} /><Field label="Host Zabbix" value={`${text(detail.technical.host_name)} · ID ${text(detail.technical.source_host_id)}`} /><Field label="Trigger(s)" value={detail.technical.trigger_ids.length ? detail.technical.trigger_ids.join(", ") : "Não informado"} /><Field label="Member / uplink" value={text(detail.technical.member_key || detail.technical.uplink_key)} /><Field label="Health-check" value={text(detail.technical.healthcheck_key)} /><Field label="IP" value={text(detail.technical.endpoint_ip)} /><Field label="Fonte" value={`${zabbixSourceDisplayName(detail.technical.source)} · ${text(detail.technical.strategy)}`} /><Field label="Confiança" value={text(detail.technical.confidence)} /></div></AccordionContent></AccordionItem></Accordion> : null}
      </>}
    </div>
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

function IncidentSummaryCard({ incident, slotKey, expanded, onToggle }: {
  incident: CanonicalLinkIncident;
  slotKey: "current" | "history" | "latest";
  expanded: boolean;
  onToggle: () => void;
}) {
  const detailId = `incident-detail-${slotKey}-${incident.sys_id || incident.number || "unknown"}`;
  const canExpand = Boolean(incident.sys_id);
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
        <p><b>{incident.number || "INC"}</b> · {text(incident.state_display, incidentStateLabel(incident.state))}</p>
        <p className="mt-1 text-xs text-muted-foreground">Aberto {timestampLabel(incident.opened_at)} · Atualizado {timestampLabel(incident.updated_at)}</p>
        {incident.short_description ? <p className="mt-1 text-xs text-muted-foreground">{incident.short_description}</p> : null}
      </div>
      <span className="shrink-0 text-xs font-medium text-primary">{expanded ? "Recolher" : "Ver detalhes"}</span>
    </button>
    {expanded && incident.sys_id ? <div id={detailId}><IncidentDetailPanel incident={incident} /></div> : null}
  </div>;
}

function IncidentDetailPanel({ incident }: { incident: CanonicalLinkIncident }) {
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
  }, [attempt, incident.sys_id]);

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
      <Field label="Status" value={text(detail.state_display, incidentStateLabel(detail.state))} />
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
  const incidentLine = incidentNumber
    ? `${incidentNumber} · ${incidentStateLabel(snapshotText(snapshot, "incident", "state"))}`
    : "Sem chamado vinculado";

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
        <p className="break-words text-xs text-muted-foreground">{incidentLine}</p>
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
  if (item.status === "sent") return `✅ Theo acionado às ${timestampLabel(item.sent_at)}`;
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
    <div className="space-y-0.5 text-sm"><p className="break-words font-medium">{identity || item.circuit_key}</p><p className="break-words text-xs text-muted-foreground">{circuit}</p><p className="break-words text-xs text-muted-foreground">{incident ? `${incident} · ${incidentStateLabel(snapshotText(snapshot, "incident", "state"))}` : "Sem chamado vinculado"}</p></div>
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
    <p className="text-xs text-muted-foreground">ACK: filtro adiado; o contrato atual de `operator_reminders` não traz reconhecimento confiável.</p>
    {mutationError ? <p role="alert" className="text-xs text-destructive">{mutationError}</p> : null}
    {error && !feed ? <OperationalErrorBanner message={error} onRetry={() => void load(true)} /> : null}
    {error && feed ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>Não foi possível atualizar os lembretes.</span><Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load(true)}>Tentar novamente</Button></div> : null}
    {loading && !feed ? <div className="space-y-2"><Skeleton className="h-28 w-full" /><Skeleton className="h-28 w-full" /></div> : !items.length ? <div className="space-y-2"><OperationalEmptyState compact icon={<Bell className="h-5 w-5" />} title={view === "scheduled" ? "Nenhum lembrete aguardando envio." : "Nenhum lembrete nesta visão."} description={view === "scheduled" ? "Agende um retorno pelo botão Lembrar no detalhe de um circuito com alerta ativo." : "Ajuste período ou filtros para consultar o histórico."} />{view === "scheduled" && (feed?.recent_sent_count || 0) > 0 ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 p-3 text-sm"><span>{feed?.recent_sent_count} lembrados nas últimas 4h</span><Button size="sm" variant="outline" onClick={() => { setPeriod("4h"); chooseView("sent"); }}>Ver lembrados</Button></div> : null}</div> : <div className="grid gap-2 lg:grid-cols-2">{items.map((item) => <ReminderHistoryCard key={item.id} item={item} saving={savingId === item.id} editing={editingId === item.id} date={date} time={time} onDate={setDate} onTime={setTime} onEdit={() => startEdit(item)} onCloseEdit={() => setEditingId(null)} onSave={() => void save(item)} onCancel={() => void cancel(item)} onOpenCircuit={() => onOpenCircuit(reminderHistoryCircuit(item))} />)}</div>}
    {feed?.pagination && feed.pagination.total_items > feed.pagination.limit ? <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{feed.pagination.offset + 1}–{feed.pagination.offset + items.length} de {feed.pagination.total_items}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={feed.pagination.offset === 0} onClick={() => setOffset(Math.max(0, feed.pagination!.offset - feed.pagination!.limit))}>Anterior</Button><Button size="sm" variant="outline" disabled={!feed.pagination.has_next} onClick={() => setOffset(feed.pagination!.offset + feed.pagination!.limit)}>Próxima</Button></div></div> : null}
  </SectionPanel>;
}

function CircuitReminderPanel({ link }: { link: CanonicalLink }) {
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

  return <section><h3 className="mb-2 text-sm font-semibold">Acompanhamento</h3><div className="rounded-lg border border-border/60 p-3 text-sm">
    {reminder ? <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 font-medium"><Bell className="h-4 w-4" />{reminderLabel(reminder.scheduled_for)}</p><p className="mt-1 text-xs text-muted-foreground">Criado por {reminder.created_by_name}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={edit} disabled={saving}>Alterar</Button><Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={saving}>Cancelar</Button></div></div> : <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-muted-foreground">Agende um retorno se o alerta continuar pendente.</p>{reminderUnavailableReason ? <p className="mt-1 text-xs text-muted-foreground">{reminderUnavailableReason}</p> : null}</div><Popover open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}><PopoverTrigger asChild><Button size="sm" variant="outline" disabled={!canSchedule || saving} onClick={create}><Bell className="h-4 w-4" />Lembrar</Button></PopoverTrigger><PopoverContent align="end" className="w-80"><ReminderForm date={date} time={time} saving={saving} submitLabel="Agendar" onDate={setDate} onTime={setTime} onCancel={() => setOpen(false)} onSubmit={() => void save()} /></PopoverContent></Popover></div>}
    {loading ? <p className="mt-2 text-xs text-muted-foreground">Carregando acompanhamento…</p> : null}
    {loadFailed ? <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span>Não foi possível carregar o acompanhamento.</span><Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void loadReminderState(true)}>Tentar novamente</Button></div> : null}
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
