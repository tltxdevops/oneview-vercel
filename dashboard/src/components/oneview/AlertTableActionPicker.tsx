import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AlertTableActionId } from "@/lib/oneview-alert-table-actions";

type ActionOption = {
  id: AlertTableActionId;
  label: string;
};

type Props = {
  orderedActions: readonly ActionOption[];
  visibility: Record<AlertTableActionId, boolean>;
  setVisible: (id: AlertTableActionId, visible: boolean) => void;
  reset: () => void;
};

export function AlertTableActionPicker({ orderedActions, visibility, setVisible, reset }: Props) {
  return (
    <div className="ml-6 space-y-1 border-l border-border/70 py-1 pl-2" aria-label="Funções da coluna de ações">
      <div className="flex items-center justify-between px-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Funções</p>
        <Button type="button" size="icon" variant="ghost" className="h-6 w-6" aria-label="Restaurar funções" title="Restaurar funções" onClick={reset}>
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
        </Button>
      </div>
      {orderedActions.map((action) => {
        const visible = visibility[action.id] !== false;
        return (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-1.5 text-xs"
            aria-pressed={visible}
            onClick={() => setVisible(action.id, !visible)}
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border">
              {visible ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
            </span>
            <span className="truncate">{action.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
