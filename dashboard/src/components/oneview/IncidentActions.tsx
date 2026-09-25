import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Clock3, Loader2, MessageSquarePlus, Paperclip, UserRoundCheck } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { AlertArtifactCard } from "@/components/oneview/AlertArtifactCard";
import {
  OneViewApiError,
  fetchServiceNowOperatorIdentity,
  fetchServiceNowPutOnHoldOptions,
  requestServiceNowIncidentAlertAttachment,
  requestServiceNowIncidentClaim,
  requestServiceNowIncidentPutOnHold,
  requestServiceNowIncidentWorkNote,
  type ServiceNowIncidentClaimResponse,
  type ServiceNowOperatorIdentity,
  type ServiceNowPutOnHoldResponse,
} from "@/lib/oneview-api";
import { defaultAlertAttachmentFileName, type AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import { captureElementToPng } from "@/lib/oneview-alert-summary-capture";
import { cn } from "@/lib/utils";

type ClaimableIncident = {
  sys_id: string | null;
  number: string | null;
  state?: string | null;
  identity_conflict?: boolean;
};

type Props = {
  incident: ClaimableIncident;
  alertArtifact?: AlertArtifactModel | null;
  placement?: "inline" | "drawer-footer" | "table-cell";
  onClaimed?: (result: ServiceNowIncidentClaimResponse) => void;
  onWorkNoteAdded?: () => void;
  onAttachmentAdded?: () => void;
  onPutOnHold?: (result: ServiceNowPutOnHoldResponse) => void;
};

const PUT_ON_HOLD_ALLOWED_STATES = new Set(["1", "2"]);

function identityUnavailableMessage(identity: ServiceNowOperatorIdentity | null, error: string | null) {
  if (identity && !identity.noc_member) {
    return "Seu usuário não pertence ao grupo N1 - Serviços - NOC no ServiceNow.";
  }
  return error || "Ação indisponível temporariamente.";
}

export function IncidentActions({
  incident,
  alertArtifact = null,
  placement = "inline",
  onClaimed,
  onWorkNoteAdded,
  onAttachmentAdded,
  onPutOnHold,
}: Props) {
  const { toast } = useToast();
  const artifactCaptureRef = useRef<HTMLDivElement>(null);
  const [identity, setIdentity] = useState<ServiceNowOperatorIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [assignedToSelf, setAssignedToSelf] = useState(false);
  const [confirmation, setConfirmation] = useState<{ currentAssignee: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workNoteOpen, setWorkNoteOpen] = useState(false);
  const [workNote, setWorkNote] = useState("");
  const [workNoteError, setWorkNoteError] = useState<string | null>(null);
  const [holdVendors, setHoldVendors] = useState<string[]>([]);
  const [holdReasonLabel, setHoldReasonLabel] = useState("Aguardando fornecedor");
  const [holdVendor, setHoldVendor] = useState("");
  const [holdSetupOpen, setHoldSetupOpen] = useState(false);
  const [holdConfirmOpen, setHoldConfirmOpen] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [holdOptionsError, setHoldOptionsError] = useState<string | null>(null);

  useEffect(() => {
    if (incident.identity_conflict) {
      setIdentity(null);
      setIdentityError(null);
      return undefined;
    }
    const controller = new AbortController();
    setIdentity(null);
    setIdentityError(null);
    setAssignedToSelf(false);
    setConfirmation(null);
    setActionError(null);
    setWorkNoteOpen(false);
    setWorkNote("");
    setWorkNoteError(null);
    setHoldSetupOpen(false);
    setHoldConfirmOpen(false);
    setHoldError(null);
    setHoldVendors([]);
    setHoldVendor("");
    setHoldOptionsError(null);
    void fetchServiceNowOperatorIdentity(controller.signal)
      .then(setIdentity)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setIdentityError(error instanceof Error ? error.message : "Ação indisponível temporariamente.");
        }
      });
    void fetchServiceNowPutOnHoldOptions(controller.signal)
      .then((options) => {
        if (controller.signal.aborted) return;
        const vendors = options.external_vendors
          .map((vendor) => vendor.trim())
          .filter(Boolean);
        setHoldVendors(vendors);
        setHoldReasonLabel(options.hold_reason_label || "Aguardando fornecedor");
        setHoldVendor(vendors[0] || "");
        setHoldOptionsError(vendors.length ? null : "Nenhum fornecedor homologado foi retornado pelo ServiceNow.");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHoldVendors([]);
          setHoldVendor("");
          setHoldOptionsError("Não foi possível carregar os fornecedores do ServiceNow. Tente novamente mais tarde.");
        }
      });
    return () => controller.abort();
  }, [incident.identity_conflict, incident.sys_id]);

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

  async function attachAlertDetails() {
    if (!incident.sys_id || !alertArtifact || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const target = artifactCaptureRef.current;
      if (!target) throw new Error("capture_failed");
      const png = await captureElementToPng(target);
      const fileName = defaultAlertAttachmentFileName(incident.number);
      await requestServiceNowIncidentAlertAttachment({
        sysId: incident.sys_id,
        fileName,
        pngBody: png,
      });
      toast({
        title: `Detalhes do alerta anexados ao ${incident.number || "chamado"}.`,
        description: "O PNG operacional foi enviado ao ServiceNow.",
      });
      try {
        await requestServiceNowIncidentWorkNote({
          sysId: incident.sys_id,
          workNote: "Detalhes do alerta anexados pelo OneView.",
        });
        onWorkNoteAdded?.();
      } catch {
        // Anexo confirmado; anotação complementar é opcional.
      }
      onAttachmentAdded?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível anexar os detalhes do alerta.";
      setActionError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function openHoldSetup() {
    if (holdOptionsError || !holdVendors.length) return;
    setHoldError(null);
    if (!holdVendor && holdVendors[0]) setHoldVendor(holdVendors[0]);
    setHoldSetupOpen(true);
  }

  function proceedHoldConfirmation() {
    if (holdOptionsError || !holdVendor || !holdVendors.includes(holdVendor)) {
      setHoldError("Selecione um fornecedor homologado.");
      return;
    }
    setHoldError(null);
    setHoldSetupOpen(false);
    setHoldConfirmOpen(true);
  }

  async function putOnHold() {
    const state = String(incident.state || "").trim();
    if (!incident.sys_id || !PUT_ON_HOLD_ALLOWED_STATES.has(state) || holdOptionsError || !holdVendor || !holdVendors.includes(holdVendor) || submitting) return;
    setSubmitting(true);
    setHoldError(null);
    setActionError(null);
    try {
      const result = await requestServiceNowIncidentPutOnHold({
        sysId: incident.sys_id,
        externalVendor: holdVendor,
      });
      setHoldConfirmOpen(false);
      toast({
        title: "Chamado colocado em espera.",
        description: incident.number || undefined,
      });
      onPutOnHold?.(result);
      onWorkNoteAdded?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível colocar o chamado em espera.";
      setHoldError(message);
      if (error instanceof OneViewApiError && error.code === "PUT_ON_HOLD_RESULT_UNCERTAIN") {
        setActionError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const canClaim = Boolean(identity?.available && identity.noc_member && incident.sys_id && !assignedToSelf);
  const canAddWorkNote = Boolean(identity?.available && incident.sys_id);
  const canAttachAlert = Boolean(identity?.available && incident.sys_id && alertArtifact);
  const incidentState = String(incident.state || "").trim();
  const holdStateAllowed = PUT_ON_HOLD_ALLOWED_STATES.has(incidentState);
  const onHoldAlready = incidentState === "3";
  const canPutOnHold = Boolean(identity?.available && incident.sys_id && holdStateAllowed && !holdOptionsError && holdVendors.length > 0);
  const disabledReason = identityUnavailableMessage(identity, identityError);
  const attachDisabledReason = !alertArtifact
    ? "Não há alerta relacionado a este chamado."
    : disabledReason;
  const holdDisabledReason = onHoldAlready
      ? "Chamado já está em espera."
      : !holdStateAllowed
        ? "Somente chamados novos ou em andamento podem ser colocados em espera."
        : holdOptionsError
          ? holdOptionsError
          : !holdVendors.length
        ? "Nenhum fornecedor homologado disponível."
        : disabledReason;
  const moreActionsDisabled = submitting || (!identity && !identityError);
  const holdMenuDisabled = !canPutOnHold || submitting;

  if (!incident.sys_id || !incident.number) return null;
  if (incident.identity_conflict) {
    return (
      <p className="text-xs text-destructive">
        Inconsistência de identidade ServiceNow. Ações temporariamente indisponíveis.
      </p>
    );
  }
  if (!identity && !identityError) {
    return (
      <Skeleton
        className={
          placement === "table-cell"
            ? "h-7 w-16"
            : placement === "drawer-footer"
              ? "h-8 w-40"
              : "mt-3 h-8 w-40"
        }
      />
    );
  }

  const isTableCell = placement === "table-cell";

  const rootClassName = placement === "drawer-footer"
    ? "space-y-2"
    : isTableCell
      ? undefined
      : "mt-3 space-y-2 border-t border-border/60 pt-3";

  const buttonClass = isTableCell ? "h-7 w-7 shrink-0 p-0" : undefined;
  const buttonVariant = isTableCell ? "ghost" : "secondary";

  const moreActionsTrigger = isTableCell ? (
    <Button
      type="button"
      size="icon"
      variant={buttonVariant}
      className={buttonClass}
      disabled={moreActionsDisabled}
      aria-label="Mais ações"
    >
      <ChevronDown className="h-4 w-4" aria-hidden="true" />
    </Button>
  ) : (
    <Button type="button" size="sm" variant={buttonVariant} className={buttonClass} disabled={moreActionsDisabled}>
      Mais ações
      <ChevronDown className="h-4 w-4" aria-hidden="true" />
    </Button>
  );

  const moreActionsMenu = (
    <DropdownMenu>
      {isTableCell ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{moreActionsTrigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{moreActionsDisabled ? disabledReason : "Mais ações"}</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{moreActionsTrigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          disabled={!canAttachAlert || submitting}
          title={!canAttachAlert ? attachDisabledReason : undefined}
          onSelect={(event) => {
            event.preventDefault();
            if (!canAttachAlert || submitting) return;
            void attachAlertDetails();
          }}
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          Anexar detalhes do alerta
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={holdMenuDisabled}
          title={holdMenuDisabled ? holdDisabledReason : undefined}
          onSelect={(event) => {
            event.preventDefault();
            if (holdMenuDisabled) return;
            openHoldSetup();
          }}
        >
          <Clock3 className="h-4 w-4" aria-hidden="true" />
          Colocar em espera
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const claimButton = assignedToSelf ? (
    <Button
      type="button"
      size={isTableCell ? "icon" : "sm"}
      variant={buttonVariant}
      className={buttonClass}
      disabled
      aria-label="Atribuído a você"
    >
      <Check className="h-4 w-4" aria-hidden="true" />
      {isTableCell ? null : "Atribuído a você"}
    </Button>
  ) : (
    <Button
      type="button"
      size={isTableCell ? "icon" : "sm"}
      variant={buttonVariant}
      className={buttonClass}
      disabled={!canClaim || submitting}
      aria-label="Assumir chamado"
      onClick={() => void claim(false)}
    >
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserRoundCheck className="h-4 w-4" aria-hidden="true" />}
      {isTableCell ? null : "Assumir chamado"}
    </Button>
  );

  const workNoteButton = (
    <Button
      type="button"
      size={isTableCell ? "icon" : "sm"}
      variant={buttonVariant}
      className={buttonClass}
      disabled={!canAddWorkNote || submitting}
      aria-label="Adicionar anotação"
      onClick={() => setWorkNoteOpen(true)}
    >
      <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
      {isTableCell ? null : "Adicionar anotação"}
    </Button>
  );

  function withTooltip(node: ReactNode, label: string, showDisabledReason: boolean) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{node}</span>
        </TooltipTrigger>
        <TooltipContent>{showDisabledReason ? disabledReason : label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className={rootClassName} aria-label="Ações do chamado">
      {alertArtifact ? (
        <div aria-hidden className="pointer-events-none fixed left-[-10000px] top-0 z-[-1] opacity-0">
          <AlertArtifactCard ref={artifactCaptureRef} model={alertArtifact} />
        </div>
      ) : null}
      <div className={cn(
        "flex gap-1.5",
        isTableCell ? "flex-nowrap items-center justify-end gap-0.5" : "flex-wrap",
      )}
      >
        {isTableCell ? (
          withTooltip(
            claimButton,
            assignedToSelf ? "Atribuído a você" : "Assumir chamado",
            !canClaim && !assignedToSelf,
          )
        ) : canClaim || assignedToSelf ? (
          claimButton
        ) : (
          withTooltip(claimButton, "Assumir chamado", true)
        )}
        {isTableCell ? (
          withTooltip(workNoteButton, "Adicionar anotação", !canAddWorkNote)
        ) : canAddWorkNote ? (
          workNoteButton
        ) : (
          withTooltip(
            <Button type="button" size="sm" variant="secondary" disabled aria-label="Adicionar anotação">
              <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
              Adicionar anotação
            </Button>,
            "Adicionar anotação",
            true,
          )
        )}
        {moreActionsMenu}
      </div>
      {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
      {holdOptionsError ? <p role="alert" className="text-xs text-destructive">{holdOptionsError}</p> : null}
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
      <Dialog open={holdSetupOpen} onOpenChange={(open) => { if (!submitting) { setHoldSetupOpen(open); if (!open) setHoldError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Colocar em espera</DialogTitle>
            <DialogDescription>{incident.number}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Fornecedor homologado</p>
            <Select value={holdVendor} onValueChange={(value) => { setHoldVendor(value); setHoldError(null); }} disabled={submitting || !holdVendors.length}>
              <SelectTrigger aria-label="Fornecedor"><SelectValue placeholder="Selecione o fornecedor" /></SelectTrigger>
              <SelectContent>
                {holdVendors.map((vendor) => (
                  <SelectItem key={vendor} value={vendor}>{vendor}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {holdError ? <p role="alert" className="text-xs text-destructive">{holdError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => setHoldSetupOpen(false)}>Cancelar</Button>
            <Button type="button" disabled={submitting || Boolean(holdOptionsError) || !holdVendor || !holdVendors.includes(holdVendor)} onClick={proceedHoldConfirmation}>Continuar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={holdConfirmOpen} onOpenChange={(open) => { if (!open && !submitting) { setHoldConfirmOpen(false); setHoldError(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Colocar {incident.number} em espera?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p><span className="font-medium text-foreground">Fornecedor:</span> {holdVendor}</p>
                <p><span className="font-medium text-foreground">Motivo:</span> {holdReasonLabel}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {holdError ? <p role="alert" className="text-xs text-destructive">{holdError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={submitting || !holdStateAllowed || Boolean(holdOptionsError) || !holdVendor || !holdVendors.includes(holdVendor)} onClick={(event) => { event.preventDefault(); void putOnHold(); }}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Colocar em espera
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
