import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Monitor,
  Users,
  MapPin,
  Phone,
  Calendar,
  Video,
  Wifi,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
  Info,
  Clock,
  Building,
  Loader2,
  History,
  CalendarClock,
} from "lucide-react";
import type { Workspace, WorkspaceMeeting } from "@/types";
import { cn } from "@/lib/utils";
import { fetchWorkspaceDevices, fetchWorkspaceMeetingsHistory } from "@/lib/webex-api";

interface WorkspaceDetailsModalProps {
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const healthConfig = {
  ok: { icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50 dark:bg-green-950/30", label: "OK" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-50 dark:bg-blue-950/30", label: "Informativo" },
  warning: { icon: AlertTriangle, color: "text-yellow-600", bg: "bg-yellow-50 dark:bg-yellow-950/30", label: "Aviso" },
  error: { icon: AlertTriangle, color: "text-red-600", bg: "bg-red-50 dark:bg-red-950/30", label: "Erro" },
};

const deviceStatusConfig: Record<string, { icon: any; color: string; label: string }> = {
  connected: { icon: Wifi, color: "text-green-600", label: "Conectado" },
  disconnected: { icon: WifiOff, color: "text-red-600", label: "Desconectado" },
  connected_with_issues: { icon: AlertTriangle, color: "text-yellow-600", label: "Com problemas" },
  offline_expired: { icon: WifiOff, color: "text-gray-500", label: "Fora de linha" },
  activating: { icon: Wifi, color: "text-blue-500", label: "Ativando" },
  unknown: { icon: AlertTriangle, color: "text-gray-400", label: "Desconhecido" },
  offline_deep_sleep: { icon: WifiOff, color: "text-gray-400", label: "Hibernando" },
};

const workspaceTypeLabels: Record<string, string> = {
  meetingRoom: "Sala de Reunião",
  huddle: "Sala colaborativa",
  focus: "Sala de Foco",
  open: "Espaço Aberto",
  desk: "Mesa",
  other: "Outro",
  notSet: "Não definido",
};

export function WorkspaceDetailsModal({ workspace, open, onOpenChange }: WorkspaceDetailsModalProps) {
  const [devices, setDevices] = useState<any[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [meetings, setMeetings] = useState<{
    past: WorkspaceMeeting[];
    upcoming: WorkspaceMeeting[];
    currentlyOccupied: boolean;
    currentMeeting: WorkspaceMeeting | null;
    nextMeeting: WorkspaceMeeting | null;
  }>({ past: [], upcoming: [], currentlyOccupied: false, currentMeeting: null, nextMeeting: null });
  const [loadingMeetings, setLoadingMeetings] = useState(false);

  // Buscar devices reais da API quando o modal abrir
  useEffect(() => {
    if (!workspace || !open) {
      setDevices([]);
      setMeetings({ past: [], upcoming: [], currentlyOccupied: false, currentMeeting: null, nextMeeting: null });
      return;
    }

    const loadDevices = async () => {
      try {
        setLoadingDevices(true);
        console.log(`🔄 Buscando devices do workspace ${workspace.id}...`);
        const response = await fetchWorkspaceDevices(workspace.id);
        console.log(`✅ ${response.items?.length || 0} devices encontrados`);
        setDevices(response.items || []);
      } catch (error) {
        console.error("❌ Erro ao buscar devices:", error);
        // Fallback para devices do workspace original
        setDevices(workspace.devices || []);
      } finally {
        setLoadingDevices(false);
      }
    };

    const loadMeetings = async () => {
      try {
        setLoadingMeetings(true);
        console.log(`🔄 Buscando histórico de reuniões...`);
        const history = await fetchWorkspaceMeetingsHistory(workspace);
        console.log(`✅ ${history.past.length} passadas, ${history.upcoming.length} próximas`);
        setMeetings(history);
      } catch (error) {
        console.error("❌ Erro ao buscar reuniões:", error);
        setMeetings({ past: [], upcoming: [], currentlyOccupied: false, currentMeeting: null, nextMeeting: null });
      } finally {
        setLoadingMeetings(false);
      }
    };

    loadDevices();
    loadMeetings();
  }, [workspace, open]);

  if (!workspace) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl">
          <p>Espaço de trabalho não encontrado</p>
        </DialogContent>
      </Dialog>
    );
  }

