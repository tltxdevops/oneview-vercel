import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { OneViewIncident } from "@/lib/oneview-api";

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

export function formatUpdatedAgo(value?: string | null) {
  if (!value) return "—";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "—";
  return formatDurationSeconds(elapsedMs / 1000);
}

export function displayIncidentField(value?: string | null, fallback?: string | null) {
  const primary = String(value || "").trim();
  if (primary && primary !== "undefined" && primary !== "null") return primary;
  const secondary = String(fallback || "").trim();
  if (secondary && secondary !== "undefined" && secondary !== "null") return secondary;
  return "—";
}

export function operationalIncidentKey(item: OneViewIncident) {
  return String(item.sys_id || item.number || "").trim();
}

function OperationalIncidentQueueRow({
  item,
  onOpen,
  selected = false,
  showAnalyst = false,
}: {
  item: OneViewIncident;
  onOpen: (item: OneViewIncident) => void;
  selected?: boolean;
  showAnalyst?: boolean;
}) {
  const number = displayIncidentField(item.number);
  const analyst = displayIncidentField(item.assigned_to_display, item.assigned_to);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border/50 py-1.5 text-left last:border-b-0 transition-colors hover:bg-muted/40",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
      )}
      aria-label={`Abrir chamado ${number}`}
    >
      <p className="truncate text-[13px] font-semibold text-foreground" title={number}>{number}</p>
      <p className="truncate text-right text-[11px] text-muted-foreground" title={formatUpdatedAgo(item.sys_updated_on)}>
        {formatUpdatedAgo(item.sys_updated_on)}
      </p>
      <p className="truncate text-[11px] text-foreground/80" title={displayIncidentField(item.company_display, item.company)}>
        {displayIncidentField(item.company_display, item.company)}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1">
        {showAnalyst ? (
          <span className="max-w-[8rem] truncate text-[10px] text-muted-foreground" title={analyst}>
            {analyst}
          </span>
        ) : null}
        <Badge variant="secondary" className="h-5 max-w-[7rem] truncate px-1.5 text-[10px]">
          {displayIncidentField(item.priority_display, item.priority)}
        </Badge>
        <Badge variant="outline" className="h-5 max-w-[7rem] truncate px-1.5 text-[10px]">
          {displayIncidentField(item.state_display, item.state)}
        </Badge>
      </div>
    </button>
  );
}

type OperationalIncidentsQueueListProps = {
  items: OneViewIncident[];
  onOpen: (item: OneViewIncident) => void;
  selectedKey?: string | null;
  showAnalyst?: boolean;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
};

export function OperationalIncidentsQueueList({
  items,
  onOpen,
  selectedKey = null,
  showAnalyst = false,
  loading = false,
  empty = false,
  emptyMessage = "Nenhum chamado monitoring sem responsável.",
  className,
}: OperationalIncidentsQueueListProps) {
  if (loading) {
    return <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>;
  }
  if (empty) {
    return <p className="py-3 text-center text-xs text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        className="grid shrink-0 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-x-2 border-b border-border/70 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        aria-hidden="true"
      >
        <span>Número · Cliente</span>
        <span className="text-right">
          {showAnalyst ? "Atualização · Analista · Prioridade · Estado" : "Atualização · Prioridade · Estado"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.map((item) => (
          <OperationalIncidentQueueRow
            key={item.sys_id || item.number || String(item.sys_updated_on)}
            item={item}
            onOpen={onOpen}
            selected={selectedKey === operationalIncidentKey(item)}
            showAnalyst={showAnalyst}
          />
        ))}
      </div>
    </div>
  );
}
