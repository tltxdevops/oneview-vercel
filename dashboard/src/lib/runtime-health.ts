import type { RuntimeHealthComponent, RuntimeHealthResponse, RuntimeHealthStatus } from "@/lib/oneview-api";

export function runtimeStatusLabel(status: RuntimeHealthStatus) {
  return ({ HEALTHY: "Saudável", DEGRADED: "Degradado", DOWN: "Indisponível", STALE: "Desatualizado", READY_DISABLED: "Pronto / desativado", CONFIG_MISSING: "Configuração pendente", UNKNOWN: "Desconhecido" })[status];
}

export function runtimeStatusTone(status: RuntimeHealthStatus) {
  if (status === "HEALTHY") return "bg-emerald-500 text-emerald-700 dark:text-emerald-400";
  if (["DEGRADED", "STALE", "CONFIG_MISSING"].includes(status)) return "bg-amber-400 text-amber-700 dark:text-amber-400";
  if (status === "DOWN") return "bg-red-500 text-red-700 dark:text-red-400";
  return "bg-muted-foreground/50 text-muted-foreground";
}

function worstStatus(items: RuntimeHealthComponent[]): RuntimeHealthStatus {
  const statuses = items.map((item) => item.status);
  if (statuses.includes("DOWN")) return "DOWN";
  if (statuses.some((status) => ["STALE", "DEGRADED", "CONFIG_MISSING"].includes(status))) return "DEGRADED";
  if (statuses.includes("UNKNOWN")) return "UNKNOWN";
  return "HEALTHY";
}

export function runtimeSummary(health: RuntimeHealthResponse | null) {
  const components = health?.components ?? [];
  const category = (name: RuntimeHealthComponent["category"]) => components.filter((item) => item.category === name);
  const zabbix = category("ZABBIX");
  const find = (id: string) => components.find((item) => item.id === id);
  return [
    { key: "oneview", name: "OneView", status: find("vercel-bff")?.status ?? "UNKNOWN", detail: null },
    { key: "database", name: "Banco", status: find("postgresql")?.status ?? "UNKNOWN", detail: null },
    { key: "zabbix", name: "Zabbix", status: worstStatus(zabbix), detail: `${zabbix.filter((item) => item.status === "HEALTHY").length}/${zabbix.length} saudáveis` },
    { key: "servicenow", name: "ServiceNow", status: find("servicenow-read-model")?.status ?? "UNKNOWN", detail: find("servicenow-read-model")?.freshness?.age_seconds != null ? `${find("servicenow-read-model")?.freshness?.age_seconds}s` : null },
    { key: "theo", name: "Theo", status: find("theo-webex")?.status ?? "UNKNOWN", detail: null },
  ] as const;
}
