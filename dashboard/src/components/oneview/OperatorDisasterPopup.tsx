import { Siren, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SEVERITY_POPUP_LABELS } from "@/lib/oneview-severity-popup";
import type { SeverityPopupLevel } from "@/lib/oneview-notification-preferences";
import { cn } from "@/lib/utils";

export type OperatorSeverityPopupItem = {
  key: string;
  severity: SeverityPopupLevel;
  customer: string;
  title: string;
};

export type OperatorDisasterPopupItem = OperatorSeverityPopupItem;

const TONE: Record<SeverityPopupLevel, string> = {
  disaster: "border-destructive/50",
  high: "border-orange-500/50",
  average: "border-amber-500/40",
};

const BAR: Record<SeverityPopupLevel, string> = {
  disaster: "bg-destructive",
  high: "bg-orange-500",
  average: "bg-amber-500",
};

export function OperatorDisasterPopup({
  items,
  onOpen,
  onDismiss,
  onDisable,
}: {
  items: OperatorSeverityPopupItem[];
  onOpen: (item: OperatorSeverityPopupItem) => void;
  onDismiss: (key: string) => void;
  onDisable: () => void;
}) {
  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-24 z-[100] flex w-[min(100vw-2rem,28rem)] flex-col gap-3" aria-live="assertive" aria-label="Novos alertas por severidade">
      {items.map((item) => (
        <article key={item.key} className={cn("pointer-events-auto overflow-hidden rounded-xl border bg-card shadow-2xl ring-1 ring-black/10", TONE[item.severity])}>
          <div className={cn("h-1.5", BAR[item.severity])} />
          <div className="flex items-start gap-3 p-4">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><Siren className="h-5 w-5" aria-hidden="true" /></div>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-sm font-semibold text-foreground">Novo alerta {SEVERITY_POPUP_LABELS[item.severity]}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.customer} · {item.title}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={item.severity === "disaster" ? "destructive" : "default"} onClick={() => onOpen(item)}>Abrir</Button>
                <Button size="sm" variant="outline" onClick={() => onDismiss(item.key)}>Fechar</Button>
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onDisable}>Não exibir pop-ups</Button>
              </div>
            </div>
            <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Fechar aviso de severidade" onClick={() => onDismiss(item.key)}><X className="h-4 w-4" /></button>
          </div>
        </article>
      ))}
    </div>
  );
}

export const OperatorSeverityPopup = OperatorDisasterPopup;
