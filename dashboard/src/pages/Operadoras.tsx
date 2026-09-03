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

function isAbortError(cause: unknown) {
  if (!(cause instanceof Error)) return false;
  return cause.name === "AbortError" || /signal is aborted|aborted without reason/i.test(cause.message);
}

const text = (value: unknown, empty = "Não informada na origem") => String(value || "").trim() || empty;
const formatDate = (value: string | null) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "Não informada na origem";
};
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

function KpiCard({ label, value, tone = "default" }: { label: string; value?: number; tone?: "default" | "danger" }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card px-3 py-3 shadow-sm last:col-span-2 lg:last:col-span-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "danger" && "text-red-700 dark:text-red-300")}>
        {typeof value === "number" ? value.toLocaleString("pt-BR") : "—"}
      </p>
    </div>
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
        <StateBadge state={item.state} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><p className="text-muted-foreground">Alertas</p><p className="font-semibold tabular-nums">{item.active_alerts}</p></div>
        <div><p className="text-muted-foreground">Sem ACK</p><p className="font-semibold tabular-nums">{item.unack_alerts}</p></div>
        <div><p className="text-muted-foreground">Chamados</p><p className="font-semibold tabular-nums">{item.incident_count}</p></div>
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
  }, [ack, carrier, classification, customer, datasource, incident, page, search, severity, state]);

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
    { label: "Links monitorados", value: totals?.links },
    { label: "Com alerta ativo", value: totals?.active_alert_links, tone: "danger" as const },
    { label: "Sem alerta ativo", value: totals ? totals.links - totals.active_alert_links : undefined },
    { label: "Com chamado", value: totals?.incident_links },
    { label: "Operadora identificada", value: totals?.known_carriers },
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
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {kpis.map((item) => <KpiCard key={item.label} {...item} />)}
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
              <Filter label="Chamado" value={incident} options={[{ value: ALL, label: "Todos" }, { value: "yes", label: "Com chamado" }, { value: "no", label: "Sem chamado" }]} onChange={setFilter(setIncident)} />
              <Filter label="Operadora" value={carrier} options={[{ value: ALL, label: "Todas" }, { value: "unknown", label: "Não informada na origem" }]} onChange={setFilter(setCarrier)} />
            </div>
          </details>
        </section>

        {error ? <OperationalErrorBanner message={error} onRetry={() => void load("manual")} /> : null}

        <SectionPanel
          title="Inventário de links"
          description="zabbix_link_inventory · correlação por Fonte Zabbix + Host ID"
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
                <Table className="min-w-[62rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Link / Serviço</TableHead>
                      <TableHead>Cliente / Fonte</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Alertas</TableHead>
                      <TableHead>Atendimento</TableHead>
                      <TableHead>Última atualização</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} className="cursor-pointer" onClick={() => setSelected(item)}>
                        <TableCell className="max-w-[18rem]">
                          <p className="truncate font-mono text-xs font-medium">{text(item.service_name, "Link sem identificação")}</p>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{text(item.classification, "Sem classificação")}</p>
                        </TableCell>
                        <TableCell className="max-w-[15rem]">
                          <p className="truncate text-sm font-medium">{text(item.customer_name)}</p>
                          <p className="truncate text-xs text-muted-foreground">{zabbixSourceDisplayName(item.datasource)}</p>
                        </TableCell>
                        <TableCell><StateBadge state={item.state} /></TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-xs">
                            <span><b>{item.active_alerts}</b> ativos</span>
                            <span className="text-muted-foreground"><b>{item.unack_alerts}</b> sem ACK</span>
                          </div>
                          {item.max_severity ? <SeverityBadge severity={item.max_severity} className="mt-1" /> : null}
                        </TableCell>
                        <TableCell className="max-w-[14rem]">
                          <p className="text-xs"><b>{item.incident_count}</b> chamado(s)</p>
                          <p className="truncate text-xs text-muted-foreground">{text(item.carrier_name)}</p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.updated_at)}</TableCell>
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
              <div className="flex flex-wrap items-center gap-2"><StateBadge state={link.state} />{link.max_severity ? <SeverityBadge severity={link.max_severity} /> : null}</div>
              <SheetTitle className="break-words font-mono text-base">{text(link.service_name, "Link sem identificação")}</SheetTitle>
              <SheetDescription>{link.customer_name} · {zabbixSourceDisplayName(link.datasource)}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 px-5 py-5">
              <section className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-2">
                <Field label="Cliente" value={link.customer_name} />
                <Field label="Fonte Zabbix" value={zabbixSourceDisplayName(link.datasource)} />
                <Field label="Host ID" value={link.source_host_id} />
                <Field label="Classificação" value={link.classification} />
                <Field label="Evidência" value={link.source_metadata?.classification_evidence?.group_name || link.classification_source} />
                <Field label="Operadora" value={text(link.carrier_name)} />
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
