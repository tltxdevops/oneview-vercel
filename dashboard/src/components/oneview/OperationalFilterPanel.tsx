import { forwardRef, useEffect, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type OperationalFilterPanelProps = {
  children: ReactNode;
  activeFilterCount?: number;
  onClearFilters?: () => void;
  title?: string;
  description?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  footer?: ReactNode;
};

type FilterTriggerProps = ButtonProps & { activeFilterCount?: number };

const COMPACT_FILTER_BREAKPOINT = 1024;

function useCompactFilterSurface() {
  const [isCompact, setIsCompact] = useState(() => (
    typeof window !== "undefined" && window.innerWidth < COMPACT_FILTER_BREAKPOINT
  ));

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${COMPACT_FILTER_BREAKPOINT - 1}px)`);
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isCompact;
}

const FilterTrigger = forwardRef<HTMLButtonElement, FilterTriggerProps>(function FilterTrigger(
  { activeFilterCount = 0, className, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      {...props}
      type="button"
      size="sm"
      variant={activeFilterCount ? "default" : "outline"}
      className={cn("h-9 shrink-0 gap-1.5", className)}
    >
      <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      Filtros
      {activeFilterCount ? <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{activeFilterCount}</Badge> : null}
    </Button>
  );
});

function FilterContents({
  children,
  activeFilterCount = 0,
  onClearFilters,
  footer,
}: Pick<OperationalFilterPanelProps, "children" | "activeFilterCount" | "onClearFilters" | "footer">) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1 sm:px-0">
        {children}
      </div>
      {footer ? (
        <div className="sticky bottom-0 shrink-0 border-t border-border/60 bg-background/95 pt-3 backdrop-blur">{footer}</div>
      ) : activeFilterCount && onClearFilters ? (
        <div className="sticky bottom-0 flex shrink-0 justify-end border-t border-border/60 bg-background/95 pt-3 backdrop-blur">
          <Button type="button" size="sm" variant="ghost" onClick={onClearFilters}>Limpar filtros</Button>
        </div>
      ) : null}
    </>
  );
}

/** Shared responsive filter surface: bounded popover through notebook widths; sheet only on mobile. */
export function OperationalFilterPanel({
  children,
  activeFilterCount = 0,
  onClearFilters,
  title = "Filtros específicos",
  description = "Use somente quando precisar refinar os resultados.",
  className,
  open: controlledOpen,
  onOpenChange,
  footer,
}: OperationalFilterPanelProps) {
  const isCompact = useCompactFilterSurface();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  if (isCompact) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild><FilterTrigger activeFilterCount={activeFilterCount} /></SheetTrigger>
        <SheetContent
          side="bottom"
          overlayClassName="bg-black/40"
          className="flex max-h-[82dvh] min-h-0 w-full flex-col gap-2 overflow-hidden rounded-t-2xl p-3 sm:max-w-none"
        >
          <SheetHeader className="shrink-0 pr-8 text-left">
            <SheetTitle className="text-sm">{title}</SheetTitle>
            <SheetDescription className="text-xs">{description}</SheetDescription>
          </SheetHeader>
          <FilterContents activeFilterCount={activeFilterCount} onClearFilters={onClearFilters} footer={footer}>{children}</FilterContents>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><FilterTrigger activeFilterCount={activeFilterCount} /></PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        collisionPadding={8}
        style={{
          width: "min(58rem, calc(100vw - 2rem))",
          maxHeight: "min(78dvh, var(--radix-popover-content-available-height))",
        }}
        className={cn("flex min-w-0 flex-col gap-3 overflow-hidden p-4", className)}
      >
        <div className="shrink-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <FilterContents activeFilterCount={activeFilterCount} onClearFilters={onClearFilters} footer={footer}>{children}</FilterContents>
      </PopoverContent>
    </Popover>
  );
}

export function OperationalFilterGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2", className)}>
      {children}
    </div>
  );
}

export function OperationalFilterSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 space-y-2", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <OperationalFilterGrid>{children}</OperationalFilterGrid>
    </section>
  );
}
