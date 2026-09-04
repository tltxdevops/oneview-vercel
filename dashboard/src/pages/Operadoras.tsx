import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { ChevronDown, Link as LinkIcon, RotateCcw, Search } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchCanonicalLinks, type CanonicalLink, type CanonicalLinksResponse } from "@/lib/oneview-api";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import { cn } from "@/lib/utils";
import { OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";

const ALL = "all";
const REFRESH_MS = 10_000;
type QueueTab = "open" | "without_incident" | "with_incident" | "resolved" | "all";

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

function incidentStatus(link: CanonicalLink) {
  if ((link.open_incident_count || 0) > 0) return "Chamado aberto";
  if (link.incident_count > 0) return "Somente histórico";
  return "Sem chamado";
}

function failureDuration(link: CanonicalLink) {
  if (!link.active_since_at) return "Tempo indisponível";
  const elapsed = Math.max(0, Date.now() - new Date(link.active_since_at).getTime());
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${Math.max(0, hours)}h`;
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
          <p className="truncate text-sm font-semibold">{text(item.service_name, "Link sem identificação")}</p>
          <p className="truncate text-xs text-muted-foreground">
            {text(item.customer_name)} · {zabbixSourceDisplayName(item.datasource)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1"><StateBadge state={item.state} /><ResolutionBadge link={item} /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><p className="text-muted-foreground">Tipo</p><p className="truncate font-medium">{linkTypeLabel(item)}</p></div>
        <div><p className="text-muted-foreground">Operadora</p><p className="truncate font-medium">{text(item.carrier_name)}</p></div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><p className="text-muted-foreground">Estado</p><p className="font-medium">{stateLabel(item.state)}</p></div>
        <div><p className="text-muted-foreground">Em falha</p><p className="font-medium">{item.active_alerts ? failureDuration(item) : "—"}</p></div>
        <div><p className="text-muted-foreground">INC</p><p className="truncate font-medium">{incidentStatus(item)}</p></div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{text(item.carrier_name)}</span>
        {item.max_severity ? <SeverityBadge severity={item.max_severity} /> : null}
      </div>
    </button>
  );
}

export default function OperadorasPage() {
  const [payload, setPayload] = useState<CanonicalLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
  const [selectedAlert, setSelectedAlert] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (mode: "initial" | "quiet" | "manual" = "initial") => {
    if (mode === "quiet" && request.current && !request.current.signal.aborted) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (mode !== "quiet") {
      setLoading(true);
      setError(null);
    }
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
        setError(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted && !isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Não foi possível carregar os links.");
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted && mode !== "quiet") setLoading(false);
      }
    }
  }, [ack, carrier, classification, customer, datasource, divergence, incident, page, resolvedWindow, search, severity, sort, state, tab]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

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
  const kpis = useMemo(() => [
    { label: "Em aberto", value: totals?.operational.open, tone: "danger" as const, tab: "open" as QueueTab },
    { label: "Sem chamado", value: totals?.operational.without_open_incident, tone: "danger" as const, tab: "without_incident" as QueueTab },
    { label: "Com chamado aberto", value: totals?.operational.with_open_incident, tab: "with_incident" as QueueTab },
    { label: "Divergências", value: totals?.operational.divergences, tab: "all" as QueueTab, divergence: "any" as const },
    { label: "Resolvidos hoje", value: totals?.operational.resolved_today, tab: "resolved" as QueueTab },
    { label: "Pendentes de classificação", value: totals?.pending_classification },
  ], [totals]);

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
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
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

        {error ? <OperationalErrorBanner message={error} onRetry={() => void load("manual")} /> : null}

        <SectionPanel
          title="Circuitos e links monitorados"
          description="zabbix_link_inventory + escalation=operator · visão circuit-level"
          aside={<span className="text-xs text-muted-foreground">{loading ? "Carregando…" : `${payload?.pagination.total_items ?? 0} links`}</span>}
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
                {items.map((item) => <MobileLinkCard key={item.id} item={item} onOpen={setSelected} />)}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table className="min-w-[64rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Serviço / Circuito</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Operadora</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Alerta</TableHead>
                      <TableHead>Chamado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} className="cursor-pointer" onClick={() => setSelected(item)}>
                        <TableCell className="max-w-[18rem]">
                          <p className="truncate font-mono text-xs font-medium">{text(item.service_name, "Link sem identificação")}</p>
                          <div className="mt-1"><ResolutionBadge link={item} /></div>
                        </TableCell>
                        <TableCell className="max-w-[15rem]">
                          <p className="truncate text-sm font-medium">{text(item.customer_name)}</p>
                          <p className="truncate text-xs text-muted-foreground">{zabbixSourceDisplayName(item.datasource)}</p>
                        </TableCell>
                        <TableCell className="max-w-[11rem] text-xs">{linkTypeLabel(item)}</TableCell>
                        <TableCell className="max-w-[11rem] truncate text-xs">{text(item.carrier_name)}</TableCell>
                        <TableCell><StateBadge state={item.state} /></TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-xs">
                            <span><b>{item.active_alerts}</b> ativos</span>
                            <span className="text-muted-foreground"><b>{item.unack_alerts}</b> sem ACK</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{item.active_alerts ? `Em falha: ${failureDuration(item)}` : "Sem alerta ativo"}</p>
                          {item.max_severity ? <SeverityBadge severity={item.max_severity} className="mt-1" /> : null}
                        </TableCell>
                        <TableCell className="max-w-[12rem]">
                          <p className="text-xs font-medium">{incidentStatus(item)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{item.open_incident_count || 0} aberto(s) · {item.incident_count} correlacionado(s)</p>
                        </TableCell>
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

      <LinkDrawer link={selected} onClose={() => setSelected(null)} onOpenAlert={setSelectedAlert} />
      {selectedAlert ? <AlertNavigator id={selectedAlert} onClose={() => setSelectedAlert(null)} /> : null}
    </AppLayout>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="break-words text-sm">{value}</p></div>;
}

function LinkDrawer({ link, onClose, onOpenAlert }: { link: CanonicalLink | null; onClose: () => void; onOpenAlert: (id: string) => void }) {
  return (
    <Sheet open={Boolean(link)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
        {link ? (
          <>
            <SheetHeader className="border-b border-border/60 px-5 py-5 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2"><StateBadge state={link.state} /><ResolutionBadge link={link} />{link.max_severity ? <SeverityBadge severity={link.max_severity} /> : null}</div>
              <SheetTitle className="break-words font-mono text-base">{text(link.service_name, "Link sem identificação")}</SheetTitle>
              <SheetDescription>{link.customer_name} · {zabbixSourceDisplayName(link.datasource)}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-5 py-5">
              <section>
                <h3 className="mb-2 text-sm font-semibold">Situação operacional</h3>
                <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                  <Field label="Cliente" value={text(link.customer_name)} />
                  <Field label="Circuito" value={text(link.service_name, "Circuito sem identificação")} />
                  <Field label="Estado" value={stateLabel(link.state)} />
                  <Field label="Em falha" value={link.active_alerts ? failureDuration(link) : "Sem alerta ativo"} />
                  <Field label="INC" value={incidentStatus(link)} />
                  <Field label="Chamados abertos" value={String(link.open_incident_count || 0)} />
                  <Field label="Operadora" value={text(link.carrier_name)} />
                  <Field label="Tipo" value={linkTypeLabel(link)} />
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold">Detalhes técnicos</h3>
                <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                  <Field label="Circuito" value={text(link.circuit_key || link.service_name)} />
                  <Field label="Site" value={text(link.site_name || link.site_key)} />
                  <Field label="Tipo" value={linkTypeLabel(link)} />
                  <Field label="Member / Uplink" value={text(link.member_key || link.uplink_key)} />
                  <Field label="Health-check" value={text(link.healthcheck_key)} />
                  <Field label="IP" value={text(link.endpoint_ip)} />
                  <Field label="Host Zabbix" value={`${text(link.host_name)} · ID ${text(link.source_host_id)}`} />
                  <Field label="Trigger(s)" value={link.trigger_ids.length ? link.trigger_ids.join(", ") : "Não informado"} />
                  <Field label="Fonte" value={`${zabbixSourceDisplayName(link.datasource)} · ${text(link.strategy)}`} />
                  <Field label="Qualidade da identificação" value={text(link.confidence)} />
                  <Field label="Operadora" value={text(link.carrier_name)} />
                  <Field label="Referência da operadora" value={text(link.carrier_reference)} />
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold">Alertas ativos · {link.alerts.length}</h3>
                {link.alerts.length ? (
                  <div className="space-y-2">
                    {link.alerts.map((alert) => (
                      <Button key={alert.id} variant="outline" className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => onOpenAlert(alert.id)}>
                        {alert.problem_name || "Alerta sem título"} · {alert.severity || "—"}
                      </Button>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted-foreground">Sem alerta ativo</p>}
              </section>
              <section>
                <h3 className="mb-2 text-sm font-semibold">Chamados correlacionados · {link.incidents.length}</h3>
                {link.incidents.length ? (
                  <div className="space-y-2">
                    {link.incidents.map((incidentItem) => (
                      <div key={incidentItem.sys_id || incidentItem.number} className="rounded-lg border border-border/60 p-3 text-sm">
                        <p><b>{incidentItem.number || "INC"}</b> · {text(incidentItem.state_display || incidentItem.state, "Estado não informado")}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {text(incidentItem.assigned_to_display || incidentItem.assigned_to, "Responsável não informado")} · {text(incidentItem.assignment_group_display || incidentItem.assignment_group, "Grupo não informado")}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : <p className="text-sm text-muted-foreground">Sem chamado correlacionado</p>}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AlertNavigator({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Alerta operacional</SheetTitle>
          <SheetDescription>Abra o alerta no drawer operacional normal.</SheetDescription>
        </SheetHeader>
        <Button className="mt-5" asChild><RouterLink to={`/alertas?alert=${encodeURIComponent(id)}`}>Abrir alerta no OneView</RouterLink></Button>
      </SheetContent>
    </Sheet>
  );
}
