import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OperatorReminderInboxItem } from "@/lib/oneview-api";

export type ReminderInboxToastRecord = OperatorReminderInboxItem & {
  toastId: string;
};

type OperatorReminderInboxToastProps = {
  items: ReminderInboxToastRecord[];
  onDismiss: (toastId: string) => void;
  onOpenLink: (item: ReminderInboxToastRecord) => void;
  onDisablePopups: () => void;
};

export function OperatorReminderInboxToastStack({
  items,
  onDismiss,
  onOpenLink,
  onDisablePopups,
}: OperatorReminderInboxToastProps) {
  if (!items.length) return null;

  return (
    <div
      className="pointer-events-none fixed right-5 top-1/2 z-[100] flex w-[min(100vw-2rem,28rem)] -translate-y-1/2 flex-col gap-3 max-sm:bottom-4 max-sm:top-auto max-sm:-translate-y-0"
      aria-live="assertive"
      aria-label="Lembretes operacionais"
    >
      {items.map((item) => (
        <article
          key={item.toastId}
          className={cn(
            "pointer-events-auto overflow-hidden rounded-xl border bg-card shadow-2xl ring-1 ring-black/10",
            item.phase === "fired" ? "border-[hsl(var(--ov-color-warning))]/50" : "border-success/50",
          )}
        >
          <div className={cn("h-1.5", item.phase === "fired" ? "bg-[hsl(var(--ov-color-warning))]" : "bg-success")} />
          <div className="flex items-start gap-3 p-4">
            <div className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", item.phase === "fired" ? "bg-[hsl(var(--ov-color-warning))]/15 text-[hsl(var(--ov-color-warning))]" : "bg-success/15 text-success")}>
              <Bell className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-sm font-semibold leading-snug text-foreground">{item.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
              <p className="text-xs font-medium text-muted-foreground">Este aviso permanece aqui até você fechar.</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" variant="secondary" onClick={() => onOpenLink(item)}>
                  Ver link
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => onDismiss(item.toastId)}>
                  Fechar
                </Button>
                <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={onDisablePopups}>
                  Não exibir pop-ups
                </Button>
              </div>
            </div>
            <button
              type="button"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Fechar notificação"
              onClick={() => onDismiss(item.toastId)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
