import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type FilterBarProps = {
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
};

export function FilterBar({
  children,
  footer,
  className,
  "aria-label": ariaLabel = "Filtros",
}: FilterBarProps) {
  return (
    <section aria-label={ariaLabel} className={cn("ov-panel p-2.5", className)}>
      {children}
      {footer ? <div className="mt-2 flex flex-wrap items-center justify-end gap-2">{footer}</div> : null}
    </section>
  );
}
