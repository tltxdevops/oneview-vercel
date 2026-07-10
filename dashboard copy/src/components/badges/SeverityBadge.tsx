import { Severity } from "@/types";
import { cn } from "@/lib/utils";

interface SeverityBadgeProps {
  severity: Severity;
  className?: string;
}

const severityConfig = {
  Info: {
    bg: "bg-info/10",
    text: "text-info",
    label: "BAIXA",
  },
  Average: {
    bg: "bg-warning/10",
    text: "text-warning",
    label: "MÉDIA",
  },
  High: {
    bg: "bg-error/10",
    text: "text-error",
    label: "ALTA",
  },
  Critical: {
    bg: "bg-critical/10",
    text: "text-critical",
    label: "DESASTRE",
  },
};

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const config = severityConfig[severity];

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
