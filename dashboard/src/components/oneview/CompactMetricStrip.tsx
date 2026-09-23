import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import type { OneViewMetricSpan, OneViewMetricStripDensity } from "@/lib/oneview-metric-strip-preferences";
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
};

type CompactMetricStripProps = {
  items: CompactMetricItem[];
  footer?: ReactNode;
  className?: string;
  /** Sobrescreve o grid padrão (ex.: fila densa de KPIs em Chamados). */
  gridClassName?: string;
  /** Grid de 12 colunas com span por card (Organizar painel → Indicadores). */
  layoutMode?: "auto" | "configurable";
  density?: OneViewMetricStripDensity;
  /** Evita uma segunda surface quando o strip já está dentro de um painel. */
  surface?: boolean;
  "aria-label"?: string;
};

export function CompactMetricStrip({
  items,
  footer,
  className,
  gridClassName,
  layoutMode = "auto",
  density = "default",
  surface = false,
  "aria-label": ariaLabel = "Indicadores",
}: CompactMetricStripProps) {
  const configurable = layoutMode === "configurable";
  return (
    <section aria-label={ariaLabel} className={cn(surface && "ov-panel p-2", className)}>
      <div
        className={cn(
          configurable ? "ov-metric-strip-grid" : "ov-live-metric-grid",
          configurable && `ov-metric-strip-density-${density}`,
          gridClassName,
        )}
      >
        {items.map((item) => {
          const spanStyle = configurable
            ? ({ "--ov-metric-span": item.span ?? 1 } as CSSProperties)
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
          const interactive = Boolean(item.onClick || item.href);
          const classNameItem = cn(
            "ov-live-metric flex min-w-0 flex-col items-start justify-center gap-1 px-4 py-3 text-left transition-colors",
            configurable && "ov-metric-strip-cell",
            interactive && "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          );

          if (item.onClick) {
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.selected}
                aria-label={`Filtrar alertas: ${item.label}${item.unknown ? " (Sem informação)" : ""}`}
                title={item.description}
                onClick={item.onClick}
                className={classNameItem}
                style={spanStyle}
                data-tone={item.tone ?? "neutral"}
              >
                {content}
              </button>
            );
          }

          if (item.href) {
            return (
              <Link
                key={item.key}
                to={item.href}
                aria-label={`Abrir alertas: ${item.label}${item.unknown ? " (Sem informação)" : ""}`}
                title={item.description}
                className={classNameItem}
                style={spanStyle}
                data-tone={item.tone ?? "neutral"}
              >
                {content}
              </Link>
            );
          }

          return (
            <div key={item.key} title={item.description} className={classNameItem} style={spanStyle} data-tone={item.tone ?? "neutral"}>
              {content}
            </div>
          );
        })}
      </div>
      {footer}
    </section>
  );
}
