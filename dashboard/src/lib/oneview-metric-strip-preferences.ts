import { useCallback, useEffect, useMemo, useState } from "react";

const METRIC_STRIP_PREFERENCES_VERSION = 1 as const;

export type OneViewMetricStripDensity = "compact" | "default" | "comfortable";
export type OneViewMetricSpan = 1 | 2 | 3 | 4;
export type OneViewMetricRowSpan = 1 | 2 | 3;

export const ONEVIEW_METRIC_STRIP_DENSITY_LABEL: Record<OneViewMetricStripDensity, string> = {
  compact: "Compacto",
  default: "Padrão",
  comfortable: "Amplo",
};

export type OneViewMetricDefinition<MetricId extends string = string> = {
  id: MetricId;
  label: string;
  required?: boolean;
  defaultVisible?: boolean;
  defaultSpan?: OneViewMetricSpan;
  defaultRowSpan?: OneViewMetricRowSpan;
};

type StoredMetricStripPreferences = {
  version: typeof METRIC_STRIP_PREFERENCES_VERSION;
  order: string[];
  visibility: Record<string, boolean>;
  span: Record<string, OneViewMetricSpan>;
  rowSpan: Record<string, OneViewMetricRowSpan>;
  density: OneViewMetricStripDensity;
};

const DEFAULT_SPAN: OneViewMetricSpan = 1;
const DEFAULT_ROW_SPAN: OneViewMetricRowSpan = 1;

function normalizeMetricStripPreferences<MetricId extends string>(
  definitions: readonly OneViewMetricDefinition<MetricId>[],
  candidate?: Partial<StoredMetricStripPreferences> | null,
): StoredMetricStripPreferences {
  const ids = definitions.map((metric) => metric.id);
  const known = new Set(ids);
  const storedOrder = Array.isArray(candidate?.order)
    ? candidate.order.filter((id): id is MetricId => typeof id === "string" && known.has(id as MetricId))
    : [];
  const order = [...new Set([...storedOrder, ...ids])];
  const visibility = Object.fromEntries(definitions.map((metric) => [
    metric.id,
    metric.required ? true : candidate?.visibility?.[metric.id] ?? metric.defaultVisible !== false,
  ]));
  const span = Object.fromEntries(definitions.map((metric) => {
    const stored = candidate?.span?.[metric.id];
    const fallback = metric.defaultSpan ?? DEFAULT_SPAN;
    const value = stored ?? fallback;
    return [metric.id, clampSpan(value)];
  }));
  const rowSpan = Object.fromEntries(definitions.map((metric) => {
    const stored = (candidate as Partial<StoredMetricStripPreferences> | null | undefined)?.rowSpan?.[metric.id];
    const fallback = metric.defaultRowSpan ?? DEFAULT_ROW_SPAN;
    return [metric.id, clampRowSpan(stored ?? fallback)];
  }));
  const density = candidate?.density === "compact" || candidate?.density === "comfortable"
    ? candidate.density
    : "default";
  return {
    version: METRIC_STRIP_PREFERENCES_VERSION,
    order,
    visibility,
    span,
    rowSpan,
    density,
  };
}

function clampSpan(value: unknown): OneViewMetricSpan {
  const parsed = typeof value === "number" ? value : Number(value);
  if (parsed >= 4) return 4;
  if (parsed >= 3) return 3;
  if (parsed >= 2) return 2;
  return 1;
}

function clampRowSpan(value: unknown): OneViewMetricRowSpan {
  const parsed = typeof value === "number" ? value : Number(value);
  if (parsed >= 3) return 3;
  if (parsed >= 2) return 2;
  return 1;
}

export type OneViewMetricGridProfile = "chamados" | "twelve";

export function metricStripGridColumns(viewportWidth: number, profile: OneViewMetricGridProfile = "chamados"): number {
  if (profile === "chamados") {
    if (viewportWidth < 768) return 2;
    if (viewportWidth < 1536) return 4;
    return 7;
  }
  if (viewportWidth < 768) return 4;
  if (viewportWidth < 1280) return 8;
  return 12;
}

/** Span efetivo na grade atual (1–4 lógico, limitado às colunas visíveis). */
export function effectiveMetricSpan(
  span: OneViewMetricSpan,
  viewportWidth: number,
  profile: OneViewMetricGridProfile = "chamados",
): OneViewMetricSpan {
  const columns = metricStripGridColumns(viewportWidth, profile);
  return clampSpan(Math.min(span, columns, 4));
}

function readMetricStripPreferences<MetricId extends string>(
  storageKey: string,
  definitions: readonly OneViewMetricDefinition<MetricId>[],
) {
  if (typeof window === "undefined") return normalizeMetricStripPreferences(definitions);
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return normalizeMetricStripPreferences(definitions);
    return normalizeMetricStripPreferences(definitions, JSON.parse(raw) as Partial<StoredMetricStripPreferences>);
  } catch {
    return normalizeMetricStripPreferences(definitions);
  }
}

export function oneViewMetricStripPreferenceKey(stripId: string, actorId?: string | null) {
  const actor = String(actorId || "anonymous").trim().toLowerCase() || "anonymous";
  return `oneview.metric-strip.${stripId}.v${METRIC_STRIP_PREFERENCES_VERSION}:${actor}`;
}

