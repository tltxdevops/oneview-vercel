import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Link as LinkIcon, RotateCcw, Search } from "lucide-react";
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
import { fetchCanonicalLinkDetail, fetchCanonicalLinks, type CanonicalLink, type CanonicalLinkDetail, type CanonicalLinksResponse } from "@/lib/oneview-api";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import { cn } from "@/lib/utils";
import { OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";

const ALL = "all";
const REFRESH_MS = 10_000;
const COLUMN_STORAGE_KEY = "oneview.operadoras.columns.v1";
const REQUIRED_COLUMNS = ["link_local", "situation", "latest_alert", "current_incident", "follow_up"] as const;
const OPTIONAL_COLUMNS = [
  ["link_type", "Tipo do link"], ["carrier", "Operadora"], ["datasource", "Fonte Zabbix"],
  ["severity", "Severidade"], ["classification", "Pendência de classificação"],
] as const;
type QueueTab = "open" | "without_incident" | "with_incident" | "resolved" | "all";
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
  const [resolvedWindow, setResolvedWindow] = useState("today");
  const [sort, setSort] = useState("recent");
  const [divergence, setDivergence] = useState<"a" | "b" | "any" | "">("");
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
  }, [ack, carrier, classification, customer, datasource, divergence, incident, page, resolvedWindow, search, severity, sort, state, tab]);

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
    setSelected(link);
    setDetail(detailCache.current.get(key) || null);
    setDetailError(null);
    setDetailLoading(!detailCache.current.has(key));
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
      if (document.hidden) return;
      void load("quiet");
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      void load("quiet");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const items = payload?.items || [];
  const totals = payload?.totals;
  const setFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };
  const activeFilterCount = [customer, datasource, classification, state, ack, severity, incident, carrier]
    .filter((value) => value !== ALL).length + (search.trim() ? 1 : 0);
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
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          {kpis.map(({ tab: targetTab, divergence: targetDivergence, ...item }) => <KpiCard key={item.label} {...item} onClick={() => { setTab(targetTab); setDivergence(targetDivergence || ""); setPage(1); }} />)}
        </div>

        <nav aria-label="Fila operacional de links" className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-border/70 bg-card p-1">
          {([
            ["open", "Em aberto"], ["without_incident", "Sem chamado"], ["with_incident", "Com chamado"], ["resolved", "Resolvidos"], ["all", "Todos os links"],
          ] as Array<[QueueTab, string]>).map(([value, label]) => (
            <Button key={value} type="button" size="sm" variant={tab === value ? "default" : "ghost"} className="shrink-0" onClick={() => { setTab(value); setDivergence(""); setPage(1); }}>{label}</Button>
          ))}
        </nav>

        {tab === "all" ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
            <span>{totals?.links ?? 0} links monitorados</span>
            <span>{totals?.known_carriers ?? 0} com operadora identificada</span>
            <span>{totals?.pending_classification ?? 0} pendentes de classificação</span>
          </div>
        ) : null}

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
                        <TableCell><FollowUp link={item} /></TableCell>
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
      </div>

      <QueueLinkDrawer link={selected} detail={detail} loading={detailLoading} error={detailError} onClose={closeLink} onRetry={() => selected && void loadDetail(selected)} />
    </AppLayout>
  );
}

