import { useState, useMemo, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { WorkspaceCard } from "@/components/workspaces/WorkspaceCard";
import { WorkspaceFilters } from "@/components/workspaces/WorkspaceFilters";
import { WorkspaceDetailsModal } from "@/components/workspaces/WorkspaceDetailsModal";
import { WorkspaceCallPerformanceModal } from "@/components/workspaces/WorkspaceCallPerformanceModal";
import { ClientSelect } from "@/components/certificados/ClientSelect";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Monitor, AlertTriangle, CheckCircle2, WifiOff, Loader2, Video, Calendar } from "lucide-react";
import type { Workspace, WorkspaceType, WorkspaceHealthLevel } from "@/types";
import { fetchWorkspaces, fetchWorkspaceDevices, fetchDeviceXAPIStatus, fetchWorkspaceMeetingsHistory } from "@/lib/webex-api";
import { mockClients } from "@/lib/mock-data";

const REFRESH_INTERVAL_SECONDS = 60;

export default function WorkspacesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<WorkspaceType | "all">("all");
  const [healthFilter, setHealthFilter] = useState<WorkspaceHealthLevel | "all">("all");
  const [selectedClient, setSelectedClient] = useState("all");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [performanceWorkspace, setPerformanceWorkspace] = useState<Workspace | null>(null);
  const [isPerformanceModalOpen, setIsPerformanceModalOpen] = useState(false);

  const enrichWorkspace = useCallback(async (ws: any): Promise<Workspace> => {
    try {
      const devicesResp = await fetchWorkspaceDevices(ws.id);
      const devices = devicesResp.items || [];
      let activeNow = false;
      let currentlyOccupied = false;
      let currentMeeting = null;
      let nextMeeting = null;
      const mainDevice = devices.find((d: any) => d.type === "roomdesk") || devices.find((d: any) => d.connectionStatus === "connected");
      if (mainDevice) {
        try {
          const x = await fetchDeviceXAPIStatus(mainDevice.id);
          const xr = (x as any)?.result || x; // API Webex retorna { deviceId, result: { ... } }
          const numCalls = Number(
            xr?.SystemUnit?.State?.NumberOfActiveCalls ??
            xr?.systemUnit?.state?.numberOfActiveCalls ??
            xr?.NumberOfActiveCalls
          ) || 0;
          const callStatus = (
            xr?.Conference?.Call?.Status ??
            xr?.conference?.call?.status ??
            xr?.CallStatus
          );
          activeNow = numCalls > 0 || ["Connected", "InProgress"].includes(String(callStatus));
        } catch {
          activeNow = false;
        }
      }

      try {
        const workspaceWithDevices = { ...ws, devices };
        const meetings = await fetchWorkspaceMeetingsHistory(workspaceWithDevices);
        currentlyOccupied = meetings.currentlyOccupied;
        currentMeeting = meetings.currentMeeting || null;
        nextMeeting = meetings.nextMeeting || meetings.upcoming?.[0] || null;
      } catch (err) {
        console.warn(`⚠️ Falha ao buscar bookings do workspace ${ws.id}`, err);
        currentlyOccupied = false;
        currentMeeting = null;
        nextMeeting = null;
      }

      return { ...ws, devices, activeNow, currentlyOccupied, currentMeeting, nextMeeting } as Workspace;
    } catch (e) {
      console.warn(`⚠️ Falha ao buscar devices do workspace ${ws.id}`, e);
      return { ...ws, devices: [], activeNow: false, currentlyOccupied: false } as Workspace;
    }
  }, []);

  // Carregar dados iniciais da API REAL anexando devices do endpoint /devices
  useEffect(() => {
    let mounted = true;
    
    const loadInitialData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        console.log("🔄 Buscando workspaces da API Cisco Webex...");
        const response = await fetchWorkspaces({ includeDevices: false });
        if (mounted) {
          console.log(`✅ ${response.items?.length || 0} workspaces carregados com sucesso!`);
          const items = response.items || [];
          // Renderizar rápido a lista “crua” e enriquecer conforme chegam as respostas
          setWorkspaces((prev) => {
            const prevMap = new Map((prev || []).map((p) => [p.id, p]));
            return items.map((ws: any) => {
              const existing = prevMap.get(ws.id);
              return existing ? { ...existing, ...ws } : ws;
            });
          });
          for (const ws of items) {
            enrichWorkspace(ws).then((enriched) => {
              if (!mounted) return;
              setWorkspaces((prev) => prev.map((p) => (p.id === ws.id ? enriched : p)));
            });
          }
        }
      } catch (err) {
        console.error("❌ Erro ao carregar workspaces:", err);
        if (mounted) {
          setError(err instanceof Error ? err.message : "Erro ao carregar workspaces");
          setWorkspaces([]);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    loadInitialData();

    return () => {
      mounted = false;
    };
  }, []);

  // Função de refresh que não altera loading (para não causar flickering)
  const handleRefresh = useCallback(async () => {
    try {
      console.log("🔄 Atualizando dados da API...");
      const response = await fetchWorkspaces({ includeDevices: false });
      const items = response.items || [];
      // Renderizar rápido a lista básica e enriquecer em segundo plano
      setWorkspaces((prev) => {
        const prevMap = new Map((prev || []).map((p) => [p.id, p]));
        return items.map((ws: any) => {
          const existing = prevMap.get(ws.id);
          return existing ? { ...existing, ...ws } : ws;
        });
      });
      items.forEach((ws: any) => {
        enrichWorkspace(ws).then((enriched) => {
          setWorkspaces((prev) => prev.map((p) => (p.id === ws.id ? enriched : p)));
          if (isModalOpen && selectedWorkspace?.id === ws.id) {
            setSelectedWorkspace(enriched as Workspace);
          }
          if (isPerformanceModalOpen && performanceWorkspace?.id === ws.id) {
            setPerformanceWorkspace(enriched as Workspace);
          }
        });
      });
      console.log(`✅ Dados atualizados: ${items.length || 0} workspaces (enriquecendo em segundo plano)`);
      setError(null);
    } catch (err) {
      console.error("❌ Erro ao atualizar workspaces:", err);
      // Não mostra erro no refresh automático para não interromper a UX
    }
  }, [isModalOpen, selectedWorkspace, enrichWorkspace]);

  const filteredWorkspaces = useMemo(() => {
    const filtered = workspaces.filter((workspace) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = workspace.displayName.toLowerCase().includes(query);
        const matchesId = workspace.id.toLowerCase().includes(query);
        if (!matchesName && !matchesId) return false;
      }

      // Type filter
      if (typeFilter !== "all" && workspace.type !== typeFilter) {
        return false;
      }

      // Health filter
      if (healthFilter !== "all") {
        const workspaceHealth = workspace.health?.level || "ok";
        if (workspaceHealth !== healthFilter) {
          return false;
        }
      }

      return true;
    });

    // Ordenar: workspaces "em uso" primeiro (activeNow ou currentlyOccupied)
    return filtered.sort((a, b) => {
      const aInUse = a.activeNow || a.currentlyOccupied;
      const bInUse = b.activeNow || b.currentlyOccupied;
      
      if (aInUse && !bInUse) return -1;
      if (!aInUse && bInUse) return 1;
      return 0;
    });
  }, [workspaces, searchQuery, typeFilter, healthFilter]);

  const kpis = useMemo(() => {
    const total = filteredWorkspaces.length;
    const totalDevices = filteredWorkspaces.reduce((acc, ws) => acc + (ws.devices?.length || 0), 0);
    const connectedDevices = filteredWorkspaces.reduce(
      (acc, ws) => acc + (ws.devices?.filter((d) => d.connectionStatus === "connected" || d.connectionStatus === "connected_with_issues").length || 0),
      0
    );
    
    const healthCounts = filteredWorkspaces.reduce(
      (acc, ws) => {
        const level = ws.health?.level || "ok";
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    // Calcular workspaces em uso agora (chamada ativa via xAPI OU ocupada por booking)
    const activeMeetings = filteredWorkspaces.filter(ws => ws.activeNow || ws.currentlyOccupied).length;

    // Calcular uptime médio
    const avgUptime = total > 0 
      ? Math.round((connectedDevices / Math.max(totalDevices, 1)) * 100)
      : 0;

    // Contar workspaces com recursos habilitados
    const withCalling = filteredWorkspaces.filter(ws => 
      ws.calling?.type && ws.calling.type !== "none"
    ).length;
    
    const withCalendar = filteredWorkspaces.filter(ws => 
      ws.calendar?.type && ws.calendar.type !== "none"
    ).length;

    return {
      total,
      totalDevices,
      connectedDevices,
      disconnectedDevices: totalDevices - connectedDevices,
      withIssues: (healthCounts.error || 0) + (healthCounts.warning || 0),
      healthy: healthCounts.ok || 0,
      critical: healthCounts.error || 0,
      warnings: healthCounts.warning || 0,
      activeMeetings,
      avgUptime,
      withCalling,
      withCalendar,
    };
  }, [filteredWorkspaces]);

  const handleClearFilters = () => {
    setSearchQuery("");
    setTypeFilter("all");
    setHealthFilter("all");
  };

  const handleClientChange = useCallback((clientId: string | string[]) => {
    setSelectedClient(Array.isArray(clientId) ? clientId[0] : clientId);
  }, []);

  const handleWorkspaceClick = useCallback((workspace: Workspace) => {
    setSelectedWorkspace(workspace);
    setIsModalOpen(true);
  }, []);

  const handleMeetingClick = useCallback((workspace: Workspace) => {
    setPerformanceWorkspace(workspace);
    setIsPerformanceModalOpen(true);
  }, []);

  return (
    <AppLayout 
      title="Espaços Cisco"
      description="Monitoramento de salas e dispositivos Webex"
      clientSelect={
        <ClientSelect
          clients={mockClients}
          selectedClient={selectedClient}
          onClientChange={handleClientChange}
        />
      }
      onRefresh={handleRefresh}
      refreshInterval={REFRESH_INTERVAL_SECONDS}
      enableAutoRefresh={true}
      showRefreshMeta={true}
    >
      <div className="space-y-6">
        {/* KPIs */}
        <div className="space-y-2">
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total Workspaces */}
            <Card className="rounded-[10px] border border-border/70 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-3xl font-bold text-foreground">{kpis.total}</p>
                   <p className="text-xs font-medium text-muted-foreground mt-2">Total de espaços</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Monitor className="h-6 w-6 text-primary" />
                </div>
              </div>
            </Card>

          {/* Devices Online */}
          <Card className="rounded-[10px] border border-border/70 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-3xl font-bold text-foreground">
                  {kpis.connectedDevices}
                  <span className="text-lg text-muted-foreground ml-1">/{kpis.totalDevices}</span>
                </p>
                 <p className="text-xs font-medium text-muted-foreground mt-2">Dispositivos online</p>
              </div>
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <CheckCircle2 className="h-6 w-6 text-primary" />
              </div>
            </div>
          </Card>

          {/* Reuniões Ativas / Em Uso */}
          <Card className="rounded-[10px] border border-border/70 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-3xl font-bold text-foreground">{kpis.activeMeetings}</p>
                <p className="text-xs font-medium text-muted-foreground mt-2">Em uso agora</p>
              </div>
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Video className="h-6 w-6 text-primary" />
              </div>
            </div>
          </Card>

          {/* Alertas Críticos */}
          <Card className="rounded-[10px] border border-border/70 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-3xl font-bold text-foreground">{kpis.critical}</p>
                <p className="text-xs font-medium text-muted-foreground mt-2">Alertas Críticos</p>
              </div>
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                <AlertTriangle className="h-6 w-6 text-primary" />
              </div>
            </div>
          </Card>
          </div>
        </div>

        {/* Resumo removido a pedido */}

        {/* Filters */}
        <WorkspaceFilters
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          healthFilter={healthFilter}
          onHealthFilterChange={setHealthFilter}
          onClearFilters={handleClearFilters}
        />

        {/* Workspaces Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
               <p className="text-sm text-muted-foreground">Carregando espaços de trabalho...</p>
            </div>
          </div>
        ) : error ? (
          <Card className="rounded-[10px] border border-border bg-white p-12 shadow-sm">
            <div className="flex flex-col items-center justify-center text-center space-y-3">
              <AlertTriangle className="h-12 w-12 text-destructive" />
              <div>
                <h3 className="text-lg font-semibold">Erro ao carregar espaços de trabalho</h3>
                <p className="text-sm text-muted-foreground mt-1">{error}</p>
                <Button onClick={handleRefresh} variant="outline" className="mt-4">
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredWorkspaces.length > 0 ? (
              filteredWorkspaces.map((workspace) => (
                <WorkspaceCard 
                  key={workspace.id} 
                  workspace={workspace}
                  onClick={() => handleWorkspaceClick(workspace)}
                  onMeetingClick={
                    workspace.activeNow || workspace.currentlyOccupied
                      ? () => handleMeetingClick(workspace)
                      : undefined
                  }
                />
              ))
            ) : (
              <div className="col-span-full">
                <Card className="rounded-[10px] border border-border bg-white p-12 shadow-sm">
                  <div className="flex flex-col items-center justify-center text-center space-y-3">
                    <WifiOff className="h-12 w-12 text-muted-foreground" />
                    <div>
                      <h3 className="text-lg font-semibold">Nenhum espaço de trabalho encontrado</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        Tente ajustar os filtros ou buscar por outro termo
                      </p>
                    </div>
                  </div>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal de Detalhes */}
      <WorkspaceDetailsModal
        workspace={selectedWorkspace}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
      />
      <WorkspaceCallPerformanceModal
        workspace={performanceWorkspace}
        open={isPerformanceModalOpen}
        onOpenChange={(open) => {
          setIsPerformanceModalOpen(open);
          if (!open) {
            setPerformanceWorkspace(null);
          }
        }}
      />
    </AppLayout>
  );
}
