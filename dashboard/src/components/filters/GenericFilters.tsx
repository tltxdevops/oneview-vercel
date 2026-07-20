import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Severity, AlertStatus } from "@/types";

interface GenericFiltersProps {
  selectedSeverity: Severity | "All";
  selectedStatus: AlertStatus | "All";
  onSeverityChange: (severity: Severity | "All") => void;
  onStatusChange: (status: AlertStatus | "All") => void;
  onApply: () => void;
  onClear: () => void;
  className?: string;
  gridClassName?: string;
  variant?: "card" | "inline";
}

export function GenericFilters({
  selectedSeverity,
  selectedStatus,
  onSeverityChange,
  onStatusChange,
  onApply,
  onClear,
  className,
  gridClassName,
  variant = "card",
}: GenericFiltersProps) {
  if (variant === "inline") {
    return (
      <div
        className={cn(
          "grid w-full gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:items-end",
          className
        )}
      >
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="alert-filter-severity">
            Severidade
          </label>
          <Select value={selectedSeverity} onValueChange={onSeverityChange}>
            <SelectTrigger
              id="alert-filter-severity"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Todas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todas</SelectItem>
              <SelectItem value="Low">Baixa</SelectItem>
              <SelectItem value="Average">Média</SelectItem>
              <SelectItem value="High">Alta</SelectItem>
              <SelectItem value="Critical">Crítica</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="alert-filter-status">
            Status
          </label>
          <Select value={selectedStatus} onValueChange={onStatusChange}>
            <SelectTrigger
              id="alert-filter-status"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Todos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              <SelectItem value="Active">Ativos</SelectItem>
              <SelectItem value="Acknowledged">Reconhecidos</SelectItem>
              <SelectItem value="Resolved">Resolvidos</SelectItem>
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
        {/* Severidade */}
        <div>
          <label className="text-xs text-muted-foreground mb-2 block">Severidade</label>
          <Select value={selectedSeverity} onValueChange={onSeverityChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todas</SelectItem>
              <SelectItem value="Low">Baixa</SelectItem>
              <SelectItem value="Average">Média</SelectItem>
              <SelectItem value="High">Alta</SelectItem>
              <SelectItem value="Critical">Crítica</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Status */}
        <div>
          <label className="text-xs text-muted-foreground mb-2 block">Status</label>
          <Select value={selectedStatus} onValueChange={onStatusChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">Todos</SelectItem>
              <SelectItem value="Active">Ativos</SelectItem>
              <SelectItem value="Acknowledged">Reconhecidos</SelectItem>
              <SelectItem value="Resolved">Resolvidos</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Actions */}
        <div className="md:col-span-2 flex items-end gap-2">
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
