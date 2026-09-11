import type { RuntimeHealthComponent, RuntimeHealthResponse, RuntimeHealthStatus } from "@/lib/oneview-api";
import { formatPtBrDateTime, formatRelativePtBr } from "@/lib/platform-health";

export const STALE_ATTENTION_MS = 14 * 60 * 1000;

export type OperationalTone = "ok" | "partial" | "stale" | "down" | "unknown";

export const RUNTIME_CATEGORY_LABELS: Record<RuntimeHealthComponent["category"], string> = {
  PLATFORM: "Plataforma",
  ZABBIX: "Zabbix",
  SERVICENOW: "ServiceNow",
  WORKERS: "Workers",
  INTEGRATIONS: "Integrações",
};

export function runtimeStatusLabel(status: RuntimeHealthStatus) {
  return ({
    HEALTHY: "Saudável",
    DEGRADED: "Degradado",
    DOWN: "Indisponível",
    STALE: "Desatualizado",
    READY_DISABLED: "Pronto / desativado",
    CONFIG_MISSING: "Configuração pendente",
    UNKNOWN: "Desconhecido",
  })[status];
}

export function theoStateLabel(status: RuntimeHealthStatus | undefined) {
  if (status === "HEALTHY") return "Operacional";
  if (status === "DEGRADED") return "Degradado";
  if (status === "READY_DISABLED") return "Desativado";
  if (status === "DOWN") return "Falha";
  if (status === "CONFIG_MISSING") return "Degradado";
  if (status === "UNKNOWN") return "Degradado";
  return "Degradado";
}

export function theoChipTone(status: RuntimeHealthStatus | undefined): OperationalTone {
  if (status === "HEALTHY") return "ok";
  if (status === "DEGRADED") return "partial";
  if (status === "DOWN" || status === "STALE") return "stale";
  return "unknown";
}

function formatTheoHm(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function theoHeartbeatLabel(heartbeat: unknown) {
  if (heartbeat === "fresh") return "heartbeat recente";
  if (heartbeat === "stale" || heartbeat === "severe") return "atrasado";
  return "indisponível";
}

export function operationalToneLabel(tone: OperationalTone) {
  return ({
    ok: "Saudável",
    partial: "Caiu em parte",
    stale: "Precisa arrumar",
    down: "Totalmente down",
    unknown: "Sem informação",
  })[tone];
}

export function operationalToneDotClass(tone: OperationalTone) {
  if (tone === "ok") return "bg-emerald-500";
  if (tone === "partial") return "bg-amber-400";
  if (tone === "stale") return "bg-red-500";
  if (tone === "down") return "bg-white ring-1 ring-foreground";
  return "bg-muted-foreground/50";
}

export function operationalToneTextClass(tone: OperationalTone) {
  if (tone === "ok") return "text-emerald-700 dark:text-emerald-400";
  if (tone === "partial") return "text-amber-700 dark:text-amber-400";
  if (tone === "stale") return "text-red-700 dark:text-red-400";
  if (tone === "down") return "text-foreground";
  return "text-muted-foreground";
}

export function runtimeStatusTone(status: RuntimeHealthStatus) {
  const tone = operationalToneFromStatus(status);
  return `${operationalToneDotClass(tone)} ${operationalToneTextClass(tone)}`;
}

function ageMs(lastSuccessAt: string | null | undefined, now: number) {
  const timestamp = Date.parse(String(lastSuccessAt || ""));
  if (!lastSuccessAt || Number.isNaN(timestamp)) return null;
  return Math.max(0, now - timestamp);
}

export function operationalToneFromStatus(
  status: RuntimeHealthStatus | undefined,
  lastSuccessAt?: string | null,
  now = Date.now(),
): OperationalTone {
  if (status === "DOWN") return "down";
  if (status === "HEALTHY") return "ok";
  if (status === "DEGRADED" || status === "STALE") {
    const age = ageMs(lastSuccessAt, now);
    if (age != null && age >= STALE_ATTENTION_MS) return "stale";
    return "partial";
  }
  return "unknown";
}

export function operationalToneFromGroup(items: RuntimeHealthComponent[], now = Date.now()): OperationalTone {
  if (!items.length) return "unknown";
  const healthyCount = items.filter((item) => item.status === "HEALTHY").length;
  if (healthyCount === items.length) return "ok";
  if (healthyCount > 0) return "partial";
  if (items.every((item) => item.status === "DOWN")) return "down";
  const ages = items
    .map((item) => ageMs(item.last_success_at, now))
    .filter((value): value is number => value != null);
  if (ages.length && Math.max(...ages) >= STALE_ATTENTION_MS) return "stale";
  if (items.some((item) => item.status === "DEGRADED" || item.status === "STALE")) return "partial";
  return "unknown";
}

function latestSuccessAt(items: Array<{ last_success_at?: string | null }>) {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const timestamp = Date.parse(String(item.last_success_at || ""));
    if (Number.isNaN(timestamp) || timestamp <= bestMs) continue;
    bestMs = timestamp;
    best = item.last_success_at ?? null;
  }
  return best;
}

