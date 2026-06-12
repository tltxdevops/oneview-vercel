import { useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { GenericFilters } from "@/components/filters/GenericFilters";
import { ClientCardFilter } from "@/components/filters/ClientCardFilter";
import { KpiCard } from "@/components/kpis/KpiCard";
import { AlertsList } from "@/components/alerts/AlertsList";
import { ChamadosTable } from "@/components/chamados/ChamadosTable";
import { mockAlerts, mockChamados, mockKPI, mockClients } from "@/lib/mock-data";
import { Severity, AlertStatus } from "@/types";
import { AlertCircle, Clock, TrendingUp, Activity } from "lucide-react";

export default function Index() {
  const [selectedClient, setSelectedClient] = useState("all");
  const [selectedSeverity, setSelectedSeverity] = useState<Severity | "All">("All");
  const [selectedStatus, setSelectedStatus] = useState<AlertStatus | "All">("All");

  const handleApplyFilters = () => {
    console.log("Filters applied:", { selectedClient, selectedSeverity, selectedStatus });
  };

  const handleClearFilters = () => {
    setSelectedClient("all");
    setSelectedSeverity("All");
    setSelectedStatus("All");
  };

  return (
    <div className="min-h-screen w-full flex bg-background">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex-1 ml-20">
        <main className="h-screen overflow-hidden">
          <div className="h-full flex flex-col lg:flex-row gap-6 p-6">
            {/* Left Column - Alerts List (1/3) */}
            <div className="w-full lg:w-1/3 flex flex-col">
              <section className="flex flex-col flex-1 overflow-hidden">
                <header className="flex items-center justify-between mb-4 px-1">
                  <h2 className="text-xl font-semibold">Alertas</h2>
                  <span className="text-sm text-muted-foreground">Últimas 24h</span>
                </header>
                <div className="flex-1 overflow-hidden">
                  <AlertsList alerts={mockAlerts} />
                </div>
              </section>
            </div>

            {/* Right Column - Filters, KPIs, Chamados (2/3) */}
            <div className="w-full lg:w-2/3 flex flex-col gap-6 overflow-y-auto pr-1">
                <div className="flex flex-col lg:flex-row gap-4 lg:items-stretch">
                  <div className="w-full lg:max-w-xs lg:h-full">
                    <ClientCardFilter
                      clients={mockClients}
                      selectedClient={selectedClient}
                      onClientChange={setSelectedClient}
                    />
                  </div>
                  <div className="flex-1 h-full">
                    <GenericFilters
                      selectedSeverity={selectedSeverity}
                      selectedStatus={selectedStatus}
                      onSeverityChange={setSelectedSeverity}
                      onStatusChange={setSelectedStatus}
                      onApply={handleApplyFilters}
                      onClear={handleClearFilters}
                    />
                  </div>
                </div>

              {/* KPIs Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard
                  title="Alertas Ativos"
                  value={mockKPI.activeAlerts}
                  delta={12}
                  trend="up"
                  icon={<AlertCircle className="h-6 w-6" />}
                />
                <KpiCard
                  title="MTTA"
                  value={mockKPI.mtta}
                  delta={-8}
                  trend="down"
                  icon={<Clock className="h-6 w-6" />}
                />
                <KpiCard
                  title="MTTR"
                  value={mockKPI.mttr}
                  delta={-5}
                  trend="down"
                  icon={<TrendingUp className="h-6 w-6" />}
                />
                <KpiCard
                  title="Disponibilidade"
                  value={`${mockKPI.availability}%`}
                  delta={0.1}
                  trend="up"
                  icon={<Activity className="h-6 w-6" />}
                />
              </div>

              {/* Chamados Table */}
              <ChamadosTable chamados={mockChamados} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
