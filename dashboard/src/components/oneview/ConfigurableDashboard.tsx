import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Eye, EyeOff, GripVertical, Minus, Plus, RotateCcw, Settings2, Tv, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  compactOneViewDashboardWidgets,
  ONEVIEW_DASHBOARD_TEMPLATE_LABEL,
  ONEVIEW_DASHBOARD_TEMPLATES,
  type OneViewDashboardWidget,
} from "@/lib/oneview-dashboard-layout";
import { ConfigurableMetricStripPanel } from "@/components/oneview/ConfigurableMetricStripPanel";
import { type OneViewDashboardController } from "@/lib/oneview-dashboard-controller";
import type { OneViewMetricStripController } from "@/lib/oneview-metric-strip-preferences";
import { cn } from "@/lib/utils";

export type OneViewDashboardSlot = {
  id: string;
  children: ReactNode;
};

type DashboardResizeGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  columnSize: number;
  columnScale: number;
  rowSize: number;
  lastWidth: number;
  lastHeight: number;
};

type DashboardDragGesture = {
  pointerId: number;
  startX: number;
  startY: number;
};

const OneViewDashboardContext = createContext<OneViewDashboardController | null>(null);
function layoutItem(controller: OneViewDashboardController, id: string) {
  return compactOneViewDashboardWidgets(controller.layout.widgets).find((candidate) => candidate.id === id) ?? null;
}

