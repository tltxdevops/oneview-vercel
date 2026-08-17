import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OV_FILTER_DIVIDER } from "@/lib/oneview-operational-ui";

type OperationalFilterGroupProps = {
  /** Nome do grupo para a11y (Cliente, Severidade, Modo, Período…). */
  label: string;
  children: ReactNode;
  className?: string;
  /** Exibe divisor à esquerda (separação visual entre grupos). */
  showDivider?: boolean;
};

/** Agrupa controles de filtro sem misturar Cliente / Severidade / Modo / Período. */
export function OperationalFilterGroup({
  label,
  children,
  className,
  showDivider = false,
}: OperationalFilterGroupProps) {
  return (
    <>
      {showDivider ? <span className={OV_FILTER_DIVIDER} aria-hidden="true" /> : null}
      <div className={cn("inline-flex flex-wrap items-center gap-1", className)} role="group" aria-label={label}>
        {children}
      </div>
    </>
  );
}