export type OneViewMetricStripController<MetricId extends string = string> = {
  orderedMetrics: OneViewMetricDefinition<MetricId>[];
  visibleMetrics: OneViewMetricDefinition<MetricId>[];
  visibility: Record<MetricId, boolean>;
  span: Record<MetricId, OneViewMetricSpan>;
  rowSpan: Record<MetricId, OneViewMetricRowSpan>;
  density: OneViewMetricStripDensity;
  setVisible: (id: MetricId, visible: boolean) => void;
  setSpan: (id: MetricId, span: OneViewMetricSpan) => void;
  increaseSpan: (id: MetricId) => void;
  decreaseSpan: (id: MetricId) => void;
  setRowSpan: (id: MetricId, rowSpan: OneViewMetricRowSpan) => void;
  increaseRowSpan: (id: MetricId) => void;
  decreaseRowSpan: (id: MetricId) => void;
  setDensity: (density: OneViewMetricStripDensity) => void;
  reorder: (sourceId: MetricId, targetId: MetricId) => void;
  move: (id: MetricId, direction: -1 | 1) => void;
  reset: () => void;
};

export function useOneViewMetricStrip<MetricId extends string>({
  stripId,
  actorId,
  definitions,
}: {
  stripId: string;
  actorId?: string | null;
  definitions: readonly OneViewMetricDefinition<MetricId>[];
}): OneViewMetricStripController<MetricId> {
  const storageKey = oneViewMetricStripPreferenceKey(stripId, actorId);
  const definitionSignature = definitions
    .map((metric) => `${metric.id}:${metric.required ? 1 : 0}:${metric.defaultVisible === false ? 0 : 1}:${metric.defaultSpan ?? DEFAULT_SPAN}`)
    .join("|");
  const [preferences, setPreferences] = useState(() => readMetricStripPreferences(storageKey, definitions));
  const [readyStorageKey, setReadyStorageKey] = useState(storageKey);

  useEffect(() => {
    setPreferences(readMetricStripPreferences(storageKey, definitions));
    setReadyStorageKey(storageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, definitionSignature]);

  useEffect(() => {
    if (readyStorageKey !== storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      // Browser storage is optional.
    }
  }, [preferences, readyStorageKey, storageKey]);

  const definitionsById = useMemo(
    () => new Map(definitions.map((metric) => [metric.id, metric])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definitionSignature],
  );

  const orderedMetrics = useMemo(
    () => preferences.order
      .map((id) => definitionsById.get(id as MetricId))
      .filter((metric): metric is OneViewMetricDefinition<MetricId> => Boolean(metric)),
    [definitionsById, preferences.order],
  );

  const visibleMetrics = orderedMetrics.filter((metric) => preferences.visibility[metric.id] !== false);

  const setVisible = useCallback((id: MetricId, visible: boolean) => {
    const definition = definitionsById.get(id);
    if (!definition || definition.required) return;
    setPreferences((current) => {
      const visibleCount = current.order.filter((candidate) => current.visibility[candidate] !== false).length;
      if (!visible && visibleCount <= 1) return current;
      return {
        ...current,
        visibility: { ...current.visibility, [id]: visible },
      };
    });
  }, [definitionsById]);

  const setSpan = useCallback((id: MetricId, span: OneViewMetricSpan) => {
    if (!definitionsById.has(id)) return;
    setPreferences((current) => ({
      ...current,
      span: { ...current.span, [id]: clampSpan(span) },
    }));
  }, [definitionsById]);

  const increaseSpan = useCallback((id: MetricId) => {
    setPreferences((current) => {
      const currentSpan = clampSpan(current.span[id]);
      if (currentSpan >= 4) return current;
      return { ...current, span: { ...current.span, [id]: (currentSpan + 1) as OneViewMetricSpan } };
    });
  }, []);

  const decreaseSpan = useCallback((id: MetricId) => {
    setPreferences((current) => {
      const currentSpan = clampSpan(current.span[id]);
      if (currentSpan <= 1) return current;
      return { ...current, span: { ...current.span, [id]: (currentSpan - 1) as OneViewMetricSpan } };
    });
  }, []);

  const setRowSpan = useCallback((id: MetricId, rowSpan: OneViewMetricRowSpan) => {
    if (!definitionsById.has(id)) return;
    setPreferences((current) => ({
      ...current,
      rowSpan: { ...current.rowSpan, [id]: clampRowSpan(rowSpan) },
    }));
  }, [definitionsById]);

  const increaseRowSpan = useCallback((id: MetricId) => {
    setPreferences((current) => {
      const currentRowSpan = clampRowSpan(current.rowSpan[id]);
      if (currentRowSpan >= 3) return current;
      return { ...current, rowSpan: { ...current.rowSpan, [id]: (currentRowSpan + 1) as OneViewMetricRowSpan } };
    });
  }, []);

  const decreaseRowSpan = useCallback((id: MetricId) => {
    setPreferences((current) => {
      const currentRowSpan = clampRowSpan(current.rowSpan[id]);
      if (currentRowSpan <= 1) return current;
      return { ...current, rowSpan: { ...current.rowSpan, [id]: (currentRowSpan - 1) as OneViewMetricRowSpan } };
    });
  }, []);

  const setDensity = useCallback((density: OneViewMetricStripDensity) => {
    setPreferences((current) => ({ ...current, density }));
  }, []);

  const reorder = useCallback((sourceId: MetricId, targetId: MetricId) => {
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

  const move = useCallback((id: MetricId, direction: -1 | 1) => {
    setPreferences((current) => {
      const index = current.order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  }, []);

  const reset = useCallback(
    () => setPreferences(normalizeMetricStripPreferences(definitions)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [definitionSignature],
  );

  return {
    orderedMetrics,
    visibleMetrics,
    visibility: preferences.visibility as Record<MetricId, boolean>,
    span: preferences.span as Record<MetricId, OneViewMetricSpan>,
    rowSpan: preferences.rowSpan as Record<MetricId, OneViewMetricRowSpan>,
    density: preferences.density,
    setVisible,
    setSpan,
    increaseSpan,
    decreaseSpan,
    setRowSpan,
    increaseRowSpan,
    decreaseRowSpan,
    setDensity,
    reorder,
    move,
    reset,
  };
}
