import { useMemo } from "react";
import { useIncidentRelatedAlert } from "@/components/oneview/IncidentRelatedAlertSection";
import { IncidentDetailActions } from "@/components/oneview/IncidentDetailActions";
import {
  buildAlertArtifactFromIncidentRelatedAlert,
  type AlertArtifactModel,
} from "@/lib/oneview-alert-artifact";
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
    >
  >;

type Props = {
  incident: IncidentTableActionsIncident;
  /** Omitir = busca alerta relacionado (como no drawer). `null` = sem anexo de alerta. */
  alertArtifact?: AlertArtifactModel | null;
  className?: string;
  onActionComplete?: () => void;
};

/** Ações SN inline em linhas de tabela — impede abrir drawer/linha ao interagir. */
export function IncidentTableActionsCell({
  incident,
  alertArtifact,
  className,
  onActionComplete,
}: Props) {
  const hasIncident = Boolean(incident.sys_id && incident.number);
  const autoResolveArtifact = alertArtifact === undefined;
  const { relatedAlert } = useIncidentRelatedAlert(
    hasIncident && autoResolveArtifact ? (incident as OneViewIncident) : null,
  );
  const resolvedArtifact = useMemo(() => {
    if (!hasIncident) return null;
    if (alertArtifact !== undefined) return alertArtifact;
    if (!relatedAlert) return null;
    return buildAlertArtifactFromIncidentRelatedAlert(relatedAlert, incident);
  }, [alertArtifact, hasIncident, incident, relatedAlert]);

  if (!hasIncident) {
    return <span className="text-[10px] text-muted-foreground">—</span>;
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
        onClaimed={onActionComplete}
        onWorkNoteAdded={onActionComplete}
        onAttachmentAdded={onActionComplete}
        onPutOnHold={onActionComplete}
      />
    </div>
  );
}
