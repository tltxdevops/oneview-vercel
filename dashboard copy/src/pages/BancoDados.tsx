import { useCallback, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { mockClients, mockDatabaseInstances, mockDatabasePerformance } from "@/lib/mock-data";
import { DatabaseInstance, DatabaseStatus } from "@/types";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Clock4,
  Database,
  PowerOff,
  ShieldAlert,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Cell,
  LineChart,
  Line,
} from "recharts";

const REFRESH_INTERVAL_SECONDS = 60;

const STATUS_CONFIG: Record<DatabaseStatus, { label: string; badgeClass: string; dotClass: string; chartColor: string }> = {
  Online: {
    label: "Disponível",
    badgeClass: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600",
    dotClass: "bg-emerald-500",
    chartColor: "#22c55e",
  },
  Degradado: {
    label: "Degradado",
    badgeClass: "border-amber-500/50 bg-amber-500/10 text-amber-600",
    dotClass: "bg-amber-500",
    chartColor: "#f59e0b",
  },
  Offline: {
    label: "Indisponível",
    badgeClass: "border-rose-500/50 bg-rose-500/10 text-rose-600",
    dotClass: "bg-rose-500",
    chartColor: "#f43f5e",
  },
  Manutenção: {
    label: "Manutenção",
    badgeClass: "border-sky-500/50 bg-sky-500/10 text-sky-600",
    dotClass: "bg-sky-500",
    chartColor: "#0ea5e9",
  },
};

const PERFORMANCE_LEGEND = [
  { label: "CPU", color: "#2563eb" },
  { label: "Memória", color: "#0ea5e9" },
  { label: "I/O", color: "#f97316" },
];

