import { AlertStatus, ChamadoStatus } from "@/types";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: AlertStatus | ChamadoStatus;
  className?: string;
}

const statusConfig = {
  Active: {
    bg: "bg-error/10",
    text: "text-error",
    label: "Ativo",
  },
  Acknowledged: {
    bg: "bg-warning/10",
    text: "text-warning",
    label: "Reconhecido",
  },
  Resolved: {
    bg: "bg-success/10",
    text: "text-success",
    label: "Resolvido",
  },
  Aberto: {
    bg: "bg-error/10",
    text: "text-error",
    label: "Aberto",
  },
  "Em andamento": {
    bg: "bg-warning/10",
    text: "text-warning",
    label: "Em progresso",
  },
  Resolvido: {
    bg: "bg-success/10",
    text: "text-success",
    label: "Resolvido",
  },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status];

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center justify-center rounded-full px-3 text-[11px] font-semibold",
        config.bg,
        config.text,
        className
      )}
    >
      <span className="truncate text-center leading-none">{config.label}</span>
    </span>
  );
}
