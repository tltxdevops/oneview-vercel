import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import { zabbixSourceDisplayName, zabbixSourceKey } from "@/lib/oneview-zabbix-source";

export type ZabbixSourceOption = {
  id?: string | null;
  name: string;
  alerts_count?: number | null;
};

type ZabbixSourceFilterProps = {
  value: string;
  options: ZabbixSourceOption[];
  onValueChange: (value: string) => void;
  className?: string;
  triggerClassName?: string;
  id?: string;
  allLabel?: string;
};

export function ZabbixSourceFilter({
  value,
  options,
  onValueChange,
  className,
  triggerClassName,
  id,
  allLabel = "Todas as fontes",
}: ZabbixSourceFilterProps) {
  const selected = value && value !== "all" ? zabbixSourceKey(value) : "all";
  return (
    <Select value={selected || "all"} onValueChange={onValueChange}>
      <SelectTrigger
        id={id}
        className={cn(OV_FILTER_CONTROL, "min-w-[10rem]", triggerClassName, className)}
        aria-label="Filtrar por Fonte Zabbix"
      >
        <SelectValue placeholder="Fonte Zabbix" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((option) => {
          const key = zabbixSourceKey(option.name);
          if (!key) return null;
          return (
            <SelectItem key={option.id || key} value={key}>
              {zabbixSourceDisplayName(option.name)}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
