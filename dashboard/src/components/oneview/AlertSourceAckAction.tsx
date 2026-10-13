import { useEffect, useRef, useState } from "react";
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
  fetchAlert,
  probeSourceAckAccess,
  type AcknowledgeAlertResponse,
  type OneViewAlert,
} from "@/lib/oneview-api";
import { SNAPSHOT_MUTATION_UNAVAILABLE_REASON } from "@/lib/oneview-snapshot-actions";
import {
  sourceAckCanOpen,
  sourceAckIsPending,
  sourceAckUnavailableReason,
  sourceAckTerminalMessage,
  sourceAckTerminalStatus,
  sourceAckTooltip,
  sourceAckVisualState,
  type AlertSourceAckPhase,
  type SourceAckTerminalStatus,
} from "@/lib/oneview-alert-source-ack";

export const SOURCE_ACK_SUCCESS_TOAST = "Reconhecimento enviado ao Zabbix...";
export const SOURCE_ACK_POLL_INTERVAL_MS = 2_000;
export const SOURCE_ACK_POLL_TIMEOUT_MS = 45_000;
export const SOURCE_ACK_ACCESS_TIMEOUT_MS = 10_000;
export const SOURCE_ACK_ACCESS_MAX_POLLS = 10;

type Props = {
  alert: OneViewAlert;
  variant?: "icon" | "button";
  buttonLabel?: string;
  waitingLabel?: string;
  className?: string;
  /** When false, the parent drawer owns the 2s fetchAlert poll. */
  livePollEnabled?: boolean;
  onRequestAccepted?: (alert: OneViewAlert, result: AcknowledgeAlertResponse) => void | Promise<void>;
  onAcknowledged?: (alert: OneViewAlert, status: SourceAckTerminalStatus) => void | Promise<void>;
  /** List is a snapshot copy. Do not POST an acknowledgement against it. */
  liveStateUnavailable?: boolean;
  /** Only the detail drawer may execute the per-operator Zabbix access probe. */
  probeEnabled?: boolean;
};

function confirmField(label: string, value: string) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold">{value || "—"}</dd>
    </div>
  );
}

