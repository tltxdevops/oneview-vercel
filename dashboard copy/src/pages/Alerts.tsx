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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  SNAPSHOT_EXPORTED_ALERTS,
  SNAPSHOT_LAST_UPDATED_AT,
  SNAPSHOT_READ_ONLY_MESSAGE,
  SNAPSHOT_SUMMARY,
  SNAPSHOT_TOTAL_ALERTS,
} from "@/lib/demo-oneview-data";
import {
  Activity,
  ArrowUpDown,
  Building2,
  CalendarRange,
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
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
  hostIp: string | null;
  sourceStatus: "active" | "resolved";
  durationLabel: string;
  lastSeen: string;
  clientName: string;
  clientId: string;
  serviceName?: string | null;
  datasourceName: string;
  persistedAt: string;
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
const MAX_VISIBLE_ALERTS = 250;

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
    hostIp: alert.host_ip,
    sourceStatus: alert.status_source === "resolved" ? "resolved" : "active",
    durationLabel: formatDurationSeconds(alert.duration_seconds),
    lastSeen: alert.last_seen_at,
    clientName: alert.client_name,
    clientId: alert.data_source_id,
    serviceName: alert.service_name,
    datasourceName: alert.datasource_name ?? alert.client_name,
    persistedAt: alert.created_at,
  };
};

const parseUnix = (value: string) => Number.parseInt(value, 10);
const formatTimestamp = (clock: number) => format(new Date(clock * 1000), "dd/MM/yyyy HH:mm:ss");

const formatSnapshotDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "data indisponível" : date.toLocaleString("pt-BR");
};

