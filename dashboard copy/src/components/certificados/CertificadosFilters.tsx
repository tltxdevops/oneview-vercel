import { CertificateStatus } from "@/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CertificadoStatusFilter = CertificateStatus | "Todos";

interface CertificadosFiltersProps {
  status: CertificadoStatusFilter;
  onStatusChange: (status: CertificadoStatusFilter) => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  onReset?: () => void;
  className?: string;
  variant?: "card" | "inline";
}

const STATUS_OPTIONS: CertificadoStatusFilter[] = [
  "Todos",
  "Válido",
  "Expirando",
  "Expirado",
  "Indefinido",
];

export function CertificadosFilters({
  status,
  onStatusChange,
  searchTerm,
  onSearchChange,
  onReset,
  className,
  variant = "card",
}: CertificadosFiltersProps) {
  if (variant === "inline") {
    return (
      <div
        className={cn(
          "grid w-full gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))] sm:items-end",
          className
        )}
      >
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="cert-filter-status">
            Status
          </label>
          <Select value={status} onValueChange={(value) => onStatusChange(value as CertificadoStatusFilter)}>
            <SelectTrigger
              id="cert-filter-status"
              className="h-11 rounded-xl border border-border/70 bg-white px-4 text-sm"
            >
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === "Todos" ? "Todos os status" : option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="cert-filter-search">
            Busca
          </label>
          <Input
            id="cert-filter-search"
            value={searchTerm}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Buscar por nome ou domínio"
            className="h-11 w-full rounded-xl border border-border/70 bg-white px-4 text-sm"
          />
        </div>

        {onReset && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-11 rounded-xl border-[1.5px] border-transparent px-4 text-sm font-medium text-muted-foreground hover:border-border"
            >
              Limpar filtros
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex w-full flex-wrap items-center gap-3", className)}>
      <Select value={status} onValueChange={(value) => onStatusChange(value as CertificadoStatusFilter)}>
        <SelectTrigger className="h-11 w-[180px] rounded-xl border border-border/70 bg-white px-4 text-sm">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option === "Todos" ? "Todos os status" : option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={searchTerm}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
        placeholder="Buscar por nome ou domínio"
        className="h-11 w-full min-w-[220px] flex-1 rounded-xl border border-border/70 bg-white px-4 text-sm"
      />

      {onReset && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="h-11 rounded-xl border-[1.5px] border-transparent px-4 text-sm font-medium text-muted-foreground hover:border-border"
        >
          Limpar filtros
        </Button>
      )}
    </div>
  );
}
