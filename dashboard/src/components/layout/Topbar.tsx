import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TopbarProps {
  clientSection?: ReactNode;
  rightSection?: ReactNode;
  className?: string;
}

export function Topbar({ clientSection, rightSection, className }: TopbarProps) {
  if (!clientSection && !rightSection) {
    return null;
  }

  return (
    <section
      className={cn(
        "sticky top-0 z-30 flex min-h-10 flex-col justify-center border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        className
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        {clientSection && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {clientSection}
          </div>
        )}
        {rightSection && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:shrink-0">
            {rightSection}
          </div>
        )}
      </div>
    </section>
  );
}
