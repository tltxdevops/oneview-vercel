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
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { StatusBadge } from "@/components/badges/StatusBadge";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { AlertStatus, Severity } from "@/types";
import { cn } from "@/lib/utils";
import {
  DataSource,
  OneViewAlert,
  addAlertNote,
  assignAlert,
  dataSourcesToClients,
  fetchAlert,
  fetchAllAlerts,
  fetchDataSources,
  formatDurationSeconds,
  updateAlertStatus,
} from "@/lib/oneview-api";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CalendarRange,
  Check,
  Eye,
  Loader2,
  MessageSquare,
  Search,
  Ticket,
  UserCheck,
} from "lucide-react";

type AckFilter = "all" | "acknowledged" | "unacknowledged";
type SuppressedFilter = "all" | "suppressed" | "unsuppressed";
type SortField = "clock" | "severity" | "eventid" | "name";
type SeverityLevelValue = "0" | "1" | "2" | "3" | "4" | "5";

interface AlertEvent {
  id: string;
  eventid: string;
  clock: string;
  name: string;
  ackState: "0" | "1";
  severity: string;
  suppressed: "0" | "1";
  hosts: { hostid: string; name: string }[];
  opdata: string;
  status: AlertStatus;
  statusInternal: string;
  durationLabel: string;
  clientName: string;
  clientId: string;
  hostGroup?: string | null;
  serviceName?: string | null;
}

const severityCatalog: Record<number, { label: string; badge: Severity; short: string }> = {
  5: { label: "Desastre", badge: "Critical", short: "Z5" },
  4: { label: "Alta", badge: "High", short: "Z4" },
  3: { label: "Media", badge: "Average", short: "Z3" },
  2: { label: "Aviso", badge: "Average", short: "Z2" },
  1: { label: "Informativo", badge: "Info", short: "Z1" },
  0: { label: "Nao classificado", badge: "Info", short: "Z0" },
};

const severityOrder = [5, 4, 3, 2, 1, 0] as const;
const DEFAULT_SEVERITIES: SeverityLevelValue[] = ["4", "5"];

const severityNumberByApi: Record<string, string> = {
  disaster: "5",
  high: "4",
  average: "3",
  warning: "2",
  information: "1",
  not_classified: "0",
};

const statusFromAlert = (alert: OneViewAlert): AlertStatus => {
  if (alert.status_source === "resolved" || alert.status_internal === "normalized") {
    return "Resolved";
  }
  if (
    alert.acknowledged_internal ||
    alert.acknowledged_source ||
    alert.status_internal === "acknowledged"
  ) {
    return "Acknowledged";
  }
  return "Active";
};

const toEvent = (alert: OneViewAlert): AlertEvent => {
  const firstSeen = new Date(alert.first_seen_at);
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
    suppressed: alert.payload_normalized?.suppressed ? "1" : "0",
    hosts: [{ hostid: alert.source_host_id ?? "", name: alert.host_name ?? "-" }],
    opdata: alert.payload_normalized?.opdata ?? "",
    status: statusFromAlert(alert),
    statusInternal: alert.status_internal,
    durationLabel: formatDurationSeconds(alert.duration_seconds),
    clientName: alert.client_name,
    clientId: alert.data_source_id,
    hostGroup: alert.host_group,
    serviceName: alert.service_name,
  };
};

const parseUnix = (value: string) => Number.parseInt(value, 10);
const toSeverity = (level: number): Severity => severityCatalog[level]?.badge ?? "Info";
const formatTimestamp = (clock: number) => format(new Date(clock * 1000), "dd/MM/yyyy HH:mm:ss");

const getDefaultRange = (): DateRange => {
  const now = new Date();
  return { from: startOfMonth(now), to: endOfMonth(now) };
};