function QueueLinkDrawer({ link, detail, loading, error, onClose, onRetry }: { link: CanonicalLink | null; detail: CanonicalLinkDetail | null; loading: boolean; error: string | null; onClose: () => void; onRetry: () => void }) {
  const view = detail || link;
  const currentIncident = detail?.current_incident || link?.current_incident;
  const latestIncident = detail?.latest_incident || link?.latest_incident;
  const currentAlert = detail?.current_alert || link?.current_alert;
  return <Sheet open={Boolean(link)} onOpenChange={(open) => { if (!open) onClose(); }}><SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">{view ? <>
    <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12 text-left"><div className="flex flex-wrap items-center gap-2"><StateBadge state={view.state} />{view.max_severity ? <SeverityBadge severity={view.max_severity} /> : null}</div><SheetTitle className="break-words text-base">{linkLabel(view)}</SheetTitle><SheetDescription>{view.customer_name} · {localLabel(view)}</SheetDescription></SheetHeader>
    <div className="space-y-5 px-5 py-5">
      {error ? <OperationalErrorBanner message={error} onRetry={onRetry} /> : null}
      <section><h3 className="mb-2 text-sm font-semibold">Resumo operacional</h3><div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2"><Field label="Cliente" value={text(view.customer_name)} /><Field label="Local" value={localLabel(view)} /><Field label="Link" value={linkLabel(view)} /><Field label="Estado" value={stateLabel(view.state)} /><Field label="Severidade" value={text(view.max_severity)} /><Field label="Em falha há" value={view.active_alerts ? failureDuration(view) : "Sem alerta ativo"} /><Field label="Caiu às" value={timestampLabel(view.alert_started_at || view.active_since_at)} /><Field label="Último alerta às" value={timestampLabel(view.latest_alert_at)} /></div></section>
      {loading && !detail ? <div className="space-y-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /></div> : <>
        <section><h3 className="mb-2 text-sm font-semibold">Chamado atual</h3>{currentIncident ? <div className="rounded-lg border border-border/60 p-3 text-sm"><p><b>{currentIncident.number || "INC"}</b> · {text(currentIncident.state_display, incidentStateLabel(currentIncident.state))}</p><p className="mt-1 text-xs text-muted-foreground">Aberto em {timestampLabel(currentIncident.opened_at)} · Atualizado em {timestampLabel(currentIncident.updated_at)}</p><p className="mt-1 text-xs text-muted-foreground">Grupo: {text(currentIncident.assignment_group_display || currentIncident.assignment_group)} · Responsável: {text(currentIncident.assigned_to_display || currentIncident.assigned_to)}</p></div> : <p className="text-sm text-muted-foreground">Nenhum chamado aberto</p>}{latestIncident && latestIncident.number !== currentIncident?.number ? <p className="mt-2 text-xs text-muted-foreground">Último chamado relacionado: <b>{latestIncident.number}</b> · {text(latestIncident.state_display, incidentStateLabel(latestIncident.state))}</p> : null}</section>
        <section><h3 className="mb-2 text-sm font-semibold">Alerta atual</h3>{currentAlert ? <div className="rounded-lg border border-border/60 p-3 text-sm"><p className="font-medium">{text(currentAlert.problem_name || currentAlert.trigger_description, "Alerta sem título")}</p><p className="mt-1 text-xs text-muted-foreground">{text(currentAlert.severity)} · Início: {timestampLabel(currentAlert.started_at)} · Último alerta: {timestampLabel(currentAlert.last_seen_at || view.latest_alert_at)}</p></div> : <p className="text-sm text-muted-foreground">Sem alerta ativo</p>}</section>
        <section><h3 className="mb-2 text-sm font-semibold">Histórico recente</h3>{detail?.incident_history.length ? <div className="space-y-2">{detail.incident_history.map((incident) => <div key={incident.sys_id || incident.number} className="rounded-lg border border-border/60 p-3 text-sm"><p><b>{incident.number || "INC"}</b> · {text(incident.state_display, incidentStateLabel(incident.state))}</p><p className="mt-1 text-xs text-muted-foreground">{timestampLabel(incident.updated_at || incident.opened_at)} · {text(incident.short_description, "Sem resumo")}</p></div>)}</div> : <p className="text-sm text-muted-foreground">Sem histórico disponível</p>}</section>
        {detail ? <Accordion type="single" collapsible className="rounded-lg border border-border/60 px-3"><AccordionItem value="technical" className="border-b-0"><AccordionTrigger className="py-3 text-sm">Detalhes técnicos</AccordionTrigger><AccordionContent><div className="grid gap-3 sm:grid-cols-2"><Field label="Circuit key" value={text(detail.technical.circuit_key || detail.service_name)} /><Field label="Host Zabbix" value={`${text(detail.technical.host_name)} · ID ${text(detail.technical.source_host_id)}`} /><Field label="Trigger(s)" value={detail.technical.trigger_ids.length ? detail.technical.trigger_ids.join(", ") : "Não informado"} /><Field label="Member / uplink" value={text(detail.technical.member_key || detail.technical.uplink_key)} /><Field label="Health-check" value={text(detail.technical.healthcheck_key)} /><Field label="IP" value={text(detail.technical.endpoint_ip)} /><Field label="Fonte" value={`${zabbixSourceDisplayName(detail.technical.source)} · ${text(detail.technical.strategy)}`} /><Field label="Confiança" value={text(detail.technical.confidence)} /></div></AccordionContent></AccordionItem></Accordion> : null}
      </>}
    </div>
  </> : null}</SheetContent></Sheet>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="break-words text-sm">{value}</p></div>;
}
