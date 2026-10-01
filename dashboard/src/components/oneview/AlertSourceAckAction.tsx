import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { OneViewButton } from "@/components/oneview/OneViewDesignSystem";
import { canonicalHostName, operationalClientLabel } from "@/components/oneview/ClientIdentity";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  acknowledgeAlert,
  type AcknowledgeAlertResponse,
  type OneViewAlert,
} from "@/lib/oneview-api";
import {
  sourceAckCanOpen,
  sourceAckTooltip,
  sourceAckVisualState,
  type AlertSourceAckPhase,
} from "@/lib/oneview-alert-source-ack";

export const SOURCE_ACK_SUCCESS_TOAST = "Reconhecimento enviado ao Zabbix...";

type Props = {
  alert: OneViewAlert;
  variant?: "icon" | "button";
  onAcknowledged?: (result: AcknowledgeAlertResponse) => void | Promise<void>;
};

function confirmField(label: string, value: string) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold">{value || "—"}</dd>
    </div>
  );
}

export function AlertSourceAckAction({ alert, variant = "icon", onAcknowledged }: Props) {
  const [phase, setPhase] = useState<AlertSourceAckPhase>("idle");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enqueued, setEnqueued] = useState(false);
  const visual = sourceAckVisualState(alert);
  const tooltip = sourceAckTooltip(alert);
  const canOpen = sourceAckCanOpen(alert) && !enqueued;
  const submitting = phase === "submitting";
  const confirming = phase === "confirming" || phase === "submitting" || phase === "error";
  const ariaLabel = visual === "acknowledged"
    ? "Alerta reconhecido"
    : visual === "resolved"
      ? "Alerta já resolvido"
      : "Reconhecer alerta";

  function openConfirm() {
    if (!canOpen || submitting) return;
    setError(null);
    setComment("");
    setPhase("confirming");
  }

  function closeConfirm(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) {
      setPhase("idle");
      setComment("");
      setError(null);
    }
  }

  async function submitExternalAck() {
    if (!canOpen || submitting) return;
    const sourceEventId = String(alert.source_event_id || "").trim();
    if (!sourceEventId) {
      setPhase("error");
      setError("Event ID indisponível para reconhecimento no Zabbix.");
      return;
    }
    setPhase("submitting");
    setError(null);
    try {
      const result = await acknowledgeAlert({
        alertId: alert.id,
        sourceEventId,
        comment: comment.trim() || undefined,
      });
      setEnqueued(result.status === "pending");
      setPhase("success");
      toast.success(SOURCE_ACK_SUCCESS_TOAST);
      try {
        await onAcknowledged?.(result);
      } catch {
        // ACK externo já confirmado; falha de refresh não assume erro de reconhecimento.
      }
      setPhase("idle");
      setComment("");
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : "Não foi possível reconhecer o alerta no Zabbix.";
      setPhase("error");
      setError(message);
      toast.error(message);
    }
  }

  const control = (
    <OneViewButton
      type="button"
      variant={variant === "button" ? "secondary" : "ghost"}
      size={variant === "button" ? "sm" : "icon"}
      className={cn(
        variant === "button" ? "ov-control-official-compact h-8 gap-1.5 px-2.5" : "ov-control-official-compact h-7 min-h-7 w-7 px-0",
        (visual === "acknowledged" || enqueued) && "text-emerald-600",
      )}
      disabled={!canOpen || submitting}
      aria-label={ariaLabel}
      aria-disabled={!canOpen || submitting}
      data-source-ack-state={visual}
      data-source-ack-phase={phase}
      onClick={(event) => {
        event.stopPropagation();
        openConfirm();
      }}
    >
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      {variant === "button" ? <span>{enqueued ? "Reconhecimento enviado" : "Reconhecer alerta"}</span> : <span className="sr-only">{enqueued ? "Reconhecimento enviado" : ariaLabel}</span>}
    </OneViewButton>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
            {control}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <Dialog open={confirming} onOpenChange={closeConfirm}>
        <DialogContent className="z-[100] max-w-md" onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Reconhecer alerta?</DialogTitle>
            <DialogDescription>
              Esta ação enviará o reconhecimento ao Worker do Zabbix. A confirmação só aparece após retorno da origem.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid gap-3">
            {confirmField("Cliente", operationalClientLabel({
              key: alert.customer_key,
              name: alert.customer_name,
              source: alert.customer_source,
              operational_scope: alert.operational_scope,
              operational_scope_label: alert.operational_scope_label,
            }))}
            {confirmField("Host", canonicalHostName(alert))}
            {confirmField("Problema", String(alert.problem_name || "—"))}
            {confirmField("Event ID", String(alert.source_event_id || "—"))}
          </dl>
          <div className="space-y-2">
            <Label htmlFor={`source-ack-comment-${alert.id}`}>Comentário opcional</Label>
            <Textarea
              id={`source-ack-comment-${alert.id}`}
              value={comment}
              maxLength={500}
              disabled={submitting}
              placeholder="Comentário opcional"
              onChange={(event) => setComment(event.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <OneViewButton type="button" variant="secondary" disabled={submitting} onClick={() => closeConfirm(false)}>
              Cancelar
            </OneViewButton>
            <OneViewButton type="button" disabled={submitting} onClick={() => void submitExternalAck()}>
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />}
              Reconhecer
            </OneViewButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
