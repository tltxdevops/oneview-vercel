import { useState } from "react";
import { Loader2 } from "lucide-react";
import { OneViewButton } from "@/components/oneview/OneViewDesignSystem";
import { canonicalHostName, operationalClientLabel } from "@/components/oneview/ClientIdentity";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OneViewAlert } from "@/lib/oneview-api";
import { fetchSuppressStatus, probeSuppressAccess, requestSuppress, requestUnsuppress, type SuppressStatus } from "@/lib/oneview-suppress-api";
import { suppressionCaption } from "@/lib/oneview-suppression-copy";
import {
  DEFAULT_SUPPRESS_REASON,
  DEFAULT_SUPPRESS_SECONDS,
  nextActionAfterTimeout,
  SUPPRESS_DURATIONS,
  SUPPRESS_STATE_LABEL,
  suppressUiState,
  type SuppressUiState,
} from "@/lib/oneview-suppress-flow";

const POLL_LIMIT = 8;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code || "") : "";
}

function newKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `suppress-${crypto.randomUUID()}`;
  return `suppress-${Date.now().toString(36)}`;
}

export function AlertSuppressAction({ alert, variant = "button" }: { alert: OneViewAlert; variant?: "button" | "row" }) {
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<number>(DEFAULT_SUPPRESS_SECONDS);
  const [reason, setReason] = useState(DEFAULT_SUPPRESS_REASON);
  const [confirmed, setConfirmed] = useState(false);
  const [indefiniteConfirmed, setIndefiniteConfirmed] = useState(false);
  const [ui, setUi] = useState<SuppressUiState | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [status, setStatus] = useState<SuppressStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const active = alert.status_source === "active" && !alert.resolved_at;
  if (!active) return null;

  const clientName = operationalClientLabel({
    key: alert.customer_key,
    name: alert.customer_name,
    source: alert.customer_source,
    operational_scope: alert.operational_scope,
    operational_scope_label: alert.operational_scope_label,
  });
  const existing = suppressionCaption(alert, (value) => value) || "Nenhuma supressão confirmada";
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const indefiniteOk = duration !== 0 || indefiniteConfirmed;
  const canSubmit = writeEnabled && reasonValid && confirmed && indefiniteOk && !busy && ui !== "suppressed" && ui !== "awaiting" && ui !== "requesting";

  async function loadStatus(outboxId?: string | null) {
    const next = await fetchSuppressStatus(alert.id, outboxId);
    setStatus(next);
    if (next.origin_confirmed) setUi("suppressed");
    return next;
  }

  async function openDialog() {
    setOpen(true);
    setUi("checking");
    setDetail(null);
    try {
      const access = await probeSuppressAccess(alert.id);
      await loadStatus();
      if (access.actor_suppress_access !== true) {
        setWriteEnabled(false);
        setUi("refused");
        setDetail(access.reason === "suppress_disabled"
          ? "Escrita desligada até o canário real"
          : (access.reason || "permissao_negada"));
        return;
      }
      setWriteEnabled(true);
      setUi(access.pending ? "checking" : null);
    } catch (error) {
      setUi("refused");
      setDetail(errorCode(error) || "permissao_negada");
    }
  }

  async function poll(outboxId: string) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const next = await loadStatus(outboxId);
      const state = suppressUiState({
        phase: "settled",
        accepted: true,
        outboxStatus: next.outbox_status,
        confirmed: next.origin_confirmed,
      });
      setUi(state);
      if (state === "suppressed" || state === "refused" || state === "inconclusive") return;
    }
    if (nextActionAfterTimeout() !== "reconcile") return;
    setUi("inconclusive");
    setDetail("A solicitação foi aceita, mas o Zabbix ainda não confirmou a supressão.");
  }

  async function submit() {
    if (!canSubmit || !alert.source_event_id) return;
    const key = newKey();
    setBusy(true);
    setUi("requesting");
    try {
      const accepted = await requestSuppress(alert.id, {
        source_event_id: alert.source_event_id,
        reason: reason.trim(),
        duration_seconds: duration,
        indefinite_confirmed: duration === 0,
      }, key);
      if (accepted.origin_confirmed) {
        setUi("suppressed");
        return;
      }
      setUi("awaiting");
      if (accepted.outbox_id) await poll(accepted.outbox_id);
    } catch (error) {
      setUi("refused");
      setDetail(errorCode(error) || "operacao_recusada");
    } finally {
      setBusy(false);
    }
  }

  async function reconcile() {
    setUi("awaiting");
    const next = await loadStatus();
    setUi(suppressUiState({
      phase: "settled",
      accepted: true,
      outboxStatus: next.outbox_status,
      confirmed: next.origin_confirmed,
      timedOut: !next.origin_confirmed && next.outbox_status !== "failed" && next.outbox_status !== "cancelled" && next.outbox_status !== "pending",
    }));
  }

  async function unsuppress() {
    if (!status?.unsuppress.enabled || !alert.source_event_id || status.unsuppress.expected_suppress_until == null || !status.unsuppress.expected_userid) return;
    setBusy(true);
    setUi("requesting");
    try {
      const accepted = await requestUnsuppress(alert.id, {
        source_event_id: alert.source_event_id,
        expected_suppress_until: status.unsuppress.expected_suppress_until,
        expected_userid: status.unsuppress.expected_userid,
      }, newKey());
      setUi(accepted.origin_confirmed ? "suppressed" : "awaiting");
    } catch (error) {
      setUi("refused");
      setDetail(errorCode(error) || "operacao_recusada");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <OneViewButton type="button" variant={variant === "row" ? "ghost" : "secondary"} size="sm" onClick={(event) => { event.stopPropagation(); void openDialog(); }}>
        Suprimir alerta
      </OneViewButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suprimir alerta</DialogTitle>
            <DialogDescription>A supressão é gravada no Zabbix com o operador autenticado. Aceitar a solicitação não significa que ela já foi aplicada.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p><span className="text-muted-foreground">Cliente:</span> {clientName}</p>
            <p><span className="text-muted-foreground">Host:</span> {canonicalHostName(alert)}</p>
            <p><span className="text-muted-foreground">Evento Zabbix:</span> {alert.source_event_id || "não informado"}</p>
            <p><span className="text-muted-foreground">Estado atual:</span> {alert.status_source || "desconhecido"}</p>
            <p><span className="text-muted-foreground">Supressão existente:</span> {existing}</p>
            <p><span className="text-muted-foreground">Operador:</span> operador autenticado</p>
            <div>
              <Label htmlFor="suppress-duration">Duração</Label>
              <select id="suppress-duration" className="mt-1 w-full rounded-md border bg-background px-2 py-1" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {SUPPRESS_DURATIONS.map((item) => <option key={item.seconds} value={item.seconds}>{item.label}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="suppress-reason">Motivo</Label>
              <Textarea id="suppress-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            {duration === 0 ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={indefiniteConfirmed} onChange={(event) => setIndefiniteConfirmed(event.target.checked)} />
                Confirmo supressão sem prazo definido
              </label>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              Confirmo a supressão deste evento no Zabbix
            </label>
            {ui ? <p role="status">{busy && ui === "requesting" ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}{SUPPRESS_STATE_LABEL[ui]}{detail ? ` · ${detail}` : ""}</p> : null}
            <section>
              <h3 className="font-medium">Supressões anteriores</h3>
              <p>{status ? `${status.period_count} período(s) comprovado(s)` : "Carregando histórico"}</p>
            </section>
            <p className="text-muted-foreground">
              Remover supressão: {status?.unsuppress.enabled ? "disponível para o período identificado" : (status?.unsuppress.reason || "suppression_not_identified")}
            </p>
          </div>
          <DialogFooter>
            {ui === "inconclusive" ? <OneViewButton type="button" variant="secondary" onClick={() => void reconcile()}>Verificar novamente</OneViewButton> : null}
            <OneViewButton type="button" variant="secondary" disabled={!writeEnabled || !status?.unsuppress.enabled || busy} onClick={() => void unsuppress()}>Remover supressão</OneViewButton>
            <OneViewButton type="button" disabled={!canSubmit} onClick={() => void submit()}>Confirmar supressão</OneViewButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
