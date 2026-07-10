import { Client } from "@/types";
import { ChevronDown } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

interface ClientCardFilterProps {
  clients: Client[];
  selectedClient: string;
  onClientChange: (clientId: string) => void;
}

export function ClientCardFilter({
  clients,
  selectedClient,
  onClientChange,
}: ClientCardFilterProps) {
  const currentClient = clients.find((c) => c.id === selectedClient) || clients[0];

  const renderAvatar = (logo: string, name: string, size: "sm" | "lg" = "lg") => {
    const boxSize = size === "lg" ? "h-12 w-12" : "h-10 w-10";
    const padding = size === "lg" ? "p-2" : "p-1.5";

    if (logo) {
      return (
        <div
          className={`${boxSize} ${padding} rounded-xl border border-border/60 bg-white dark:bg-white flex items-center justify-center shadow-sm flex-shrink-0`}
        >
          <img src={logo} alt={name} className="h-full w-full object-contain" />
        </div>
      );
    }

    return (
      <div
        className={`${boxSize} rounded-xl border border-dashed border-muted-foreground/40 bg-white dark:bg-white flex items-center justify-center text-center uppercase text-muted-foreground font-semibold flex-shrink-0 px-1`}
      >
        <span className={`${size === "lg" ? "text-xs" : "text-[10px]"} leading-tight`}>{name}</span>
      </div>
    );
  };

  return (
    <Select value={selectedClient} onValueChange={onClientChange}>
      <SelectTrigger
        className="group relative h-full w-full p-0 border-0 bg-transparent hover:bg-transparent ring-0 ring-offset-0 focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:ring-0 data-[state=open]:ring-offset-0 [&>svg]:hidden"
        aria-label="Selecionar cliente"
      >
  <div className="rounded-xl border border-border bg-white p-5 w-full h-full flex items-center justify-between gap-3 text-left transition hover:border-primary/40 cursor-pointer shadow-sm">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {renderAvatar(currentClient.logo, currentClient.name, "lg")}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Cliente</p>
              <p className="font-semibold text-base truncate">{currentClient.name}</p>
            </div>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </div>
      </SelectTrigger>
      <SelectContent className="min-w-[240px]">
        {clients.map((client) => (
          <SelectItem key={client.id} value={client.id}>
            <div className="flex items-center gap-3">
              {renderAvatar(client.logo, client.name, "sm")}
              <span>{client.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
