import { useEffect, useState } from "react";
import { Check, Loader2, UserRoundCheck } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  OneViewApiError,
  fetchServiceNowOperatorIdentity,
  requestServiceNowIncidentClaim,
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
};

function identityUnavailableMessage(identity: ServiceNowOperatorIdentity | null, error: string | null) {
  if (identity && !identity.noc_member) {
    return "Seu usuário não pertence ao grupo N1 - Serviços - NOC no ServiceNow.";
  }
  return error || "Ação indisponível temporariamente.";
}

export function IncidentActions({ incident, onClaimed }: Props) {
  const [identity, setIdentity] = useState<ServiceNowOperatorIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assignedToSelf, setAssignedToSelf] = useState(false);
  const [confirmation, setConfirmation] = useState<{ currentAssignee: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setIdentity(null);
    setIdentityError(null);
    setAssignedToSelf(false);
    setConfirmation(null);
    setActionError(null);
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

  const canClaim = Boolean(identity?.available && identity.noc_member && incident.sys_id && !assignedToSelf);
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
      {canClaim || assignedToSelf ? button : (
        <Tooltip>
          <TooltipTrigger asChild><span className="inline-flex">{button}</span></TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      )}
      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
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
