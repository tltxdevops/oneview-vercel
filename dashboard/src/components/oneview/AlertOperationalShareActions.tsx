/**
 * OV-P0-307 — preview do print do resumo + cópia em texto.
 */
import { useCallback, useState, type RefObject } from "react";
import { Copy, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  fetchAlertRelatedIncidents,
  type AlertHistoryItem,
  type AlertRelatedIncident,
  type OneViewAlert,
} from "@/lib/oneview-api";
import {
  buildAlertClientSharePlainText,
  buildAlertOperationalShareDocument,
  buildAlertRelatedIncidentsFetchParams,
} from "@/lib/oneview-alert-operational-share";
import { captureElementToPng } from "@/lib/oneview-alert-summary-capture";
import {
  AlertSharePreviewDialog,
  type AlertSharePreviewBundle,
} from "@/components/oneview/AlertSharePreviewDialog";

type Props = {
  alert: OneViewAlert;
  historyItems?: AlertHistoryItem[];
  historyReady?: boolean;
  captureTargetRef: RefObject<HTMLElement | null>;
  onPrepareCapture: () => Promise<void> | void;
};

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

async function loadRelatedIncidents(
  alert: OneViewAlert,
  historyItems: AlertHistoryItem[],
): Promise<AlertRelatedIncident[]> {
  const params = buildAlertRelatedIncidentsFetchParams(alert, historyItems);
  if (!params) return [];
  const response = await fetchAlertRelatedIncidents(params);
  return Array.isArray(response.incidents) ? response.incidents : [];
}

export function AlertOperationalShareActions({
  alert,
  historyItems = [],
  historyReady = true,
  captureTargetRef,
  onPrepareCapture,
}: Props) {
  const { toast } = useToast();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [bundle, setBundle] = useState<AlertSharePreviewBundle | null>(null);
  const [busyEntry, setBusyEntry] = useState(false);

  const releasePreviewUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    setBundle((current) => (current?.previewUrl === url ? null : current));
  }, []);

  const disabled = !historyReady || busyEntry || previewLoading;

  async function prepareShareBundle(): Promise<AlertSharePreviewBundle | null> {
    await onPrepareCapture();
    const target = captureTargetRef.current;
    if (!target) throw new Error("capture_target_missing");
    const pngBlob = await captureElementToPng(target);
    let relatedIncidents: AlertRelatedIncident[] = [];
    try {
      relatedIncidents = await loadRelatedIncidents(alert, historyItems);
    } catch {
      relatedIncidents = [];
    }
    const documentShare = buildAlertOperationalShareDocument({
      alert,
      historyItems,
      relatedIncidents,
      generatedAt: new Date(),
    });
    const clientPlainText = buildAlertClientSharePlainText({
      alert,
      relatedIncidents,
    });
    const previewUrl = URL.createObjectURL(pngBlob);
    return {
      pngBlob,
      previewUrl,
      internalPlainText: documentShare.plainText,
      clientPlainText,
    };
  }

  async function openPreview() {
    if (disabled) return;
    setBusyEntry(true);
    setPreviewOpen(true);
    setPreviewLoading(true);
    if (bundle?.previewUrl) {
      releasePreviewUrl(bundle.previewUrl);
      setBundle(null);
    }
    try {
      const next = await prepareShareBundle();
      setBundle(next);
    } catch {
      setPreviewOpen(false);
      toast({
        title: "Não foi possível gerar o preview do resumo.",
        description: "Abra a aba Resumo e tente novamente.",
        variant: "destructive",
      });
    } finally {
      setPreviewLoading(false);
      setBusyEntry(false);
    }
  }

  function handlePreviewOpenChange(open: boolean) {
    setPreviewOpen(open);
    if (!open && bundle?.previewUrl) {
      releasePreviewUrl(bundle.previewUrl);
      setBundle(null);
    }
  }

  const buttons = (
    <div className="flex flex-wrap gap-2" aria-label="Compartilhar resumo operacional">
      <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => void openPreview()}>
        {busyEntry ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Printer className="h-4 w-4" aria-hidden="true" />}
        Print resumo
      </Button>
      <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => void openPreview()}>
        {busyEntry ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        Copiar resumo
      </Button>
      <AlertSharePreviewDialog
        open={previewOpen}
        onOpenChange={handlePreviewOpenChange}
        loading={previewLoading}
        bundle={bundle}
        copyPlainText={copyPlainText}
      />
    </div>
  );

  if (historyReady) return buttons;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{buttons}</span>
        </TooltipTrigger>
        <TooltipContent>Aguarde o histórico</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