const safeDisplayText = (value: unknown, fallback = "-", maxLength = 240) => {
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
  const [timeRange, setTimeRange] = useState<DateRange | undefined>(() => (isDemoMode ? undefined : getDefaultRange()));
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [totalAlerts, setTotalAlerts] = useState(isDemoMode ? SNAPSHOT_TOTAL_ALERTS : 0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

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

  const filteredEvents = useMemo(() => {
    let items = [...events];

    if (selectedClientIds.length > 0) {
      items = items.filter((event) => selectedClientIds.includes(event.clientId));
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
        const matchProblem = event.name.toLowerCase().includes(lookup);
        const matchHost = event.hosts.some((host) => host.name.toLowerCase().includes(lookup));
        const matchService = (event.serviceName ?? "").toLowerCase().includes(lookup);
        const matchClient = event.clientName.toLowerCase().includes(lookup);
        return matchProblem || matchHost || matchService || matchClient;
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
    searchTerm,
    selectedClientIds,
    severityFilter,
    sortField,
    sortOrder,
    statusFilter,
    timeRangeSeconds.from,
    timeRangeSeconds.to,
  ]);

  const selectedEvent = useMemo(
    () => filteredEvents.find((event) => event.id === selectedEventId) ?? null,
    [filteredEvents, selectedEventId],
  );

  const summaryCards = useMemo(() => {
    if (isDemoMode && SNAPSHOT_GRAFANA_SUMMARY) {
      return [
        { title: "Alertas sincronizados", value: SNAPSHOT_TOTAL_ALERTS, description: "Total persistido no OneView", icon: Activity, iconTone: "bg-primary/10 text-primary" },
        { title: "Alertas exportados", value: SNAPSHOT_EXPORTED_ALERTS, description: "Eventos na cópia atual", icon: CheckCircle2, iconTone: "bg-primary/10 text-primary" },
        { title: "Alertas ativos", value: SNAPSHOT_SUMMARY.active_alerts, description: "Ocorrências em acompanhamento", icon: CircleAlert, iconTone: "bg-amber-100 text-amber-700" },
        { title: "Reconhecidos", value: SNAPSHOT_GRAFANA_SUMMARY.acknowledged, description: "Reconhecidos na origem", icon: UserCheck, iconTone: "bg-emerald-100 text-emerald-700" },
        { title: "Pendentes", value: SNAPSHOT_GRAFANA_SUMMARY.unacknowledged, description: "Aguardando tratamento", icon: TriangleAlert, iconTone: "bg-yellow-100 text-yellow-700" },
        { title: "Alta", value: SNAPSHOT_GRAFANA_SUMMARY.high, description: "Prioridade elevada", icon: ShieldAlert, iconTone: "bg-orange-100 text-orange-700" },
        { title: "Desastre", value: SNAPSHOT_GRAFANA_SUMMARY.disaster, description: "Incidentes críticos", icon: Siren, iconTone: "bg-red-100 text-red-700" },
      ];
    }

    const acknowledged = filteredEvents.filter((event) => event.ackState === "1").length;

    return [
      { title: "Alertas sincronizados", value: totalAlerts, description: "Total persistido no OneView", icon: Activity, iconTone: "bg-primary/10 text-primary" },
      { title: "Alertas exportados", value: events.length, description: "Eventos carregados na visão", icon: CheckCircle2, iconTone: "bg-primary/10 text-primary" },
      { title: "Alertas ativos", value: filteredEvents.filter((event) => event.sourceStatus === "active").length, description: "Ocorrências em acompanhamento", icon: CircleAlert, iconTone: "bg-amber-100 text-amber-700" },
      { title: "Reconhecidos", value: acknowledged, description: "Reconhecidos na origem", icon: UserCheck, iconTone: "bg-emerald-100 text-emerald-700" },
      { title: "Pendentes", value: filteredEvents.length - acknowledged, description: "Aguardando tratamento", icon: TriangleAlert, iconTone: "bg-yellow-100 text-yellow-700" },
      { title: "Alta", value: filteredEvents.filter((event) => event.severity === "4").length, description: "Prioridade elevada", icon: ShieldAlert, iconTone: "bg-orange-100 text-orange-700" },
      { title: "Desastre", value: filteredEvents.filter((event) => event.severity === "5").length, description: "Incidentes críticos", icon: Siren, iconTone: "bg-red-100 text-red-700" },
    ];
  }, [events.length, filteredEvents, totalAlerts]);

  const clientCards = useMemo(() => [
    {
      id: "all",
      name: "Todos",
      count: isDemoMode ? SNAPSHOT_TOTAL_ALERTS : events.length,
    },
    ...dataSources.map((source) => ({
      id: source.id,
      name: safeDisplayText(source.name, "Cliente"),
      count: isDemoMode
        ? source.alerts_count ?? 0
        : events.filter((event) => event.clientId === source.id || event.clientName === source.name).length,
    })),
  ], [dataSources, events]);

  const selectedClientLabel = useMemo(() => {
    if (selectedClientIds.length === 0) return "Todos os clientes";
    if (selectedClientIds.length === 1) {
      return clientCards.find((client) => client.id === selectedClientIds[0])?.name ?? "1 cliente";
    }
    return `${selectedClientIds.length} clientes selecionados`;
  }, [clientCards, selectedClientIds]);

  const timeRangeLabel = useMemo(() => {
    if (timeRange?.from && timeRange?.to) return `${format(timeRange.from, "dd/MM/yyyy")} - ${format(timeRange.to, "dd/MM/yyyy")}`;
    if (timeRange?.from) return `Desde ${format(timeRange.from, "dd/MM/yyyy")}`;
    if (timeRange?.to) return `Até ${format(timeRange.to, "dd/MM/yyyy")}`;
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
    setSelectedClientIds([]);
  }, []);

  const handleClientToggle = useCallback((clientId: string) => {
    if (clientId === "all") {
      setSelectedClientIds([]);
      return;
    }

    setSelectedClientIds((current) =>
      current.includes(clientId)
        ? current.filter((id) => id !== clientId)
        : [...current, clientId],
    );
  }, []);

  const closeDrawer = useCallback(() => {
    setSelectedEventId(null);
  }, []);

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="gap-6 p-5"
      headerContent={
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">Alertas</h1>
            <p className="mt-1 text-sm text-muted-foreground">Eventos Zabbix persistidos no OneView</p>
            <p className="mt-2 text-xs text-muted-foreground">Cópia atualizada em {formatSnapshotDate(SNAPSHOT_LAST_UPDATED_AT)}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void loadData()} disabled={isLoading}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            Atualizar visualização
          </Button>
        </header>
      }
    >
      <section aria-label="Resumo operacional" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-7">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.title} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{card.value.toLocaleString("pt-BR")}</p>
                  <p className="text-xs text-muted-foreground">{card.description}</p>
                </div>
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", card.iconTone)}>
                  <Icon className="h-4 w-4" />
                </div>
              </div>
            </Card>
          );
        })}
      </section>

      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Empresas monitoradas</h2>
            <p className="text-sm text-muted-foreground">Clique para combinar uma ou mais empresas na visão de alertas.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Building2 className="h-4 w-4" />
            {selectedClientLabel}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {clientCards.map((client) => {
            const active = client.id === "all"
              ? selectedClientIds.length === 0
              : selectedClientIds.includes(client.id);

            return (
              <button
                key={client.id}
                type="button"
                aria-pressed={active}
                onClick={() => handleClientToggle(client.id)}
                className={cn(
                  "rounded-[10px] border px-4 py-3 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/70 bg-white hover:border-primary/30 hover:bg-muted/30",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={cn("text-sm font-semibold", active ? "text-primary-foreground" : "text-foreground")}>{client.name}</p>
                    <p className={cn("mt-1 text-xs", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
                      {client.id === "all" ? "Limpa a seleção local" : "Filtra os alertas desta empresa"}
                    </p>
                  </div>
                  <span className={cn("rounded-full px-2 py-1 text-xs font-semibold tabular-nums", active ? "bg-primary-foreground/15 text-primary-foreground" : "bg-muted text-foreground")}>
                    {client.count.toLocaleString("pt-BR")}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,1.6fr)_repeat(3,minmax(150px,0.65fr))_auto] lg:items-end">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Buscar alerta
            <span className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Host, serviço, problema ou cliente"
                className="h-9 pl-9"
              />
            </span>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Reconhecimento
            <Select value={ackFilter} onValueChange={(value) => setAckFilter(value as AckFilter)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="acknowledged">Reconhecidos</SelectItem>
                <SelectItem value="unacknowledged">Não reconhecidos</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Status
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativos</SelectItem>
                <SelectItem value="resolved">Resolvidos</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            Ordenação
            <Select value={sortField} onValueChange={(value) => setSortField(value as SortField)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="clock">Horário</SelectItem>
                <SelectItem value="severity">Severidade</SelectItem>
                <SelectItem value="eventid">Evento</SelectItem>
                <SelectItem value="name">Problema</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSortOrder((value) => (value === "ASC" ? "DESC" : "ASC"))}
              aria-label="Alternar ordem"
            >
              <ArrowUpDown className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={handleClearFilters}>
              Limpar
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <span className="mr-1 text-xs font-medium text-muted-foreground">Severidade</span>
          <ToggleGroup
            type="multiple"
            value={severityLevels}
            onValueChange={(value) => setSeverityLevels(value as SeverityLevelValue[])}
            className="flex flex-wrap justify-start gap-1.5"
          >
            {severityOrder.map((level) => (
              <ToggleGroupItem
                key={level}
                value={String(level)}
                aria-label={severityCatalog[level].label}
                className="h-7 rounded-full border border-border bg-white px-2.5 text-[10px] text-muted-foreground data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {severityCatalog[level].short} · {severityCatalog[level].label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {!isDemoMode ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="ml-auto">
                  <CalendarRange className="h-4 w-4" />
                  {timeRangeLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-0">
                <Calendar mode="range" numberOfMonths={1} selected={timeRange} onSelect={setTimeRange} />
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </Card>

      <Card className="overflow-hidden rounded-[10px] border border-border/70 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Alertas operacionais</h2>
            <p className="text-xs text-muted-foreground">
              Exibindo {Math.min(filteredEvents.length, MAX_VISIBLE_ALERTS).toLocaleString("pt-BR")} de {filteredEvents.length.toLocaleString("pt-BR")} alertas filtrados · {events.length.toLocaleString("pt-BR")} exportados
            </p>
          </div>
          {fetchError ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              Não foi possível atualizar a visualização.
            </div>
          ) : null}
        </div>

        <div className="max-h-[70vh] overflow-auto">
          <Table className="min-w-[1080px] text-xs">
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="border-border/70 bg-muted/70 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted/70">
                <TableHead className="w-36">Cliente</TableHead>
                <TableHead className="w-48">Host</TableHead>
                <TableHead className="w-28">IP</TableHead>
                <TableHead className="w-28">Severidade</TableHead>
                <TableHead>Problema</TableHead>
                <TableHead className="w-24">Tempo</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-24">ACK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                    Carregando eventos da cópia...
                  </TableCell>
                </TableRow>
              ) : filteredEvents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-16 text-center text-muted-foreground">
                    Nenhum alerta corresponde aos filtros selecionados.
                  </TableCell>
                </TableRow>
              ) : (
                filteredEvents.slice(0, MAX_VISIBLE_ALERTS).map((event) => {
                  const severityLevel = Number(event.severity);
                  const lastSeenDate = new Date(event.lastSeen);
                  const lastSeenClock = Number.isNaN(lastSeenDate.getTime())
                    ? parseUnix(event.clock)
                    : Math.floor(lastSeenDate.getTime() / 1000);
                  const hostPrimary = event.hosts[0]?.name ?? "-";
                  const selected = event.id === selectedEventId;
                  const severityTone = severityLevel === 5
                    ? "border-red-200 bg-red-50 text-red-700"
                    : severityLevel === 4
                      ? "border-orange-200 bg-orange-50 text-orange-700"
                      : severityLevel === 3
                        ? "border-yellow-200 bg-yellow-50 text-yellow-700"
                        : "border-border bg-muted text-muted-foreground";

                  return (
                    <TableRow
                      key={event.id}
                      role="button"
                      tabIndex={0}
                      aria-selected={selected}
                      onClick={() => setSelectedEventId(event.id)}
                      onKeyDown={(keyboardEvent) => {
                        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                          keyboardEvent.preventDefault();
                          setSelectedEventId(event.id);
                        }
                      }}
                      className={cn(
                        "cursor-pointer border-border/40 text-foreground outline-none hover:bg-muted/40 focus-visible:bg-muted/60",
                        selected && "bg-muted/60 hover:bg-muted/60",
                      )}
                    >
                      <TableCell className="py-3 font-medium text-foreground">
                        {safeDisplayText(event.clientName, "Cliente")}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-foreground">{safeDisplayText(hostPrimary, "-")}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">#{safeDisplayText(event.eventid, "-", 48)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-muted-foreground">
                        {safeDisplayText(event.hostIp, "-", 64)}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge className={cn("border px-2 py-1 text-[10px] font-semibold hover:bg-inherit", severityTone)}>
                          {severityCatalog[severityLevel]?.label ?? "Informativo"}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <p className="max-w-xl font-medium leading-5 text-foreground">
                          {safeDisplayText(event.name, "Alerta sem descrição")}
                        </p>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-muted-foreground">
                        {safeDisplayText(event.durationLabel, "-")}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className={cn("font-medium", event.sourceStatus === "active" ? "text-red-700" : "text-emerald-700")}>
                            {event.sourceStatus === "active" ? "Ativo" : "Resolvido"}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {formatTimestamp(lastSeenClock)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge className={cn(
                          "border px-2 py-1 text-[10px] hover:bg-inherit",
                          event.ackState === "1"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-amber-200 bg-amber-50 text-amber-700",
                        )}>
                          {event.ackState === "1" ? "Reconhecido" : "Pendente"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Sheet open={selectedEvent !== null} onOpenChange={(open) => { if (!open) closeDrawer(); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-xl">
          {selectedEvent ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 px-6 py-5 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <SheetTitle className="text-xl">Detalhes do alerta</SheetTitle>
                    <SheetDescription>Visualização operacional da tarefa selecionada.</SheetDescription>
                  </div>
                  <Badge className={cn(
                    "border px-2 py-1 text-[10px] hover:bg-inherit",
                    selectedEvent.ackState === "1"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-amber-200 bg-amber-50 text-amber-700",
                  )}>
                    {selectedEvent.ackState === "1" ? "Reconhecido" : "Pendente"}
                  </Badge>
                </div>
              </SheetHeader>

              <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
                <div className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p>
                  <p className="mt-2 text-base font-semibold leading-6 text-foreground">
                    {safeDisplayText(selectedEvent.name, "Alerta sem descrição")}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Cliente</p>
                    <p className="mt-1 font-semibold text-foreground">{safeDisplayText(selectedEvent.clientName, "Cliente")}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Datasource</p>
                    <p className="mt-1 font-semibold text-foreground">{safeDisplayText(selectedEvent.datasourceName, "-")}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Host</p>
                    <p className="mt-1 font-semibold text-foreground">{safeDisplayText(selectedEvent.hosts[0]?.name, "-")}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">IP</p>
                    <p className="mt-1 font-mono font-semibold text-foreground">{safeDisplayText(selectedEvent.hostIp, "-", 64)}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Severidade</p>
                    <p className="mt-1 font-semibold text-foreground">{severityCatalog[Number(selectedEvent.severity)]?.label ?? "Informativo"}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Status</p>
                    <p className="mt-1 font-semibold text-foreground">{selectedEvent.sourceStatus === "active" ? "Ativo" : "Resolvido"}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Duração</p>
                    <p className="mt-1 font-semibold text-foreground">{safeDisplayText(selectedEvent.durationLabel, "-")}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                    <p className="text-[11px] text-muted-foreground">Event ID</p>
                    <p className="mt-1 font-mono font-semibold text-foreground">{safeDisplayText(selectedEvent.eventid, "-", 48)}</p>
                  </Card>
                  <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm sm:col-span-2">
                    <p className="text-[11px] text-muted-foreground">Última atualização</p>
                    <p className="mt-1 font-semibold text-foreground">
                      {formatSnapshotDate(selectedEvent.lastSeen)}
                    </p>
                  </Card>
                </div>

                <div className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                  <h3 className="text-sm font-semibold text-foreground">Linha do tempo</h3>
                  <ol className="mt-4 space-y-4 border-l border-border pl-4 text-xs">
                    <li className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-primary" />
                      <p className="font-medium text-foreground">Detectado no Zabbix</p>
                      <p className="text-muted-foreground">{formatTimestamp(parseUnix(selectedEvent.clock))}</p>
                    </li>
                    <li className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-primary" />
                      <p className="font-medium text-foreground">Persistido no OneView</p>
                      <p className="text-muted-foreground">{formatSnapshotDate(selectedEvent.persistedAt)}</p>
                    </li>
                    <li className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-muted-foreground" />
                      <p className="font-medium text-foreground">Incluído na cópia atualizada</p>
                      <p className="text-muted-foreground">{formatSnapshotDate(SNAPSHOT_LAST_UPDATED_AT)}</p>
                    </li>
                  </ol>
                </div>
              </div>

              <div className="border-t border-border/70 px-6 py-4">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <Button type="button" variant="default" className="gap-2" title="Os detalhes desta tarefa já estão abertos neste painel.">
                    <Eye className="h-4 w-4" />
                    Visualizar
                  </Button>
                  <Button type="button" variant="outline" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} className="gap-2">
                    <Check className="h-4 w-4" />
                    ACK
                  </Button>
                  <Button type="button" variant="outline" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} className="gap-2">
                    <UserCheck className="h-4 w-4" />
                    Atribuir
                  </Button>
                  <Button type="button" variant="outline" disabled title={SNAPSHOT_READ_ONLY_MESSAGE} className="gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Comentar
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
