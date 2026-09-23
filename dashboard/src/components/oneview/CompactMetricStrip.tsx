import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import {
  effectiveMetricSpan,
  metricStripGridColumns,
  type OneViewMetricGridProfile,
  type OneViewMetricRowSpan,
  type OneViewMetricSpan,
  type OneViewMetricStripDensity,
} from "@/lib/oneview-metric-strip-preferences";
import { cn } from "@/lib/utils";

export type CompactMetricItem = {
  key: string;
  label: string;
  value: ReactNode;
  description?: string;
  selected?: boolean;
  unknown?: boolean;
  loading?: boolean;
  tone?: "neutral" | "danger" | "success" | "warning" | "info" | "recurrence";
  onClick?: () => void;
  /** Navegação declarativa (Home → Alertas). Preferir a onClick quando ambos existirem. */
  href?: string;
  /** Largura relativa no grid configurável (1–4 colunas lógicas). */
  span?: OneViewMetricSpan;
  rowSpan?: OneViewMetricRowSpan;
};

type MetricResizeGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startSpan: OneViewMetricSpan;
  startRowSpan: OneViewMetricRowSpan;
  columnStep: number;
  rowStep: number;
  lastSpan: OneViewMetricSpan;
  lastRowSpan: OneViewMetricRowSpan;
};

type CompactMetricStripProps = {
  items: CompactMetricItem[];
  footer?: ReactNode;
  className?: string;
  /** Sobrescreve o grid padrão (ex.: fila densa de KPIs em Chamados). */
  gridClassName?: string;
  /** Grid de 12 colunas com span por card (Organizar painel → Indicadores). */
  layoutMode?: "auto" | "configurable";
  gridProfile?: OneViewMetricGridProfile;
  density?: OneViewMetricStripDensity;
  editable?: boolean;
  onMetricSpanChange?: (id: string, span: OneViewMetricSpan) => void;
  onMetricRowSpanChange?: (id: string, rowSpan: OneViewMetricRowSpan) => void;
  /** Evita uma segunda surface quando o strip já está dentro de um painel. */
  surface?: boolean;
  "aria-label"?: string;
};

