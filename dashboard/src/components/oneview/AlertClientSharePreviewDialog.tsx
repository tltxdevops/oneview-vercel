import { useRef, useState } from "react";
import { ImageIcon, Loader2, Send } from "lucide-react";
import {
  AlertClientCommunicationCard,
  AlertClientCommunicationEditor,
} from "@/components/oneview/AlertClientCommunicationCard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  isAlertClientCommunicationValid,
  type AlertClientCommunication,
  type AlertClientCommunicationEdits,
} from "@/lib/oneview-alert-operational-share";
import { captureElementToPng, copyPngBlob } from "@/lib/oneview-alert-summary-capture";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  communication: AlertClientCommunication;
  onCommunicationChange: (edits: AlertClientCommunicationEdits) => void;
  onSendToClient: () => void;
};

export function AlertClientSharePreviewDialog({
  open,
  onOpenChange,
  communication,
  onCommunicationChange,
  onSendToClient,
}: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const valid = isAlertClientCommunicationValid(communication);

  async function runCopyImage() {
    if (busy || !valid) return;
    const target = cardRef.current;
    if (!target) return;
    setBusy(true);
    try {
      const ok = await copyPngBlob(await captureElementToPng(target));
      if (!ok) throw new Error("copy_image_failed");
      toast({ title: "Imagem copiada", description: "Cole no Teams, Webex ou e-mail." });
    } catch {
      toast({ title: "Não foi possível copiar a imagem.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const actionsDisabled = busy || !valid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[100] flex max-h-[90vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-1 border-b border-border px-6 py-4 text-left">
          <DialogTitle>Prévia da comunicação ao cliente</DialogTitle>
          <DialogDescription>A imagem usa exatamente as informações abaixo.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <AlertClientCommunicationCard ref={cardRef} communication={communication} />
          <details className="mt-4 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium">Ajustar mensagem antes de compartilhar</summary>
            <AlertClientCommunicationEditor
              communication={communication}
              onChange={onCommunicationChange}
              className="mt-3"
            />
          </details>
          {!valid ? <p className="mt-3 text-sm text-destructive">Preencha Ação, Próximos passos e Acompanhamento.</p> : null}
        </div>
        <DialogFooter className="flex-col gap-2 border-t border-border px-4 py-4 sm:flex-row sm:flex-wrap sm:justify-end sm:px-6">
          <Button type="button" variant="outline" disabled={actionsDisabled} onClick={() => void runCopyImage()}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImageIcon className="mr-2 h-4 w-4" />}
            Copiar imagem
          </Button>
          <Button type="button" disabled={actionsDisabled} onClick={onSendToClient}>
            <Send className="mr-2 h-4 w-4" />
            Enviar ao cliente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
