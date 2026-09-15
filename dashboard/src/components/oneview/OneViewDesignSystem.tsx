import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ONEVIEW_SEVERITY_CATALOG,
  ONEVIEW_STATUS_CATALOG,
  type OneViewSemanticStatus,
  type OneViewSeverity,
} from "@/lib/oneview-design-system";

export function OneViewPanel({ title, description, action, className, children }: {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("ov-surface-official overflow-hidden", className)} aria-label={title}>
      {title || description || action ? (
        <header className="flex items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="ov-type-section-title">{title}</h2> : null}
            {description ? <p className="mt-1 ov-type-secondary text-muted-foreground">{description}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

type OneViewButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function OneViewButton({ variant = "primary", className, ...props }: Omit<ComponentProps<typeof Button>, "variant"> & {
  variant?: OneViewButtonVariant;
}) {
  const implementation = {
    primary: "default",
    secondary: "outline",
    ghost: "ghost",
    danger: "destructive",
  } as const;

  return <Button variant={implementation[variant]} className={cn("ov-control-official", className)} {...props} />;
}

export function OneViewTextAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("text-sm font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} {...props} />;
}

/** @deprecated Compatibility wrapper. New code uses OneViewPanel. */
export function OneViewSurface({ title, description, className, children }: {
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("ov-surface overflow-hidden", className)} aria-label={title}>
      <header className="border-b border-border/60 px-4 py-3">
        <h2 className="ov-typography-section-title">{title}</h2>
        {description ? <p className="mt-1 ov-typography-small text-muted-foreground">{description}</p> : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function OneViewSemanticStatusBadge({ status, label, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  status: OneViewSemanticStatus;
  label?: string;
}) {
  const definition = ONEVIEW_STATUS_CATALOG[status];
  return <span className={cn("ov-status-badge", definition.className, className)} data-oneview-status={status} {...props}>{label || definition.label}</span>;
}

export function OneViewSeverityBadge({ severity, label, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  severity: OneViewSeverity;
  label?: string;
}) {
  const definition = ONEVIEW_SEVERITY_CATALOG[severity];
  return <span className={cn("ov-severity-badge", definition.className, className)} data-oneview-severity={severity} {...props}>{label || definition.label}</span>;
}

export function OneViewPill({ selected = false, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "ov-pill-official ov-type-caption inline-flex h-8 items-center justify-center border px-3 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function OneViewKpiCard({ label, value, hint, tone = "neutral", selected = false, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "danger" | "success" | "warning" | "info" | "recurrence";
  selected?: boolean;
}) {
  const toneClass = {
    neutral: "text-foreground",
    danger: "text-[hsl(var(--ov-color-danger))]",
    success: "text-[hsl(var(--ov-color-success))]",
    warning: "text-[hsl(var(--ov-color-warning))]",
    info: "text-[hsl(var(--ov-color-info))]",
    recurrence: "text-[hsl(var(--ov-color-recurrence))]",
  }[tone];
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn("ov-surface min-w-0 px-4 py-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected && "ring-2 ring-ring", className)}
      {...props}
    >
      <span className="block ov-typography-caption text-muted-foreground">{label}</span>
      <span className={cn("mt-1 block ov-typography-metric", toneClass)}>{value}</span>
      {hint ? <span className="mt-1 block ov-typography-caption text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

export function OneViewHealthIndicator({ status, label, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  status: "healthy" | "degraded" | "down" | "unknown";
  label: string;
}) {
  return <span className={cn("ov-health-indicator ov-typography-small", `ov-health-${status}`, className)} {...props}>{label}</span>;
}
