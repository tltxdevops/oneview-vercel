import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ONEVIEW_FEEDBACK_CATALOG,
  ONEVIEW_SEVERITY_CATALOG,
  ONEVIEW_STATUS_CATALOG,
  type OneViewFeedbackTone,
  type OneViewSemanticStatus,
  type OneViewSeverity,
} from "@/lib/oneview-design-system";
import { ONEVIEW_ICON_MAP } from "@/lib/oneview-icons";

export function SectionAccentTitle({ children, level = 2, className }: {
  children: ReactNode;
  level?: 1 | 2;
  className?: string;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag className={cn(
      level === 1 ? "shrink-0 ov-type-page-title text-foreground" : "ov-type-section-title",
      className,
    )}>
      {children}<span aria-hidden="true" className="ov-title-signature-accent">_</span>
    </Tag>
  );
}

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

  return <Button variant={implementation[variant]} className={cn("ov-control-official ov-focus-accent", variant === "primary" && "ov-button-primary", className)} {...props} />;
}

export function OneViewTextAction({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn("ov-link-accent ov-focus-accent text-sm font-semibold focus-visible:outline-none", className)} {...props} />;
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

export function SemanticBadge({ label, showDot = true, className, children, ...props }: HTMLAttributes<HTMLSpanElement> & {
  label: string;
  showDot?: boolean;
}) {
  return (
    <span className={cn("ov-semantic-badge", className)} {...props}>
      {showDot ? <span className="ov-semantic-badge-dot" aria-hidden="true" /> : null}
      <span>{children || label}</span>
    </span>
  );
}

export function OneViewSemanticStatusBadge({ status, label, showDot, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  status: OneViewSemanticStatus;
  label?: string;
  showDot?: boolean;
}) {
  const definition = ONEVIEW_STATUS_CATALOG[status];
  return <SemanticBadge label={label || definition.label} showDot={showDot} className={cn("ov-status-badge", definition.className, className)} data-oneview-status={status} {...props} />;
}

export function OneViewSeverityBadge({ severity, label, showDot, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  severity: OneViewSeverity;
  label?: string;
  showDot?: boolean;
}) {
  // A stale runtime payload must degrade to the neutral badge, never blank Alerts.
  const definition = ONEVIEW_SEVERITY_CATALOG[severity] ?? ONEVIEW_SEVERITY_CATALOG.not_classified;
  return <SemanticBadge label={label || definition.label} showDot={showDot} className={cn("ov-severity-badge", definition.className, className)} data-oneview-severity={severity} {...props} />;
}

export function OneViewPill({ selected = false, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "ov-pill-official ov-type-caption ov-focus-accent inline-flex h-8 items-center justify-center border px-3 font-semibold transition-colors focus-visible:outline-none",
        selected ? "border-[hsl(var(--ov-color-accent-blue)/0.55)] bg-[hsl(var(--ov-color-accent-blue)/0.1)] text-[hsl(var(--ov-color-accent-blue))]" : "border-border bg-background text-foreground hover:bg-muted",
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
      data-tone={tone}
      title={hint}
      className={cn("ov-surface ov-kpi-official ov-focus-accent min-w-0 px-4 py-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none", className)}
      {...props}
    >
      <span className="block ov-typography-caption text-muted-foreground">{label}</span>
      <span className={cn("mt-1 block ov-typography-metric", toneClass)}>{value}</span>
    </button>
  );
}

export function OneViewHealthIndicator({ status, label, className, ...props }: HTMLAttributes<HTMLSpanElement> & {
  status: "healthy" | "degraded" | "down" | "unknown";
  label: string;
}) {
  return <span className={cn("ov-health-indicator ov-typography-small", `ov-health-${status}`, className)} {...props}>{label}</span>;
}

export function OneViewFeedback({ tone, title, description, className }: {
  tone: OneViewFeedbackTone;
  title: string;
  description?: string;
  className?: string;
}) {
  const definition = ONEVIEW_FEEDBACK_CATALOG[tone];
  const Icon = ONEVIEW_ICON_MAP[definition.icon];
  return (
    <div
      className={cn("ov-feedback", definition.className, className)}
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      data-oneview-feedback={tone}
    >
      <Icon className="mt-0.5 h-[18px] w-[18px]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="ov-type-body font-bold">{title}</p>
        {description ? <p className="mt-1 ov-type-secondary">{description}</p> : null}
      </div>
    </div>
  );
}
