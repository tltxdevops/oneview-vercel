import { useState } from "react";
import { Copy, Loader2, Printer, Send, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { copyPngBlob, printPngBlob } from "@/lib/oneview-alert-summary-capture";

export type AlertSharePreviewBundle = {
  pngBlob: Blob;
  previewUrl: string;
  internalPlainText: string;
  clientPlainText: string;
};

type DialogBusy = "copyImage" | "copyInternal" | "copyClient" | "print" | null;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  bundle: AlertSharePreviewBundle | null;
  copyPlainText: (value: string) => Promise<boolean>;
};

export function AlertSharePreviewDialog({
  open,
  onOpenChange,
  loading,
  bundle,
  copyPlainText,
}: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<DialogBusy>(null);

  async function runCopyImage() {
    if (!bundle || busy) return;
    setBusy("copyImage");
    try {
      const ok = await copyPngBlob(bundle.pngBlob);
      if (!ok) throw new Error("copy_image_failed");
      toast({ title: "Imagem copiada", description: "Cole no Teams, Webex ou e-mail." });
    } catch {
      toast({
        title: "Não foi possível copiar a imagem.",
        description: "Use Imprimir ou salve a captura manualmente.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function runCopyInternal() {
    if (!bundle || busy) return;
    setBusy("copyInternal");
    try {
      const copied = await copyPlainText(bundle.internalPlainText);
      if (!copied) throw new Error("copy_failed");
      toast({
        title: "Resumo copiado",
        description: "Texto operacional pronto para colar no Teams ou Webex.",
      });
    } catch {
      toast({
        title: "Não foi possível copiar o resumo.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function runCopyClient() {
    if (!bundle || busy) return;
    setBusy("copyClient");
    try {
      const copied = await copyPlainText(bundle.clientPlainText);
      if (!copied) throw new Error("copy_failed");
      toast({
        title: "Texto para o cliente copiado",
        description: "Revise antes de enviar ao cliente.",
      });
    } catch {
      toast({
        title: "Não foi possível copiar o texto para o cliente.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function runPrint() {
    if (!bundle || busy) return;
    setBusy("print");
    try {
      const printed = printPngBlob(bundle.pngBlob);
      if (!printed) throw new Error("print_failed");
    } catch {
      toast({
        title: "Não foi possível imprimir.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  const actionsDisabled = loading || !bundle || Boolean(busy);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[100] flex max-h-[90vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-1 border-b border-border px-6 py-4 text-left">
          <DialogTitle>Este print está ok?</DialogTitle>
          <DialogDescription>
            Revise a captura antes de compartilhar com o cliente ou a equipe.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-[280px] w-full rounded-md" />
              <p className="text-center text-sm text-muted-foreground">Gerando preview…</p>
            </div>
          ) : bundle ? (
            <img
              src={bundle.previewUrl}
              alt="Preview do resumo operacional"
              className="mx-auto max-h-[min(60vh,32rem)] w-full rounded-md border border-border object-contain bg-muted/30"
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Não foi possível gerar o preview. Feche e tente novamente.
            </p>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 border-t border-border px-6 py-4 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="outline" disabled={actionsDisabled} onClick={() => void runCopyImage()}>
            {busy === "copyImage" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImageIcon className="mr-2 h-4 w-4" />}
            Copiar imagem
          </Button>
          <Button type="button" variant="secondary" disabled={actionsDisabled} onClick={() => void runCopyInternal()}>
            {busy === "copyInternal" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Copy className="mr-2 h-4 w-4" />}
            Copiar resumo
          </Button>
          <Button type="button" variant="secondary" disabled={actionsDisabled} onClick={() => void runCopyClient()}>
            {busy === "copyClient" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Copiar texto do cliente
          </Button>
          <Button type="button" disabled={actionsDisabled} onClick={() => void runPrint()}>
            {busy === "print" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}
            Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
