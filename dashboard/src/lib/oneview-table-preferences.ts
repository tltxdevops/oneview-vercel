import { useCallback, useEffect, useMemo, useState } from "react";

const TABLE_PREFERENCES_VERSION = 1 as const;

export type OneViewTableColumnDefinition<ColumnId extends string = string> = {
  id: ColumnId;
  label: string;
  required?: boolean;
  defaultVisible?: boolean;
};

type StoredTablePreferences = {
  version: typeof TABLE_PREFERENCES_VERSION;
  order: string[];
  visibility: Record<string, boolean>;
};

function normalizePreferences<ColumnId extends string>(
  definitions: readonly OneViewTableColumnDefinition<ColumnId>[],
  candidate?: Partial<StoredTablePreferences> | null,
): StoredTablePreferences {
  const ids = definitions.map((column) => column.id);
  const known = new Set(ids);
  const storedOrder = Array.isArray(candidate?.order)
    ? candidate.order.filter((id): id is ColumnId => typeof id === "string" && known.has(id as ColumnId))
    : [];
  const order = [...new Set([...storedOrder, ...ids])];
  const visibility = Object.fromEntries(definitions.map((column) => [
    column.id,
    column.required ? true : candidate?.visibility?.[column.id] ?? column.defaultVisible !== false,
  ]));
  return { version: TABLE_PREFERENCES_VERSION, order, visibility };
}

function readPreferences<ColumnId extends string>(
  storageKey: string,
  definitions: readonly OneViewTableColumnDefinition<ColumnId>[],
) {
  if (typeof window === "undefined") return normalizePreferences(definitions);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return normalizePreferences(definitions);
    return normalizePreferences(definitions, JSON.parse(raw) as Partial<StoredTablePreferences>);
  } catch {
    return normalizePreferences(definitions);
  }
}

export function oneViewTablePreferenceKey(tableId: string, actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim().toLowerCase() || "anonymous";
  return `oneview.table.${tableId}.v${TABLE_PREFERENCES_VERSION}:${actor}`;
}

export function useOneViewTableColumns<ColumnId extends string>({
  tableId,
  actorId,
  definitions,
}: {
  tableId: string;
  actorId?: string | null;
  definitions: readonly OneViewTableColumnDefinition<ColumnId>[];
}) {
  const storageKey = oneViewTablePreferenceKey(tableId, actorId);
  const definitionSignature = definitions.map((column) => `${column.id}:${column.required ? 1 : 0}:${column.defaultVisible === false ? 0 : 1}`).join("|");
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey, definitions));
  const [readyStorageKey, setReadyStorageKey] = useState(storageKey);

  useEffect(() => {
    setPreferences(readPreferences(storageKey, definitions));
    setReadyStorageKey(storageKey);
    // definitions are represented by the stable signature to avoid resets from inline arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, definitionSignature]);

  useEffect(() => {
    // Auth may resolve after the first render. Do not write anonymous/previous
    // table state into the user's key before that key has been read.
    if (readyStorageKey !== storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Browser storage is optional; keep the in-memory preference.
    }
  }, [preferences, readyStorageKey, storageKey]);

  const definitionsById = useMemo(
    () => new Map(definitions.map((column) => [column.id, column])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definitionSignature],
  );

  const orderedColumns = useMemo(
    () => preferences.order
      .map((id) => definitionsById.get(id as ColumnId))
      .filter((column): column is OneViewTableColumnDefinition<ColumnId> => Boolean(column)),
    [definitionsById, preferences.order],
  );
  const visibleColumns = orderedColumns.filter((column) => preferences.visibility[column.id] !== false);

  const setVisible = useCallback((id: ColumnId, visible: boolean) => {
    const definition = definitionsById.get(id);
    if (!definition || definition.required) return;
    setPreferences((current) => ({
      ...current,
      visibility: { ...current.visibility, [id]: visible },
    }));
  }, [definitionsById]);

  const reorder = useCallback((sourceId: ColumnId, targetId: ColumnId) => {
    if (sourceId === targetId) return;
    setPreferences((current) => {
      const sourceIndex = current.order.indexOf(sourceId);
      const targetIndex = current.order.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const order = [...current.order];
      const [source] = order.splice(sourceIndex, 1);
      order.splice(targetIndex, 0, source);
      return { ...current, order };
    });
  }, []);

  const move = useCallback((id: ColumnId, direction: -1 | 1) => {
    setPreferences((current) => {
      const index = current.order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  }, []);

  const reset = useCallback(() => setPreferences(normalizePreferences(definitions)), [definitionSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    orderedColumns,
    visibleColumns,
    visibility: preferences.visibility as Record<ColumnId, boolean>,
    setVisible,
    reorder,
    move,
    reset,
  };
}