export default function AlertsPage() {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [severityLevels, setSeverityLevels] = useState<SeverityLevelValue[]>(DEFAULT_SEVERITIES);
  const [ackFilter, setAckFilter] = useState<AckFilter>("all");
  const [suppressedFilter, setSuppressedFilter] = useState<SuppressedFilter>("all");
  const [sortField, setSortField] = useState<SortField>("clock");
  const [sortOrder, setSortOrder] = useState<"ASC" | "DESC">("DESC");
  const [searchTerm, setSearchTerm] = useState("");
  const [timeRange, setTimeRange] = useState<DateRange | undefined>(getDefaultRange);
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const clients = useMemo(() => dataSourcesToClients(dataSources), [dataSources]);

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
    if (suppressedFilter !== "all") {
      items = items.filter((event) =>
        suppressedFilter === "suppressed" ? event.suppressed === "1" : event.suppressed !== "1",
      );
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
    suppressedFilter,
    timeRangeSeconds.from,
    timeRangeSeconds.to,
  ]);

  const kpis = useMemo(() => {
    const total = filteredEvents.length;
    const acknowledged = filteredEvents.filter((event) => event.ackState === "1").length;
    const pending = total - acknowledged;
    const highSeverity = filteredEvents.filter((event) => Number(event.severity) >= 4).length;

    return [
      { title: "Eventos monitorados", value: total, description: "Dados persistidos", icon: <Activity className="h-5 w-5" />, accent: "bg-primary/10 text-primary" },
      { title: "Pendentes", value: pending, description: "Sem reconhecimento", icon: <AlertTriangle className="h-5 w-5" />, accent: "bg-error/10 text-error" },
      { title: "Reconhecidos", value: acknowledged, description: "Fonte ou interno", icon: <Check className="h-5 w-5" />, accent: "bg-success/10 text-success" },
      { title: "Alta severidade", value: highSeverity, description: ">= Z4", icon: <Ticket className="h-5 w-5" />, accent: "bg-warning/10 text-warning" },
    ];
  }, [filteredEvents]);

  const timeRangeLabel = useMemo(() => {
    if (timeRange?.from && timeRange?.to) return `${format(timeRange.from, "dd/MM/yyyy")} - ${format(timeRange.to, "dd/MM/yyyy")}`;
    if (timeRange?.from) return `Desde ${format(timeRange.from, "dd/MM/yyyy")}`;
    if (timeRange?.to) return `Ate ${format(timeRange.to, "dd/MM/yyyy")}`;
    return "Selecione intervalo";
  }, [timeRange]);

  const handleClearFilters = useCallback(() => {
    setSeverityLevels(DEFAULT_SEVERITIES);
    setAckFilter("all");
    setSuppressedFilter("all");
    setSortField("clock");
    setSortOrder("DESC");
    setSearchTerm("");
    setTimeRange(getDefaultRange());
  }, []);

  const selectedClientSummary = useMemo(() => {
    if (normalizedSelectedClients.includes("all")) return "Todos";
    const names = normalizedSelectedClients
      .map((id) => clients.find((client) => client.id === id)?.name ?? id)
      .filter(Boolean);
    return names.length === 1 ? names[0] : `${names[0]} (+${names.length - 1})`;
  }, [clients, normalizedSelectedClients]);

  const runAlertAction = useCallback(async (key: string, action: () => Promise<void>) => {
    setRunningAction(key);
    try {
      await action();
      await loadData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao executar acao");
    } finally {
      setRunningAction(null);
    }
  }, [loadData]);

  const handleDetails = useCallback((event: AlertEvent) => {
    void runAlertAction(`details:${event.id}`, async () => {
      const detail = await fetchAlert(event.id);
      await updateAlertStatus(event.id, "viewed", "Visualizado pela tela de alertas");
      toast.info(`${detail.client_name} | ${detail.host_name ?? "-"} | ${detail.problem_name}`);
    });
  }, [runAlertAction]);

  const handleAddNote = useCallback((event: AlertEvent) => {
    const message = window.prompt(`Observacao interna para o alerta ${event.eventid}`);
    if (!message?.trim()) return;
    void runAlertAction(`note:${event.id}`, async () => {
      await addAlertNote(event.id, message.trim());
      toast.success("Observacao registrada no historico do alerta");
    });
  }, [runAlertAction]);

  const handleAssign = useCallback((event: AlertEvent) => {
    void runAlertAction(`assign:${event.id}`, async () => {
      await assignAlert(event.id);
      toast.success("Atendimento assumido e historico atualizado");
    });
  }, [runAlertAction]);

  const handleAck = useCallback((event: AlertEvent) => {
    const confirmed = window.confirm("Registrar reconhecimento interno no OneView? ACK real no Zabbix esta bloqueado.");
    if (!confirmed) return;
    void runAlertAction(`ack:${event.id}`, async () => {
      await updateAlertStatus(event.id, "acknowledged", "Reconhecimento interno pela tela de alertas");
      toast.success("Reconhecimento interno registrado");
    });
  }, [runAlertAction]);

  return (
    <AppLayout
      title="Alertas"
      description="Eventos Zabbix persistidos no OneView."
      enableAutoRefresh={false}
      showRefreshMeta={false}
      onRefresh={loadData}
      clientSelect={
        <ClientSelect
          clients={clients}
          selectedClient={selectedClient}
          onClientChange={setSelectedClient}
        />
      }
    >
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.title} className="rounded-[10px] border border-border/60 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{kpi.title}</p>
                <p className="mt-2 text-3xl font-semibold tabular-nums">{kpi.value}</p>
                <p className="mt-1 text-xs text-muted-foreground/80">{kpi.description}</p>
              </div>
              <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", kpi.accent)}>{kpi.icon}</div>
            </div>
          </Card>
        ))}
      </section>

      <Card className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5">
          <div className="grid gap-4 lg:grid-cols-[1.6fr,1fr]">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Pesquisa</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80" />
                <Input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Buscar por host, servico ou problema"
                  className="h-10 rounded-lg border border-border/70 bg-white pl-9 text-sm"
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Janela temporal</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="flex h-10 w-full items-center justify-between rounded-lg border border-border/70 bg-white px-3 text-sm font-normal text-foreground">
                    <span className="truncate text-left">{timeRangeLabel}</span>
                    <CalendarRange className="ml-2 h-4 w-4 text-muted-foreground/80" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar mode="range" numberOfMonths={1} selected={timeRange} onSelect={setTimeRange} />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Severidade Zabbix</span>
            <ToggleGroup
              type="multiple"
              value={severityLevels}
              onValueChange={(value) => setSeverityLevels(value.length > 0 ? (value as SeverityLevelValue[]) : [])}
              className="flex flex-wrap gap-2"
            >
              {severityOrder.map((level) => (
                <ToggleGroupItem
                  key={level}
                  value={String(level) as SeverityLevelValue}
                  className="h-9 rounded-lg border border-border/70 bg-white px-3 text-[11px] font-semibold uppercase tracking-wide text-foreground data-[state=on]:border-black data-[state=on]:bg-black data-[state=on]:text-white"
                  title={severityCatalog[level].label}
                  aria-label={severityCatalog[level].label}
                >
                  {severityCatalog[level].short}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Reconhecimento</span>
              <Select value={ackFilter} onValueChange={(value) => setAckFilter(value as AckFilter)}>
                <SelectTrigger className="h-10 rounded-lg border border-border/70 bg-white text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="acknowledged">Somente reconhecidos</SelectItem>
                  <SelectItem value="unacknowledged">Somente pendentes</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Estado suprimido</span>
              <Select value={suppressedFilter} onValueChange={(value) => setSuppressedFilter(value as SuppressedFilter)}>
                <SelectTrigger className="h-10 rounded-lg border border-border/70 bg-white text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="suppressed">Apenas suprimidos</SelectItem>
                  <SelectItem value="unsuppressed">Somente ativos</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Ordem</span>
              <Button variant="outline" className="flex h-10 items-center justify-between rounded-lg border border-border/70 bg-white px-3 text-sm font-medium" onClick={() => setSortOrder((prev) => (prev === "ASC" ? "DESC" : "ASC"))}>
                <span>{sortOrder === "ASC" ? "Ascendente" : "Descendente"}</span>
                <ArrowUpDown className="h-4 w-4 text-muted-foreground/80" />
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[2fr,1fr]">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">Campo de ordenacao</span>
              <Select value={sortField} onValueChange={(value) => setSortField(value as SortField)}>
                <SelectTrigger className="h-10 rounded-lg border border-border/70 bg-white text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="clock">clock</SelectItem>
                  <SelectItem value="severity">severity</SelectItem>
                  <SelectItem value="eventid">eventid</SelectItem>
                  <SelectItem value="name">name</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-9 rounded-lg border border-border/70 bg-white px-4 text-xs font-semibold" onClick={handleClearFilters}>
                Limpar filtros
              </Button>
              <Button size="sm" className="h-9 rounded-lg px-4 text-xs font-semibold" onClick={() => void loadData()} disabled={isLoading}>
                {isLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Consultando...</> : "Atualizar"}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="rounded-[10px] border border-border/60 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-border/60 px-6 py-5">
          <div className="flex flex-col gap-1 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Eventos retornados</h2>
              <p className="text-xs text-muted-foreground">{filteredEvents.length} registros encontrados</p>
            </div>
            <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground lg:items-end">
              <span>Clientes: {selectedClientSummary}</span>
              <span>Janela: {timeRangeLabel}</span>
              <span>Data Sources: {dataSources.length}</span>
            </div>
          </div>
          {fetchError && <div className="rounded-lg border border-error/60 bg-error/10 px-4 py-3 text-sm text-error">{fetchError}</div>}
        </div>

        <div className="overflow-x-auto">
          <Table className="min-w-full text-sm">
            <TableHeader>
              <TableRow className="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <TableHead className="w-28">Evento</TableHead>
                <TableHead className="w-40">Detectado em</TableHead>
                <TableHead className="w-40">Cliente</TableHead>
                <TableHead className="w-48">Host</TableHead>
                <TableHead>Descricao</TableHead>
                <TableHead className="w-36">Severidade</TableHead>
                <TableHead className="w-40">Operacional</TableHead>
                <TableHead className="w-32">Duracao</TableHead>
                <TableHead className="w-40">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9} className="py-12 text-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />Consultando eventos no OneView...</TableCell></TableRow>
              ) : filteredEvents.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="py-12 text-center text-sm text-muted-foreground">Nenhum evento real encontrado. Sincronize um Data Source em Configuracoes.</TableCell></TableRow>
              ) : (
                filteredEvents.map((event) => {
                  const severityLevel = Number(event.severity);
                  const clock = parseUnix(event.clock);
                  const hostPrimary = event.hosts?.[0]?.name ?? "-";
                  const suppressed = event.suppressed === "1";

                  return (
                    <TableRow key={event.id} className="border-b border-border/40 last:border-none">
                      <TableCell><span className="font-mono text-xs font-semibold text-foreground">#{event.eventid}</span></TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs text-foreground">
                          <span className="font-medium">{formatTimestamp(clock)}</span>
                          <span className="text-[11px] text-muted-foreground">Unix: {clock}</span>
                        </div>
                      </TableCell>
                      <TableCell><span className="text-sm font-semibold text-foreground/90">{event.clientName}</span></TableCell>
                      <TableCell>
                        <div className="flex flex-col text-sm font-medium text-foreground">
                          <span>{hostPrimary}</span>
                          {event.hostGroup && <span className="text-[11px] text-muted-foreground">{event.hostGroup}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-2">
                          <span className="text-sm font-medium text-foreground/90">{event.name}</span>
                          {event.opdata && <span className="text-xs text-muted-foreground/80">{event.opdata}</span>}
                          {event.serviceName && <span className="text-xs text-muted-foreground/80">Servico: {event.serviceName}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <SeverityBadge severity={toSeverity(severityLevel)} />
                          <span className="text-[10px] text-muted-foreground">{severityCatalog[severityLevel]?.label ?? "-"}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <StatusBadge status={event.status} className="text-[11px]" />
                          <Badge className={cn("h-6 w-fit rounded-full px-3 text-[11px]", suppressed ? "border-transparent bg-muted text-muted-foreground" : "border-transparent bg-primary/10 text-primary")}>
                            {event.statusInternal}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell><span className="text-sm font-medium tabular-nums text-foreground">{event.durationLabel}</span></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg border border-border/70 text-muted-foreground hover:border-black hover:text-foreground" onClick={() => handleDetails(event)} disabled={runningAction !== null} aria-label={`Ver detalhes ${event.eventid}`}>
                            {runningAction === `details:${event.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                          </Button>
                          <Button variant="outline" size="sm" className="h-8 rounded-lg px-3 text-xs" onClick={() => handleAssign(event)} disabled={runningAction !== null} title="Assumir atendimento interno">
                            {runningAction === `assign:${event.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <UserCheck className="mr-1.5 h-3.5 w-3.5" />}Assumir
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg border border-border/70 text-muted-foreground hover:border-black hover:text-foreground" onClick={() => handleAddNote(event)} disabled={runningAction !== null} title="Adicionar observacao interna" aria-label={`Adicionar observacao ${event.eventid}`}>
                            {runningAction === `note:${event.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg border border-border/70 text-muted-foreground hover:border-black hover:text-foreground" onClick={() => handleAck(event)} disabled={runningAction !== null} title="Reconhecimento interno" aria-label={`Reconhecer internamente ${event.eventid}`}>
                            {runningAction === `ack:${event.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
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
