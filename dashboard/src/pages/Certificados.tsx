import { useCallback, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { CertificateStatusBadge } from "@/components/certificados/CertificateStatusBadge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { mockCertificates, mockClients } from "@/lib/mock-data";
import { Certificate } from "@/types";
import { Shield, Clock, AlertTriangle } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  LabelList,
} from "recharts";

const REFRESH_INTERVAL_SECONDS = 45;

const resolveClientName = (clientId?: string) => {
  if (!clientId) return "Indefinido";
  const client = mockClients.find((c) => c.id === clientId);
  return client?.name ?? clientId;
};

const sortCertificates = (items: Certificate[]) => {
  return [...items].sort((a, b) => {
    const da = a.daysRemaining;
    const db = b.daysRemaining;

    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;

    const isExpiredA = da <= 0;
    const isExpiredB = db <= 0;

    if (isExpiredA && !isExpiredB) return -1;
    if (isExpiredB && !isExpiredA) return 1;

    return da - db;
  });
};

const formatDaysRemaining = (value: number | null) => {
  if (value === null) return "—";
  if (value === 0) return "Hoje";
  if (value < 0) return `Expirado há ${Math.abs(value)}d`;
  return `${value}d`;
};

export default function CertificadosPage() {
  const [selectedClient, setSelectedClient] = useState("all");

  const handleRefresh = useCallback(async () => {
    // Attach data fetching logic here when integrating with backend
    return Promise.resolve();
  }, []);

  const selectedClientName = useMemo(() => {
    if (selectedClient === "all") {
      return null;
    }

    return mockClients.find((client) => client.id === selectedClient)?.name ?? selectedClient;
  }, [selectedClient]);

  const filteredCertificates = useMemo(() => {
    if (selectedClient === "all") {
      return sortCertificates(mockCertificates);
    }

    const normalizedClientName = selectedClientName?.toLowerCase();

    return sortCertificates(
      mockCertificates.filter((certificate) => {
        if (certificate.clientId === selectedClient) return true;

        const clientName = resolveClientName(certificate.clientId);
        return clientName.toLowerCase() === normalizedClientName;
      })
    );
  }, [selectedClient, selectedClientName]);

  const kpis = useMemo(() => {
    const total = filteredCertificates.length;
    let valid = 0;
    let expiring = 0;
    let expired = 0;
    let nextPositive = Number.POSITIVE_INFINITY;

    filteredCertificates.forEach((certificate) => {
      const days = certificate.daysRemaining;
      switch (certificate.status) {
        case "Expirado":
          expired += 1;
          break;
        case "Expirando":
          expiring += 1;
          break;
        case "Válido":
          valid += 1;
          break;
        default:
          if (days !== null && days <= 0) {
            expired += 1;
          } else if (days !== null && days <= 30) {
            expiring += 1;
          } else if (days !== null && days > 30) {
            valid += 1;
          }
          break;
      }

      if (days !== null && days > 0) {
        nextPositive = Math.min(nextPositive, days);
      }
    });

    const nextValue =
      filteredCertificates.length === 0
        ? "—"
        : nextPositive === Number.POSITIVE_INFINITY
          ? "—"
          : nextPositive === 0
            ? "Hoje"
            : `${nextPositive}d`;

    return [
      {
        title: "Total",
        value: total,
        description: "Certificados monitorados",
        icon: <Shield className="h-5 w-5" />,
      },
      {
        title: "Válidos",
        value: valid,
        description: "Sem ações necessárias",
        icon: <Shield className="h-5 w-5" />,
      },
      {
        title: "Expirando (≤30d)",
        value: expiring,
        description: "Planeje renovação",
        icon: <Clock className="h-5 w-5" />,
      },
      {
        title: "Expirados",
        value: expired,
        description: "Ação imediata",
        icon: <AlertTriangle className="h-5 w-5" />,
      },
      {
        title: "Próxima expiração",
        value: nextValue,
        description: "Dias restantes",
        icon: <Clock className="h-5 w-5" />,
      },
    ];
  }, [filteredCertificates]);

  const topCriticalData = useMemo(() => {
    return filteredCertificates
      .map((certificate) => ({
        name: certificate.name || certificate.domain,
        chartLabel: certificate.daysRemaining === null
          ? "—"
          : certificate.daysRemaining <= 0
            ? "expirado"
            : `${certificate.daysRemaining}d`,
        days: certificate.daysRemaining === null
          ? 90
          : certificate.daysRemaining < 0
            ? 0
            : certificate.daysRemaining,
      }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 10)
      .map((entry) => ({
        ...entry,
        name: entry.name.length > 26 ? `${entry.name.slice(0, 25)}…` : entry.name,
      }));
  }, [filteredCertificates]);

  return (
    <AppLayout
      title="Certificados"
      description="Monitoramento de certificados SSL/TLS e status de expiração."
      clientSelect={
        <ClientSelect
          clients={mockClients}
          selectedClient={selectedClient}
          onClientChange={setSelectedClient}
        />
      }
      onRefresh={handleRefresh}
      refreshInterval={REFRESH_INTERVAL_SECONDS}
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

  <section className="rounded-[10px] border border-border/60 bg-white shadow-sm">
              <div className="flex flex-col gap-2 border-b border-border/60 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Lista de certificados</h2>
                  <p className="text-xs text-muted-foreground">
                    {filteredCertificates.length} certificados monitorados
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
                    <TableHead className="w-[180px]">Certificado</TableHead>
                    <TableHead>Domínio</TableHead>
                    <TableHead className="hidden lg:table-cell">Emissor</TableHead>
                    <TableHead>Expiração</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Dias restantes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCertificates.map((certificate) => (
                    <TableRow key={certificate.id} className="border-b border-border/40 hover:bg-muted/40">
                      <TableCell className="font-medium text-foreground/90">
                        <div className="flex flex-col">
                          <span>{certificate.name}</span>
                          <span className="text-xs text-muted-foreground/80">
                            {resolveClientName(certificate.clientId)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-foreground/80">{certificate.domain}</TableCell>
                      <TableCell className="hidden lg:table-cell text-foreground/70">{certificate.issuer}</TableCell>
                      <TableCell className="text-foreground/80">{certificate.expiration}</TableCell>
                      <TableCell>
                        <CertificateStatusBadge status={certificate.status} />
                      </TableCell>
                      <TableCell className="text-right font-medium text-foreground/80">
                        {formatDaysRemaining(certificate.daysRemaining)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredCertificates.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                        Nenhum certificado encontrado para o cliente selecionado.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
  </section>

  <section className="rounded-[10px] border border-border/60 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-semibold">10 mais críticos</h2>
                <p className="text-xs text-muted-foreground">
                  Menores valores de dias restantes aparecem primeiro (expirados ficam com 0 dias).
                </p>
              </div>
              <div className="mt-6 h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topCriticalData} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} interval={0} height={70} angle={-20} textAnchor="end" />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <RechartsTooltip formatter={(value: any, _name: any, entry: any) => entry?.payload?.chartLabel ?? value} />
                    <Bar dataKey="days" fill="#005ca9" radius={[6, 6, 0, 0]}>
                      <LabelList dataKey="chartLabel" position="top" className="text-xs" />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
      </section>
    </AppLayout>
  );
}
