import { useCallback, useEffect, useMemo, useState } from "react";
import { DateRange } from "react-day-picker";
import { endOfDay, endOfMonth, format, startOfDay, startOfMonth } from "date-fns";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DataSource,
  OneViewAlert,
  fetchAllAlerts,
  fetchDataSources,
  formatDurationSeconds,
} from "@/lib/oneview-api";
import { toast } from "sonner";
import { isSnapshotMode as isDemoMode } from "@/lib/demo-mode";
import {
  SNAPSHOT_GRAFANA_SUMMARY,
  SNAPSHOT_LAST_UPDATED_AT,
  SNAPSHOT_READ_ONLY_MESSAGE,
  SNAPSHOT_TOTAL_ALERTS,
} from "@/lib/demo-oneview-data";
import {
  Activity,
  ArrowUpDown,
  CalendarRange,
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  LockKeyhole,
  Loader2,
  MessageSquare,
  RefreshCcw,
  Search,
  ShieldAlert,
  Siren,
  TriangleAlert,
  UserCheck,
} from "lucide-react";

type AckFilter = "all" | "acknowledged" | "unacknowledged";
type StatusFilter = "all" | "active" | "resolved";
type SortField = "clock" | "severity" | "eventid" | "name";
type SeverityLevelValue = "0" | "1" | "2" | "3" | "4" | "5";

interface AlertEvent {
  id: string;
  eventid: string;
  clock: string;
  name: string;
  ackState: "0" | "1";
  severity: string;
  hosts: { hostid: string; name: string }[];
  sourceStatus: "active" | "resolved";
  durationLabel: string;
  lastSeen: string;
  clientName: string;
  clientId: string;
  serviceName?: string | null;
}

const severityCatalog: Record<number, { label: string; short: string }> = {
  5: { label: "Desastre", short: "Z5" },
  4: { label: "Alta", short: "Z4" },
  3: { label: "Média", short: "Z3" },
  2: { label: "Aviso", short: "Z2" },
  1: { label: "Informativo", short: "Z1" },
  0: { label: "Não classificado", short: "Z0" },
};

const severityOrder = [5, 4, 3, 2, 1, 0] as const;
const ALL_SEVERITIES: SeverityLevelValue[] = ["0", "1", "2", "3", "4", "5"];
const DEFAULT_SEVERITIES: SeverityLevelValue[] = isDemoMode ? ALL_SEVERITIES : ["4", "5"];

const severityNumberByApi: Record<string, string> = {
  disaster: "5",
  high: "4",
  average: "3",
  warning: "2",
  information: "1",
  not_classified: "0",
};

const toEvent = (alert: OneViewAlert): AlertEvent => {
  const startedAt = alert.started_at ?? alert.first_seen_at;
  const firstSeen = new Date(startedAt);
  const clock = Number.isNaN(firstSeen.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(firstSeen.getTime() / 1000);

  return {
    id: alert.id,
    eventid: alert.source_event_id || alert.id,
    clock: String(clock),
    name: alert.problem_name,
    ackState: alert.acknowledged_internal || alert.acknowledged_source ? "1" : "0",
    severity: severityNumberByApi[alert.severity] ?? "0",
    hosts: [{ hostid: alert.source_host_id ?? "", name: alert.host_name ?? "-" }],
    sourceStatus: alert.status_source === "resolved" ? "resolved" : "active",
    durationLabel: formatDurationSeconds(alert.duration_seconds),
    lastSeen: alert.last_seen_at,
    clientName: alert.client_name,
    clientId: alert.data_source_id,
    serviceName: alert.service_name,
  };
};

const parseUnix = (value: string) => Number.parseInt(value, 10);
const formatTimestamp = (clock: number) => format(new Date(clock * 1000), "dd/MM/yyyy HH:mm:ss");
const formatSnapshotDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "data indisponível" : date.toLocaleString("pt-BR");
};
const MAX_VISIBLE_ALERTS = 250;
const teletexLogoSrc = `${import.meta.env.BASE_URL}tltx/tltx-t-branco.svg`;

const safeDisplayText = (value: unknown, fallback = "—", maxLength = 240) => {
  if (typeof value !== "string") return fallback;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 ? character : " ";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : fallback;
};

const getDefaultRange = (): DateRange => {
  const now = new Date();
  return { from: startOfMonth(now), to: endOfMonth(now) };
};

