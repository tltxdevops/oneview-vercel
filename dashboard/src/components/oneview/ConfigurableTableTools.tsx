import { Fragment, useState, type ReactNode } from "react";
import { ArrowUpDown, Check, ChevronDown, ChevronUp, Columns3, GripVertical, ListFilter, RotateCcw, Search } from "lucide-react";
import { OneViewTableSearchField } from "@/components/oneview/OneViewTableSearchField";
import { OperationalFilterPanel } from "@/components/oneview/OperationalFilterPanel";
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

export function OneViewColumnFilterPopover({
  label,
  activeCount = 0,
  kind = "filter",
  align = "start",
  children,
}: {
  label: string;
  activeCount?: number;
  kind?: "filter" | "search";
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  const Icon = kind === "search" ? Search : ListFilter;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            activeCount > 0 && "bg-primary/10 text-primary",
          )}
          aria-label={`${label}${activeCount > 0 ? `, ${activeCount} ativo${activeCount === 1 ? "" : "s"}` : ""}`}
          title={label}
          onClick={(event) => event.stopPropagation()}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {activeCount > 1 ? (
            <span className="absolute -right-1 -top-1 grid min-h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[8px] font-bold leading-none text-primary-foreground">
              {activeCount > 9 ? "9+" : activeCount}
            </span>
          ) : activeCount === 1 ? (
            <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={6}
        collisionPadding={8}
        style={{ maxHeight: "min(24rem, var(--radix-popover-content-available-height))" }}
        className="w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain p-3"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function OneViewFilterableHeader({
  label,
  active = false,
  direction = "asc",
  onSort,
  filter,
}: {
  label: string;
  active?: boolean;
  direction?: OneViewSortDirection;
  onSort?: () => void;
  filter?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {onSort ? (
        <OneViewSortableHeader label={label} active={active} direction={direction} onClick={onSort} />
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {filter}
    </div>
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
        <SelectTrigger className="h-9 min-w-[10rem] max-w-[15rem] max-lg:max-w-[13rem]" aria-label={label}>
          <ArrowUpDown className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent
          align="end"
          className="w-[min(20rem,calc(100vw-1rem))]"
          style={{ maxHeight: "min(20rem, var(--radix-select-content-available-height))" }}
        >
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

type ResponsiveColumnState = {
  autoHiddenCount?: number;
  showAllColumns?: boolean;
  onShowAllColumnsChange?: (showAll: boolean) => void;
};

export function ConfigurableTableColumns<ColumnId extends string>({
  controller,
  label = "Colunas",
  responsive,
  afterColumn,
}: {
  controller: ColumnController<ColumnId>;
  label?: string;
  responsive?: ResponsiveColumnState;
  afterColumn?: { id: ColumnId; content: ReactNode };
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
        {responsive?.autoHiddenCount ? (
          <div className="px-2 text-[10px] text-muted-foreground">
            {responsive.autoHiddenCount} oculta(s) pela largura atual.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-1 text-[10px]"
              onClick={() => responsive.onShowAllColumnsChange?.(!responsive.showAllColumns)}
            >
              {responsive.showAllColumns ? "Visão adaptativa" : "Mostrar todas"}
            </Button>
          </div>
        ) : null}
        <div className="space-y-1">
          {controller.orderedColumns.map((column, index) => {
            const visible = controller.visibility[column.id] !== false;
            return (
              <Fragment key={column.id}>
              <div
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
              {afterColumn?.id === column.id ? afterColumn.content : null}
              </Fragment>
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
  onSearchSuggestionPick,
  onSearchSubmit,
  normalizeIncSearch = true,
  searchActivity = "idle",
  searchActivityQuery,
  localSearchSuggestions,
  getSearchSuggestionActionLabel,
  isSearchSuggestionSelected,
  sort,
  responsiveColumns,
  afterColumn,
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
  onSearchSuggestionPick?: (item: OneViewSearchSuggestion) => void;
  onSearchSubmit?: (value: string) => void;
  normalizeIncSearch?: boolean;
  searchActivity?: "idle" | "pending" | "searching";
  searchActivityQuery?: string;
  localSearchSuggestions?: OneViewSearchSuggestion[];
  getSearchSuggestionActionLabel?: (item: OneViewSearchSuggestion) => string | null;
  isSearchSuggestionSelected?: (item: OneViewSearchSuggestion) => boolean;
  sort?: {
    value: string;
    options: OneViewTableSortOption[];
    onChange: (value: string) => void;
    label?: string;
  };
  responsiveColumns?: ResponsiveColumnState;
  afterColumn?: { id: ColumnId; content: ReactNode };
}) {
  return (
    <div className={cn("border-b border-border/60 bg-background/75 px-3 py-2", className)}>
      <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(18rem,1fr)_auto] lg:items-center">
        <OneViewTableSearchField
          value={search}
          onChange={onSearchChange}
          onSubmit={onSearchSubmit}
          onSelect={onSearchPick}
          onSuggestionSelect={onSearchSuggestionPick}
          fetchSuggestions={fetchSearchSuggestions}
          placeholder={searchPlaceholder}
          ariaLabel={searchLabel}
          normalizeInc={normalizeIncSearch}
          activity={searchActivity}
          activityQuery={searchActivityQuery}
          localSuggestions={localSearchSuggestions}
          getSuggestionActionLabel={getSearchSuggestionActionLabel}
          isSuggestionSelected={isSearchSuggestionSelected}
          className="w-full min-w-0"
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
          {filters ? (
          <OperationalFilterPanel activeFilterCount={activeFilterCount} onClearFilters={onClearFilters}>
            {filters}
          </OperationalFilterPanel>
          ) : null}
          {sort ? <OneViewTableSortMenu {...sort} /> : null}
          <ConfigurableTableColumns controller={columns} responsive={responsiveColumns} afterColumn={afterColumn} />
          {trailing}
        </div>
      </div>
      {scopeHint ? <p className="mt-1 text-[10px] text-muted-foreground">{scopeHint}</p> : null}
    </div>
  );
}
