import { OneViewSemanticStatusBadge } from "@/components/oneview/OneViewDesignSystem";
import { ONEVIEW_INCIDENT_STATE_STATUS } from "@/lib/oneview-design-system";
import { oneViewIncidentStatusVisual } from "@/lib/oneview-incident-status-visual";
import { cn } from "@/lib/utils";

export function OneViewIncidentStatusBadge({ state, display, className }: { state: string | number | null | undefined; display?: string | null; className?: string }) {
  const visual = oneViewIncidentStatusVisual(state, display);
  const semanticStatus = ONEVIEW_INCIDENT_STATE_STATUS[String(state ?? "").trim()];
  if (semanticStatus) {
    return <OneViewSemanticStatusBadge status={semanticStatus} label={visual.label} data-tone={visual.tone} className={className} />;
  }
  return (
    <span
      data-tone={visual.tone}
      className={cn("ov-status-badge shrink-0", visual.className, className)}
    >
      {visual.label}
    </span>
  );
}
