import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
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
  fetchClientShareDestinations,
  fetchClientSharePreview,
  sendClientShare,
  type ClientShareDestination,
  type ClientShareMessage,
  type ClientSharePreview,
  type ClientShareResolution,
} from "@/lib/oneview-api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: ClientShareMessage;
};

function idempotencyKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `client-share:${uuid || `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}

function channelLabel(channel: ClientShareDestination["channel_type"]) {
  return channel === "webex" ? "Webex" : "Teams";
}

function destinationLabel(item: ClientShareDestination) {
  const route = item.route_label && item.route_label !== item.destination_name ? ` · ${item.route_label}` : "";
  const fallback = item.is_default ? " · Padrão" : "";
  return `${item.destination_name}${route} · ${channelLabel(item.channel_type)}${fallback}`;
}

function selectionHint(reason: ClientShareResolution["reason"] | undefined) {
  if (reason === "unknown_route") return "A rota do alerta não corresponde a um grupo. Selecione o destino.";
  if (reason === "ambiguous_route") return "Há mais de um destino para esta rota. Selecione o grupo.";
  if (reason === "multiple_destinations") return "Este cliente possui vários grupos. Selecione o destino.";
  return "";
}

export function ClientShareDialog({ open, onOpenChange, message }: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [destinations, setDestinations] = useState<ClientShareDestination[]>([]);
  const [resolution, setResolution] = useState<ClientShareResolution | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<ClientSharePreview | null>(null);
  const keyRef = useRef(idempotencyKey());
  const selected = destinations.find((item) => item.destination_id === selectedId) || null;
  const hasDestination = destinations.length > 0;
  const needsChoice = destinations.length > 1;
  const externalEnabled = Boolean(preview?.external_enabled);
  const body = useMemo(() => preview?.preview.text || "Gerando preview…", [preview]);
  const hint = selectionHint(resolution?.reason);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    keyRef.current = idempotencyKey();
    setLoading(true);
    setDestinations([]);
    setResolution(null);
    setSelectedId("");
    setPreview(null);
    void Promise.all([
      fetchClientShareDestinations(message.client_key, message.route_key, controller.signal),
      fetchClientSharePreview(message, controller.signal),
    ]).then(([list, nextPreview]) => {
      if (controller.signal.aborted) return;
      setDestinations(list.destinations);
      setResolution(list.resolution);
      setSelectedId(list.resolution.selected_destination_id || "");
      setPreview(nextPreview);
    }).catch(() => {
      if (!controller.signal.aborted) toast({ title: "Não foi possível preparar o envio ao cliente.", variant: "destructive" });
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [message, open, toast]);

  async function send() {
    if (sending || !externalEnabled || !selected) return;
    setSending(true);
    try {
      const result = await sendClientShare(message, keyRef.current, selected.destination_id);
      toast({ title: result.duplicate ? "Solicitação já registrada" : "Dry-run registrado", description: "Nenhuma mensagem externa foi enviada." });
      onOpenChange(false);
    } catch {
      toast({ title: "Não foi possível registrar o dry-run.", variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Enviar para o cliente</DialogTitle>
          <DialogDescription>Revise o destino e a mensagem antes de confirmar.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="font-medium">{message.client_name}</p>
            <p className="text-muted-foreground">{message.host} · {message.severity}</p>
          </div>
          {selected && !needsChoice ? (
            <div className="rounded-md border p-3" aria-label="Destino selecionado">
              Destino: <strong>{destinationLabel(selected)}</strong>
            </div>
          ) : null}
          {needsChoice ? (
            <label className="block space-y-1" htmlFor="client-share-destination">
              <span className="font-medium">Destino</span>
              <select
                id="client-share-destination"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedId}
                aria-required={resolution?.requires_selection ? "true" : undefined}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                <option value="">Selecione o destino</option>
                {destinations.map((item) => (
                  <option key={item.destination_id} value={item.destination_id}>{destinationLabel(item)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {hint ? <p className="text-muted-foreground">{hint}</p> : null}
          {!loading && !hasDestination ? <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">Cliente sem canal de comunicação configurado.</p> : null}
          <div>
            <p className="mb-1 font-medium">Preview</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-sans text-xs">{body}</pre>
          </div>
          <p className="text-xs text-muted-foreground">Envio externo permanece em dry-run até habilitação explícita da feature.</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="button" disabled={loading || sending || !selected || !externalEnabled} onClick={() => void send()}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
