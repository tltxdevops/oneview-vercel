import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type OperationalErrorBannerProps = {
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retryDisabled?: boolean;
  className?: string;
};

export function OperationalErrorBanner({
  message,
  onRetry,
  retryLabel = "Tentar novamente",
  retryDisabled,
  className,
}: OperationalErrorBannerProps) {
  return (
    <div className={cn("ov-error-banner", className)} role="alert">
      <div className="min-w-0">{typeof message === "string" ? <p>{message}</p> : message}</div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ov-error-action"
          onClick={onRetry}
          disabled={retryDisabled}
        >
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
