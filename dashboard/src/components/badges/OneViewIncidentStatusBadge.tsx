import { Badge } from "@/components/ui/badge";
import { oneViewIncidentStatusVisual } from "@/lib/oneview-incident-status-visual";
import { cn } from "@/lib/utils";

export function OneViewIncidentStatusBadge({ state, display, className }: { state: string | number | null | undefined; display?: string | null; className?: string }) {
  const visual = oneViewIncidentStatusVisual(state, display);
  return (
    <Badge
      variant="outline"
      data-tone={visual.tone}
      className={cn("shrink-0 px-2 py-0.5 text-[10px] font-medium hover:bg-inherit", visual.className, className)}
    >
      {visual.label}
    </Badge>
  );
}