const parseDate = (value: string) => {
  const normalized = value.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const hoursSince = (value: string) => {
  const parsed = parseDate(value);
  if (!parsed) return Number.POSITIVE_INFINITY;
  return (Date.now() - parsed.getTime()) / 3_600_000;
};

const formatPercentage = (value: number) => `${Math.round(value)}%`;

const formatLatency = (value: number) => `${Math.round(value)} ms`;

const formatReplicationLag = (value: number) => {
  if (value <= 0) return "—";
  if (value < 60) return `${value}s`;
  const minutes = value / 60;
  return `${minutes.toFixed(minutes >= 10 ? 0 : 1)}min`;
};

const resolveClientName = (clientId?: string) => {
  if (!clientId) return "Indefinido";
  const client = mockClients.find((c) => c.id === clientId);
  return client?.name ?? clientId;
};

const chartTooltipFormatter = (value: number) => `${value}`;

export default function BancoDadosPage() {
  const [selectedClient, setSelectedClient] = useState("all");

  const handleClientSelect = useCallback((value: string | string[]) => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        setSelectedClient("all");
        return;
      }

      const last = value[value.length - 1];
      setSelectedClient(last ?? "all");
      return;
    }

    setSelectedClient(value);
  }, []);

  const handleRefresh = useCallback(async () => {
    // Substituir por requisição real quando houver backend
    return Promise.resolve();
  }, []);

  const filteredInstances = useMemo(() => {
    if (selectedClient === "all") return mockDatabaseInstances;
    return mockDatabaseInstances.filter((instance) => instance.clientId === selectedClient);
  }, [selectedClient]);

  const statusCounts = useMemo(() => {
    return filteredInstances.reduce(
      (acc, instance) => {
        acc[instance.status] += 1;
        return acc;
      },
      {
        Online: 0,
        Degradado: 0,
        Offline: 0,
        Manutenção: 0,
      } as Record<DatabaseStatus, number>,
    );
  }, [filteredInstances]);

  const delayedBackups = useMemo(() => {
    return filteredInstances.filter((instance) => hoursSince(instance.lastBackup) > 24).length;
  }, [filteredInstances]);

  const averageLatency = useMemo(() => {
    if (filteredInstances.length === 0) return 0;
    const total = filteredInstances.reduce((acc, instance) => acc + instance.avgLatencyMs, 0);
    return total / filteredInstances.length;
  }, [filteredInstances]);

  const averageCpu = useMemo(() => {
    if (filteredInstances.length === 0) return 0;
    const total = filteredInstances.reduce((acc, instance) => acc + instance.cpuUsage, 0);
    return total / filteredInstances.length;
  }, [filteredInstances]);

  const kpis = useMemo(() => {
    const total = filteredInstances.length;

    return [
      {
        title: "Bancos monitorados",
        value: total,
        description: "Total de instâncias ativas no painel",
        icon: <Database className="h-5 w-5" />,
      },
      {
        title: "Disponíveis",
        value: statusCounts.Online,
        description: "Instâncias operando normalmente",
        icon: <CheckCircle2 className="h-5 w-5" />,
      },
      {
        title: "Degradados",
        value: statusCounts.Degradado,
        description: "Monitorar possíveis impactos",
        icon: <AlertTriangle className="h-5 w-5" />,
      },
      {
        title: "Indisponíveis",
        value: statusCounts.Offline,
        description: "Ação imediata necessária",
        icon: <PowerOff className="h-5 w-5" />,
      },
      {
        title: "Backups > 24h",
        value: delayedBackups,
        description: "Instâncias com backup atrasado",
        icon: <Clock4 className="h-5 w-5" />,
      },
    ];
  }, [filteredInstances.length, statusCounts, delayedBackups]);

  const statusChartData = useMemo(() => {
    return (Object.keys(STATUS_CONFIG) as DatabaseStatus[]).map((status) => ({
      status,
      label: STATUS_CONFIG[status].label,
      value: statusCounts[status],
      color: STATUS_CONFIG[status].chartColor,
    }));
  }, [statusCounts]);

  const incidents = useMemo(() => {
    return filteredInstances
      .filter((instance) => instance.status !== "Online" || (instance.issues && instance.issues.length > 0))
      .map((instance) => ({
        id: instance.id,
        name: instance.name,
        status: instance.status,
        issues: instance.issues ?? [],
        host: instance.host,
        environment: instance.environment,
      }));
  }, [filteredInstances]);

  const performanceData = useMemo(() => {
    if (filteredInstances.length === mockDatabaseInstances.length) {
      return mockDatabasePerformance;
    }

    // Ajusta escala considerando apenas instâncias selecionadas, usando fator percentual de CPU médio
    const cpuFactor = averageCpu === 0 ? 1 : averageCpu / 100;

    return mockDatabasePerformance.map((point) => ({
      ...point,
      cpu: Math.min(100, Math.round(point.cpu * cpuFactor * 1.05)),
      memory: Math.min(100, Math.round(point.memory * cpuFactor * 1.1)),
      io: Math.round(point.io * cpuFactor * 1.2),
    }));
  }, [averageCpu, filteredInstances.length]);

  const description = useMemo(() => {
    if (selectedClient === "all") {
      return "Visão consolidada da saúde dos bancos de dados monitorados.";
    }
    const client = mockClients.find((c) => c.id === selectedClient);
    return client
      ? `Status operacional dos bancos associados a ${client.name}.`
      : "Status operacional dos bancos para o cliente selecionado.";
  }, [selectedClient]);

  return (
    <AppLayout
      title="Banco de Dados"
      description={description}
      clientSelect={
        <ClientSelect
          clients={mockClients}
          selectedClient={selectedClient}
          onClientChange={handleClientSelect}
        />
      }
      onRefresh={handleRefresh}
      refreshInterval={REFRESH_INTERVAL_SECONDS}
      headerAside={
        <div className="flex flex-col items-end gap-1 text-right text-xs text-muted-foreground">
          <span>
            Latência média: <span className="font-semibold text-foreground">{formatLatency(averageLatency)}</span>
          </span>
          <span>
            CPU média: <span className="font-semibold text-foreground">{formatPercentage(averageCpu)}</span>
          </span>
        </div>
      }
    >
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map((kpi) => (
          <Card key={kpi.title} className="rounded-[10px] border border-border bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{kpi.title}</p>
                <p className="text-2xl font-semibold text-foreground">{kpi.value}</p>
                <p className="mt-2 text-xs text-muted-foreground/80">{kpi.description}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                {kpi.icon}
              </div>
            </div>
          </Card>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm xl:col-span-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Distribuição de status</h2>
              <p className="text-xs text-muted-foreground">
                Contagem de instâncias por status operacional.
              </p>
            </div>
          </div>
          <div className="mt-6 h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusChartData} barSize={36}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <RechartsTooltip formatter={chartTooltipFormatter} labelFormatter={(label) => label} />
                <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                  {statusChartData.map((entry) => (
                    <Cell key={entry.status} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm xl:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Histórico de desempenho</h2>
              <p className="text-xs text-muted-foreground">
                Evolução de CPU, memória e IO nas últimas 24h.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
              {PERFORMANCE_LEGEND.map((item) => (
                <div key={item.label} className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                    aria-hidden
                  />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-6 h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={performanceData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 200]} tick={{ fontSize: 12 }} />
                <RechartsTooltip formatter={chartTooltipFormatter} />
                <Line type="monotone" dataKey="cpu" stroke="#2563eb" strokeWidth={2} dot={false} name="CPU" />
                <Line type="monotone" dataKey="memory" stroke="#0ea5e9" strokeWidth={2} dot={false} name="Memória" />
                <Line type="monotone" dataKey="io" stroke="#f97316" strokeWidth={2} dot={false} name="I/O" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </section>

      <section className="rounded-[10px] border border-border/60 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-border/60 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Inventário de bancos</h2>
            <p className="text-xs text-muted-foreground">
              {filteredInstances.length} instâncias monitoradas neste contexto.
            </p>
          </div>
          {selectedClient !== "all" && (
            <p className="text-xs text-muted-foreground sm:text-right">
              Cliente selecionado: <span className="font-medium text-foreground">{resolveClientName(selectedClient)}</span>
            </p>
          )}
        </div>
        <Table className="min-w-full text-sm">
          <TableHeader>
            <TableRow className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/80">
              <TableHead className="w-[220px]">Banco</TableHead>
              <TableHead>Mecanismo</TableHead>
              <TableHead className="hidden lg:table-cell">Ambiente</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden xl:table-cell">CPU</TableHead>
              <TableHead className="hidden xl:table-cell">Memória</TableHead>
              <TableHead className="hidden 2xl:table-cell">Armazenamento</TableHead>
              <TableHead className="hidden xl:table-cell">Latência</TableHead>
              <TableHead className="hidden 2xl:table-cell">Replicação</TableHead>
              <TableHead className="text-right">Último backup</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredInstances.map((instance) => (
              <TableRow key={instance.id} className="border-b border-border/40 hover:bg-muted/40">
                <TableCell className="font-medium text-foreground/90">
                  <div className="flex flex-col gap-1">
                    <span>{instance.name}</span>
                    <span className="text-xs text-muted-foreground/70">{instance.host}</span>
                  </div>
                </TableCell>
                <TableCell className="text-foreground/80">
                  <span className="font-medium">{instance.engine}</span>
                  <span className="ml-1 text-xs text-muted-foreground">v{instance.version}</span>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-foreground/80">{instance.environment}</TableCell>
                <TableCell>
                  <StatusPill status={instance.status} />
                </TableCell>
                <TableCell className="hidden xl:table-cell text-foreground/80">{formatPercentage(instance.cpuUsage)}</TableCell>
                <TableCell className="hidden xl:table-cell text-foreground/80">{formatPercentage(instance.memoryUsage)}</TableCell>
                <TableCell className="hidden 2xl:table-cell text-foreground/80">
                  {formatPercentage(instance.storageUsage)}
                  <span className="ml-1 text-xs text-muted-foreground/70">livre {Math.round(instance.storageFreeGb)}GB</span>
                </TableCell>
                <TableCell className="hidden xl:table-cell text-foreground/80">{formatLatency(instance.avgLatencyMs)}</TableCell>
                <TableCell className="hidden 2xl:table-cell text-foreground/80">{formatReplicationLag(instance.replicationLagSeconds)}</TableCell>
                <TableCell className="text-right text-foreground/80">{instance.lastBackup}</TableCell>
              </TableRow>
            ))}
            {filteredInstances.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  Nenhuma instância encontrada para o filtro selecionado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Pendências e incidentes</h2>
              <p className="text-xs text-muted-foreground">
                Instâncias degradadas, em manutenção ou com observações relevantes.
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-5 space-y-4">
            {incidents.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nenhuma pendência registrada para o filtro aplicado.
              </p>
            )}
            {incidents.map((incident) => (
              <div
                key={incident.id}
                className="rounded-[10px] border border-border/60 bg-muted/30 p-4 hover:border-border transition"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">{incident.name}</p>
                    <p className="text-xs text-muted-foreground/80">
                      {incident.host} · {incident.environment}
                    </p>
                  </div>
                  <StatusPill status={incident.status} />
                </div>
                {incident.issues.length > 0 && (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {incident.issues.map((issue, index) => (
                      <li key={`${incident.id}-issue-${index}`}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Resumo por cliente</h2>
              <p className="text-xs text-muted-foreground">
                Agrupamento das instâncias por cliente para referência rápida.
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {mockClients
              .filter((client) => client.id === "all" || filteredInstances.some((item) => item.clientId === client.id))
              .filter((client) => client.id !== "all")
              .map((client) => {
                const clientInstances = filteredInstances.filter((instance) => instance.clientId === client.id);
                const online = clientInstances.filter((instance) => instance.status === "Online").length;
                const degrade = clientInstances.filter((instance) => instance.status === "Degradado").length;
                const offline = clientInstances.filter((instance) => instance.status === "Offline").length;

                if (clientInstances.length === 0) {
                  return null;
                }

                return (
                  <div key={client.id} className="rounded-[10px] border border-border/50 bg-muted/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-foreground">{client.name}</span>
                        <span className="text-xs text-muted-foreground">{clientInstances.length} instâncias</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusCounter label="Disponíveis" value={online} status="Online" />
                        <StatusCounter label="Degradado" value={degrade} status="Degradado" />
                        <StatusCounter label="Indisponíveis" value={offline} status="Offline" />
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      </section>
    </AppLayout>
  );
}

interface StatusPillProps {
  status: DatabaseStatus;
  className?: string;
}

function StatusPill({ status, className }: StatusPillProps) {
  const config = STATUS_CONFIG[status];

  return (
    <Badge
      variant="outline"
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold",
        config.badgeClass,
        className,
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", config.dotClass)} />
      {config.label}
    </Badge>
  );
}

interface StatusCounterProps {
  label: string;
  value: number;
  status: DatabaseStatus;
}

function StatusCounter({ label, value, status }: StatusCounterProps) {
  const config = STATUS_CONFIG[status];
  return (
    <div className="flex items-center gap-1 rounded-full bg-white/50 px-3 py-1 text-xs font-medium text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full", config.dotClass)} />
      <span>{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );
}
