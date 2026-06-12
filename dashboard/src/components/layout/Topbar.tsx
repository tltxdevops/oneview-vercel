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
        "sticky top-0 z-30 flex min-h-[80px] flex-col justify-center border-b border-border/60 bg-white/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/80",
        className
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {clientSection && (
          <div className="flex min-w-0 items-center gap-3">
            {clientSection}
          </div>
        )}
        {rightSection && (
          <div className="flex min-w-0 flex-1 items-center justify-end">
            {rightSection}
          </div>
        )}
      </div>
    </section>
  );
}