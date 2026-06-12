import { Alert } from "@/types";
import { Button } from "@/components/ui/button";
import { Check, Ticket, Eye } from "lucide-react";
import { toast } from "sonner";
import { useMemo } from "react";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Card } from "@/components/ui/card";

interface AlertItemProps {
  alert: Alert;
}

export function AlertItem({ alert }: AlertItemProps) {
  const handleOpenChamado = () => {
    toast.success(`Chamado aberto para o alerta ${alert.id}`);
  };

  const formattedTimestamp = useMemo(() => {
    try {
      const t = alert.time ?? "";
      const hasDate = /\d{4}-\d{2}-\d{2}/.test(t);
      let dt: Date;
      if (hasDate) {
        dt = new Date(t);
      } else if (/^\d{2}:\d{2}:\d{2}$/.test(t)) {
        const now = new Date();
        const [hh, mm, ss] = t.split(":").map((s) => parseInt(s, 10));
        dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, ss);
      } else {
        dt = new Date();
      }
      return dt.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      return alert.time ?? "";
    }
  }, [alert.time]);

  const handleView = () => {
    toast(`Detalhes do alerta ${alert.id}`);
  };

  return (
    <Card className="relative w-full rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-white text-xs font-semibold uppercase text-muted-foreground">
              {(alert.clientName || "?").slice(0, 2)}
            </span>
            <span className="text-sm font-semibold text-foreground/90">{alert.clientName ?? "-"}</span>
            <SeverityBadge severity={alert.severity} className="text-[11px]" />
            <span className="text-xs text-muted-foreground/80">{formattedTimestamp}</span>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-foreground/95 truncate">{alert.host}</span>
            <span className="text-sm text-muted-foreground/80">-</span>
            <span className="text-sm text-foreground/90 truncate">{alert.problem}</span>
            <span className="text-sm text-muted-foreground/80">-</span>
            <span className="text-sm text-muted-foreground/80">{alert.duration}</span>
          </div>
        </div>

        <div className="ml-4 flex h-full items-center gap-2 self-center">
          <Button
            variant="ghost"
            size="icon"
              className="h-8 w-8 rounded-[7px] border-[1.5px] border-border/70 bg-white text-[#484848] transition-colors hover:border-black hover:text-black"
            aria-label={`Ver detalhes ${alert.id}`}
            onClick={handleView}
          >
            <Eye className="h-4 w-4 text-current" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
              className="h-8 w-8 rounded-[7px] border-[1.5px] border-border/70 bg-white text-[#484848] transition-colors hover:border-black hover:text-black"
            aria-label={`Abrir chamado ${alert.id}`}
            onClick={handleOpenChamado}
          >
            <Ticket className="h-4 w-4 text-current" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-[7px] border-[1.5px] border-border/70 bg-white text-[#484848] transition-colors hover:border-black hover:text-black disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={`Reconhecer ${alert.id}`}
            title="ACK desabilitado nesta etapa"
            disabled
          >
            <Check className="h-4 w-4 text-current" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
