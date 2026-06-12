import { useMemo, useState } from "react";
import { Client } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ChevronsUpDown, Check } from "lucide-react";

interface ClientSelectProps {
  clients: Client[];
  // allow single or multiple selected client ids
  selectedClient: string | string[];
  onClientChange: (clientId: string | string[]) => void;
  className?: string;
}

export function ClientSelect({ clients, selectedClient, onClientChange, className }: ClientSelectProps) {
  const [open, setOpen] = useState(false);

  const selectedIds = useMemo(() => (Array.isArray(selectedClient) ? selectedClient : [selectedClient]), [selectedClient]);

  const currentClient = useMemo(() => {
    // show first selected or 'all'
    const first = selectedIds[0];
    return clients.find((client) => client.id === first) ?? clients.find((client) => client.id === "all") ?? clients[0];
  }, [clients, selectedIds]);

  const renderClientLogo = (client: Client, size = 40) => {
    if (client.logo) {
      return (
        <img
          src={client.logo}
          alt={client.name}
          className={cn("rounded border border-border/50 object-contain bg-white", size === 32 ? "h-8 w-8" : "h-10 w-10")}
        />
      );
    }

    return (
      <span
        className={cn(
          "flex items-center justify-center rounded bg-white text-xs font-semibold uppercase text-muted-foreground",
          size === 32 ? "h-8 w-8" : "h-10 w-10"
        )}
      >
        {client.name.slice(0, 2)}
      </span>
    );
  };

  return (
    <div className={cn("flex items-center", className)}>
  <div className="flex items-center gap-3 rounded-[10px] border-[1.5px] border-border/60 bg-white px-4 py-2 shadow-sm">
        {currentClient && renderClientLogo(currentClient, 32)}
        <div className="min-w-0">
          <span className="block text-sm font-semibold uppercase tracking-wide text-foreground">
            {Array.isArray(selectedClient) ? (selectedIds.length > 1 ? `${currentClient?.name} (+${selectedIds.length - 1})` : currentClient?.name) : (currentClient ? currentClient.name : "Selecionar")}
          </span>
        </div>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-full border-[1.5px] border-border/60 bg-white/90 text-muted-foreground hover:border-black hover:bg-white hover:text-foreground"
                aria-label="Trocar cliente"
              >
                <ChevronsUpDown className="h-4 w-4" />
              </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[280px] p-0">
            <Command>
              <CommandInput placeholder="Buscar cliente..." className="h-10" />
              <CommandList>
                <CommandEmpty>Nenhum cliente encontrado.</CommandEmpty>
                <CommandGroup heading="Clientes disponíveis">
                  {clients.map((client) => (
                    <CommandItem
                      key={client.id}
                      value={client.name}
                      onSelect={() => {
                        // toggle selection
                        let next: string[] = Array.isArray(selectedClient) ? [...selectedClient] : [selectedClient as string];
                        if (next.includes(client.id)) {
                          next = next.filter((id) => id !== client.id);
                        } else {
                          // if 'all' selected, remove it
                          next = next.filter((id) => id !== "all");
                          next.push(client.id);
                        }
                        onClientChange(next.length === 1 ? next[0] : next);
                      }}
                      className={cn(
                        "flex items-center gap-3 rounded-md border-[1.5px] border-transparent px-2 py-1.5 transition-colors",
                        "bg-white text-foreground",
                        selectedIds.includes(client.id) && "border-black",
                        "hover:border-black hover:bg-white hover:text-foreground",
                        "focus-visible:border-black focus-visible:bg-white focus-visible:text-foreground",
                        "data-[selected=true]:border-black data-[selected=true]:bg-white data-[selected=true]:text-foreground",
                        "data-[highlighted=true]:border-black data-[highlighted=true]:bg-white data-[highlighted=true]:text-foreground"
                      )}
                    >
                      {renderClientLogo(client, 32)}
                      <div className="flex flex-1 items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{client.name}</span>
                        {selectedIds.includes(client.id) && (
                          <Check className="h-4 w-4 text-primary" aria-hidden />
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