function DashboardToolbar({
  controller,
  metricStrip,
}: {
  controller: OneViewDashboardController;
  metricStrip?: OneViewMetricStripController<string>;
}) {
  const { layout, widgets, isEditing, isWallboard } = controller;
  const [open, setOpen] = useState(false);
  const visibleItems = compactOneViewDashboardWidgets(layout.widgets).filter((item) => !item.hidden);
  const visibleCount = visibleItems.length;
  const finishEditing = () => {
    controller.setDraggedId(null);
    controller.setEditing(false);
    setOpen(false);
  };

  if (isWallboard) {
    return (
      <div className="ov-dashboard-wallboard-exit">
        <span className="ov-typography-small hidden sm:inline">Wallboard</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ov-filter-control gap-1.5 px-2.5"
          onClick={() => controller.selectTemplate("operational")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Sair do wallboard
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("ov-dashboard-toolbar", !isEditing && "ov-dashboard-toolbar-floating")} aria-label="Configuração do painel">
      {isEditing ? (
        <div className="ov-dashboard-edit-bar">
          <p className="ov-typography-small text-muted-foreground">
            Painéis: arraste pela alça e redimensione pelo canto. Indicadores (Total, Abertos…): use o canto de cada card.
          </p>
          <Button
            type="button"
            size="sm"
            className="ov-dashboard-finish-button"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              finishEditing();
            }}
            onClick={finishEditing}
          >
            Concluir
          </Button>
          <Button type="button" size="sm" variant="ghost" className="ov-filter-control h-7 gap-1.5 px-2.5" onClick={controller.resetLayout}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Restaurar
          </Button>
        </div>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className={cn("ov-dashboard-organize ov-dashboard-organize-fab", (isEditing || open) && "ov-dashboard-organize-active")}
            aria-label="Organizar painel"
            title="Organizar painel"
            aria-expanded={open}
            aria-haspopup="dialog"
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-[min(24rem,calc(100vw-2rem))] space-y-3 p-3">
          <div className="space-y-1.5">
            <p className="ov-typography-caption uppercase text-muted-foreground">Disposição</p>
            <div className="ov-segmented-control" role="group" aria-label="Template do painel">
              {ONEVIEW_DASHBOARD_TEMPLATES.filter((template) => template !== "wallboard").map((template) => (
                <Button
                  key={template}
                  type="button"
                  size="sm"
                  variant={layout.template === template ? "default" : "ghost"}
                  className="ov-segmented-item px-2.5"
                  aria-pressed={layout.template === template}
                  onClick={() => controller.selectTemplate(template)}
                >
                  {ONEVIEW_DASHBOARD_TEMPLATE_LABEL[template]}
                </Button>
              ))}
            </div>
            <p className="ov-typography-caption text-muted-foreground">
              Celular e tablet vertical: 1 coluna · Tablet horizontal: até 2 · Desktop: grade de 12.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={isEditing ? "default" : "outline"}
              className="ov-filter-control gap-1.5 px-2.5"
              aria-pressed={isEditing}
              onClick={() => {
                if (isEditing) finishEditing();
                else {
                  controller.setEditing(true);
                  setOpen(false);
                }
              }}
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
              {isEditing ? "Concluir ajuste" : "Ajustar tamanho e posição"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ov-filter-control gap-1.5 px-2.5"
              onClick={() => {
                controller.selectTemplate("wallboard");
                setOpen(false);
              }}
            >
              <Tv className="h-3.5 w-3.5" aria-hidden="true" />
              Wallboard
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ov-filter-control gap-1.5 px-2.5"
              onClick={controller.resetLayout}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Restaurar
            </Button>
          </div>
          <div className="space-y-1">
            <p className="ov-typography-caption uppercase text-muted-foreground">Painéis visíveis</p>
            {widgets.map((widget) => {
              const item = layoutItem(controller, widget.id);
              const hidden = Boolean(item?.hidden);
              const lastVisible = !hidden && visibleCount <= 1;
              return (
                <Button
                  key={widget.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full justify-start gap-2 px-2 text-xs"
                  aria-pressed={!hidden}
                  disabled={lastVisible}
                  onClick={() => controller.updateWidget(widget.id, { hidden: !hidden })}
                >
                  {hidden ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                  <span className="truncate">{widget.title}</span>
                </Button>
              );
            })}
          </div>
          {metricStrip ? <ConfigurableMetricStripPanel controller={metricStrip} /> : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DashboardWidgetFrame({
  controller,
  definition,
  draggedId,
  setDraggedId,
  children,
}: {
  controller: OneViewDashboardController;
  definition: OneViewDashboardWidget;
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  children: ReactNode;
}) {
  const resizeGesture = useRef<DashboardResizeGesture | null>(null);
  const dragGesture = useRef<DashboardDragGesture | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const item = layoutItem(controller, definition.id);
  const editable = controller.isEditing;

  useEffect(() => {
    if (editable) return;
    resizeGesture.current = null;
    dragGesture.current = null;
    setPreviewSize(null);
    setDragOffset(null);
    setIsResizing(false);
    setDraggedId(null);
  }, [editable, setDraggedId]);

  if (!item || item.hidden) return null;

  const width = previewSize?.width ?? item.width;
  const height = previewSize?.height ?? item.height;

  const style = {
    "--ov-dashboard-width": width,
    "--ov-dashboard-height": height,
    "--ov-dashboard-tablet-width": Math.max(3, Math.min(6, Math.ceil(width / 2))),
    order: item.order,
    transform: dragOffset ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)` : undefined,
    zIndex: draggedId === definition.id ? 3 : undefined,
  } as CSSProperties;
  const itemLimitOptions = definition.itemLimitOptions ?? [];
  const itemLimit = item.itemLimit ?? definition.defaultItemLimit ?? itemLimitOptions[0];
  const itemLimitIndex = itemLimitOptions.findIndex((option) => option === itemLimit);
  const previousItemLimit = itemLimitIndex > 0 ? itemLimitOptions[itemLimitIndex - 1] : null;
  const nextItemLimit = itemLimitIndex >= 0 && itemLimitIndex < itemLimitOptions.length - 1
    ? itemLimitOptions[itemLimitIndex + 1]
    : null;

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const grid = event.currentTarget.closest<HTMLElement>(".ov-dashboard-grid");
    if (!grid) return;
    const viewportWidth = window.innerWidth;
    const columns = viewportWidth >= 1280 ? 12 : viewportWidth >= 1024 ? 6 : 1;
    if (columns === 1) return;
    const gridStyle = window.getComputedStyle(grid);
    const columnGap = Number.parseFloat(gridStyle.columnGap) || 0;
    const gridWidth = grid.getBoundingClientRect().width;
    const columnSize = Math.max(1, (gridWidth - columnGap * (columns - 1)) / columns);
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: width,
      startHeight: height,
      columnSize,
      columnScale: 12 / columns,
      rowSize: viewportWidth >= 1280 ? 64 : 56,
      lastWidth: width,
      lastHeight: height,
    };
    setIsResizing(true);
  };

  const continueResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const widthDelta = Math.round((event.clientX - gesture.startX) / gesture.columnSize) * gesture.columnScale;
    const heightDelta = Math.round((event.clientY - gesture.startY) / gesture.rowSize);
    const width = Math.max(definition.minWidth, Math.min(12, Math.round(gesture.startWidth + widthDelta)));
    const height = Math.max(definition.minHeight, Math.min(8, gesture.startHeight + heightDelta));
    if (width === gesture.lastWidth && height === gesture.lastHeight) return;
    gesture.lastWidth = width;
    gesture.lastHeight = height;
    setPreviewSize({ width, height });
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = resizeGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { lastWidth, lastHeight } = gesture;
    resizeGesture.current = null;
    setPreviewSize(null);
    setIsResizing(false);
    controller.updateWidget(definition.id, { width: lastWidth, height: lastHeight });
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || item.pinned || isResizing) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    setDraggedId(definition.id);
    setDragOffset({ x: 0, y: 0 });
  };

  const continueDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setDragOffset({ x: event.clientX - gesture.startX, y: event.clientY - gesture.startY });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragGesture.current = null;
    setDragOffset(null);
    setDraggedId(null);

    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-dashboard-widget-id]"))
      .find((candidate) => {
        if (candidate.dataset.dashboardWidgetId === definition.id) return false;
        const rect = candidate.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
    const targetId = target?.dataset.dashboardWidgetId;
    if (targetId) controller.reorderWidgets(definition.id, targetId);
  };

  return (
    <article
      className={cn(
        "ov-dashboard-widget",
        editable && "ov-dashboard-widget-editing",
        item.pinned && "ov-dashboard-widget-pinned",
        isResizing && "ov-dashboard-widget-resizing",
        draggedId === definition.id && "ov-dashboard-widget-dragging",
      )}
      style={style}
      data-dashboard-widget-id={definition.id}
      data-dashboard-width={width}
      data-dashboard-height={height}
      aria-label={`${definition.title}${item.pinned ? ", fixado" : ""}`}
    >
      {editable ? (
        <div className="ov-dashboard-widget-editor" role="toolbar" aria-label={`Editar ${definition.title}`}>
          <button
            type="button"
            className="ov-dashboard-drag-handle"
            aria-label={`Arrastar ${definition.title} para outra posição`}
            disabled={item.pinned}
            onPointerDown={startDrag}
            onPointerMove={continueDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            Arrastar
          </button>
          <div className="ov-dashboard-widget-editor-controls">
            {itemLimitOptions.length > 0 && itemLimit != null ? (
              <div className="ov-dashboard-size-control" role="group" aria-label={`Quantidade de itens em ${definition.title}`}>
                <span className="ov-dashboard-size-label">Itens</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Mostrar menos itens em ${definition.title}`}
                  disabled={previousItemLimit == null}
                  onClick={() => previousItemLimit != null && controller.updateWidget(definition.id, { itemLimit: previousItemLimit })}
                >
                  <Minus className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <output className="ov-dashboard-size-value" aria-label={`${itemLimit} itens visíveis em ${definition.title}`}>
                  {itemLimit}
                </output>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={`Mostrar mais itens em ${definition.title}`}
                  disabled={nextItemLimit == null}
                  onClick={() => nextItemLimit != null && controller.updateWidget(definition.id, { itemLimit: nextItemLimit })}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
            <div className="ov-dashboard-order-control" role="group" aria-label={`Posição de ${definition.title}`}>
            </div>
          </div>
          <span className="ov-dashboard-resize-hint">Canto: redimensionar</span>
        </div>
      ) : null}
      {children}
      {editable ? (
        <button
          type="button"
          className="ov-dashboard-resize-handle"
          aria-label={`Redimensionar ${definition.title} pelo canto`}
          title="Arraste para ajustar largura e altura"
          onPointerDown={startResize}
          onPointerMove={continueResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
        >
          <span aria-hidden="true" />
        </button>
      ) : null}
    </article>
  );
}

export function ConfigurableDashboardWidget({ id, children }: OneViewDashboardSlot) {
  const controller = useContext(OneViewDashboardContext);
  if (!controller) {
    throw new Error("ConfigurableDashboardWidget deve ser utilizado dentro de ConfigurableDashboard");
  }
  const definition = controller.widgets.find((widget) => widget.id === id);
  if (!definition) return null;
  return (
    <DashboardWidgetFrame
      controller={controller}
      definition={definition}
      draggedId={controller.draggedId}
      setDraggedId={controller.setDraggedId}
    >
      {children}
    </DashboardWidgetFrame>
  );
}

export function ConfigurableDashboard({
  controller,
  children,
  className,
  metricStrip,
}: {
  controller: OneViewDashboardController;
  children: ReactNode;
  className?: string;
  metricStrip?: OneViewMetricStripController<string>;
}) {
  return (
    <OneViewDashboardContext.Provider value={controller}>
      <section
        className={cn("ov-dashboard", controller.isWallboard && "ov-dashboard-wallboard", className)}
        data-dashboard-page={controller.layout.page}
        data-dashboard-template={controller.layout.template}
      >
        <DashboardToolbar controller={controller} metricStrip={metricStrip} />
        <div className="ov-dashboard-grid">{children}</div>
      </section>
    </OneViewDashboardContext.Provider>
  );
}
