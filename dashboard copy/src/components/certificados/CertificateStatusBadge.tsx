import { CertificateStatus } from "@/types";
import { cn } from "@/lib/utils";

interface CertificateStatusBadgeProps {
  status: CertificateStatus;
  className?: string;
}

const STATUS_STYLES: Record<CertificateStatus, { bg: string; text: string; border: string; label: string }> = {
  "Válido": {
    bg: "bg-success/10",
    text: "text-success",
    border: "border-success/30",
    label: "Válido",
  },
  "Expirando": {
    bg: "bg-warning/10",
    text: "text-warning",
    border: "border-warning/30",
    label: "Expirando",
  },
  "Expirado": {
    bg: "bg-error/10",
    text: "text-error",
    border: "border-error/30",
    label: "Expirado",
  },
  "Indefinido": {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border/50",
    label: "Indefinido",
  },
};

export function CertificateStatusBadge({ status, className }: CertificateStatusBadgeProps) {
  const styles = STATUS_STYLES[status] ?? STATUS_STYLES["Indefinido"];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium",
        styles.bg,
        styles.text,
        styles.border,
        className
      )}
    >
      {styles.label}
    </span>
  );
}
