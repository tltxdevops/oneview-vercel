import { useEffect, useRef, useState } from "react";
import { Check, Clock, Loader2, Minus } from "lucide-react";
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
  reconcileSourceAckSubmission,
  sourceAckCanOpen,
  sourceAckIsPending,
  sourceAckRowControl,
  sourceAckUnavailableReason,
  sourceAckTerminalMessage,
  sourceAckTooltip,
  sourceAckVisualState,
  startSourceAckSubmission,
  type AlertSourceAckPhase,
  type SourceAckSubmission,
  type SourceAckSubmissionOutcome,
  type SourceAckTerminalStatus,
} from "@/lib/oneview-alert-source-ack";

export const SOURCE_ACK_SUCCESS_TOAST = "Reconhecimento enviado ao Zabbix...";
export const SOURCE_ACK_POLL_INTERVAL_MS = 2_000;
export const SOURCE_ACK_POLL_TIMEOUT_MS = 45_000;
export const SOURCE_ACK_ACCESS_TIMEOUT_MS = 10_000;
export const SOURCE_ACK_ACCESS_MAX_POLLS = 10;
export const SOURCE_ACK_RESOLVED_MESSAGE = "O alerta foi resolvido na origem antes da confirmação do reconhecimento.";
export const SOURCE_ACK_TIMEOUT_MESSAGE = "Reconhecimento ainda aguardando confirmação da origem.";

type SourceAckNotice = { alertId: string; tone: "success" | "error" | "info"; message: string };

function newAttemptKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `ack-${crypto.randomUUID()}`;
  return `ack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function outcomeNotice(alertId: string, outcome: SourceAckSubmissionOutcome): SourceAckNotice | null {
  if (outcome.kind === "settled") {
    return { alertId, tone: outcome.status === "confirmed" ? "success" : "error", message: sourceAckTerminalMessage(outcome.status) };
  }
  if (outcome.kind === "resolved") return { alertId, tone: "info", message: SOURCE_ACK_RESOLVED_MESSAGE };
  if (outcome.kind === "timeout") return { alertId, tone: "info", message: SOURCE_ACK_TIMEOUT_MESSAGE };
  return null;
}

type Props = {
  alert: OneViewAlert;
  variant?: "icon" | "button";
  buttonLabel?: string;
  waitingLabel?: string;
  className?: string;
  /**
   * When false, the parent must keep `alert` fresh while an ACK is in flight
   * (the drawer does it through useAlertDrawerLiveRefresh).
   */
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
  const [scopeAlertId, setScopeAlertId] = useState(alert.id);
  const [phase, setPhase] = useState<AlertSourceAckPhase>("idle");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SourceAckSubmission | null>(null);
  const [polledAlert, setPolledAlert] = useState<OneViewAlert | null>(null);
  const [notice, setNotice] = useState<SourceAckNotice | null>(null);
  const [actorAckAccess, setActorAckAccess] = useState<true | false | "unknown">("unknown");
  const [actorAckReason, setActorAckReason] = useState<string | null>(null);
  const [probeGeneration, setProbeGeneration] = useState(0);
  const [timeoutTick, setTimeoutTick] = useState(0);
  const submittingRef = useRef(false);
  const onAcknowledgedRef = useRef(onAcknowledged);
  useEffect(() => { onAcknowledgedRef.current = onAcknowledged; }, [onAcknowledged]);

  // Same instance reused for another alert: drop everything tied to the previous one before rendering.
  if (scopeAlertId !== alert.id) {
    setScopeAlertId(alert.id);
    setPhase("idle");
    setComment("");
    setError(null);
    setAttemptKey(null);
    setSubmission(null);
    setPolledAlert(null);
    setNotice(null);
    setActorAckAccess("unknown");
    setActorAckReason(null);
  }

  const activeSubmission = submission?.alertId === alert.id ? submission : null;
  const currentAlert = activeSubmission && livePollEnabled && polledAlert?.id === alert.id ? polledAlert : alert;
  const visibleNotice = notice?.alertId === alert.id ? notice : null;
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

  // Standalone use only: the drawer passes livePollEnabled={false} and feeds `alert` from its own poll.
  useEffect(() => {
    if (!activeSubmission || !livePollEnabled) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetchAlert(alert.id, controller.signal, { fresh: true });
        if (!controller.signal.aborted) setPolledAlert(response.item);
      } catch {
        // Falha transitória no refetch isolado não interrompe a confirmação.
      } finally {
        inFlight = false;
      }
    }, SOURCE_ACK_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeSubmission, alert.id, livePollEnabled]);

  useEffect(() => {
    if (!activeSubmission) return undefined;
    const outcome = reconcileSourceAckSubmission(activeSubmission, currentAlert, Date.now(), SOURCE_ACK_POLL_TIMEOUT_MS);
    if (outcome.kind === "waiting") {
      const remaining = activeSubmission.startedAt + SOURCE_ACK_POLL_TIMEOUT_MS - Date.now();
      const timer = window.setTimeout(() => setTimeoutTick((value) => value + 1), Math.max(0, remaining) + 50);
      return () => window.clearTimeout(timer);
    }
    setSubmission(null);
    setPolledAlert(null);
    const nextNotice = outcomeNotice(activeSubmission.alertId, outcome);
    setNotice(nextNotice);
    // An uncertain timeout must keep the original key. Rotate only after the
    // read model proves a terminal outcome (or the alert itself is resolved).
    if (outcome.kind === "settled" || outcome.kind === "resolved") setAttemptKey(null);
    if (nextNotice?.tone === "success") toast.success(nextNotice.message);
    else if (nextNotice?.tone === "error") toast.error(nextNotice.message);
    else if (nextNotice) toast.message(nextNotice.message);
    if (outcome.kind === "settled" && outcome.status !== "confirmed") {
      // Revalidate delegated access before offering a retry.
      setProbeGeneration((value) => value + 1);
    }
    const terminal: SourceAckTerminalStatus | null = outcome.kind === "settled"
      ? outcome.status
      : outcome.kind === "resolved" ? "cancelled" : null;
    if (terminal) void Promise.resolve(onAcknowledgedRef.current?.(currentAlert, terminal)).catch(() => undefined);
    return undefined;
  }, [activeSubmission, currentAlert, timeoutTick]);

  const visual = sourceAckVisualState(currentAlert);
  const waitingForOrigin = Boolean(activeSubmission) || sourceAckIsPending(currentAlert);
  const accessMessage = actorAckReason === "operator_event_access_denied"
    ? "Seu usuário Zabbix não possui acesso a este alerta."
    : actorAckReason === "ack_identity_not_mapped"
      ? "Seu usu\u00e1rio n\u00e3o est\u00e1 mapeado para esta origem."
      : actorAckReason === "ack_identity_mapping_invalid"
        ? "O mapeamento do seu usu\u00e1rio nesta origem precisa ser revisado."
    : actorAckReason === "operator_not_found_in_zabbix"
      ? "Seu usuário ainda não está habilitado para reconhecimento nesta origem."
      : actorAckReason === "source_event_not_found"
        ? "O evento não está mais disponível na origem."
        : actorAckReason === "source_event_resolved"
          ? "O alerta já foi resolvido na origem."
          : actorAckReason === "source_already_acknowledged"
            ? "O alerta já foi reconhecido na origem."
            : actorAckReason === "delegated_ack_version_unsupported"
              ? "A vers\u00e3o desta origem n\u00e3o suporta reconhecimento delegado."
              : actorAckReason === "delegated_ack_datasource_not_allowed"
                ? "Reconhecimento delegado ainda n\u00e3o homologado para esta origem."
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
  const submitting = phase === "submitting";
  const canOpen = !liveStateUnavailable
    && sourceAckCanOpen(currentAlert)
    && actorAckAccess === true
    && !activeSubmission
    && !waitingForOrigin;
  const probeFailed = actorAckReason === "source_ack_access_unavailable";
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
    setNotice(null);
    setAttemptKey((current) => current ?? newAttemptKey());
    setPhase("confirming");
  }

  function closeConfirm(nextOpen: boolean) {
    if (submitting) return;
    if (!nextOpen) {
      setPhase("idle");
      setComment("");
      setError(null);
      // Preserve an attempted key across an ambiguous HTTP/network failure.
      // A confirmation cancelled before POST has no attempt to preserve.
      if (phase !== "error") setAttemptKey(null);
    }
  }

  async function submitExternalAck() {
    if (liveStateUnavailable || !canOpen || submitting || currentAlert.source_ack_available !== true) return;
    if (actorAckAccess !== true || submittingRef.current) return;
    const sourceEventId = String(alert.source_event_id || "").trim();
    if (!sourceEventId) {
      setPhase("error");
      setError("Event ID indisponível para reconhecimento no Zabbix.");
      return;
    }
    // Retries inside the same confirmation reuse the key, so a POST that landed but timed out is not duplicated.
    const idempotencyKey = attemptKey ?? newAttemptKey();
    if (!attemptKey) setAttemptKey(idempotencyKey);
    const baseline = startSourceAckSubmission(currentAlert, Date.now());
    submittingRef.current = true;
    setPhase("submitting");
    setError(null);
    try {
      const result = await acknowledgeAlert({
        alertId: alert.id,
        sourceEventId,
        comment: comment.trim() || undefined,
        idempotencyKey,
      });
      const accepted = result.status === "pending" && !result.acknowledged_source;
      setSubmission(accepted ? { ...baseline, startedAt: Date.now() } : null);
      setPolledAlert(null);
      setPhase("idle");
      setComment("");
      if (accepted) {
        toast.success(SOURCE_ACK_SUCCESS_TOAST);
      } else {
        setAttemptKey(null);
        setNotice({ alertId: alert.id, tone: "success", message: sourceAckTerminalMessage("confirmed") });
        toast.success("Reconhecido");
      }
      try {
        await onRequestAccepted?.(alert, result);
        if (!accepted) await onAcknowledged?.(alert, "confirmed");
      } catch {
        // ACK externo já aceito; falha de refresh não assume erro de reconhecimento.
      }
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : "Não foi possível reconhecer o alerta no Zabbix.";
      setPhase("error");
      setError(message);
      toast.error(message);
    } finally {
      submittingRef.current = false;
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
      data-source-ack-phase={activeSubmission ? "waiting" : phase}
      onClick={(event) => {
        event.stopPropagation();
        openConfirm();
      }}
    >
      {submitting || activeSubmission ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
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
        {visibleNotice && !waitingForOrigin ? (
          <p
            className={cn(
              "text-xs",
              visibleNotice.tone === "error" ? "text-destructive" : visibleNotice.tone === "success" ? "text-emerald-600" : "text-muted-foreground",
            )}
            role={visibleNotice.tone === "error" ? "alert" : "status"}
            data-source-ack-notice={visibleNotice.tone}
          >
            {visibleNotice.message}
          </p>
        ) : null}
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

type RowProps = {
  alert: OneViewAlert;
  /** Opens this alert's drawer, where access is probed and the ACK is confirmed. */
  onOpenDetail: (alert: OneViewAlert) => void;
  liveStateUnavailable?: boolean;
  className?: string;
};

/** Table cell: never probes or POSTs. Actionable alerts open the drawer; otherwise it only shows state. */
export function AlertSourceAckRowAction({ alert, onOpenDetail, liveStateUnavailable = false, className }: RowProps) {
  const control = sourceAckRowControl(alert, liveStateUnavailable);
  if (control.kind === "open-detail") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <OneViewButton
            type="button"
            variant="ghost"
            size="icon"
            className={cn("ov-control-official-compact h-7 min-h-7 w-7 px-0", className)}
            aria-label={control.label}
            data-source-ack-row="open-detail"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail(alert);
            }}
          >
            <Check className="h-4 w-4" />
            <span className="sr-only">{control.label}</span>
          </OneViewButton>
        </TooltipTrigger>
        <TooltipContent>{control.label}</TooltipContent>
      </Tooltip>
    );
  }
  const unavailable = liveStateUnavailable && control.tone === "muted" && sourceAckVisualState(alert) === "pending";
  const label = unavailable ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : control.label;
  const Icon = control.tone === "success" ? Check : control.tone === "waiting" ? Clock : Minus;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={label}
          data-source-ack-row={control.tone}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md",
            control.tone === "success" ? "text-emerald-600" : control.tone === "waiting" ? "text-amber-600" : "text-muted-foreground/60",
            className,
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon className="h-4 w-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
