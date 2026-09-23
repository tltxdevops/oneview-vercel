import { useEffect } from "react";
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
  autoDismissMs?: number;
};

export function OperatorReminderInboxToastStack({
  items,
  onDismiss,
  onOpenLink,
  autoDismissMs = 30_000,
}: OperatorReminderInboxToastProps) {
  useEffect(() => {
    if (!items.length || autoDismissMs <= 0) return;
    const timers = items.map((item) => window.setTimeout(() => onDismiss(item.toastId), autoDismissMs));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [items, autoDismissMs, onDismiss]);

  if (!items.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(100vw-2rem,24rem)] flex-col gap-2"
      aria-live="polite"
      aria-label="Lembretes de link"
    >
      {items.map((item) => (
        <article
          key={item.toastId}
          className={cn(
            "pointer-events-auto rounded-lg border border-border/80 bg-card p-3 shadow-lg ring-1 ring-black/5",
            item.phase === "fired" ? "border-l-4 border-l-[hsl(var(--ov-color-warning))]" : "border-l-4 border-l-success",
          )}
        >
          <div className="flex items-start gap-2">
            <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-semibold leading-snug text-foreground">{item.title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{item.body}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" variant="secondary" onClick={() => onOpenLink(item)}>
                  Ver link
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss(item.toastId)}>
                  Dispensar
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
