import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OV_SEGMENTED_GROUP, OV_SEGMENTED_ITEM } from "@/lib/oneview-operational-ui";

export type OperationalSegmentOption<T extends string> = {
  value: T;
  label: string;
};

type OperationalSegmentedControlProps<T extends string> = {
  value: T;
  options: Array<OperationalSegmentOption<T>>;
  onChange: (value: T) => void;
  "aria-label": string;
  className?: string;
};

/** Segmented control canônico (Prioritários / Todos). */
export function OperationalSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
  className,
}: OperationalSegmentedControlProps<T>) {
  return (
    <div className={cn(OV_SEGMENTED_GROUP, className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={pressed ? "default" : "ghost"}
            className={OV_SEGMENTED_ITEM}
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
