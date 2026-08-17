import { Link } from "react-router-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OV_CTA } from "@/lib/oneview-operational-ui";

type OperationalCtaProps = Omit<ButtonProps, "size" | "asChild"> & {
  to?: string;
};

/**
 * CTA operacional canônico (Ver todos / Abrir / Limpar).
 * h-7 text-xs — sem pills.
 */
export function OperationalCta({
  className,
  variant = "ghost",
  to,
  children,
  type = "button",
  ...props
}: OperationalCtaProps) {
  const classes = cn(OV_CTA, className);
  if (to) {
    return (
      <Button type={type} size="sm" variant={variant} className={classes} asChild>
        <Link to={to}>{children}</Link>
      </Button>
    );
  }
  return (
    <Button type={type} size="sm" variant={variant} className={classes} {...props}>
      {children}
    </Button>
  );
}
