import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Wifi, WifiOff, AlertTriangle, Monitor, Phone } from "lucide-react";
import type { WorkspaceDevice } from "@/types";
import { cn } from "@/lib/utils";

const deviceStatusConfig = {
  connected: { icon: Wifi, color: "text-green-500", bg: "bg-green-500/10", label: "Conectado" },
  disconnected: { icon: WifiOff, color: "text-red-500", bg: "bg-red-500/10", label: "Desconectado" },
  connected_with_issues: { icon: AlertTriangle, color: "text-yellow-500", bg: "bg-yellow-500/10", label: "Com problemas" },
  offline_expired: { icon: WifiOff, color: "text-gray-500", bg: "bg-gray-500/10", label: "Offline" },
  activating: { icon: Wifi, color: "text-blue-500", bg: "bg-blue-500/10", label: "Ativando" },
  unknown: { icon: WifiOff, color: "text-gray-400", bg: "bg-gray-400/10", label: "Desconhecido" },
  offline_deep_sleep: { icon: WifiOff, color: "text-gray-400", bg: "bg-gray-400/10", label: "Hibernando" },
};

interface DeviceItemProps {
  device: WorkspaceDevice;
}

export function DeviceItem({ device }: DeviceItemProps) {
  const statusConfig = deviceStatusConfig[device.connectionStatus] || deviceStatusConfig.unknown;
  const StatusIcon = statusConfig.icon;
  const isCollaboration = device.type?.toLowerCase().includes("collaboration");
  const DeviceIcon = isCollaboration ? Monitor : Phone;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="p-2 rounded-lg bg-muted">
              <DeviceIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-base truncate">{device.displayName}</CardTitle>
              <p className="text-sm text-muted-foreground truncate">{device.product}</p>
            </div>
          </div>
          <div className={cn("p-2 rounded-full shrink-0", statusConfig.bg)}>
            <StatusIcon className={cn("h-4 w-4", statusConfig.color)} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Badge 
            variant={device.connectionStatus === "connected" ? "default" : "secondary"}
            className="text-xs"
          >
            {statusConfig.label}
          </Badge>
          {device.capabilities && device.capabilities.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {device.capabilities.length} recursos
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
