import { useState } from "react";
import { Check, ChevronDown, ChevronUp, GripVertical, Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ONEVIEW_METRIC_STRIP_DENSITY_LABEL,
  type OneViewMetricStripController,
} from "@/lib/oneview-metric-strip-preferences";
import { cn } from "@/lib/utils";

export function ConfigurableMetricStripPanel<MetricId extends string>({
  controller,
  title = "Indicadores",
}: {
  controller: OneViewMetricStripController<MetricId>;
  title?: string;
}) {
  const [draggedId, setDraggedId] = useState<MetricId | null>(null);

  return (
    <div className="space-y-2 border-t border-border/70 pt-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="ov-typography-caption uppercase text-muted-foreground">{title}</p>
          <p className="text-[10px] text-muted-foreground">Mostrar, ordenar e ajustar largura/altura. No modo edição, arraste o canto de cada card.</p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label="Restaurar indicadores"
          title="Restaurar indicadores"
          onClick={controller.reset}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div className="ov-segmented-control w-full" role="group" aria-label="Densidade dos indicadores">
        {(["compact", "default", "comfortable"] as const).map((density) => (
          <Button
            key={density}
            type="button"
            size="sm"
            variant={controller.density === density ? "default" : "ghost"}
            className="ov-segmented-item flex-1 px-2 text-[11px]"
            aria-pressed={controller.density === density}
            onClick={() => controller.setDensity(density)}
          >
            {ONEVIEW_METRIC_STRIP_DENSITY_LABEL[density]}
          </Button>
        ))}
      </div>
      <div className="max-h-[min(18rem,40vh)] space-y-1 overflow-y-auto pr-0.5">
        {controller.orderedMetrics.map((metric, index) => {
          const visible = controller.visibility[metric.id] !== false;
          const span = controller.span[metric.id] ?? 1;
          const rowSpan = controller.rowSpan[metric.id] ?? 1;
          const visibleCount = controller.orderedMetrics.filter((item) => controller.visibility[item.id] !== false).length;
          const lastVisible = visible && visibleCount <= 1;
          return (
            <div
              key={metric.id}
              draggable
              onDragStart={(event) => {
                setDraggedId(metric.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", metric.id);
              }}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = (draggedId || event.dataTransfer.getData("text/plain")) as MetricId;
                if (source) controller.reorder(source, metric.id);
                setDraggedId(null);
              }}
              className={cn(
                "flex min-h-9 items-center gap-0.5 rounded-md border border-transparent px-0.5 transition-colors hover:bg-muted/60",
                draggedId === metric.id && "border-border bg-muted/70 opacity-60",
              )}
            >
              <span className="grid h-7 w-5 shrink-0 cursor-grab place-items-center text-muted-foreground active:cursor-grabbing" title="Arrastar indicador">
                <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 min-w-0 flex-1 justify-start gap-2 px-1 text-xs"
                disabled={metric.required || lastVisible}
                aria-pressed={visible}
                onClick={() => controller.setVisible(metric.id, !visible)}
              >
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border">
                  {visible ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                </span>
                <span className="truncate">{metric.label}{metric.required ? " (fixo)" : ""}</span>
              </Button>
              <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-0.5" role="group" aria-label={`Largura de ${metric.label}`}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  disabled={span <= 1}
                  aria-label={`Diminuir ${metric.label}`}
                  onClick={() => controller.decreaseSpan(metric.id)}
                >
                  <Minus className="h-3 w-3" aria-hidden="true" />
                </Button>
                <span className="min-w-[1.25rem] text-center text-[10px] font-semibold tabular-nums" aria-label={`${span} colunas`}>
                  {span}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  disabled={span >= 4}
                  aria-label={`Aumentar largura de ${metric.label}`}
                  onClick={() => controller.increaseSpan(metric.id)}
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-0.5" role="group" aria-label={`Altura de ${metric.label}`}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  disabled={rowSpan <= 1}
                  aria-label={`Diminuir altura de ${metric.label}`}
                  onClick={() => controller.decreaseRowSpan(metric.id)}
                >
                  <Minus className="h-3 w-3" aria-hidden="true" />
                </Button>
                <span className="min-w-[1.25rem] text-center text-[10px] font-semibold tabular-nums" aria-label={`${rowSpan} linhas`}>
                  {rowSpan}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  disabled={rowSpan >= 3}
                  aria-label={`Aumentar altura de ${metric.label}`}
                  onClick={() => controller.increaseRowSpan(metric.id)}
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                </Button>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-6"
                disabled={index === 0}
                aria-label={`Mover ${metric.label} para cima`}
                onClick={() => controller.move(metric.id, -1)}
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-6"
                disabled={index === controller.orderedMetrics.length - 1}
                aria-label={`Mover ${metric.label} para baixo`}
                onClick={() => controller.move(metric.id, 1)}
              >
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
