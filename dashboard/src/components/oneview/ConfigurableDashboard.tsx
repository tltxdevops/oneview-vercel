import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { Eye, EyeOff, GripVertical, Pin, PinOff, RotateCcw, Settings2, Tv, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  compactOneViewDashboardWidgets,
  ONEVIEW_DASHBOARD_TEMPLATE_LABEL,
  ONEVIEW_DASHBOARD_TEMPLATES,
  type OneViewDashboardWidget,
} from "@/lib/oneview-dashboard-layout";
import { type OneViewDashboardController } from "@/lib/oneview-dashboard-controller";
import { cn } from "@/lib/utils";

export type OneViewDashboardSlot = {
  id: string;
  children: ReactNode;
};

const OneViewDashboardContext = createContext<OneViewDashboardController | null>(null);
const WIDTH_PRESETS = [
  { width: 4, label: "1/3" },
  { width: 6, label: "1/2" },
  { width: 8, label: "2/3" },
  { width: 12, label: "Cheia" },
] as const;

function layoutItem(controller: OneViewDashboardController, id: string) {
  return compactOneViewDashboardWidgets(controller.layout.widgets).find((candidate) => candidate.id === id) ?? null;
}

function DashboardToolbar({ controller }: { controller: OneViewDashboardController }) {
  const { layout, widgets, isEditing, isWallboard } = controller;
  const [open, setOpen] = useState(false);
  const visibleItems = compactOneViewDashboardWidgets(layout.widgets).filter((item) => !item.hidden);
  const visibleCount = visibleItems.length;

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
    <div className="ov-dashboard-toolbar" aria-label="Configuração do painel">
      {isEditing ? (
        <div className="ov-dashboard-edit-bar">
          <p className="ov-typography-small text-muted-foreground">
            Arraste para reordenar. Escolha 1/3, 1/2, 2/3 ou Cheia em cada painel.
          </p>
          <Button type="button" size="sm" className="ov-filter-control h-7 px-2.5" onClick={() => controller.setEditing(false)}>
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
            variant="ghost"
            className={cn("ov-dashboard-organize", (isEditing || open) && "ov-dashboard-organize-active")}
            aria-label="Organizar painel"
            title="Organizar painel"
            aria-expanded={open}
            aria-haspopup="dialog"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-3 p-3">
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
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={isEditing ? "default" : "outline"}
              className="ov-filter-control gap-1.5 px-2.5"
              aria-pressed={isEditing}
              onClick={() => {
                controller.setEditing(!isEditing);
                if (!isEditing) setOpen(false);
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
  const item = layoutItem(controller, definition.id);
  const visibleCount = compactOneViewDashboardWidgets(controller.layout.widgets).filter((candidate) => !candidate.hidden).length;
  if (!item || item.hidden) return null;

  const style = {
    "--ov-dashboard-width": item.width,
    "--ov-dashboard-height": item.height,
    order: item.order,
  } as CSSProperties;
  const editable = controller.isEditing;
  const lastVisible = visibleCount <= 1;
  const widthChoices = WIDTH_PRESETS.filter((preset) => preset.width >= definition.minWidth);
  const heightChoices = Array.from(new Set([
    definition.minHeight,
    Math.min(8, Math.max(definition.minHeight + 1, 5)),
    8,
  ]));

  return (
    <article
      className={cn("ov-dashboard-widget", editable && "ov-dashboard-widget-editing", item.pinned && "ov-dashboard-widget-pinned")}
      style={style}
      draggable={editable && !item.pinned}
      onDragStart={(event) => {
        if (!editable || item.pinned) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", definition.id);
        setDraggedId(definition.id);
      }}
      onDragEnd={() => setDraggedId(null)}
      onDragOver={(event) => {
        if (!editable || item.pinned) return;
        const sourceId = draggedId;
        if (!sourceId || sourceId === definition.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
        if (sourceId) controller.reorderWidgets(sourceId, definition.id);
        setDraggedId(null);
      }}
      aria-label={`${definition.title}${item.pinned ? ", fixado" : ""}`}
    >
      {editable ? (
        <div className="ov-dashboard-widget-editor" role="toolbar" aria-label={`Editar ${definition.title}`}>
          <span className="inline-flex items-center gap-1.5 ov-typography-caption text-muted-foreground">
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
            Arrastar
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <span className="sr-only">Largura</span>
            {widthChoices.map((preset) => (
              <Button
                key={preset.width}
                type="button"
                size="sm"
                variant={item.width === preset.width ? "secondary" : "ghost"}
                className="h-6 px-1.5 text-[11px]"
                aria-label={`Largura ${preset.label} para ${definition.title}`}
                aria-pressed={item.width === preset.width}
                onClick={() => controller.updateWidget(definition.id, { width: preset.width })}
              >
                {preset.label}
              </Button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <span className="sr-only">Altura</span>
            {heightChoices.map((height, index) => {
              const label = index === 0 ? "Baixa" : index === heightChoices.length - 1 ? "Alta" : "Média";
              return (
                <Button
                  key={height}
                  type="button"
                  size="sm"
                  variant={item.height === height ? "secondary" : "ghost"}
                  className="h-6 px-1.5 text-[11px]"
                  aria-label={`Altura ${label} para ${definition.title}`}
                  aria-pressed={item.height === height}
                  onClick={() => controller.updateWidget(definition.id, { height })}
                >
                  {label}
                </Button>
              );
            })}
            <Button
              type="button"
              size="icon"
              variant={item.pinned ? "secondary" : "ghost"}
              className="h-6 w-6"
              aria-label={`${item.pinned ? "Desafixar" : "Fixar"} ${definition.title}`}
              aria-pressed={item.pinned}
              onClick={() => controller.updateWidget(definition.id, { pinned: !item.pinned })}
            >
              {item.pinned ? <PinOff className="h-3 w-3" aria-hidden="true" /> : <Pin className="h-3 w-3" aria-hidden="true" />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={lastVisible}
              aria-label={`Ocultar ${definition.title}`}
              onClick={() => controller.updateWidget(definition.id, { hidden: true })}
            >
              <EyeOff className="h-3 w-3" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
      {children}
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
}: {
  controller: OneViewDashboardController;
  children: ReactNode;
  className?: string;
}) {
  return (
    <OneViewDashboardContext.Provider value={controller}>
      <section
        className={cn("ov-dashboard", controller.isWallboard && "ov-dashboard-wallboard", className)}
        data-dashboard-page={controller.layout.page}
        data-dashboard-template={controller.layout.template}
      >
        <DashboardToolbar controller={controller} />
        <div className="ov-dashboard-grid">{children}</div>
      </section>
    </OneViewDashboardContext.Provider>
  );
}