  const health = workspace.health?.level || "ok";
  const HealthIcon = healthConfig[health].icon;
  
  const connectedDevices = devices.filter(d => d.connectionStatus === "connected" || d.connectionStatus === "connected_with_issues").length;
  const totalDevices = devices.length;

  // Recursos/Serviços configurados (mesmo estilo do card)
  const hasCalendar = workspace.calendar?.type && workspace.calendar.type !== "none";
  const hasCalling = workspace.calling?.type && workspace.calling.type !== "none";
  const hasMeetings = workspace.deviceHostedMeetings?.enabled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl bg-white p-0 gap-0 overflow-hidden h-[90vh] flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-xl font-semibold flex items-center gap-3 text-black">
                {workspace.displayName}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-3 mt-2">
                <span className="text-xs text-gray-600">
                  {workspaceTypeLabels[workspace.type] || workspace.type}
                </span>
                {workspace.capacity && (
                  <span className="flex items-center gap-1 text-xs text-gray-600">
                    <Users className="h-3 w-3" />
                    {workspace.capacity} pessoas
                  </span>
                )}
                {meetings.currentlyOccupied && (
                  <span className="px-2 py-0.5 bg-black text-white text-xs font-medium rounded">
                    Em uso agora
                  </span>
                )}
              </DialogDescription>
              {/* Terceira linha do header: Serviços configurados (badges) */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {hasCalling && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md">
                    <Phone className="h-3.5 w-3.5 text-black" />
                    <span className="text-xs font-medium text-black">Chamadas</span>
                  </div>
                )}
                {hasCalendar && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md">
                    <Calendar className="h-3.5 w-3.5 text-black" />
                    <span className="text-xs font-medium text-black">Calendário</span>
                  </div>
                )}
                {hasMeetings && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md">
                    <Video className="h-3.5 w-3.5 text-black" />
                    <span className="text-xs font-medium text-black">Reuniões</span>
                  </div>
                )}
                {!hasCalling && !hasCalendar && !hasMeetings && (
                  <span className="text-xs text-gray-500">Nenhum serviço configurado</span>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Layout em 2 colunas - sem espaço em branco abaixo do header */}
        <div className="grid grid-cols-2 gap-6 px-6 py-6 overflow-y-auto flex-1">
          
          {/* COLUNA ESQUERDA */}
          <div className="space-y-4">
            
            {/* Métricas Rápidas */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg border bg-white">
                <div className="flex items-center gap-2 mb-1">
                  <Monitor className="h-4 w-4 text-black" />
                  <span className="text-xs font-medium text-gray-600">Dispositivos online</span>
                </div>
                <p className="text-2xl font-bold text-black">{connectedDevices}<span className="text-base text-gray-500 font-normal">/{totalDevices}</span></p>
              </div>
              
              <div className="p-3 rounded-lg border bg-white">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-black" />
                  <span className="text-xs font-medium text-gray-600">Alertas</span>
                </div>
                <p className="text-2xl font-bold text-black">{workspace.health?.issues?.length || 0}</p>
              </div>

              <div className="p-3 rounded-lg border bg-white">
                <div className="flex items-center gap-2 mb-1">
                  <CalendarClock className="h-4 w-4 text-black" />
                  <span className="text-xs font-medium text-gray-600">Reunião</span>
                </div>
                {loadingMeetings ? (
                  <Loader2 className="h-5 w-5 animate-spin text-gray-400 mt-1" />
                ) : meetings.currentlyOccupied ? (
                  <div>
                    <p className="text-sm font-bold text-black">Agora</p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {meetings.upcoming.find((m: any) => {
                        const start = new Date(m.start);
                        const end = new Date(m.end);
                        const now = new Date();
                        return start <= now && end > now;
                      })?.title || "Em uso"}
                    </p>
                  </div>
                ) : meetings.upcoming.length > 0 ? (
                  <div>
                    <p className="text-sm font-bold text-black">
                      {new Date(meetings.upcoming[0].start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">{meetings.upcoming[0].title}</p>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 mt-1">Sem reuniões</p>
                )}
              </div>
            </div>

          {/* Serviços Configurados - movido para o header como badges */}

          {/* Devices - Dados REAIS da API */}
          <div className="rounded-lg border bg-white p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-black">Dispositivos ({connectedDevices}/{totalDevices})</h3>
              {loadingDevices && (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              )}
            </div>
            
            {devices.length === 0 && !loadingDevices ? (
              <p className="text-xs text-gray-500 text-center py-4">
                Nenhum dispositivo encontrado
              </p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => {
                  const statusConfig = deviceStatusConfig[device.connectionStatus || "unknown"] || deviceStatusConfig.unknown;
                  const StatusIcon = statusConfig.icon;
                  const isOnline = device.connectionStatus === "connected" || device.connectionStatus === "connected_with_issues";
                  
                  return (
                    <div key={device.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg border">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm text-black">{device.product}</p>
                            <p className="text-xs text-gray-500 capitalize">{device.type}</p>
                          </div>
                          <div className={cn("flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium", isOnline ? "bg-gray-900 text-white" : "bg-gray-300 text-gray-700")}>
                            <StatusIcon className="h-3 w-3" />
                            <span>{statusConfig.label}</span>
                          </div>
                        </div>
                        
                        <div className="space-y-1">
                          {device.ip && (
                            <div className="text-gray-600">
                              <span className="font-medium">IP:</span> <span className="font-mono">{device.ip}</span>
                            </div>
                          )}
                          {device.serial && (
                            <div className="text-gray-600">
                              <span className="font-medium">Número de série:</span> <span className="font-mono">{device.serial}</span>
                            </div>
                          )}
                          {Array.isArray(device.errorCodes) && device.errorCodes.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {device.errorCodes.map((code: string, idx: number) => {
                                const codeLower = String(code).toLowerCase();
                                let label = code;
                                if (codeLower.includes("endofsupport")) {
                                  label = "Fim de suporte";
                                } else if (codeLower.includes("offline") || codeLower.includes("connection")) {
                                  label = "Conectividade instável";
                                }
                                return (
                                  <span key={idx} className="px-2 py-0.5 text-[10px] font-medium rounded bg-gray-200 text-gray-700">
                                    {label}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          </div>

          {/* COLUNA DIREITA */}
          <div className="space-y-4">
          
          {/* Reuniões Agendadas */}
          <div className="rounded-lg border bg-white p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-black">Reuniões Agendadas</h3>
              {loadingMeetings && (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              )}
            </div>
            
            {meetings.upcoming.length === 0 && meetings.past.length === 0 && !loadingMeetings ? (
              <p className="text-xs text-gray-500 text-center py-3">Sem reuniões nos próximos 7 dias</p>
            ) : (
              <div className="space-y-2">
                {/* Combine past (single) + upcoming into one list; past appears first and is disabled */}
                {([
                  ...(meetings.past.length > 0 ? meetings.past.slice(0, 1).map(m => ({ ...m, __isPast: true })) : []),
                  ...meetings.upcoming.slice(0, 5).map(m => ({ ...m, __isPast: false })),
                ] as (WorkspaceMeeting & { __isPast?: boolean })[]).map((meeting, index) => {
                  const startTime = new Date(meeting.start);
                  const endTime = new Date(meeting.end);
                  const now = new Date();
                  const isPast = Boolean(meeting.__isPast);
                  const isHappeningNow = !isPast && startTime <= now && endTime > now;

                  if (isPast) {
                    return (
                      <div key={`past-${meeting.id || index}`} className="p-3 rounded-lg border border-dashed bg-gray-50 opacity-50">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium text-sm truncate flex-1 text-gray-600">{meeting.title}</p>
                          <span className="text-[10px] px-2 py-0.5 bg-gray-300 text-gray-600 rounded font-medium shrink-0">ENCERRADA</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-500">
                          <Clock className="h-3 w-3" />
                          <span>
                            {startTime.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                            {' → '}
                            {endTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {meeting.hostDisplayName && (
                          <p className="text-xs mt-1 text-gray-500">{meeting.hostDisplayName}</p>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div key={meeting.id || index} className={cn("p-3 rounded-lg border", isHappeningNow ? "bg-black text-white" : "bg-gray-50")}>
                      <div className="flex items-start justify-between gap-2">
                        <p className={cn("font-medium text-sm truncate flex-1", isHappeningNow ? "text-white" : "text-black")}>{meeting.title}</p>
                        {isHappeningNow && (
                          <span className="text-[10px] px-2 py-0.5 bg-white text-black rounded font-medium shrink-0">AGORA</span>
                        )}
                      </div>
                      <div className={cn("flex items-center gap-1.5 mt-1.5 text-xs", isHappeningNow ? "text-gray-300" : "text-gray-600")}>
                        <Clock className="h-3 w-3" />
                        <span>
                          {startTime.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          {' → '}
                          {endTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {meeting.hostDisplayName && (
                        <p className={cn("text-xs mt-1", isHappeningNow ? "text-gray-300" : "text-gray-500")}>
                          {meeting.hostDisplayName}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Health Issues */}
          {workspace.health?.issues && workspace.health.issues.length > 0 && (
            <div className="rounded-lg border bg-white p-4">
              <h3 className="text-sm font-semibold mb-3 text-black">
                Alertas ({workspace.health.issues.length})
              </h3>
              <div className="space-y-2">
                {workspace.health.issues.slice(0, 3).map((issue, index) => (
                  <div key={`${issue.id}-${index}`} className="p-3 rounded-lg bg-gray-50 border-l-2 border-black">
                    <p className="font-medium text-sm text-black">{issue.title}</p>
                    <p className="text-xs text-gray-600 mt-1">{issue.description}</p>
                    {issue.recommendedAction && (
                      <p className="text-xs text-gray-500 mt-2">
                        <span className="font-medium">Ação:</span> {issue.recommendedAction}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Informações Adicionais */}
          <div className="rounded-lg border bg-white p-4">
            <h3 className="text-sm font-semibold mb-3 text-black">Informações</h3>
            <div className="space-y-2 text-xs">
              {workspace.sipAddress && (
                <div className="flex justify-between">
                  <span className="text-gray-600">SIP:</span>
                  <span className="font-mono text-black">{workspace.sipAddress}</span>
                </div>
              )}
              {workspace.calendar?.emailAddress && (
                <div className="flex justify-between">
                  <span className="text-gray-600">E-mail:</span>
                  <span className="font-mono text-black">{workspace.calendar.emailAddress}</span>
                </div>
              )}
              {workspace.hotdeskingStatus && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Mesa compartilhada:</span>
                  <span className="text-black capitalize">
                    {String(workspace.hotdeskingStatus).toLowerCase() === "active" ? "Ativa" : String(workspace.hotdeskingStatus).toLowerCase() === "inactive" ? "Inativa" : workspace.hotdeskingStatus}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t">
                <span className="text-gray-600">ID:</span>
                <span className="font-mono text-[10px] text-gray-500">{workspace.id.slice(-12)}</span>
              </div>
            </div>
          </div>

          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
