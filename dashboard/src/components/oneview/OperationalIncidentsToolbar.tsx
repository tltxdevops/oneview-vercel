import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { OV_CLIENT_FILTER_TRIGGER } from "@/lib/oneview-operational-ui";
import {
  INCIDENTS_QUEUE_MODE,
  MAX_ASSIGNED_TO_IDS,
  parseAssignedToSysId,
  type IncidentsQueueMode,
} from "@/lib/oneview-operational-incidents";
import type { IncidentAssigneeFacet } from "@/lib/oneview-api";

const ALL_ANALYSTS = "all";

const MODE_OPTIONS: Array<{ value: IncidentsQueueMode; label: string }> = [
  { value: INCIDENTS_QUEUE_MODE.unassigned, label: "Sem responsável" },
  { value: INCIDENTS_QUEUE_MODE.assigned, label: "Com analista" },
  { value: INCIDENTS_QUEUE_MODE.all, label: "Todos" },
];

type OperationalIncidentsToolbarProps = {
  mode: IncidentsQueueMode;
  onModeChange: (mode: IncidentsQueueMode) => void;
  assignedTo: string[];
  onAssignedToChange: (assignedTo: string[]) => void;
  analysts: IncidentAssigneeFacet[];
};

function analystLabel(analyst: IncidentAssigneeFacet) {
  return analyst.label || analyst.display_value || analyst.value;
}

function selectedAnalystLabel(assignedTo: string[], analysts: IncidentAssigneeFacet[]) {
  if (!assignedTo.length) return "Todos";
  if (assignedTo.length === 1) {
    const match = analysts.find((item) => item.value === assignedTo[0]);
    return match ? analystLabel(match) : assignedTo[0];
  }
  return String(assignedTo.length);
}

export function OperationalIncidentsToolbar({
  mode,
  onModeChange,
  assignedTo,
  onAssignedToChange,
  analysts,
}: OperationalIncidentsToolbarProps) {
  const [open, setOpen] = useState(false);
  const showAnalysts = mode !== INCIDENTS_QUEUE_MODE.unassigned;
  const selected = new Set(assignedTo);
  const options = [...analysts];
  for (const id of assignedTo) {
    if (!options.some((item) => item.value === id)) {
      options.push({ value: id, label: id, count: 0 });
    }
  }
  const triggerLabel = selectedAnalystLabel(assignedTo, options);

  function toggleAnalyst(key: string) {
    if (key === ALL_ANALYSTS) {
      onAssignedToChange([]);
      setOpen(false);
      return;
    }
    const id = parseAssignedToSysId(key);
    if (!id) return;
    if (selected.has(id)) {
      onAssignedToChange(assignedTo.filter((item) => item !== id));
      return;
    }
    if (assignedTo.length >= MAX_ASSIGNED_TO_IDS) return;
    onAssignedToChange([...assignedTo, id]);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <OperationalSegmentedControl
        aria-label="Modo dos chamados"
        value={mode}
        options={MODE_OPTIONS}
        onChange={onModeChange}
      />
      {showAnalysts ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label={`Filtrar por analista: ${triggerLabel}`}
              className={cn(OV_CLIENT_FILTER_TRIGGER, "items-center gap-2")}
            >
              <span className="min-w-0 flex-1 truncate text-left text-xs leading-none">
                <span className="font-medium text-muted-foreground">Analistas · </span>
                <span className="font-semibold text-foreground">{triggerLabel}</span>
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[20rem] p-0">
            <Command>
              <CommandInput placeholder="Buscar analista..." className="h-10" />
              <CommandList>
                <CommandEmpty>Nenhum analista encontrado.</CommandEmpty>
                <CommandGroup heading="Analistas">
                  <CommandItem
                    value="todos os analistas"
                    onSelect={() => toggleAnalyst(ALL_ANALYSTS)}
                    className={cn(
                      "mx-1 my-1 gap-3 rounded-md border border-transparent px-2 py-2",
                      !assignedTo.length && "border-foreground/20 bg-muted/40",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">Todos os analistas</span>
                    <Check className={cn("h-4 w-4 text-primary", !assignedTo.length ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                  {options.map((analyst) => {
                    const active = selected.has(analyst.value);
                    return (
                      <CommandItem
                        key={analyst.value}
                        value={`${analystLabel(analyst)} ${analyst.value}`}
                        onSelect={() => toggleAnalyst(analyst.value)}
                        className={cn(
                          "mx-1 my-1 gap-3 rounded-md border border-transparent px-2 py-2",
                          active && "border-foreground/20 bg-muted/40",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{analystLabel(analyst)}</span>
                        <Check className={cn("h-4 w-4 text-primary", active ? "opacity-100" : "opacity-0")} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
