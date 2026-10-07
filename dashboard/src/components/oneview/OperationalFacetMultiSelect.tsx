import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type OperationalFacetOption<Value extends string = string> = {
  value: Value;
  label: string;
  count?: number | null;
  disabled?: boolean;
};

export function OperationalFacetMultiSelect<Value extends string>({
  label,
  options,
  selectedValues,
  onChange,
  allLabel = "Todas",
  searchPlaceholder = "Buscar opção...",
  emptyLabel = "Nenhuma opção encontrada.",
  className,
}: {
  label: string;
  options: OperationalFacetOption<Value>[];
  selectedValues: Value[];
  onChange: (values: Value[]) => void;
  allLabel?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => new Set(selectedValues), [selectedValues]);
  const triggerLabel = selectedValues.length === 0
    ? allLabel
    : selectedValues.length === 1
      ? options.find((option) => option.value === selectedValues[0])?.label ?? selectedValues[0]
      : `${selectedValues.length} selecionadas`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`${label}: ${triggerLabel}`}
          className={cn("h-9 w-full min-w-0 justify-between gap-2 px-3 font-normal", className)}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={8} className="w-[min(20rem,calc(100vw-1rem))] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-10" />
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={allLabel} onSelect={() => { onChange([]); setOpen(false); }} className="gap-2">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border">
                  {selected.size === 0 ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="flex-1">{allLabel}</span>
              </CommandItem>
              {options.map((option) => {
                const checked = selected.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value}`}
                    disabled={option.disabled}
                    onSelect={() => onChange(checked
                      ? selectedValues.filter((value) => value !== option.value)
                      : [...selectedValues, option.value])}
                    className="gap-2"
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-border">
                      {checked ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.count != null ? <span className="text-[10px] tabular-nums text-muted-foreground">{option.count.toLocaleString("pt-BR")}</span> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