export function AlertSourceAckAction({
  alert,
  variant = "icon",
  buttonLabel = "Reconhecer alerta",
  waitingLabel = "Aguardando confirmação da origem",
  className,
  livePollEnabled = true,
  onRequestAccepted,
  onAcknowledged,
  liveStateUnavailable = false,
  probeEnabled = false,
}: Props) {
  const [phase, setPhase] = useState<AlertSourceAckPhase>("idle");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enqueued, setEnqueued] = useState(false);
  const [polling, setPolling] = useState(false);
  const [observedAlert, setObservedAlert] = useState<OneViewAlert | null>(null);
  const [actorAckAccess, setActorAckAccess] = useState<true | false | "unknown">("unknown");
  const [actorAckReason, setActorAckReason] = useState<string | null>(null);
  const [probeGeneration, setProbeGeneration] = useState(0);
  const onAcknowledgedRef = useRef(onAcknowledged);
  useEffect(() => { onAcknowledgedRef.current = onAcknowledged; }, [onAcknowledged]);
  const currentAlert = observedAlert?.id === alert.id ? observedAlert : alert;
  const shouldProbe = probeEnabled
    && !liveStateUnavailable
    && currentAlert.source_ack_supported === true
    && currentAlert.source_ack_available === true
    && currentAlert.status_source === "active"
    && !currentAlert.resolved_at
    && !currentAlert.acknowledged_source;
  useEffect(() => {
    if (!shouldProbe) return undefined;
    let stopped = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let requestController: AbortController | undefined;
    const probe = async () => {
      if (stopped) return;
      requestController = new AbortController();
      const timeoutTimer = window.setTimeout(() => requestController?.abort(), SOURCE_ACK_ACCESS_TIMEOUT_MS);
      try {
        const result = await probeSourceAckAccess(alert.id, requestController.signal);
        if (stopped || requestController.signal.aborted) return;
        setActorAckAccess(result.actor_ack_access);
        setActorAckReason(result.reason);
        if (result.pending) {
          attempts += 1;
          if (attempts < SOURCE_ACK_ACCESS_MAX_POLLS) {
            retryTimer = window.setTimeout(() => void probe(), SOURCE_ACK_POLL_INTERVAL_MS);
          } else {
            setActorAckAccess(false);
            setActorAckReason("source_ack_access_unavailable");
          }
        }
      } catch {
        // Transport/BFF failures must not be presented as a Zabbix permission denial.
        if (!stopped) {
          setActorAckAccess(false);
          setActorAckReason("source_ack_access_unavailable");
        }
      } finally {
        window.clearTimeout(timeoutTimer);
      }
    };
    setActorAckAccess("unknown");
    setActorAckReason(null);
    void probe();
    return () => {
      stopped = true;
      requestController?.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [alert.id, probeGeneration, shouldProbe]);
  const visual = sourceAckVisualState(currentAlert);
  const waitingForOrigin = enqueued || sourceAckIsPending(currentAlert);
  const accessMessage = actorAckReason === "operator_event_access_denied"
    ? "Seu usuário Zabbix não possui acesso a este alerta."
    : actorAckReason === "operator_not_found_in_zabbix"
      ? "Seu usuário ainda não está habilitado para reconhecimento nesta origem."
      : actorAckReason === "source_event_not_found"
        ? "O evento não está mais disponível na origem."
        : actorAckReason === "source_event_resolved"
          ? "O alerta já foi resolvido na origem."
          : actorAckReason === "source_already_acknowledged"
            ? "O alerta já foi reconhecido na origem."
            : actorAckReason === "source_ack_access_unavailable"
              ? "Não foi possível validar o acesso no Zabbix."
            : null;
  const tooltip = liveStateUnavailable
    ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON
    : waitingForOrigin
      ? "Aguardando confirmação da origem"
      : shouldProbe && actorAckAccess === "unknown"
        ? "Verificando acesso do usuário Zabbix..."
        : accessMessage ?? sourceAckTooltip(currentAlert);
  const canOpen = !liveStateUnavailable && sourceAckCanOpen(currentAlert) && actorAckAccess === true && !enqueued;
  const probeFailed = actorAckReason === "source_ack_access_unavailable";
  const submitting = phase === "submitting";
  const confirming = phase === "confirming" || phase === "submitting" || phase === "error";
  const unavailableReason = sourceAckUnavailableReason(currentAlert);
  const ariaLabel = liveStateUnavailable
    ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON
    : visual === "acknowledged"
    ? "Alerta reconhecido"
    : visual === "resolved"
      ? "Alerta já resolvido"
    : accessMessage || unavailableReason
        ? "Reconhecimento indisponível nesta origem"
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

  useEffect(() => {
    if (!polling || !livePollEnabled) return undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    let stopped = false;
    const stop = () => {
      stopped = true;
      controller.abort();
      setPolling(false);
    };
    const poll = async () => {
      if (stopped || controller.signal.aborted) return;
      try {
        const response = await fetchAlert(alert.id, controller.signal);
        if (stopped || controller.signal.aborted) return;
        const refreshed = response.item;
        setObservedAlert(refreshed);
        const terminal = sourceAckTerminalStatus(refreshed);
        if (terminal) {
          stop();
          setEnqueued(false);
          if (terminal === "confirmed") toast.success(sourceAckTerminalMessage(terminal));
          else toast.error(sourceAckTerminalMessage(terminal));
          await onAcknowledgedRef.current?.(refreshed, terminal);
          return;
        }
        if (!sourceAckIsPending(refreshed)) {
          stop();
          setEnqueued(false);
          setObservedAlert(null);
          return;
        }
        if (Date.now() - startedAt >= SOURCE_ACK_POLL_TIMEOUT_MS) {
          stop();
          setEnqueued(false);
          setObservedAlert(null);
          toast.message("Reconhecimento ainda aguardando confirmação da origem.");
        }
      } catch {
        // Falha transitória no refetch isolado não interrompe a confirmação.
      }
    };
    const timer = window.setInterval(() => void poll(), SOURCE_ACK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [alert.id, livePollEnabled, polling]);

  async function submitExternalAck() {
    if (liveStateUnavailable || !canOpen || submitting || currentAlert.source_ack_available !== true || actorAckAccess !== true) return;
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
      const accepted = result.status === "pending" && !result.acknowledged_source;
      setEnqueued(accepted);
      setPolling(accepted);
      setObservedAlert(accepted ? {
        ...alert,
        source_ack_status: "pending",
        oneview_ack: {
          status: "pending",
          requested_at: new Date().toISOString(),
          processed_at: null,
          actor_name: result.actor_name || null,
          reason: null,
          message: null,
        },
      } : alert);
      setPhase("success");
      if (accepted) toast.success(SOURCE_ACK_SUCCESS_TOAST);
      else toast.success("Reconhecido");
      try {
        await onRequestAccepted?.(alert, result);
        if (!accepted) await onAcknowledged?.(alert, "confirmed");
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
        (visual === "acknowledged" || waitingForOrigin) && "text-emerald-600",
        className,
      )}
      disabled={!canOpen || submitting || waitingForOrigin}
      aria-label={waitingForOrigin ? waitingLabel : ariaLabel}
      aria-disabled={!canOpen || submitting || waitingForOrigin}
      data-source-ack-state={visual}
      data-source-ack-phase={phase}
      onClick={(event) => {
        event.stopPropagation();
        openConfirm();
      }}
    >
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      {variant === "button" ? <span>{waitingForOrigin ? waitingLabel : buttonLabel}</span> : <span className="sr-only">{waitingForOrigin ? waitingLabel : ariaLabel}</span>}
    </OneViewButton>
  );

  return (
    <>
      <div className="flex flex-col items-start gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
              {control}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
        {probeFailed ? (
          <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
            <span>Não foi possível validar o acesso no Zabbix.</span>
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              onClick={(event) => {
                event.stopPropagation();
                setProbeGeneration((value) => value + 1);
              }}
            >
              Tentar novamente
            </button>
          </div>
        ) : null}
      </div>

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
