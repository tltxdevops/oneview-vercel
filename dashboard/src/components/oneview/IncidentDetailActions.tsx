import { IncidentActions } from "@/components/oneview/IncidentActions";
import type { AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import type {
  ServiceNowIncidentClaimResponse,
  ServiceNowPutOnHoldResponse,
} from "@/lib/oneview-api";
import { cn } from "@/lib/utils";

type IncidentRef = {
  sys_id: string | null;
  number: string | null;
  state?: string | null;
  identity_conflict?: boolean;
};

type Props = {
  incident: IncidentRef;
  alertArtifact?: AlertArtifactModel | null;
  placement?: "inline" | "drawer-footer" | "table-cell";
  className?: string;
  onClaimed?: (result: ServiceNowIncidentClaimResponse) => void;
  onWorkNoteAdded?: () => void;
  onAttachmentAdded?: () => void;
  onPutOnHold?: (result: ServiceNowPutOnHoldResponse) => void;
};

export function IncidentDetailActions({
  incident,
  alertArtifact = null,
  placement = "drawer-footer",
  className,
  onClaimed,
  onWorkNoteAdded,
  onAttachmentAdded,
  onPutOnHold,
}: Props) {
  if (!incident.sys_id || !incident.number) return null;

  if (placement === "table-cell") {
    return (
      <IncidentActions
        incident={incident}
        alertArtifact={alertArtifact}
        placement={placement}
        onClaimed={onClaimed}
        onWorkNoteAdded={onWorkNoteAdded}
        onAttachmentAdded={onAttachmentAdded}
        onPutOnHold={onPutOnHold}
      />
    );
  }

  return (
    <section
      aria-label="Ações do chamado"
      className={cn(
        placement === "drawer-footer" ? "space-y-3" : "space-y-2",
        className,
      )}
    >
      {placement === "drawer-footer" ? (
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Ações</h3>
      ) : null}
      <IncidentActions
        incident={incident}
        alertArtifact={alertArtifact}
        placement={placement}
        onClaimed={onClaimed}
        onWorkNoteAdded={onWorkNoteAdded}
        onAttachmentAdded={onAttachmentAdded}
        onPutOnHold={onPutOnHold}
      />
    </section>
  );
}
