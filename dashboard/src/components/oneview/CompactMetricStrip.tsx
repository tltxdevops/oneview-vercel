import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type CompactMetricItem = {
  key: string;
  label: string;
  value: ReactNode;
  description?: string;
  selected?: boolean;
  unknown?: boolean;
  loading?: boolean;
  onClick?: () => void;
  /** Navegação declarativa (Home → Alertas). Preferir a onClick quando ambos existirem. */
  href?: string;
};

type CompactMetricStripProps = {
  items: CompactMetricItem[];
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
};

export function CompactMetricStrip({
  items,
  footer,
  className,
  "aria-label": ariaLabel = "Indicadores",
}: CompactMetricStripProps) {
  return (
    <section aria-label={ariaLabel} className={cn("ov-panel px-1 py-0.5", className)}>
      <div className="flex flex-wrap items-stretch divide-x divide-border/60 md:flex-nowrap">
        {items.map((item) => {
          const content = (
            <>
              <span className="max-w-full truncate text-center text-[11px] font-medium text-muted-foreground">{item.label}</span>
              {item.loading ? (
                <Skeleton className="h-4 w-8" />
              ) : (
                <span className="shrink-0 text-center text-sm font-semibold tabular-nums text-foreground">
                  {item.value}
                </span>
              )}
            </>
          );
          const interactive = Boolean(item.onClick || item.href);
          const classNameItem = cn(
            "flex min-w-[5.5rem] flex-1 flex-col items-center justify-center gap-0.5 px-2 py-1 text-center transition-colors",
            interactive && "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            item.selected && "bg-muted/50",
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
              >
                {content}
              </Link>
            );
          }

          return (
            <div key={item.key} title={item.description} className={classNameItem}>
              {content}
            </div>
          );
        })}
      </div>
      {footer}
    </section>
  );
}
