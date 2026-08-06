import { Check, ChevronsUpDown } from "lucide-react";
import { ClientIdentity, type ClientIdentityCustomer } from "@/components/oneview/ClientIdentity";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ClientFilterOption = ClientIdentityCustomer & {
  key: string;
  name: string;
  alerts_count?: number | null;
};

type ClientFilterComboboxProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: ClientFilterOption[];
  selectedKeys: string[];
  selectedLabel: string;
  onToggle: (key: string) => void;
  className?: string;
  triggerClassName?: string;
  emptyLabel?: string;
};

export function ClientFilterCombobox({
  open,
  onOpenChange,
  options,
  selectedKeys,
  selectedLabel,
  onToggle,
  className,
  triggerClassName,
  emptyLabel = "Nenhum cliente encontrado.",
}: ClientFilterComboboxProps) {
  const selectedCustomer = selectedKeys.length === 1
    ? options.find((customer) => customer.key === selectedKeys[0])
    : { key: "all", name: "Todos" };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`Filtrar por cliente: ${selectedLabel}`}
          className={cn(
            "h-9 min-w-[11.5rem] justify-between rounded-xl border border-border/70 bg-card px-2.5 shadow-sm hover:border-foreground/30 hover:bg-card",
            triggerClassName,
          )}
        >
          <span className={cn("flex min-w-0 items-center gap-2.5 text-left", className)}>
            <ClientIdentity customer={selectedCustomer} />
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Cliente</span>
              <span className="block truncate text-sm font-semibold tracking-wide text-foreground">{selectedLabel}</span>
            </span>
          </span>
          <span className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground">
            <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-0">
        <Command>
          <CommandInput placeholder="Buscar cliente..." className="h-10" />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup heading="Clientes disponíveis">
              {options.map((customer) => {
                const selected = customer.key === "all"
                  ? selectedKeys.length === 0
                  : selectedKeys.includes(customer.key);
                return (
                  <CommandItem
                    key={customer.key}
                    value={`${customer.name} ${customer.key}`}
                    onSelect={() => {
                      onToggle(customer.key);
                      if (customer.key === "all") onOpenChange(false);
                    }}
                    className={cn(
                      "mx-1 my-1 gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors",
                      selected && "border-foreground/20 bg-muted/40",
                      "data-[selected=true]:border-foreground/20 data-[selected=true]:bg-muted/40 data-[selected=true]:text-foreground",
                    )}
                  >
                    <ClientIdentity customer={customer} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{customer.name}</span>
                      {customer.alerts_count != null ? (
                        <span className="text-[10px] text-muted-foreground">
                          {Number(customer.alerts_count).toLocaleString("pt-BR")} alertas
                        </span>
                      ) : null}
                    </span>
                    <Check className={cn("h-4 w-4 text-primary", selected ? "opacity-100" : "opacity-0")} />
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
