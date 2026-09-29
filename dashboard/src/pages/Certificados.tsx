import { useCallback, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { OneViewSortableHeader, OneViewTableSortMenu } from "@/components/oneview/ConfigurableTableTools";
import { OneViewTableSearchField, useOneViewCommittedSearch } from "@/components/oneview/OneViewTableSearchField";
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
type CertificateSortKey = "name" | "domain" | "issuer" | "expiration" | "status" | "days";
type SortOrder = "asc" | "desc";
const CERTIFICATE_SORT_OPTIONS = [
  { value: "expiration:asc", label: "Expiração: mais próximas" }, { value: "expiration:desc", label: "Expiração: mais distantes" },
  { value: "name:asc", label: "Certificado: A–Z" }, { value: "name:desc", label: "Certificado: Z–A" },
  { value: "domain:asc", label: "Domínio: A–Z" }, { value: "domain:desc", label: "Domínio: Z–A" },
];

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
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CertificateSortKey>("expiration");
  const [order, setOrder] = useState<SortOrder>("asc");
  const { commitNow: commitSearchNow } = useOneViewCommittedSearch(searchDraft, setSearch);

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
  const tableCertificates = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("pt-BR");
    const values = filteredCertificates.filter((item) => !needle || [item.name, item.domain, item.issuer, item.status, resolveClientName(item.clientId)]
      .some((value) => String(value || "").toLocaleLowerCase("pt-BR").includes(needle)));
    const direction = order === "asc" ? 1 : -1;
    const statusRank: Record<string, number> = { Expirado: 0, Crítico: 1, Atenção: 2, Válido: 3 };
    return [...values].sort((left, right) => {
      const textValue = (item: Certificate) => ({ name: item.name, domain: item.domain, issuer: item.issuer }[sort] || "");
      const numberValue = (item: Certificate) => ({ expiration: item.daysRemaining ?? Number.MAX_SAFE_INTEGER, days: item.daysRemaining ?? Number.MAX_SAFE_INTEGER, status: statusRank[item.status] ?? 99 }[sort] || 0);
      const comparison = ["name", "domain", "issuer"].includes(sort)
        ? textValue(left).localeCompare(textValue(right), "pt-BR", { numeric: true, sensitivity: "base" })
        : numberValue(left) - numberValue(right);
      return comparison * direction || String(left.id).localeCompare(String(right.id));
    });
  }, [filteredCertificates, order, search, sort]);
  const applySort = (value: string) => { const [field, direction] = value.split(":") as [CertificateSortKey, SortOrder]; setSort(field); setOrder(direction); };
  const toggleSort = (field: CertificateSortKey) => { setOrder((current) => sort === field ? current === "asc" ? "desc" : "asc" : "asc"); setSort(field); };

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
      clientSelect={(
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <SectionAccentTitle level={1}>Certificados</SectionAccentTitle>
          <ClientSelect
            clients={mockClients}
            selectedClient={selectedClient}
            onClientChange={(clientId) => {
              setSelectedClient(Array.isArray(clientId) ? (clientId[0] ?? "all") : clientId);
            }}
          />
        </div>
      )}
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
                    {tableCertificates.length} certificados encontrados
                  </p>
                </div>
                {selectedClient !== "all" && (
                  <p className="text-xs text-muted-foreground sm:text-right">
                    Cliente selecionado: <span className="font-medium text-foreground">{resolveClientName(selectedClient)}</span>
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2 border-b border-border/60 p-3 sm:flex-row">
                <OneViewTableSearchField value={searchDraft} onChange={setSearchDraft} onSubmit={commitSearchNow} placeholder="Buscar certificado, domínio ou cliente…" ariaLabel="Buscar certificados" activity={searchDraft !== search ? "pending" : "idle"} />
                <OneViewTableSortMenu value={`${sort}:${order}`} options={CERTIFICATE_SORT_OPTIONS} onChange={applySort} label="Ordenar certificados" />
              </div>
              <Table className="min-w-full text-sm">
                <TableHeader>
                  <TableRow className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/80">
                    <TableHead className="w-[180px]" aria-sort={sort === "name" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Certificado" active={sort === "name"} direction={order} onClick={() => toggleSort("name")} /></TableHead>
                    <TableHead aria-sort={sort === "domain" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Domínio" active={sort === "domain"} direction={order} onClick={() => toggleSort("domain")} /></TableHead>
                    <TableHead className="hidden lg:table-cell" aria-sort={sort === "issuer" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Emissor" active={sort === "issuer"} direction={order} onClick={() => toggleSort("issuer")} /></TableHead>
                    <TableHead aria-sort={sort === "expiration" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Expiração" active={sort === "expiration"} direction={order} onClick={() => toggleSort("expiration")} /></TableHead>
                    <TableHead aria-sort={sort === "status" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Status" active={sort === "status"} direction={order} onClick={() => toggleSort("status")} /></TableHead>
                    <TableHead className="text-right" aria-sort={sort === "days" ? order === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Dias restantes" active={sort === "days"} direction={order} onClick={() => toggleSort("days")} className="justify-end" /></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableCertificates.map((certificate) => (
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
                  {tableCertificates.length === 0 && (
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
