import type { ReactNode } from "react";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, aside, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0 space-y-1">
        <SectionAccentTitle level={1}>{title}</SectionAccentTitle>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : null}
    </header>
  );
}
