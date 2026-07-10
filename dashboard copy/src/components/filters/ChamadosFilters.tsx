import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ChamadoStatus, Severity } from "@/types";

interface ChamadosFiltersProps {
  selectedSeverity: Severity | "All";
  selectedStatus: ChamadoStatus | "All";
  selectedAssignee: string;
  assignees: string[];
  onSeverityChange: (severity: Severity | "All") => void;
  onStatusChange: (status: ChamadoStatus | "All") => void;
  onAssigneeChange: (assignee: string) => void;
  onApply: () => void;
  onClear: () => void;
  className?: string;
  gridClassName?: string;
  variant?: "card" | "inline";
}

export function ChamadosFilters({
  selectedSeverity,
  selectedStatus,
  selectedAssignee,
  assignees,
  onSeverityChange,
  onStatusChange,
  onAssigneeChange,
  onApply,
  onClear,
  className,
  gridClassName,
  variant = "card",
}: ChamadosFiltersProps) {
  if (variant === "inline") {
    return (
      <div
        className={cn(
          "grid w-full gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:items-end",
          className
        )}
      >
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="chamados-filter-severity">
            Severidade
          </label>
          <Select value={selectedSeverity} onValueChange={onSeverityChange}>
            <SelectTrigger
              id="chamados-filter-severity"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todas</SelectItem>
              <SelectItem value="Info">Informativa</SelectItem>
              <SelectItem value="Average">Média</SelectItem>
              <SelectItem value="High">Alta</SelectItem>
              <SelectItem value="Critical">Crítica</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="chamados-filter-status">
            Status
          </label>
          <Select value={selectedStatus} onValueChange={onStatusChange}>
            <SelectTrigger
              id="chamados-filter-status"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              <SelectItem value="Aberto">Abertos</SelectItem>
              <SelectItem value="Em andamento">Em andamento</SelectItem>
              <SelectItem value="Resolvido">Resolvidos</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="chamados-filter-assignee">
            Responsável
          </label>
          <Select value={selectedAssignee} onValueChange={onAssigneeChange}>
            <SelectTrigger
              id="chamados-filter-assignee"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              {assignees.map((assignee) => (
                <SelectItem key={assignee} value={assignee}>
                  {assignee}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={onApply} size="sm" className="h-11 rounded-xl px-4">
            Aplicar
          </Button>
          <Button onClick={onClear} variant="ghost" size="sm" className="h-11 rounded-xl px-4">
            Limpar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-border bg-white p-5 shadow-sm", className)}>
      <div className={cn("grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4", gridClassName)}>
        <div>
          <label className="text-xs text-muted-foreground mb-2 block">Severidade</label>
          <Select value={selectedSeverity} onValueChange={onSeverityChange}>
            <SelectTrigger>
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todas</SelectItem>
              <SelectItem value="Info">Informativa</SelectItem>
              <SelectItem value="Average">Média</SelectItem>
              <SelectItem value="High">Alta</SelectItem>
              <SelectItem value="Critical">Crítica</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-2 block">Status</label>
          <Select value={selectedStatus} onValueChange={onStatusChange}>
            <SelectTrigger>
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              <SelectItem value="Aberto">Abertos</SelectItem>
              <SelectItem value="Em andamento">Em andamento</SelectItem>
              <SelectItem value="Resolvido">Resolvidos</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground mb-2 block">Responsável</label>
          <Select value={selectedAssignee} onValueChange={onAssigneeChange}>
            <SelectTrigger>
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              {assignees.map((assignee) => (
                <SelectItem key={assignee} value={assignee}>
                  {assignee}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="md:col-span-2 xl:col-span-1 flex items-end gap-2">
          <Button onClick={onApply} className="flex-1">
            Aplicar
          </Button>
          <Button onClick={onClear} variant="ghost">
            Limpar
          </Button>
        </div>
      </div>
    </div>
  );
}
