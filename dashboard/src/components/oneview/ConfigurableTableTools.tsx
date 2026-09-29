import { useState, type ReactNode } from "react";
import { ArrowUpDown, Check, ChevronDown, ChevronUp, Columns3, GripVertical, RotateCcw, SlidersHorizontal } from "lucide-react";
import { OneViewTableSearchField } from "@/components/oneview/OneViewTableSearchField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { OneViewSearchSuggestion } from "@/lib/oneview-api";
import type { OneViewTableColumnDefinition } from "@/lib/oneview-table-preferences";
import { cn } from "@/lib/utils";

export type OneViewSortDirection = "asc" | "desc";
export type OneViewTableSortOption = { value: string; label: string };

export function OneViewSortableHeader({
  label,
  active = false,
  direction = "asc",
  onClick,
  className,
}: {
  label: string;
  active?: boolean;
  direction?: OneViewSortDirection;
  onClick: () => void;
  className?: string;
}) {
  const nextLabel = active
    ? direction === "asc" ? "ordem decrescente" : "ordem crescente"
    : "ordenar";
  return (
    <button
      type="button"
      className={cn("group inline-flex w-full min-w-0 items-center justify-start gap-1 whitespace-nowrap font-semibold text-inherit transition-colors hover:text-primary", className)}
      aria-label={`${label}: ${nextLabel}`}
      aria-pressed={active}
      title={`${label}: ${nextLabel}`}
      onClick={onClick}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ArrowUpDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary", active && "text-primary")} aria-hidden="true" />
    </button>
  );
}

export function OneViewTableSortMenu({
  value,
  options,
  onChange,
  label = "Ordenar",
}: {
  value: string;
  options: OneViewTableSortOption[];
  onChange: (value: string) => void;
  label?: string;
}) {
  if (!options.length) return null;
  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5">
      <span className="sr-only">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 min-w-[10rem] max-w-[15rem]" aria-label={label}>
          <ArrowUpDown className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

type ColumnController<ColumnId extends string> = {
  orderedColumns: OneViewTableColumnDefinition<ColumnId>[];
  visibility: Record<ColumnId, boolean>;
  setVisible: (id: ColumnId, visible: boolean) => void;
  reorder: (sourceId: ColumnId, targetId: ColumnId) => void;
  move: (id: ColumnId, direction: -1 | 1) => void;
  reset: () => void;
};

export function ConfigurableTableColumns<ColumnId extends string>({
  controller,
  label = "Colunas",
}: {
  controller: ColumnController<ColumnId>;
  label?: string;
}) {
  const [draggedId, setDraggedId] = useState<ColumnId | null>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-9 gap-1.5">
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        <div className="flex items-center justify-between px-2 py-1">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Colunas visíveis</p>
            <p className="text-[10px] text-muted-foreground">Arraste para alterar a ordem.</p>
          </div>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Restaurar colunas" title="Restaurar colunas" onClick={controller.reset}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="space-y-1">
          {controller.orderedColumns.map((column, index) => {
            const visible = controller.visibility[column.id] !== false;
            return (
              <div
                key={column.id}
                draggable
                onDragStart={(event) => {
                  setDraggedId(column.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", column.id);
                }}
                onDragEnd={() => setDraggedId(null)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const source = (draggedId || event.dataTransfer.getData("text/plain")) as ColumnId;
                  if (source) controller.reorder(source, column.id);
                  setDraggedId(null);
                }}
                className={cn(
                  "flex min-h-9 items-center gap-1 rounded-md border border-transparent px-1 transition-colors hover:bg-muted/60",
                  draggedId === column.id && "border-border bg-muted/70 opacity-60",
                )}
              >
                <span className="grid h-7 w-6 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing" title="Arrastar coluna">
                  <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 min-w-0 flex-1 justify-start gap-2 px-1.5 text-xs"
                  disabled={column.required}
                  aria-pressed={visible}
                  onClick={() => controller.setVisible(column.id, !visible)}
                >
                  <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border">{visible ? <Check className="h-3 w-3" /> : null}</span>
                  <span className="truncate">{column.label}{column.required ? " (fixa)" : ""}</span>
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={index === 0} aria-label={`Mover ${column.label} para esquerda`} onClick={() => controller.move(column.id, -1)}>
                  <ChevronUp className="h-3.5 w-3.5 -rotate-90" aria-hidden="true" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="h-7 w-7" disabled={index === controller.orderedColumns.length - 1} aria-label={`Mover ${column.label} para direita`} onClick={() => controller.move(column.id, 1)}>
                  <ChevronDown className="h-3.5 w-3.5 -rotate-90" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ConfigurableTableToolbar<ColumnId extends string>({
  search,
  onSearchChange,
  searchPlaceholder,
  searchLabel,
  columns,
  filters,
  activeFilterCount = 0,
  onClearFilters,
  updating = false,
  scopeHint,
  trailing,
  className,
  fetchSearchSuggestions,
  onSearchPick,
  onSearchSubmit,
  normalizeIncSearch = true,
  searchActivity = "idle",
  searchActivityQuery,
  sort,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchLabel: string;
  columns: ColumnController<ColumnId>;
  filters?: ReactNode;
  activeFilterCount?: number;
  onClearFilters?: () => void;
  updating?: boolean;
  scopeHint?: string;
  trailing?: ReactNode;
  className?: string;
  fetchSearchSuggestions?: (query: string, signal: AbortSignal) => Promise<OneViewSearchSuggestion[]>;
  onSearchPick?: (value: string) => void;
  onSearchSubmit?: (value: string) => void;
  normalizeIncSearch?: boolean;
  searchActivity?: "idle" | "pending" | "searching";
  searchActivityQuery?: string;
  sort?: {
    value: string;
    options: OneViewTableSortOption[];
    onChange: (value: string) => void;
    label?: string;
  };
}) {
  return (
    <div className={cn("border-b border-border/60 bg-background/75 px-3 py-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <OneViewTableSearchField
          value={search}
          onChange={onSearchChange}
          onSubmit={onSearchSubmit}
          onSelect={onSearchPick}
          fetchSuggestions={fetchSearchSuggestions}
          placeholder={searchPlaceholder}
          ariaLabel={searchLabel}
          normalizeInc={normalizeIncSearch}
          activity={searchActivity}
          activityQuery={searchActivityQuery}
        />
        {filters ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant={activeFilterCount ? "default" : "outline"} className="h-9 gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                Filtros
                {activeFilterCount ? <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{activeFilterCount}</Badge> : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(42rem,calc(100vw-2rem))] space-y-3 p-4">
              <div>
                <p className="text-sm font-semibold">Filtros específicos</p>
                <p className="text-[11px] text-muted-foreground">Use somente quando precisar refinar os resultados.</p>
              </div>
              {filters}
              {activeFilterCount && onClearFilters ? (
                <div className="flex justify-end border-t border-border/60 pt-3">
                  <Button type="button" size="sm" variant="ghost" onClick={onClearFilters}>Limpar filtros</Button>
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : null}
        {sort ? <OneViewTableSortMenu {...sort} /> : null}
        <ConfigurableTableColumns controller={columns} />
        {trailing}
      </div>
      {scopeHint ? <p className="mt-1 text-[10px] text-muted-foreground">{scopeHint}</p> : null}
    </div>
  );
}
