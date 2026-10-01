import { forwardRef } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  AlertClientCommunication,
  AlertClientCommunicationEdits,
} from "@/lib/oneview-alert-operational-share";
import { formatAlertClientCommunication } from "@/lib/oneview-alert-operational-share";
import { cn } from "@/lib/utils";

type CardProps = {
  communication: AlertClientCommunication;
  className?: string;
};

export const AlertClientCommunicationCard = forwardRef<HTMLDivElement, CardProps>(
  function AlertClientCommunicationCard({ communication, className }, ref) {
    return (
      <div
        ref={ref}
        data-alert-client-communication-card
        className={cn(
          "w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#0f1012] px-4 py-4 font-sans text-white shadow-sm sm:px-5",
          className,
        )}
        aria-label="Comunicação pronta para o cliente"
      >
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-50">
          {formatAlertClientCommunication(communication)}
        </pre>
      </div>
    );
  },
);

type EditorProps = {
  communication: AlertClientCommunication;
  onChange: (edits: AlertClientCommunicationEdits) => void;
  className?: string;
};

export function AlertClientCommunicationEditor({ communication, onChange, className }: EditorProps) {
  return (
    <div className={cn("grid gap-3", className)} aria-label="Ajustar comunicação ao cliente">
      <label className="grid gap-1.5 text-xs font-medium">
        Ação
        <Textarea
          value={communication.action}
          maxLength={240}
          rows={2}
          className="min-h-16 resize-y text-sm"
          onChange={(event) => onChange({ action: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium">
        Próximos passos
        <Textarea
          value={communication.nextSteps}
          maxLength={240}
          rows={2}
          className="min-h-16 resize-y text-sm"
          onChange={(event) => onChange({ nextSteps: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-xs font-medium">
        Acompanhamento
        <Input
          value={communication.followUp}
          maxLength={120}
          className="text-sm"
          onChange={(event) => onChange({ followUp: event.target.value })}
        />
      </label>
      <p className="text-[11px] text-muted-foreground">
        Ajustes valem somente para esta comunicação e não alteram o alerta ou o chamado.
      </p>
    </div>
  );
}
