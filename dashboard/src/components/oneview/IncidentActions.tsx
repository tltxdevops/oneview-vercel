import { useEffect, useState } from "react";
import { Check, Loader2, MessageSquarePlus, UserRoundCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  OneViewApiError,
  fetchServiceNowOperatorIdentity,
  requestServiceNowIncidentClaim,
  requestServiceNowIncidentWorkNote,
  type ServiceNowIncidentClaimResponse,
  type ServiceNowOperatorIdentity,
} from "@/lib/oneview-api";

type ClaimableIncident = {
  sys_id: string | null;
  number: string | null;
};

type Props = {
  incident: ClaimableIncident;
  onClaimed?: (result: ServiceNowIncidentClaimResponse) => void;
  onWorkNoteAdded?: () => void;
};

function identityUnavailableMessage(identity: ServiceNowOperatorIdentity | null, error: string | null) {
  if (identity && !identity.noc_member) {
    return "Seu usuário não pertence ao grupo N1 - Serviços - NOC no ServiceNow.";
  }
  return error || "Ação indisponível temporariamente.";
}

export function IncidentActions({ incident, onClaimed, onWorkNoteAdded }: Props) {
  const { toast } = useToast();
  const [identity, setIdentity] = useState<ServiceNowOperatorIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assignedToSelf, setAssignedToSelf] = useState(false);
  const [confirmation, setConfirmation] = useState<{ currentAssignee: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workNoteOpen, setWorkNoteOpen] = useState(false);
  const [workNote, setWorkNote] = useState("");
  const [workNoteError, setWorkNoteError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setIdentity(null);
    setIdentityError(null);
    setAssignedToSelf(false);
    setConfirmation(null);
    setActionError(null);
    setWorkNoteOpen(false);
    setWorkNote("");
    setWorkNoteError(null);
    void fetchServiceNowOperatorIdentity(controller.signal)
      .then(setIdentity)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setIdentityError(error instanceof Error ? error.message : "Ação indisponível temporariamente.");
        }
      });
    return () => controller.abort();
  }, [incident.sys_id]);

  async function claim(confirmReassign = false) {
    if (!incident.sys_id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const result = await requestServiceNowIncidentClaim({ sysId: incident.sys_id, confirmReassign });
      setAssignedToSelf(true);
      setConfirmation(null);
      onClaimed?.(result);
    } catch (error) {
      if (error instanceof OneViewApiError && error.code === "INCIDENT_ASSIGNED_TO_OTHER" && !confirmReassign) {
        const currentAssignee = typeof error.details?.current_assignee_name === "string"
          ? error.details.current_assignee_name
          : "outro analista";
        setConfirmation({ currentAssignee });
      } else {
        setActionError(error instanceof Error ? error.message : "Ação indisponível temporariamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function addWorkNote() {
    const value = workNote.trim();
    if (!incident.sys_id || submitting) return;
    if (!value || value.length > 2_000) {
      setWorkNoteError("A anotação deve possuir entre 1 e 2000 caracteres.");
      return;
    }
    setSubmitting(true);
    setWorkNoteError(null);
    setActionError(null);
    try {
      await requestServiceNowIncidentWorkNote({ sysId: incident.sys_id, workNote: value });
      setWorkNote("");
      setWorkNoteOpen(false);
      toast({
        title: "Anotação adicionada",
        description: `${incident.number || "Chamado"} atualizado no ServiceNow.`,
      });
      onWorkNoteAdded?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível adicionar a anotação.";
      setWorkNoteError(message);
      if (error instanceof OneViewApiError && error.code === "WORK_NOTE_RESULT_UNCERTAIN") {
        setActionError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canClaim = Boolean(identity?.available && identity.noc_member && incident.sys_id && !assignedToSelf);
  const canAddWorkNote = Boolean(identity?.available && incident.sys_id);
  const disabledReason = identityUnavailableMessage(identity, identityError);
  const button = assignedToSelf ? (
    <Button type="button" size="sm" variant="secondary" disabled aria-label="Atribuído a você">
      <Check className="h-4 w-4" aria-hidden="true" />
      Atribuído a você
    </Button>
  ) : (
    <Button type="button" size="sm" variant="secondary" disabled={!canClaim || submitting} onClick={() => void claim(false)}>
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserRoundCheck className="h-4 w-4" aria-hidden="true" />}
      Assumir chamado
    </Button>
  );

  if (!incident.sys_id || !incident.number) return null;
  if (!identity && !identityError) return <Skeleton className="mt-3 h-8 w-40" />;

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3" aria-label="Ações do chamado">
      <div className="flex flex-wrap gap-2">
        {canClaim || assignedToSelf ? button : (
          <Tooltip>
            <TooltipTrigger asChild><span className="inline-flex">{button}</span></TooltipTrigger>
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        )}
        {canAddWorkNote ? (
          <Button type="button" size="sm" variant="secondary" disabled={submitting} onClick={() => setWorkNoteOpen(true)}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            Adicionar anotação
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button type="button" size="sm" variant="secondary" disabled>
                  <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                  Adicionar anotação
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{disabledReason}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
      <Dialog open={workNoteOpen} onOpenChange={(open) => { if (!submitting) { setWorkNoteOpen(open); if (!open) setWorkNoteError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar anotação</DialogTitle>
            <DialogDescription>{incident.number}</DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            aria-label="Texto da anotação"
            maxLength={2_000}
            rows={6}
            value={workNote}
            disabled={submitting}
            onChange={(event) => { setWorkNote(event.target.value); setWorkNoteError(null); }}
            placeholder="Descreva a atualização operacional"
          />
          <div className="flex items-start justify-between gap-3 text-xs">
            {workNoteError ? <p role="alert" className="text-destructive">{workNoteError}</p> : <span />}
            <span className="shrink-0 text-muted-foreground">{workNote.length}/2000</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => setWorkNoteOpen(false)}>Cancelar</Button>
            <Button type="button" disabled={submitting || !workNote.trim()} onClick={() => void addWorkNote()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Adicionar anotação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !submitting) setConfirmation(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Assumir chamado?</AlertDialogTitle>
            <AlertDialogDescription>
              Este chamado está atribuído a {confirmation?.currentAssignee || "outro analista"}. Ao continuar, o responsável será alterado para você.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={(event) => { event.preventDefault(); void claim(true); }}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Assumir chamado
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