function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function MetricStripCell({
  item,
  configurable,
  editable,
  span,
  rowSpan,
  viewportWidth,
  gridProfile,
  onSpanChange,
  onRowSpanChange,
}: {
  item: CompactMetricItem;
  configurable: boolean;
  editable: boolean;
  span: OneViewMetricSpan;
  rowSpan: OneViewMetricRowSpan;
  viewportWidth: number;
  gridProfile: OneViewMetricGridProfile;
  onSpanChange?: (span: OneViewMetricSpan) => void;
  onRowSpanChange?: (rowSpan: OneViewMetricRowSpan) => void;
}) {
  const resizeGesture = useRef<MetricResizeGesture | null>(null);
  const [preview, setPreview] = useState<{ span: OneViewMetricSpan; rowSpan: OneViewMetricRowSpan } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const displaySpan = effectiveMetricSpan(preview?.span ?? span, viewportWidth, gridProfile);
  const displayRowSpan = preview?.rowSpan ?? rowSpan;

  const spanStyle = configurable
    ? ({
        "--ov-metric-span": displaySpan,
        "--ov-metric-row-span": displayRowSpan,
      } as CSSProperties)
    : undefined;

  const content = (
    <>
      <span className="max-w-full truncate ov-type-caption font-medium text-muted-foreground">{item.label}</span>
      {item.loading ? (
        <Skeleton className="h-4 w-8" />
      ) : (
        <span className="ov-live-metric-value shrink-0 font-mono text-lg font-semibold tabular-nums">
          {item.value}
        </span>
      )}
    </>
  );

  const interactive = Boolean(item.onClick || item.href) && !editable;
  const classNameItem = cn(
    "ov-live-metric flex h-full min-w-0 flex-col items-start justify-center gap-1 text-left transition-colors",
    !configurable && "px-4 py-3",
    editable && "ov-metric-strip-cell-editing",
    isResizing && "ov-metric-strip-cell-resizing",
    interactive && "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  );

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !onSpanChange || !onRowSpanChange) return;
    const grid = event.currentTarget.closest<HTMLElement>(".ov-metric-strip-grid");
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const columns = metricStripGridColumns(viewportWidth, gridProfile);
    const columnStep = Math.max(24, gridRect.width / columns);
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSpan: span,
      startRowSpan: rowSpan,
      columnStep,
      rowStep: 28,
      lastSpan: span,
      lastRowSpan: rowSpan,
    };
    setIsResizing(true);
  };

  const continueResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const spanDelta = Math.round((event.clientX - gesture.startX) / gesture.columnStep);
    const rowDelta = Math.round((event.clientY - gesture.startY) / gesture.rowStep);
    const nextSpan = effectiveMetricSpan(
      clampSpan(gesture.startSpan + spanDelta),
      viewportWidth,
      gridProfile,
    );
    const nextRowSpan = clampRowSpan(gesture.startRowSpan + rowDelta);
    if (nextSpan === gesture.lastSpan && nextRowSpan === gesture.lastRowSpan) return;
    gesture.lastSpan = nextSpan;
    gesture.lastRowSpan = nextRowSpan;
    setPreview({ span: nextSpan, rowSpan: nextRowSpan });
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { lastSpan, lastRowSpan, startSpan, startRowSpan } = gesture;
    resizeGesture.current = null;
    setPreview(null);
    setIsResizing(false);
    if (lastSpan !== startSpan) onSpanChange?.(lastSpan);
    if (lastRowSpan !== startRowSpan) onRowSpanChange?.(lastRowSpan);
  };

  let inner: ReactNode;
  if (item.onClick && !editable) {
    inner = (
      <button
        type="button"
        aria-pressed={item.selected}
        aria-label={`Filtrar alertas: ${item.label}${item.unknown ? " (Sem informação)" : ""}`}
        title={item.description}
        onClick={item.onClick}
        className={classNameItem}
        style={configurable ? undefined : spanStyle}
        data-tone={item.tone ?? "neutral"}
      >
        {content}
      </button>
    );
  } else if (item.href && !editable) {
    inner = (
      <Link
        to={item.href}
        aria-label={`Abrir alertas: ${item.label}${item.unknown ? " (Sem informação)" : ""}`}
        title={item.description}
        className={classNameItem}
        style={configurable ? undefined : spanStyle}
        data-tone={item.tone ?? "neutral"}
      >
        {content}
      </Link>
    );
  } else {
    inner = (
      <div
        title={item.description}
        className={classNameItem}
        style={configurable ? undefined : spanStyle}
        data-tone={item.tone ?? "neutral"}
        aria-label={editable ? `Indicador ${item.label}, modo edição` : item.label}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0",
        configurable && "ov-metric-strip-cell ov-metric-strip-cell-host",
      )}
      style={spanStyle}
    >
      {inner}
      {editable ? (
        <button
          type="button"
          className="ov-metric-strip-resize-handle"
          aria-label={`Redimensionar ${item.label}`}
          title="Arraste para ajustar largura e altura"
          onPointerDown={startResize}
          onPointerMove={continueResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        >
          <span aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function clampSpan(value: number): OneViewMetricSpan {
  if (value >= 4) return 4;
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  return 1;
}

function clampRowSpan(value: number): OneViewMetricRowSpan {
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  return 1;
}

export function CompactMetricStrip({
  items,
  footer,
  className,
  gridClassName,
  layoutMode = "auto",
  gridProfile = "chamados",
  density = "default",
  editable = false,
  onMetricSpanChange,
  onMetricRowSpanChange,
  surface = false,
  "aria-label": ariaLabel = "Indicadores",
}: CompactMetricStripProps) {
  const configurable = layoutMode === "configurable";
  const viewportWidth = useViewportWidth();

  return (
    <section aria-label={ariaLabel} className={cn(surface && "ov-panel p-2", className)}>
      <div
        className={cn(
          "ov-live-metric-grid",
          configurable && "ov-metric-strip-grid",
          gridClassName,
          configurable && `ov-metric-strip-density-${density}`,
          editable && "ov-metric-strip-grid-editing",
        )}
      >
        {items.map((item) => (
          <MetricStripCell
            key={item.key}
            item={item}
            configurable={configurable}
            editable={editable && configurable}
            span={item.span ?? 1}
            rowSpan={item.rowSpan ?? 1}
            viewportWidth={viewportWidth}
            gridProfile={gridProfile}
            onSpanChange={onMetricSpanChange ? (span) => onMetricSpanChange(item.key, span) : undefined}
            onRowSpanChange={onMetricRowSpanChange ? (rowSpan) => onMetricRowSpanChange(item.key, rowSpan) : undefined}
          />
        ))}
      </div>
      {footer}
    </section>
  );
}
