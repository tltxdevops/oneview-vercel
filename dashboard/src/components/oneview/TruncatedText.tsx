import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type TruncatedTextProps = {
  children: ReactNode;
  /** Texto completo do tooltip nativo; default = children string. */
  title?: string;
  className?: string;
  as?: "span" | "p" | "div";
};

/** Truncation + tooltip nativo consistente (listas/tabelas). */
export function TruncatedText({
  children,
  title,
  className,
  as: Tag = "span",
}: TruncatedTextProps) {
  const tip = title ?? (typeof children === "string" ? children : undefined);
  return (
    <Tag className={cn("block min-w-0 truncate", className)} title={tip || undefined}>
      {children}
    </Tag>
  );
}
