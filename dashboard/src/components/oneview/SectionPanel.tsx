import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type SectionPanelProps = {
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  "aria-label"?: string;
};

export function SectionPanel({
  title,
  description,
  aside,
  children,
  className,
  bodyClassName,
  "aria-label": ariaLabel,
}: SectionPanelProps) {
  const hasHeader = Boolean(title || description || aside);

  return (
    <section
      aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
      className={cn("ov-panel", className)}
    >
      {hasHeader ? (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2.5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
