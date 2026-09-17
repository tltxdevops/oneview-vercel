import { ReactNode } from "react";
import { TeletexMark } from "@/components/layout/TeletexMark";
import { cn } from "@/lib/utils";

interface TopbarProps {
  clientSection?: ReactNode;
  rightSection?: ReactNode;
  className?: string;
  showBrand?: boolean;
}

export function Topbar({ clientSection, rightSection, className, showBrand = false }: TopbarProps) {
  if (!clientSection && !rightSection && !showBrand) {
    return null;
  }

  return (
    <section
      className={cn(
        "sticky top-0 z-30 flex h-14 shrink-0 items-center border-b border-border/60 bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {showBrand ? <TeletexMark inverted className="shrink-0" /> : null}
        {clientSection ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {clientSection}
          </div>
        ) : null}
        {rightSection ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 sm:shrink-0">
            {rightSection}
          </div>
        ) : null}
      </div>
    </section>
  );
}
