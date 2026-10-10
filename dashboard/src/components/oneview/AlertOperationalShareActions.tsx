/**
 * Comunicação operacional do alerta: print em imagem do resumo e cartão curto para o cliente.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { FileText, Loader2, Printer, Send } from "lucide-react";
import { AlertClientSharePreviewDialog } from "@/components/oneview/AlertClientSharePreviewDialog";
import { AlertSharePreviewDialog, type AlertSharePreviewBundle } from "@/components/oneview/AlertSharePreviewDialog";
import { AlertSummaryPrintCard } from "@/components/oneview/AlertSummaryPrintCard";
import { ClientShareDialog } from "@/components/oneview/ClientShareDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  type AlertClientCommunication,
  type AlertClientCommunicationEdits,
  buildAlertClientSharePlainText,
  buildAlertOperationalShareDocument,
  isAlertClientCommunicationValid,
} from "@/lib/oneview-alert-operational-share";
import { captureElementToPng } from "@/lib/oneview-alert-summary-capture";
import type {
  AlertHistoryItem,
  AlertRelatedIncident,
  ClientShareMessage,
  OneViewAlert,
} from "@/lib/oneview-api";
import { SNAPSHOT_MUTATION_UNAVAILABLE_REASON } from "@/lib/oneview-snapshot-actions";

type Props = {
  alert: OneViewAlert;
  communication: AlertClientCommunication;
  relatedIncidents?: AlertRelatedIncident[];
  historyItems?: AlertHistoryItem[];
  onCommunicationChange: (edits: AlertClientCommunicationEdits) => void;
  liveStateUnavailable?: boolean;
};

type BusyAction = "summary" | "print" | null;

async function copyPlainText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fallback abaixo */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function explicitAlertRouteKey(alert: OneViewAlert): string | null {
  const value = (alert as OneViewAlert & { route_key?: unknown }).route_key;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function waitNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function AlertOperationalShareActions({
  alert,
  communication,
  relatedIncidents = [],
  historyItems = [],
  onCommunicationChange,
  liveStateUnavailable = false,
}: Props) {
  const { toast } = useToast();
  const printCardRef = useRef<HTMLDivElement>(null);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewLoading, setPrintPreviewLoading] = useState(false);
  const [printBundle, setPrintBundle] = useState<AlertSharePreviewBundle | null>(null);
  const [clientPreviewOpen, setClientPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [clientShareOpen, setClientShareOpen] = useState(false);
  const valid = isAlertClientCommunicationValid(communication);

  const shareDocument = useMemo(() => buildAlertOperationalShareDocument({
    alert,
    historyItems,
    relatedIncidents,
    generatedAt: new Date(),
  }), [alert, historyItems, relatedIncidents]);

  const clientPlainText = useMemo(() => buildAlertClientSharePlainText({
    alert,
    relatedIncidents,
    clientCommunication: communication,
  }), [alert, communication, relatedIncidents]);

  const currentRelatedIncident = useMemo(() => relatedIncidents.find((item) => (
    !item.identity_conflict
    && String(item.number || "").trim().toUpperCase() === communication.incidentNumber
  )) || null, [communication.incidentNumber, relatedIncidents]);

  const clientShareMessage = useMemo<ClientShareMessage>(() => ({
    client_key: alert.customer_key || alert.client_name,
    client_name: alert.customer_name || alert.client_name,
    severity: alert.severity || "Não classificada",
    host: communication.unitHost,
    equipment: communication.equipment,
    problem: alert.problem_name || alert.trigger_description || "Alerta sem descrição",
    started_at: alert.started_at || alert.first_seen_at,
    status: communication.messageType === "resolved" ? "Resolvido" : "Ativo",
    action: communication.action,
    next_steps: communication.nextSteps,
    follow_up: communication.followUp,
    incident_number: communication.incidentNumber,
    incident_state: currentRelatedIncident?.state_display || currentRelatedIncident?.state || null,
    servicenow_url: currentRelatedIncident?.servicenow_url || null,
    oneview_url: typeof window === "undefined" ? null : `${window.location.origin}/alertas?alert=${encodeURIComponent(alert.id)}`,
    message_type: communication.messageType,
    route_key: explicitAlertRouteKey(alert),
    snapshot: { alert_id: alert.id, data_source_id: alert.data_source_id, source_event_id: alert.source_event_id },
  }), [alert, communication, currentRelatedIncident]);

  const releasePreviewUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    setPrintBundle((current) => (current?.previewUrl === url ? null : current));
  }, []);

  async function copySummary() {
    if (busy) return;
    setBusy("summary");
    try {
      if (!await copyPlainText(shareDocument.plainText)) throw new Error("copy_failed");
      toast({ title: "Resumo copiado", description: "Detalhe operacional do alerta copiado." });
    } catch {
      toast({ title: "Não foi possível copiar o resumo.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function openPrintPreview() {
    if (busy) return;
    setBusy("print");
    setPrintPreviewOpen(true);
    setPrintPreviewLoading(true);
    if (printBundle?.previewUrl) {
      releasePreviewUrl(printBundle.previewUrl);
      setPrintBundle(null);
    }
    try {
      await waitNextPaint();
      const target = printCardRef.current;
      if (!target) throw new Error("capture_target_missing");
      const pngBlob = await captureElementToPng(target);
      setPrintBundle({
        pngBlob,
        previewUrl: URL.createObjectURL(pngBlob),
        internalPlainText: shareDocument.plainText,
        clientPlainText,
      });
    } catch {
      setPrintPreviewOpen(false);
      toast({
        title: "Não foi possível gerar o preview do resumo.",
        description: "Tente novamente.",
        variant: "destructive",
      });
    } finally {
      setPrintPreviewLoading(false);
      setBusy(null);
    }
  }

  function handlePrintPreviewOpenChange(open: boolean) {
    setPrintPreviewOpen(open);
    if (!open && printBundle?.previewUrl) {
      releasePreviewUrl(printBundle.previewUrl);
      setPrintBundle(null);
    }
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/70 bg-muted/20 p-1" aria-label="Compartilhar detalhe e comunicação do alerta">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-0 w-[720px]"
        style={{ left: -10000 }}
      >
        <div ref={printCardRef}>
          <AlertSummaryPrintCard alert={alert} relatedIncidents={relatedIncidents} />
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2.5 text-xs"
        title="Copiar resumo do detalhe do alerta"
        aria-label="Copiar resumo"
        disabled={Boolean(busy)}
        onClick={() => void copySummary()}
      >
        {busy === "summary" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
        Copiar resumo
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2.5 text-xs"
        title="Print do resumo operacional"
        aria-label="Print"
        disabled={Boolean(busy)}
        onClick={() => void openPrintPreview()}
      >
        {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Printer className="h-4 w-4" aria-hidden="true" />}
        Print
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2.5 text-xs"
        title={liveStateUnavailable ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : "Enviar ao cliente ou copiar imagem"}
        aria-label={liveStateUnavailable ? SNAPSHOT_MUTATION_UNAVAILABLE_REASON : "Enviar ao cliente"}
        disabled={!valid || liveStateUnavailable}
        onClick={() => {
          if (liveStateUnavailable) return;
          setClientPreviewOpen(true);
        }}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
        Enviar
      </Button>
      <AlertSharePreviewDialog
        open={printPreviewOpen}
        onOpenChange={handlePrintPreviewOpenChange}
        loading={printPreviewLoading}
        bundle={printBundle}
        copyPlainText={copyPlainText}
      />
      <AlertClientSharePreviewDialog
        open={clientPreviewOpen}
        onOpenChange={setClientPreviewOpen}
        communication={communication}
        onCommunicationChange={onCommunicationChange}
        onSendToClient={() => {
          setClientPreviewOpen(false);
          setClientShareOpen(true);
        }}
      />
      <ClientShareDialog open={clientShareOpen} onOpenChange={setClientShareOpen} message={clientShareMessage} mutationsBlocked={liveStateUnavailable} />
    </div>
  );
}
