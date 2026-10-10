import { IncidentDetailActions } from "@/components/oneview/IncidentDetailActions";
import type { IncidentTableActionId } from "@/components/oneview/IncidentActions";
import type { AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import type { OneViewIncident } from "@/lib/oneview-api";
import { cn } from "@/lib/utils";

export type IncidentTableActionsIncident = Pick<OneViewIncident, "sys_id" | "number"> &
  Partial<
    Pick<
      OneViewIncident,
      | "state"
      | "zabbix_event_id"
      | "assignment_group"
      | "assignment_group_display"
      | "assigned_to"
      | "assigned_to_display"
      | "identity_conflict"
    >
  >;

type Props = {
  incident: IncidentTableActionsIncident;
  /** Listas nunca resolvem correlação. O drawer é o único carregamento sob demanda. */
  alertArtifact?: AlertArtifactModel | null;
  visibleActions?: readonly IncidentTableActionId[];
  className?: string;
  onActionComplete?: () => void;
  mutationsBlocked?: boolean;
};

/** Ações SN inline em linhas de tabela — impede abrir drawer/linha ao interagir. */
export function IncidentTableActionsCell({
  incident,
  alertArtifact,
  visibleActions,
  className,
  onActionComplete,
  mutationsBlocked = false,
}: Props) {
  const hasIncident = Boolean(incident.sys_id && incident.number);
  const resolvedArtifact = alertArtifact ?? null;

  if (!hasIncident) {
    return <span className="text-[10px] text-muted-foreground">—</span>;
  }

  if (incident.identity_conflict) {
    return <span className="text-[10px] text-destructive">Inconsistência de identidade</span>;
  }

  return (
    <div
      className={cn("flex justify-end", className)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      <IncidentDetailActions
        incident={incident}
        alertArtifact={resolvedArtifact}
        placement="table-cell"
        visibleActions={visibleActions}
        mutationsBlocked={mutationsBlocked}
        onClaimed={onActionComplete}
        onWorkNoteAdded={onActionComplete}
        onAttachmentAdded={onActionComplete}
        onPutOnHold={onActionComplete}
      />
    </div>
  );
}
