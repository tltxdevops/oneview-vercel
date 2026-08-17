import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  formatOneViewSeverityLabel,
  severityTone,
} from "@/lib/oneview-severity-visual";

interface SeverityBadgeProps {
  /** Valor bruto ou canônico (OneView / Zabbix); labels oficiais sem tradução. */
  severity?: string | number | null;
  className?: string;
}

/**
 * Badge canônico de severidade (OV-P0-77).
 * Cor só no badge — não colorir a linha.
 */
export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("border text-[10px] hover:bg-inherit", severityTone(severity), className)}
    >
      {formatOneViewSeverityLabel(severity)}
    </Badge>
  );
}
