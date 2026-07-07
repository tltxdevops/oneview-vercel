import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Search, Filter, X } from "lucide-react";
import type { WorkspaceType, WorkspaceHealthLevel } from "@/types";

interface WorkspaceFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  typeFilter: WorkspaceType | "all";
  onTypeFilterChange: (value: WorkspaceType | "all") => void;
  healthFilter: WorkspaceHealthLevel | "all";
  onHealthFilterChange: (value: WorkspaceHealthLevel | "all") => void;
  onClearFilters: () => void;
}

export function WorkspaceFilters({
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  healthFilter,
  onHealthFilterChange,
  onClearFilters,
}: WorkspaceFiltersProps) {
  const hasActiveFilters = searchQuery || typeFilter !== "all" || healthFilter !== "all";

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar espaço de trabalho..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex gap-2">
        <Select value={typeFilter} onValueChange={(value) => onTypeFilterChange(value as WorkspaceType | "all")}>
          <SelectTrigger className="w-[180px]">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os tipos</SelectItem>
            <SelectItem value="meetingRoom">Sala de Reunião</SelectItem>
            <SelectItem value="huddle">Sala colaborativa</SelectItem>
            <SelectItem value="focus">Sala de Foco</SelectItem>
            <SelectItem value="open">Espaço Aberto</SelectItem>
            <SelectItem value="desk">Mesa</SelectItem>
            <SelectItem value="other">Outro</SelectItem>
          </SelectContent>
        </Select>

        <Select value={healthFilter} onValueChange={(value) => onHealthFilterChange(value as WorkspaceHealthLevel | "all")}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="info">Informativo</SelectItem>
            <SelectItem value="warning">Aviso</SelectItem>
            <SelectItem value="error">Erro</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearFilters}
            className="shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
