import { useCallback, useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { ChamadosFilters } from "@/components/filters/ChamadosFilters";
import { ChamadosTable } from "@/components/chamados/ChamadosTable";
import { Button } from "@/components/ui/button";
import { mockChamados, mockClients } from "@/lib/mock-data";
import { ChamadoStatus, Severity } from "@/types";
import { Download, Ticket } from "lucide-react";

export default function ChamadosPage() {
  const [selectedClient, setSelectedClient] = useState<string | string[]>("all");
  const [selectedSeverity, setSelectedSeverity] = useState<Severity | "All">("All");
  const [selectedStatus, setSelectedStatus] = useState<ChamadoStatus | "All">("All");
  const [selectedAssignee, setSelectedAssignee] = useState<string>("All");

  const assignees = useMemo(() => {
    return Array.from(new Set(mockChamados.map((chamado) => chamado.assignee))).sort();
  }, []);

  const selectedClientName = useMemo(() => {
    if (selectedClient === "all") return null;
    const sel = Array.isArray(selectedClient) ? selectedClient : [selectedClient];
    const names = sel.map((id) => mockClients.find((c) => c.id === id)?.name ?? id).filter(Boolean);
    return names.length === 1 ? names[0] : `${names[0]} (+${names.length - 1})`;
  }, [selectedClient]);

  const filteredChamados = useMemo(() => {
    return mockChamados.filter((chamado) => {
      const matchesClient =
        selectedClient === "all" ||
        chamado.client.toLowerCase() === (selectedClientName ?? "").toLowerCase() ||
        chamado.client === "TODOS";
      const matchesSeverity = selectedSeverity === "All" || chamado.severity === selectedSeverity;
      const matchesStatus = selectedStatus === "All" || chamado.status === selectedStatus;
      const matchesAssignee = selectedAssignee === "All" || chamado.assignee === selectedAssignee;
      return matchesClient && matchesSeverity && matchesStatus && matchesAssignee;
    });
  }, [selectedClient, selectedClientName, selectedSeverity, selectedStatus, selectedAssignee]);

  const statusSummary = useMemo(() => {
    return filteredChamados.reduce(
      (acc, chamado) => {
        acc.total += 1;
        acc[chamado.status] = (acc[chamado.status] ?? 0) + 1;
        return acc;
      },
      { total: 0, Aberto: 0, "Em andamento": 0, Resolvido: 0 } as Record<string, number>
    );
  }, [filteredChamados]);

  const handleApplyFilters = useCallback(() => {
    console.log("Aplicando filtros de chamados", {
      client: selectedClient,
      severity: selectedSeverity,
      status: selectedStatus,
      assignee: selectedAssignee,
    });
  }, [selectedClient, selectedSeverity, selectedStatus, selectedAssignee]);

  const handleClearFilters = useCallback(() => {
    setSelectedClient("all");
    setSelectedSeverity("All");
    setSelectedStatus("All");
    setSelectedAssignee("All");
  }, []);

  const handleRefresh = useCallback(async () => {
    return Promise.resolve();
  }, []);

  const clientLabel = selectedClientName ?? "Todos";
  const severityLabel = selectedSeverity === "All" ? "Todas" : selectedSeverity;
  const statusLabel = selectedStatus === "All" ? "Todos" : selectedStatus;
  const assigneeLabel = selectedAssignee === "All" ? "Todos" : selectedAssignee;

  const headerActions = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" size="sm" className="gap-2">
        <Download className="h-4 w-4" />
        Exportar lista
      </Button>
      <Button size="sm" className="gap-2">
        <Ticket className="h-4 w-4" />
        Novo chamado
      </Button>
    </div>
  );

  return (
    <AppLayout
      title="Chamados"
      description="Acompanhe os chamados em andamento, aplique filtros e tome ações rápidas."
      headerAside={headerActions}
      clientSelect={
        <ClientSelect
          clients={mockClients}
            selectedClient={selectedClient}
            onClientChange={setSelectedClient}
        />
      }
      onRefresh={handleRefresh}
    >
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[10px] border border-border bg-white p-5 shadow-sm">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Abertos</span>
          <p className="mt-2 text-2xl font-semibold text-error/90">{statusSummary.Aberto}</p>
        </div>
        <div className="rounded-[10px] border border-border bg-white p-5 shadow-sm">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Em andamento</span>
          <p className="mt-2 text-2xl font-semibold text-warning/90">{statusSummary["Em andamento"]}</p>
        </div>
        <div className="rounded-[10px] border border-border bg-white p-5 shadow-sm">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Resolvidos</span>
          <p className="mt-2 text-2xl font-semibold text-success/90">{statusSummary.Resolvido}</p>
        </div>
      </section>

      <ChamadosTable
        chamados={filteredChamados}
        constrainHeight={false}
        showViewAllButton={false}
        className="bg-white"
        headerContent={(
          <div className="flex flex-col gap-4 border-b border-border/60 bg-white px-6 py-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Lista de chamados</h2>
                <p className="text-xs text-muted-foreground">
                  {statusSummary.total} registros encontrados
                </p>
              </div>
              <div className="flex flex-col text-xs text-muted-foreground sm:items-end">
                <span>Cliente: {clientLabel}</span>
                <span>Severidade: {severityLabel}</span>
                <span>Status: {statusLabel}</span>
                <span>Responsável: {assigneeLabel}</span>
              </div>
            </div>
            <ChamadosFilters
              selectedSeverity={selectedSeverity}
              selectedStatus={selectedStatus}
              selectedAssignee={selectedAssignee}
              assignees={assignees}
              onSeverityChange={setSelectedSeverity}
              onStatusChange={setSelectedStatus}
              onAssigneeChange={setSelectedAssignee}
              onApply={handleApplyFilters}
              onClear={handleClearFilters}
              className="border-none bg-transparent p-0 shadow-none"
              gridClassName="md:grid-cols-3 xl:grid-cols-4"
            />
          </div>
        )}
      />
    </AppLayout>
  );
}