function lastSyncLines(lastSuccessAt: string | null | undefined, now: number) {
  const absolute = formatPtBrDateTime(lastSuccessAt);
  const relative = formatRelativePtBr(lastSuccessAt, now);
  if (!absolute) return ["Último sync: Sem informação"];
  return [`Último sync: ${absolute}${relative ? ` (${relative})` : ""}`];
}

export type RuntimeSummaryItem = {
  key: "oneview" | "database" | "zabbix" | "servicenow" | "theo";
  name: string;
  status: RuntimeHealthStatus;
  tone: OperationalTone;
  lastSuccessAt: string | null;
  tooltipLines: string[];
};

export function runtimeSummary(health: RuntimeHealthResponse | null, now = Date.now()): RuntimeSummaryItem[] {
  const components = health?.components ?? [];
  const category = (name: RuntimeHealthComponent["category"]) => components.filter((item) => item.category === name);
  const zabbix = category("ZABBIX");
  const find = (id: string) => components.find((item) => item.id === id);

  const oneview = find("vercel-bff");
  const database = find("postgresql");
  const servicenow = find("servicenow-read-model");
  const theo = find("theo-webex");
  const oneviewTone = operationalToneFromStatus(oneview?.status, oneview?.last_success_at, now);
  const databaseTone = operationalToneFromStatus(database?.status, database?.last_success_at, now);
  const servicenowTone = operationalToneFromStatus(servicenow?.status, servicenow?.last_success_at, now);
  const theoTone = theoChipTone(theo?.status);
  const zabbixTone = operationalToneFromGroup(zabbix, now);
  const zabbixHealthy = zabbix.filter((item) => item.status === "HEALTHY").length;
  const zabbixLastSuccess = latestSuccessAt(zabbix);
  const zabbixStatus: RuntimeHealthStatus = zabbixTone === "ok"
    ? "HEALTHY"
    : zabbixTone === "down"
      ? "DOWN"
      : zabbixTone === "stale"
        ? "STALE"
        : zabbixTone === "partial"
          ? "DEGRADED"
          : "UNKNOWN";

  return [
    {
      key: "oneview",
      name: "OneView",
      status: oneview?.status ?? "UNKNOWN",
      tone: oneviewTone,
      lastSuccessAt: oneview?.last_success_at ?? null,
      tooltipLines: [
        operationalToneLabel(oneviewTone),
        ...lastSyncLines(oneview?.last_success_at, now),
      ],
    },
    {
      key: "database",
      name: "Banco",
      status: database?.status ?? "UNKNOWN",
      tone: databaseTone,
      lastSuccessAt: database?.last_success_at ?? null,
      tooltipLines: [
        operationalToneLabel(databaseTone),
        ...lastSyncLines(database?.last_success_at, now),
        Number.isFinite(database?.duration_ms) ? `Tempo de resposta: ${Math.round(Number(database?.duration_ms))} ms` : null,
      ].filter(Boolean) as string[],
    },
    {
      key: "zabbix",
      name: "Zabbix",
      status: zabbixStatus,
      tone: zabbixTone,
      lastSuccessAt: zabbixLastSuccess,
      tooltipLines: [
        operationalToneLabel(zabbixTone),
        zabbix.length ? `${zabbixHealthy}/${zabbix.length} links saudáveis` : "Nenhum link Zabbix observado",
        ...lastSyncLines(zabbixLastSuccess, now),
        ...zabbix.flatMap((item) => {
          const relative = formatRelativePtBr(item.last_success_at, now);
          const badge = item.badge_label || (item.badge === "HEALTHY_SILENT" ? "Origem silenciosa" : null);
          const cause = item.cause ? ` · ${item.cause}` : "";
          const badgePart = badge ? ` · ${badge}` : "";
          return [`${item.name} — ${runtimeStatusLabel(item.status)}${badgePart}${cause}${relative ? ` · ${relative}` : ""}`];
        }),
      ],
    },
    {
      key: "servicenow",
      name: "ServiceNow",
      status: servicenow?.status ?? "UNKNOWN",
      tone: servicenowTone,
      lastSuccessAt: servicenow?.last_success_at ?? null,
      tooltipLines: [
        operationalToneLabel(servicenowTone),
        ...lastSyncLines(servicenow?.last_success_at, now),
      ],
    },
    {
      key: "theo",
      name: "Theo",
      status: theo?.status ?? "UNKNOWN",
      tone: theoTone,
      lastSuccessAt: theo?.last_success_at ?? null,
      tooltipLines: (() => {
        const pending = Number(theo?.metrics?.pending ?? 0);
        const queueCount = Number.isFinite(pending) ? pending : 0;
        const dispatchHm = formatTheoHm(theo?.last_success_at);
        const lastError = String(theo?.current_error || "").trim();
        return [
          `Estado: ${theoStateLabel(theo?.status)}`,
          `Último dispatch Theo: ${dispatchHm || "—"}`,
          `Dispatcher: ${theoHeartbeatLabel(theo?.metrics?.heartbeat)}`,
          `Fila: ${queueCount <= 0 ? "0 pendentes" : `${queueCount} aguardando/retry`}`,
          lastError ? `Último erro: ${lastError.slice(0, 140)}` : null,
        ].filter(Boolean) as string[];
      })(),
    },
  ];
}
