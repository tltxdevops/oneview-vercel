import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { OneViewSortableHeader, type OneViewSortDirection } from "@/components/oneview/ConfigurableTableTools";
import { IncidentTableActionsCell } from "@/components/oneview/IncidentTableActionsCell";
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

export const OPERATIONAL_INCIDENT_QUEUE_COLUMNS = [
  { id: "number", label: "Número", required: true },
  { id: "description", label: "Descrição" },
  { id: "client", label: "Cliente" },
  { id: "updated", label: "Atualização" },
  { id: "analyst", label: "Analista" },
  { id: "priority", label: "Prioridade" },
  { id: "state", label: "Estado" },
  { id: "actions", label: "Ações", required: true },
] as const;

export type OperationalIncidentQueueColumnId = typeof OPERATIONAL_INCIDENT_QUEUE_COLUMNS[number]["id"];

export const OPERATIONAL_INCIDENT_QUEUE_COLUMN_WIDTH: Record<OperationalIncidentQueueColumnId, string> = {
  number: "7.5rem",
  description: "minmax(10rem,1.25fr)",
  client: "minmax(8rem,0.85fr)",
  updated: "6.5rem",
  analyst: "8rem",
  priority: "7rem",
  state: "7.5rem",
  actions: "minmax(12rem, 1.1fr)",
};

export const OPERATIONAL_INCIDENT_QUEUE_TABLE_MIN_WIDTH = "64rem";

export function operationalIncidentColumnAlign(column: string) {
  if (column === "updated") return "justify-self-end text-right";
  if (column === "actions") return "justify-self-start text-left";
  return "justify-self-start text-left";
}

function OperationalIncidentQueueRow({
  item,
  onOpen,
  columns,
  gridTemplate,
  selected = false,
  showAnalyst = false,
  onActionComplete,
}: {
  item: OneViewIncident;
  onOpen: (item: OneViewIncident) => void;
  columns: readonly OperationalIncidentQueueColumnId[];
  gridTemplate: string;
  selected?: boolean;
  showAnalyst?: boolean;
  onActionComplete?: () => void;
}) {
  const number = displayIncidentField(item.number);
  const analyst = displayIncidentField(item.assigned_to_display, item.assigned_to);
  const incidentDescription = displayIncidentField(item.short_description, item.description);
  const cells: Record<OperationalIncidentQueueColumnId, ReactNode> = {
    number: <span key="number" className="block truncate text-[13px] font-semibold text-foreground" title={number}>{number}</span>,
    description: <span key="description" className="block truncate text-[11px] text-foreground/85" title={incidentDescription}>{incidentDescription}</span>,
    client: <span key="client" className="block truncate text-[11px] text-foreground/80" title={displayIncidentField(item.company_display, item.company)}>{displayIncidentField(item.company_display, item.company)}</span>,
    updated: <span key="updated" className="block truncate text-[11px] tabular-nums text-muted-foreground" title={formatUpdatedAgo(item.sys_updated_on)}>{formatUpdatedAgo(item.sys_updated_on)}</span>,
    analyst: <span key="analyst" className="block truncate text-[10px] text-muted-foreground" title={analyst}>{showAnalyst ? analyst : "—"}</span>,
    priority: <span key="priority"><Badge variant="secondary" className="h-5 max-w-full truncate px-1.5 text-[10px]">{displayIncidentField(item.priority_display, item.priority)}</Badge></span>,
    state: <span key="state"><Badge variant="outline" className="h-5 max-w-full truncate px-1.5 text-[10px]">{displayIncidentField(item.state_display, item.state)}</Badge></span>,
    actions: (
      <IncidentTableActionsCell
        key="actions"
        incident={item}
        onActionComplete={onActionComplete}
      />
    ),
  };
  return (
    <div
      className={cn(
        "ov-monitoring-table-grid grid w-full min-h-10 items-center gap-x-3 border-b border-border/50 px-1 py-1.5 text-left last:border-b-0 transition-colors",
        selected && "bg-muted/55 ring-1 ring-inset ring-border/80",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
      role="row"
    >
      {columns.map((column) => (
        <div
          key={column}
          className={cn(
            "min-w-0 overflow-hidden",
            operationalIncidentColumnAlign(column),
            column !== "actions" && "cursor-pointer hover:opacity-90",
          )}
          onClick={column === "actions" ? undefined : () => onOpen(item)}
          onKeyDown={column === "actions" ? undefined : (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(item);
            }
          }}
          role={column === "actions" ? undefined : "button"}
          tabIndex={column === "actions" ? undefined : 0}
          aria-label={column === "actions" ? undefined : `Abrir chamado ${number}`}
        >
          {cells[column]}
        </div>
      ))}
    </div>
  );
}

type OperationalIncidentsQueueListProps = {
  items: OneViewIncident[];
  onOpen: (item: OneViewIncident) => void;
  columnIds: readonly OperationalIncidentQueueColumnId[];
  gridTemplate: string;
  columnLabels: ReadonlyArray<{ id: string; label: string }>;
  selectedKey?: string | null;
  showAnalyst?: boolean;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  onActionComplete?: () => void;
  sort?: {
    field: string;
    order: OneViewSortDirection;
    columnFields: Partial<Record<OperationalIncidentQueueColumnId, string>>;
    onSort: (field: string) => void;
  };
};

export function OperationalIncidentsQueueList({
  items,
  onOpen,
  columnIds,
  gridTemplate,
  columnLabels,
  selectedKey = null,
  showAnalyst = false,
  loading = false,
  empty = false,
  emptyMessage = "Nenhum chamado monitoring sem responsável.",
  className,
  onActionComplete,
  sort,
}: OperationalIncidentsQueueListProps) {
  if (loading) {
    return <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>;
  }
  if (empty) {
    return <p className="py-3 text-center text-xs text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        <div style={{ minWidth: OPERATIONAL_INCIDENT_QUEUE_TABLE_MIN_WIDTH }}>
          <div
            className="ov-monitoring-table-grid grid shrink-0 gap-x-3 border-b border-border/70 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns: gridTemplate }}
            role="row"
          >
            {columnLabels.map((column) => {
              const id = column.id as OperationalIncidentQueueColumnId;
              const field = sort?.columnFields[id];
              return (
                <span key={column.id} className={cn("min-w-0", operationalIncidentColumnAlign(column.id))} aria-sort={field ? sort?.field === field ? sort.order === "asc" ? "ascending" : "descending" : "none" : undefined}>
                  {field && sort ? <OneViewSortableHeader label={column.label} active={sort.field === field} direction={sort.order} className={id === "updated" ? "justify-end" : undefined} onClick={() => sort.onSort(field)} /> : column.label}
                </span>
              );
            })}
          </div>
          {items.map((item) => (
            <OperationalIncidentQueueRow
              key={item.sys_id || item.number || String(item.sys_updated_on)}
              item={item}
              onOpen={onOpen}
              columns={columnIds}
              gridTemplate={gridTemplate}
              selected={selectedKey === operationalIncidentKey(item)}
              showAnalyst={showAnalyst}
              onActionComplete={onActionComplete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