export default function AlertsPage() {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [severityLevels, setSeverityLevels] = useState<SeverityLevelValue[]>(DEFAULT_SEVERITIES);
  const [ackFilter, setAckFilter] = useState<AckFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("clock");
  const [sortOrder, setSortOrder] = useState<"ASC" | "DESC">("DESC");
  const [searchTerm, setSearchTerm] = useState("");
  const [timeRange, setTimeRange] = useState<DateRange | undefined>(() => isDemoMode ? undefined : getDefaultRange());
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [totalAlerts, setTotalAlerts] = useState(isDemoMode ? SNAPSHOT_TOTAL_ALERTS : 0);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setFetchError(null);
    try {
      const [sources, alertsResponse] = await Promise.all([
        fetchDataSources(),
        fetchAllAlerts(),
      ]);
      setDataSources(sources);
      setEvents(alertsResponse.items.map(toEvent));
      setTotalAlerts(alertsResponse.total);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao carregar dados reais";
      setFetchError(message);
      toast.error(message);
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const severityFilter = useMemo(() => {
    if (severityLevels.length === 0) return undefined;
    return severityLevels.map((level) => Number(level)).sort((a, b) => a - b);
  }, [severityLevels]);

  const timeRangeSeconds = useMemo(() => {
    const from = timeRange?.from ? Math.floor(startOfDay(timeRange.from).getTime() / 1000) : undefined;
    const to = timeRange?.to ? Math.floor(endOfDay(timeRange.to).getTime() / 1000) : undefined;
    return { from, to };
  }, [timeRange]);

  const normalizedSelectedClients = useMemo(() => {
    if (Array.isArray(selectedClient)) {
      return selectedClient.length === 0 ? ["all"] : selectedClient;
    }
    return [selectedClient];
  }, [selectedClient]);

  const filteredEvents = useMemo(() => {
    let items = [...events];
    if (normalizedSelectedClients.length > 0 && !normalizedSelectedClients.includes("all")) {
      items = items.filter((event) => normalizedSelectedClients.includes(event.clientId));
    }
    if (severityFilter?.length) {
      items = items.filter((event) => severityFilter.includes(Number(event.severity)));
    }
    if (ackFilter !== "all") {
      items = items.filter((event) =>
        ackFilter === "acknowledged" ? event.ackState === "1" : event.ackState === "0",
      );
    }
    if (statusFilter !== "all") {
      items = items.filter((event) => event.sourceStatus === statusFilter);
    }
    if (searchTerm.trim()) {
      const lookup = searchTerm.trim().toLowerCase();
      items = items.filter((event) => {
        const matchName = event.name.toLowerCase().includes(lookup);
        const matchHosts = event.hosts?.some((host) => host.name.toLowerCase().includes(lookup));
        const matchService = (event.serviceName ?? "").toLowerCase().includes(lookup);
        return matchName || matchHosts || matchService;
      });
    }
    if (timeRangeSeconds.from !== undefined) {
      items = items.filter((event) => parseUnix(event.clock) >= timeRangeSeconds.from!);
    }
    if (timeRangeSeconds.to !== undefined) {
      items = items.filter((event) => parseUnix(event.clock) <= timeRangeSeconds.to!);
    }
    items.sort((a, b) => {
      if (sortField === "clock") {
        return sortOrder === "DESC" ? parseUnix(b.clock) - parseUnix(a.clock) : parseUnix(a.clock) - parseUnix(b.clock);
      }
      if (sortField === "severity") {
        return sortOrder === "DESC" ? Number(b.severity) - Number(a.severity) : Number(a.severity) - Number(b.severity);
      }
      if (sortField === "name") {
        return sortOrder === "DESC" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
      }
      return sortOrder === "DESC" ? b.eventid.localeCompare(a.eventid) : a.eventid.localeCompare(b.eventid);
    });

    return items;
  }, [
    ackFilter,
    events,
    normalizedSelectedClients,
    searchTerm,
    severityFilter,
    sortField,
    sortOrder,
    statusFilter,
    timeRangeSeconds.from,
    timeRangeSeconds.to,
  ]);

  const summaryCards = useMemo(() => {
    if (isDemoMode && SNAPSHOT_GRAFANA_SUMMARY) {
      return [
        { title: "TOTAL", value: SNAPSHOT_TOTAL_ALERTS, description: "Alertas sincronizados", icon: Activity, tone: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
        { title: "RECONHECIDOS", value: SNAPSHOT_GRAFANA_SUMMARY.acknowledged, description: "Reconhecidos na origem", icon: CheckCircle2, tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
        { title: "NÃO RECONHECIDOS", value: SNAPSHOT_GRAFANA_SUMMARY.unacknowledged, description: "Aguardando tratamento", icon: CircleAlert, tone: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
        { title: "MÉDIA", value: SNAPSHOT_GRAFANA_SUMMARY.average, description: "Severidade média", icon: TriangleAlert, tone: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300" },
        { title: "ALTA", value: SNAPSHOT_GRAFANA_SUMMARY.high, description: "Alta severidade", icon: ShieldAlert, tone: "border-orange-500/40 bg-orange-500/10 text-orange-300" },
        { title: "DESASTRE", value: SNAPSHOT_GRAFANA_SUMMARY.disaster, description: "Incidentes críticos", icon: Siren, tone: "border-red-500/50 bg-red-500/10 text-red-300" },
      ];
    }
    const total = filteredEvents.length;
    const acknowledged = filteredEvents.filter((event) => event.ackState === "1").length;
    return [
      { title: "TOTAL", value: total, description: "Alertas na visão atual", icon: Activity, tone: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
      { title: "RECONHECIDOS", value: acknowledged, description: "Reconhecidos na origem", icon: CheckCircle2, tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
      { title: "NÃO RECONHECIDOS", value: total - acknowledged, description: "Aguardando tratamento", icon: CircleAlert, tone: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
      { title: "MÉDIA", value: filteredEvents.filter((event) => event.severity === "3").length, description: "Severidade média", icon: TriangleAlert, tone: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300" },
      { title: "ALTA", value: filteredEvents.filter((event) => event.severity === "4").length, description: "Alta severidade", icon: ShieldAlert, tone: "border-orange-500/40 bg-orange-500/10 text-orange-300" },
      { title: "DESASTRE", value: filteredEvents.filter((event) => event.severity === "5").length, description: "Incidentes críticos", icon: Siren, tone: "border-red-500/50 bg-red-500/10 text-red-300" },
    ];
  }, [filteredEvents]);

  const clientTabs = useMemo(() => [
    { id: "all", name: "Todos", count: isDemoMode ? SNAPSHOT_TOTAL_ALERTS : events.length },
    ...dataSources.map((source) => ({
      id: source.id,
      name: safeDisplayText(source.name, "Cliente"),
      count: isDemoMode
        ? source.alerts_count ?? 0
        : events.filter((event) => event.clientId === source.id || event.clientName === source.name).length,
    })),
  ], [dataSources, events]);

  const timeRangeLabel = useMemo(() => {
    if (timeRange?.from && timeRange?.to) return `${format(timeRange.from, "dd/MM/yyyy")} - ${format(timeRange.to, "dd/MM/yyyy")}`;
    if (timeRange?.from) return `Desde ${format(timeRange.from, "dd/MM/yyyy")}`;
    if (timeRange?.to) return `Ate ${format(timeRange.to, "dd/MM/yyyy")}`;
    return "Selecione intervalo";
  }, [timeRange]);

  const handleClearFilters = useCallback(() => {
    setSeverityLevels(DEFAULT_SEVERITIES);
    setAckFilter("all");
    setStatusFilter("all");
    setSortField("clock");
    setSortOrder("DESC");
    setSearchTerm("");
    setTimeRange(isDemoMode ? undefined : getDefaultRange());
    setSelectedClient("all");
  }, []);

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="dark min-h-[calc(100vh-80px)] gap-4 bg-background p-4 text-foreground lg:p-5"
      topbarClassName="dark border-slate-800 bg-slate-950/95 text-slate-100 supports-[backdrop-filter]:bg-slate-950/90"
      clientSelect={
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900">
            <img src={teletexLogoSrc} alt="Teletex" className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-wide text-white">TELETEX · ONEVIEW</p>
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Centro de Operações de Rede</p>
          </div>
        </div>
      }
      topbarRightSection={
        <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
          Monitoramento somente leitura
        </div>
      }
      headerContent={
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-400">
              <Activity className="h-4 w-4" />
              Visão operacional consolidada
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white lg:text-3xl">Painel operacional de alertas</h1>
            <p className="mt-1 text-sm text-slate-400">
              Dados reais atualizados em {formatSnapshotDate(SNAPSHOT_LAST_UPDATED_AT)} · {totalAlerts.toLocaleString("pt-BR")} alertas sincronizados · cópia em modo leitura
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-slate-700 bg-slate-900 text-slate-200 hover:border-sky-500 hover:bg-slate-800 hover:text-white"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            Recarregar visualização
          </Button>
        </header>
      }
    >
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
        <LockKeyhole className="h-4 w-4 shrink-0" />
        <span><strong>Modo leitura:</strong> {SNAPSHOT_READ_ONLY_MESSAGE} A Vercel não mantém conexão em tempo real; endereços IP, pontos de acesso e nomes internos permanecem protegidos.</span>
      </div>

      <section aria-label="Filtro por cliente" className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-3">
        <div className="flex min-w-max items-center gap-2">
          {clientTabs.map((client) => {
            const active = normalizedSelectedClients.includes("all") ? client.id === "all" : normalizedSelectedClients.includes(client.id);
            return (
              <button
                key={client.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedClient(client.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                  active
                    ? "border-sky-500 bg-sky-500/15 text-sky-200"
                    : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200",
                )}
              >
                {client.name}
                <span className={cn("rounded-md px-1.5 py-0.5 font-mono text-[10px]", active ? "bg-sky-400/20" : "bg-slate-800")}>{client.count}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Resumo operacional" className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.title} className={cn("border p-4 shadow-none", card.tone)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">{card.title}</p>
                  <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-white">{card.value.toLocaleString("pt-BR")}</p>
                  <p className="mt-1 text-[11px] opacity-70">{card.description}</p>
                </div>
                <Icon className="h-5 w-5 shrink-0" />
              </div>
            </Card>
          );
        })}
      </section>

      <Card className="border-slate-800 bg-slate-950 p-4 shadow-none">
        <div className="grid gap-4 xl:grid-cols-[minmax(260px,1.5fr)_auto_auto_auto_auto] xl:items-end">
          <label className="flex flex-col gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Buscar alerta
            <span className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Host, serviço ou problema"
                className="h-10 border-slate-700 bg-slate-900 pl-9 text-slate-100 placeholder:text-slate-600"
              />
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Reconhecimento</span>
            <Select value={ackFilter} onValueChange={(value) => setAckFilter(value as AckFilter)}>
              <SelectTrigger className="h-10 min-w-44 border-slate-700 bg-slate-900 text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="acknowledged">Reconhecidos</SelectItem>
                <SelectItem value="unacknowledged">Não reconhecidos</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Status</span>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
              <SelectTrigger className="h-10 min-w-36 border-slate-700 bg-slate-900 text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativos</SelectItem>
                <SelectItem value="resolved">Resolvidos</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Ordenação</span>
            <Select value={sortField} onValueChange={(value) => setSortField(value as SortField)}>
              <SelectTrigger className="h-10 min-w-36 border-slate-700 bg-slate-900 text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="clock">Horário</SelectItem>
                <SelectItem value="severity">Severidade</SelectItem>
                <SelectItem value="eventid">Evento</SelectItem>
                <SelectItem value="name">Problema</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" className="border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white" onClick={() => setSortOrder((value) => value === "ASC" ? "DESC" : "ASC")} aria-label="Alternar ordem">
              <ArrowUpDown className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" className="border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800 hover:text-white" onClick={handleClearFilters}>
              Limpar
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Severidade</span>
          <ToggleGroup type="multiple" value={severityLevels} onValueChange={(value) => setSeverityLevels(value as SeverityLevelValue[])} className="flex flex-wrap justify-start gap-2">
            {severityOrder.map((level) => (
              <ToggleGroupItem
                key={level}
                value={String(level)}
                aria-label={severityCatalog[level].label}
                className="h-8 border border-slate-700 bg-slate-900 px-3 text-[10px] font-semibold text-slate-400 data-[state=on]:border-sky-500 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200"
              >
                {severityCatalog[level].short} · {severityCatalog[level].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {!isDemoMode ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="ml-auto border-slate-700 bg-slate-900 text-slate-300">
                  <CalendarRange className="h-4 w-4" />{timeRangeLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-0">
                <Calendar mode="range" numberOfMonths={1} selected={timeRange} onSelect={setTimeRange} />
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </Card>

      <Card className="overflow-hidden border-slate-800 bg-slate-950 shadow-none">
        <div className="flex flex-col gap-2 border-b border-slate-800 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Alertas operacionais</h2>
            <p className="text-xs text-slate-400">
              Exibindo {Math.min(filteredEvents.length, MAX_VISIBLE_ALERTS).toLocaleString("pt-BR")} de {filteredEvents.length.toLocaleString("pt-BR")} alertas filtrados na cópia de {events.length.toLocaleString("pt-BR")} · total sincronizado {totalAlerts.toLocaleString("pt-BR")}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Info className="h-4 w-4" /> Dados sensíveis removidos antes da exibição
          </div>
          {fetchError ? <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">Falha ao carregar os alertas.</div> : null}
        </div>

        <div className="max-h-[62vh] overflow-auto">
          <Table className="min-w-[1280px] text-xs">
            <TableHeader>
              <TableRow className="border-slate-800 bg-slate-900/95 text-[10px] uppercase tracking-[0.14em] text-slate-400 hover:bg-slate-900/95">
                <TableHead className="w-40">Cliente</TableHead>
                <TableHead className="w-44">Host</TableHead>
                <TableHead className="w-28">IP</TableHead>
                <TableHead className="w-32">Severidade</TableHead>
                <TableHead>Problema</TableHead>
                <TableHead className="w-28">Tempo</TableHead>
                <TableHead className="w-56">Informações</TableHead>
                <TableHead className="w-36">ACK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="py-16 text-center text-slate-400"><Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />Carregando eventos da cópia...</TableCell></TableRow>
              ) : filteredEvents.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-16 text-center text-slate-400">Nenhum alerta corresponde aos filtros selecionados.</TableCell></TableRow>
              ) : (
                filteredEvents.slice(0, MAX_VISIBLE_ALERTS).map((event) => {
                  const severityLevel = Number(event.severity);
                  const lastSeenDate = new Date(event.lastSeen);
                  const lastSeenClock = Number.isNaN(lastSeenDate.getTime())
                    ? parseUnix(event.clock)
                    : Math.floor(lastSeenDate.getTime() / 1000);
                  const hostPrimary = event.hosts?.[0]?.name ?? "-";
                  const severityTone = severityLevel === 5
                    ? "border-red-500/40 bg-red-500/15 text-red-300"
                    : severityLevel === 4
                      ? "border-orange-500/40 bg-orange-500/15 text-orange-300"
                      : severityLevel === 3
                        ? "border-yellow-500/40 bg-yellow-500/15 text-yellow-300"
                        : "border-sky-500/30 bg-sky-500/10 text-sky-300";

                  return (
                    <TableRow key={event.id} className="border-slate-800/80 bg-slate-950 text-slate-300 hover:bg-slate-900/80">
                      <TableCell className="py-3">
                        <span className="font-semibold text-slate-200">{safeDisplayText(event.clientName, "Cliente")}</span>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex flex-col gap-1">
                          <span className="font-medium text-slate-200">{safeDisplayText(hostPrimary, "Host protegido")}</span>
                          <span className="font-mono text-[10px] text-slate-600">#{safeDisplayText(event.eventid, "—", 80)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="inline-flex items-center gap-1.5 text-slate-500"><LockKeyhole className="h-3.5 w-3.5" />Protegido</span>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge className={cn("border px-2 py-1 text-[10px] font-bold uppercase hover:bg-inherit", severityTone)}>
                          {severityCatalog[severityLevel]?.label ?? "Informativo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="max-w-2xl">
                          <p className="font-medium leading-5 text-slate-100">{safeDisplayText(event.name, "Alerta sem descrição")}</p>
                          <p className="mt-1 text-[10px] text-slate-500">
                            {event.serviceName ? `Serviço: ${safeDisplayText(event.serviceName, "—", 100)}` : "Origem sanitizada"}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-slate-300">
                        {safeDisplayText(event.durationLabel)}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex flex-col gap-1">
                            <span className={cn("font-semibold", event.sourceStatus === "active" ? "text-red-300" : "text-emerald-300")}>{event.sourceStatus === "active" ? "ATIVO" : "RESOLVIDO"}</span>
                            <span className="font-mono text-[10px] text-slate-500">{formatTimestamp(lastSeenClock)}</span>
                          </div>
                          <div className="flex gap-1" aria-label="Ações somente leitura">
                            <Button variant="ghost" size="sm" className="h-7 border border-slate-700 px-2 text-[10px] text-slate-500" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} aria-label="Atribuição indisponível no modo leitura">
                              <UserCheck className="h-3.5 w-3.5" />
                              Atribuir
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 border border-slate-700 px-2 text-[10px] text-slate-500" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} aria-label="Comentários indisponíveis no modo leitura">
                              <MessageSquare className="h-3.5 w-3.5" />
                              Comentar
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center gap-2">
                          <Badge className={cn("border px-2 py-1 text-[10px] hover:bg-inherit", event.ackState === "1" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300")}>
                            {event.ackState === "1" ? "ACK" : "PENDENTE"}
                          </Badge>
                          <Button variant="ghost" size="sm" className="h-7 border border-slate-700 px-2 text-[10px] text-slate-500" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} aria-label="ACK indisponível no modo leitura">
                            <Check className="h-3.5 w-3.5" />
                            ACK
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </AppLayout>
  );
}
