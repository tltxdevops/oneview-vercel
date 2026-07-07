import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CheckCircle2, Wifi, WifiOff, Users, Video, Phone, AlertTriangle, Info, Monitor, Circle, Calendar as CalendarIcon } from "lucide-react";
import type { Workspace } from "@/types";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceMeeting } from "@/types";

const healthLevelConfig = {
  ok: { icon: CheckCircle2, color: "text-green-600", bg: "bg-green-50 dark:bg-green-950/30", label: "Saudável" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-50 dark:bg-blue-950/30", label: "Informação" },
  warning: { icon: AlertTriangle, color: "text-yellow-600", bg: "bg-yellow-50 dark:bg-yellow-950/30", label: "Atenção" },
  error: { icon: AlertTriangle, color: "text-red-600", bg: "bg-red-50 dark:bg-red-950/30", label: "Crítico" },
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

interface WorkspaceCardProps {
  workspace: Workspace;
  onClick?: () => void;
  onMeetingClick?: () => void;
}

const NAME_MAX_LENGTH = 28;
const PREPOSITIONS = new Set(["da", "de", "do", "das", "dos", "e"]);

function abbreviateName(name: string) {
  const parts = name.split(" ");
  if (parts.length === 1) return parts[0];
  const first = parts[0];

  // Montar parte final mantendo sobrenome + preposições
  let lastIndex = parts.length - 1;
  const tailParts = [parts[lastIndex]];
  while (lastIndex - 1 > 0 && PREPOSITIONS.has(parts[lastIndex - 1].toLowerCase())) {
    tailParts.unshift(parts[lastIndex - 1]);
    lastIndex -= 1;
  }
  const middleParts = parts.slice(1, lastIndex);
  const formatted: string[] = [first];

  for (const middle of middleParts) {
    const lower = middle.toLowerCase();
    if (PREPOSITIONS.has(lower)) {
      formatted.push(lower);
    } else {
      formatted.push(`${middle.charAt(0).toUpperCase()}.`);
    }
  }

  formatted.push(...tailParts);
  return formatted.join(" ");
}

function formatMeetingHost(meeting?: WorkspaceMeeting | null) {
  const rawName = meeting?.hostDisplayName || meeting?.title;
  if (!rawName) {
    return "Organizador não informado";
  }
  const cleaned = rawName.trim().replace(/\s+/g, " ");
  if (cleaned.length <= NAME_MAX_LENGTH) {
    return cleaned;
  }
  const abbreviated = abbreviateName(cleaned);
  if (abbreviated.length <= NAME_MAX_LENGTH) {
    return abbreviated;
  }
  return `${abbreviated.slice(0, NAME_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatMeetingTime(iso?: string) {
  if (!iso) return "--:--";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "--:--";
  }
}

export function WorkspaceCard({ workspace, onClick, onMeetingClick }: WorkspaceCardProps) {
  const healthConfig = healthLevelConfig[workspace.health?.level || "ok"];
  const HealthIcon = healthConfig.icon;
  
  const connectedDevices = workspace.devices?.filter(d =>
    d.connectionStatus === "connected" || d.connectionStatus === "connected_with_issues"
  ).length || 0;
  const totalDevices = workspace.devices?.length || 0;
  const allOnline = totalDevices > 0 && connectedDevices === totalDevices;
  const hasIssues = (workspace.health?.issues?.length || 0) > 0;
  
  // Reunião ativa (xAPI) OU ocupada (booking): usar campos derivados activeNow e currentlyOccupied
  const hasActiveMeeting = Boolean(workspace.activeNow || workspace.currentlyOccupied);
  const meetingClickable = Boolean(hasActiveMeeting && onMeetingClick);
  
  // Calcular uptime dos devices (todos conectados = 100%)
  const deviceUptime = totalDevices > 0 ? Math.round((connectedDevices / totalDevices) * 100) : 0;
  
  // Features ativas
  const hasCalendar = workspace.calendar?.type && workspace.calendar.type !== "none";
  const hasCalling = workspace.calling?.type && workspace.calling.type !== "none";
  const hasMeetings = workspace.deviceHostedMeetings?.enabled;
  const currentMeetingHost = workspace.currentMeeting ? formatMeetingHost(workspace.currentMeeting) : null;
  const nextMeeting = workspace.nextMeeting;
  const nextMeetingHost = nextMeeting ? formatMeetingHost(nextMeeting) : null;
  const nextMeetingTime = nextMeeting ? formatMeetingTime(nextMeeting.start) : null;

  return (
    <Card 
      className="rounded-[10px] border border-border bg-white shadow-sm transition-all hover:shadow-lg hover:border-primary/40 cursor-pointer overflow-hidden group"
      onClick={onClick}
    >
      {/* Header com nome e badge Em uso */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-base truncate group-hover:text-primary transition-colors mb-1">
              {workspace.displayName}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
               {/* Estado de integridade */}
              <div className={cn("px-2 py-0.5 rounded flex items-center gap-1", healthConfig.bg)}>
                <HealthIcon className={cn("h-3 w-3", healthConfig.color)} />
                <span className={cn("text-xs font-medium", healthConfig.color)}>
                  {healthConfig.label}
                </span>
              </div>
              
              <Badge variant="secondary" className="text-xs font-normal">
                {workspaceTypeLabels[workspace.type] || workspace.type}
              </Badge>
              {workspace.capacity && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="h-3 w-3" />
                  <span>{workspace.capacity} pessoas</span>
                </span>
              )}
            </div>
          </div>
          
          {/* Badge Em uso no canto superior direito */}
          {hasActiveMeeting && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 px-2 py-1 bg-black text-white rounded text-xs font-medium cursor-help animate-pulse">
                    <Circle className="h-2 w-2 fill-white" />
                    <span>Em uso</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">🎥 Sala em uso agora</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Chamada ativa (xAPI) ou reunião agendada em andamento
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        
        <Separator />
      </div>

      {/* Métricas */}
      <div className="px-4 pb-4 space-y-3">
        {/* Dispositivos, alertas e reunião */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Monitor className="h-3.5 w-3.5" />
              <span>Dispositivos</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={cn(
                "text-xl font-bold",
                allOnline ? "text-green-600" : "text-black dark:text-white"
              )}>
                {connectedDevices}
              </span>
              <span className="text-sm text-muted-foreground">/ {totalDevices}</span>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Alertas</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className={cn(
                "text-xl font-bold",
                hasIssues ? "text-yellow-600" : "text-green-600"
              )}>
                {workspace.health?.issues?.length || 0}
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Video className="h-3.5 w-3.5" />
              <span>Reunião</span>
            </div>
            {hasActiveMeeting ? (
              <div
                className={cn(
                  "space-y-0.5",
                  meetingClickable && "px-2 py-1 -mx-2 -my-1 rounded-md border border-transparent hover:border-black/10 hover:bg-gray-50 cursor-pointer transition-colors"
                )}
                onClick={(e) => {
                  if (!meetingClickable) return;
                  e.stopPropagation();
                  onMeetingClick?.();
                }}
              >
                <span className="text-sm font-bold text-black dark:text-white flex items-center gap-1">
                  Agora
                  {meetingClickable && (
                    <svg
                      aria-hidden="true"
                      focusable="false"
                      className="h-4 w-4 text-primary"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="4 12 6 12 8 5 10 19 12 12 14 12 16 8 18 16 20 12 22 12" />
                    </svg>
                  )}
                </span>
                <p className="text-xs text-muted-foreground truncate">
                  {currentMeetingHost || "Reunião em andamento"}
                </p>
              </div>
            ) : nextMeeting ? (
              <div className="space-y-0.5">
                <span className="text-sm font-bold text-black dark:text-white">
                  {nextMeetingTime}
                </span>
                <p className="text-xs text-muted-foreground truncate">
                  {nextMeetingHost}
                </p>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Sem agenda</span>
            )}
          </div>
        </div>

        <Separator />

        {/* Features */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Recursos</div>
          <div className="flex items-center gap-3 flex-wrap">
            {hasCalling && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 dark:bg-gray-800/40 rounded-md">
                <Phone className="h-3.5 w-3.5 text-black dark:text-gray-100" />
                <span className="text-xs font-medium text-black dark:text-gray-100">Chamadas</span>
              </div>
            )}
            {hasCalendar && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 dark:bg-gray-800/40 rounded-md">
                <CalendarIcon className="h-3.5 w-3.5 text-black dark:text-gray-100" />
                <span className="text-xs font-medium text-black dark:text-gray-100">Calendário</span>
              </div>
            )}
            {hasMeetings && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 dark:bg-gray-800/40 rounded-md">
                <Video className="h-3.5 w-3.5 text-black dark:text-gray-100" />
                <span className="text-xs font-medium text-black dark:text-gray-100">Reuniões</span>
              </div>
            )}
            {!hasCalling && !hasCalendar && !hasMeetings && (
              <span className="text-xs text-muted-foreground">Nenhum recurso configurado</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
