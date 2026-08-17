/**
 * OV-P0-115 — bloco discreto de recorrência no Resumo do drawer.
 * Sem badge, sem coluna em Monitoramento.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildAlertRecurrenceSignal,
  formatRecurrenceWhen,
  RECURRENCE_SIGNAL_TOOLTIP,
  type AlertRecurrenceFields,
} from "@/lib/oneview-recurrence-signal";

type Props = {
  alert?: AlertRecurrenceFields | null;
};

export function AlertRecurrenceSignal({ alert }: Props) {
  const signal = buildAlertRecurrenceSignal(alert);
  if (!signal) return null;

  const previousOccurrence = formatRecurrenceWhen(signal.previous_occurrence_at);
  const previousRecovery = formatRecurrenceWhen(signal.previous_recovery_at);

  return (
    <section aria-label="Recorrência" className="space-y-0.5">
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="cursor-help text-xs text-muted-foreground">{signal.headline}</p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs leading-relaxed">
            {RECURRENCE_SIGNAL_TOOLTIP}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {previousOccurrence ? (
        <p className="text-[11px] text-muted-foreground/80">
          Última ocorrência anterior: {previousOccurrence}
        </p>
      ) : null}
      {previousRecovery ? (
        <p className="text-[11px] text-muted-foreground/80">
          Última recuperação: {previousRecovery}
        </p>
      ) : null}
    </section>
  );
}
