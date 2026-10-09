import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { OneViewTableColumnDefinition } from "@/lib/oneview-table-preferences";

export type OneViewResponsiveColumnPriority = "essential" | "intermediate" | "secondary";

export type OneViewOperationalColumnDefinition<ColumnId extends string = string> =
  OneViewTableColumnDefinition<ColumnId> & {
    minWidth?: number;
    preferredWidth?: number;
    responsivePriority?: OneViewResponsiveColumnPriority;
  };

const PRIORITY_WEIGHT: Record<OneViewResponsiveColumnPriority, number> = {
  essential: 1,
  intermediate: 2,
  secondary: 3,
};

const DEFAULT_MIN_WIDTH = 112;
const DEFAULT_PREFERRED_WIDTH = 144;

export function operationalColumnMinWidth(column: OneViewOperationalColumnDefinition) {
  return column.minWidth ?? DEFAULT_MIN_WIDTH;
}

export function operationalColumnPreferredWidth(column: OneViewOperationalColumnDefinition) {
  return Math.max(column.preferredWidth ?? DEFAULT_PREFERRED_WIDTH, operationalColumnMinWidth(column));
}

export function selectOperationalColumns<ColumnId extends string>(
  columns: readonly OneViewOperationalColumnDefinition<ColumnId>[],
  availableWidth: number,
  showAll = false,
  wideBreakpoint = 1440,
) {
  if (!availableWidth || availableWidth >= wideBreakpoint || showAll) return [...columns];

  const selected = [...columns];
  let minimumWidth = selected.reduce((total, column) => total + operationalColumnMinWidth(column), 0);
  const removable = selected
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.required && (column.responsivePriority ?? "intermediate") !== "essential")
    .sort((left, right) => {
      const priority = PRIORITY_WEIGHT[right.column.responsivePriority ?? "intermediate"]
        - PRIORITY_WEIGHT[left.column.responsivePriority ?? "intermediate"];
      return priority || right.index - left.index;
    });

  const hidden = new Set<ColumnId>();
  for (const candidate of removable) {
    if (minimumWidth <= availableWidth) break;
    hidden.add(candidate.column.id);
    minimumWidth -= operationalColumnMinWidth(candidate.column);
  }
  return selected.filter((column) => !hidden.has(column.id));
}

export function useOperationalTableLayout<ColumnId extends string>({
  columns,
  wideBreakpoint = 1440,
}: {
  columns: readonly OneViewOperationalColumnDefinition<ColumnId>[];
  wideBreakpoint?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [showAllColumns, setShowAllColumns] = useState(false);

  useEffect(() => {
    const target = containerRef.current;
    if (!target) return undefined;
    const update = (width: number) => setAvailableWidth(Math.floor(width));
    update(target.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? 0));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const adaptiveColumns = useMemo(
    () => selectOperationalColumns(columns, availableWidth, false, wideBreakpoint),
    [availableWidth, columns, wideBreakpoint],
  );
  const visibleColumns = useMemo(
    () => showAllColumns ? [...columns] : adaptiveColumns,
    [adaptiveColumns, columns, showAllColumns],
  );
  const adaptiveIds = useMemo(() => new Set(adaptiveColumns.map((column) => column.id)), [adaptiveColumns]);
  const autoHiddenColumns = useMemo(
    () => columns.filter((column) => !adaptiveIds.has(column.id)),
    [adaptiveIds, columns],
  );
  const minimumTableWidth = useMemo(
    () => visibleColumns.reduce((total, column) => total + operationalColumnMinWidth(column), 0),
    [visibleColumns],
  );

  return {
    containerRef: containerRef as RefObject<HTMLDivElement>,
    visibleColumns,
    autoHiddenColumns,
    showAllColumns,
    setShowAllColumns,
    minimumTableWidth,
  };
}
