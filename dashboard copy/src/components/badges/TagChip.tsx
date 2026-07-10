import { cn } from "@/lib/utils";

interface TagChipProps {
  tag: string;
  className?: string;
}

export function TagChip({ tag, className }: TagChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        "bg-muted text-muted-foreground border border-border",
        className
      )}
    >
      {tag}
    </span>
  );
}
