import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type OperationalEmptyStateProps = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
};

export function OperationalEmptyState({
  title,
  description,
  icon,
  action,
  compact = false,
  className,
}: OperationalEmptyStateProps) {
  if (compact) {
    return (
      <div className={cn("px-4 py-10 text-center text-muted-foreground", className)}>
        {icon ? <div className="mb-2 flex justify-center">{icon}</div> : null}
        <p className="text-sm">{title}</p>
        {description ? <p className="mt-1 text-xs">{description}</p> : null}
        {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className={cn("px-6 py-14 text-center", className)}>
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3">
        {icon ? (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
        {action}
      </div>
    </div>
  );
}
