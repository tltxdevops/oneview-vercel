import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateRange } from "react-day-picker";
import { endOfDay, format, formatDistanceToNow, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  AlertListResponse,
  AlertMetrics,
  AlertPagination,
  ONEVIEW_SEVERITY_CATALOG,
  ONEVIEW_V1_FILTER_SEVERITIES,
  ONEVIEW_READ_ONLY_MESSAGE,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewSeverity,
  OneViewHealthResponse,
  OneViewFacetsResponse,
  OperationsHealthResponse,
  fetchAlert,
  fetchAlertHistory,
  fetchAlertMetrics,
  fetchAlerts,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchOneViewFacets,
  fetchOperationsHealth,
  formatDurationSeconds,
  isOneViewSeverity,
  normalizeOneViewSeverity,
  requestAlertAcknowledgement,
} from "@/lib/oneview-api";
import {
  Activity,
  ArrowUpDown,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ChevronsUpDown,
  Database,
  Eye,
  History,
  Info,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ServerCog,
  ShieldAlert,
  Siren,
  TriangleAlert,
  UserCheck,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

type RecognitionFilter = "all" | "acknowledged" | "unacknowledged";
type StatusFilter = "active" | "resolved" | "all";
type SortField = "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "client" | "datasource" | "host" | "problem" | "duration" | "status" | "acknowledged_source";
type SortOrder = "asc" | "desc";
type TemporalPreset = "all" | "15m" | "1h" | "6h" | "24h" | "7d" | "custom";
type ResolvedTemporalPreset = TemporalPreset | "30d";
type HistoryFilter = "all" | "acknowledgements" | "changes" | "recovery" | "legacy";
type MetaState = { source?: OneViewDataSourceKind; checkedAt?: string; fallbackCode?: string | null };
type SummaryFilter = "total" | "active" | "acknowledged" | "pending" | "high" | "disaster";

const SUMMARY_REFRESH_MS = 60_000;
const ALERTS_REFRESH_MS = 120_000;

const emptyPagination: AlertPagination = {
  page: 1,
  page_size: 50,
  total_items: 0,
  total_pages: 0,
  has_next: false,
  has_previous: false,
};

/**
 * Keeps the page renderable while a local/proxy process is being restarted or
 * an older BFF response is still in flight.  The current contract always
 * includes `pagination`, but a missing field must never blank the whole page.
 */
function normalizeAlertResponse(response: AlertListResponse, requestedPage: number, requestedPageSize: number) {
  const runtimeResponse = (response ?? {}) as AlertListResponse & { alerts?: OneViewAlert[] };
  const items = Array.isArray(runtimeResponse.items)
    ? runtimeResponse.items
    : Array.isArray(runtimeResponse.alerts) ? runtimeResponse.alerts : [];
  const rawPagination = runtimeResponse.pagination;
  const totalItems = Number.isFinite(Number(rawPagination?.total_items))
    ? Math.max(0, Number(rawPagination?.total_items))
    : items.length;
  const page = Number.isFinite(Number(rawPagination?.page)) && Number(rawPagination?.page) > 0
    ? Number(rawPagination?.page)
    : requestedPage;
  const pageSize = Number.isFinite(Number(rawPagination?.page_size)) && Number(rawPagination?.page_size) > 0
    ? Number(rawPagination?.page_size)
    : requestedPageSize;
  const totalPages = Number.isFinite(Number(rawPagination?.total_pages))
    ? Math.max(0, Number(rawPagination?.total_pages))
    : (totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0);

  return {
    items,
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: totalPages,
      has_next: Boolean(rawPagination?.has_next ?? page < totalPages),
      has_previous: Boolean(rawPagination?.has_previous ?? page > 1),
    } satisfies AlertPagination,
  };
}

const severityCatalog: Record<OneViewSeverity, { label: string; short: string; tone: string }> = {
  disaster: { label: ONEVIEW_SEVERITY_CATALOG.disaster.label, short: "P1", tone: "border-red-600 bg-red-100 text-red-950 shadow-sm" },
  critical: { label: ONEVIEW_SEVERITY_CATALOG.critical.label, short: "P1", tone: "border-red-500 bg-red-50 text-red-900 shadow-sm" },
  high: { label: ONEVIEW_SEVERITY_CATALOG.high.label, short: "P2", tone: "border-red-200 bg-red-50 text-red-700" },
  average: { label: ONEVIEW_SEVERITY_CATALOG.average.label, short: "P3", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  warning: { label: ONEVIEW_SEVERITY_CATALOG.warning.label, short: "P4", tone: "border-yellow-200 bg-yellow-50 text-yellow-800" },
  information: { label: ONEVIEW_SEVERITY_CATALOG.information.label, short: "P5", tone: "border-sky-200 bg-sky-50 text-sky-700" },
  not_classified: { label: ONEVIEW_SEVERITY_CATALOG.not_classified.label, short: "N/C", tone: "border-slate-200 bg-slate-50 text-slate-700" },
};

const severityOrder: OneViewSeverity[] = [...ONEVIEW_V1_FILTER_SEVERITIES];

function normalizedClientKey(...values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const customerLogoCatalog = [
  { aliases: ["ailos"], src: "/tltx/clientes/logos/Ailos.png" },
  { aliases: ["alubauen"], src: "/tltx/clientes/logos/alubauen-logo.png" },
  { aliases: ["arauco"], src: "/tltx/clientes/logos/arauco-logo.png" },
  { aliases: ["berneck"], src: "/tltx/clientes/logos/berneck-logo.png" },
  { aliases: ["bnb", "banco do nordeste"], src: "/tltx/clientes/logos/bnb-logo.png" },
  { aliases: ["brinks"], src: "/tltx/clientes/logos/brinks-logo.png" },
  { aliases: ["castrolanda"], src: "/tltx/clientes/logos/castrolanda-logo.png" },
  { aliases: ["ciser"], src: "/tltx/clientes/logos/ciser-logo.png" },
  { aliases: ["copel"], src: "/tltx/clientes/logos/copel-logo.png" },
  { aliases: ["essentia"], src: "/tltx/clientes/logos/essentia-logo.png" },
  { aliases: ["estacio"], src: "/tltx/clientes/logos/estacio-logo.png" },
  { aliases: ["fps"], src: "/tltx/clientes/logos/fps-logo.png" },
  { aliases: ["fraport"], src: "/tltx/clientes/logos/fraport-logo.png" },
  { aliases: ["havan"], src: "/tltx/clientes/logos/havan-logo.png" },
  { aliases: ["nissan"], src: "/tltx/clientes/logos/nissan-logo.png" },
  { aliases: ["ntn"], src: "/tltx/clientes/logos/ntn-logo.png" },
  { aliases: ["osasco"], src: "/tltx/clientes/logos/osasco-logo.png" },
  { aliases: ["sapore"], src: "/tltx/clientes/logos/sapore-logo.png" },
  { aliases: ["sesi"], src: "/tltx/clientes/logos/sesi-logo.png" },
  { aliases: ["teletex", "teletex-http"], src: "/tltx/clientes/logos/teletex-logo.png" },
  { aliases: ["tjba", "tribunal de justica da bahia"], src: "/tltx/clientes/logos/tjba-logo.png" },
  { aliases: ["tullett"], src: "/tltx/clientes/logos/tullett-logo.png" },
  { aliases: ["tuper"], src: "/tltx/clientes/logos/tuper-logo.png" },
  { aliases: ["unicap"], src: "/tltx/clientes/logos/unicap-logo.png" },
  { aliases: ["unimed"], src: "/tltx/clientes/logos/unimed-logo.png" },
  { aliases: ["zurich"], src: "/tltx/clientes/logos/zurich-logo.png" },
] as const;

function customerLogoFor(customer?: { key?: string | null; name?: string | null }) {
  const normalized = normalizedClientKey(customer?.key, customer?.name);
  return customerLogoCatalog.find((item) => item.aliases.some((alias) => normalized.includes(alias)))?.src ?? null;
}

function customerInitials(customer?: { key?: string | null; name?: string | null }, fallback = "CL") {
  const source = safeDisplayText(customer?.name || customer?.key, fallback);
  return source
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || fallback;
}

function CustomerLogo({ customer, size = "sm" }: { customer?: { key?: string | null; name?: string | null }; size?: "sm" | "md" }) {
  const logo = customerLogoFor(customer);
  const className = size === "md" ? "h-10 w-10" : "h-8 w-8";
  if (logo) {
    return (
      <img
        src={logo}
        alt={safeDisplayText(customer?.name, "Cliente")}
        className={cn(className, "shrink-0 rounded-md border border-border/50 bg-white object-contain p-1")}
        loading="lazy"
      />
    );
  }
  return (
    <span className={cn(className, "flex shrink-0 items-center justify-center rounded-md border border-dashed border-border/70 bg-white text-[10px] font-semibold uppercase text-muted-foreground")}>
      {customerInitials(customer)}
    </span>
  );
}

function safeDisplayText(value: unknown, fallback = "-", maxLength = 500) {
  if (typeof value !== "string") return fallback;
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function safeHostIp(value: unknown): string | null {
  const candidate = safeDisplayText(value, "", 64);
  if (!candidate || ["-", "[redacted]", "[ip_protegido]"].includes(candidate.toLowerCase())) return null;

  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return null;
    if (first === 100 && second >= 64 && second <= 127) return null;
    if (first === 169 && second === 254) return null;
    if (first === 172 && second >= 16 && second <= 31) return null;
    if (first === 192 && second === 168) return null;
    return candidate;
  }

  const normalizedIpv6 = candidate.toLowerCase();
  if (/^[0-9a-f:]+$/i.test(normalizedIpv6) && normalizedIpv6.includes(":")) {
    if (normalizedIpv6 === "::1" || normalizedIpv6.startsWith("fe8") || normalizedIpv6.startsWith("fe9")
      || normalizedIpv6.startsWith("fea") || normalizedIpv6.startsWith("feb")
      || normalizedIpv6.startsWith("fc") || normalizedIpv6.startsWith("fd")) return null;
    return candidate;
  }

  return null;
}

function safeActorName(value: unknown) {
  const candidate = safeDisplayText(value, "", 160);
  return candidate && !/^\d+$/.test(candidate) ? candidate : null;
}

function isWorkerActorName(value: unknown) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return false;
  return /oneview[-_\s]?worker|worker[-_\s]?vm|^worker$/.test(candidate);
}

function historyActorLabel(value: unknown, options?: { allowWorkerLabel?: boolean }) {
  const nominal = safeActorName(value);
  if (nominal) {
    if (isWorkerActorName(nominal)) {
      return options?.allowWorkerLabel === false ? null : "Processado pelo Worker OneView";
    }
    return nominal;
  }
  if (isWorkerActorName(value)) return options?.allowWorkerLabel === false ? null : "Processado pelo Worker OneView";
  return null;
}

function sourceAckPresentation(alert: {
  acknowledged_source?: boolean;
  acknowledged_source_by?: string | null;
  acknowledged_by?: string | null;
  acknowledged_source_at?: string | null;
  acknowledged_at?: string | null;
  source_ack?: {
    acknowledged?: boolean;
    actor_name?: string | null;
    acknowledged_at?: string | null;
    comment?: string | null;
    acknowledge_id?: string | null;
    history_available?: boolean;
  } | null;
} | null | undefined) {
  const sourceAck = alert?.source_ack;
  if (sourceAck) {
    if (!sourceAck.acknowledged) {
      return {
        status: "pending" as const,
        actorLabel: null as string | null,
        at: null as string | null,
        comment: null as string | null,
        historyAvailable: false,
      };
    }
    return {
      status: "acknowledged" as const,
      actorLabel: historyActorLabel(sourceAck.actor_name, { allowWorkerLabel: false }),
      at: sourceAck.acknowledged_at || null,
      comment: sourceAck.comment || null,
      historyAvailable: sourceAck.history_available === true,
    };
  }
  if (!alert || !alert.acknowledged_source) {
    return {
      status: "pending" as const,
      actorLabel: null as string | null,
      at: null as string | null,
      comment: null as string | null,
      historyAvailable: false,
    };
  }
  const actorLabel = historyActorLabel(alert.acknowledged_source_by || alert.acknowledged_by, { allowWorkerLabel: false });
  return {
    status: "acknowledged" as const,
    actorLabel,
    at: alert.acknowledged_source_at || alert.acknowledged_at || null,
    comment: null as string | null,
    historyAvailable: false,
  };
}

function historyValueText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return safeDisplayText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 0 && (Array.isArray(value) || typeof value === "object")) return "Evidência estruturada disponível";
  return "-";
}

function historyValueIsMeaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    return !["", "-", "new", "novo", "null", "none", "undefined", "n/a", "na"].includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) return value.some(historyValueIsMeaningful);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(historyValueIsMeaningful);
  return true;
}

function historySeverityValue(value: unknown): string | null {
  const labels: Record<string, string> = {
    disaster: "Desastre",
    critical: "Crítico",
    high: "Alto",
    average: "Médio",
    warning: "Aviso",
    information: "Informação",
    not_classified: "Não classificado",
  };
  if (typeof value === "string") return labels[value.trim().toLowerCase()] ?? null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entry = Object.entries(value as Record<string, unknown>)
      .find(([key]) => key.toLowerCase().includes("severity") || key.toLowerCase().includes("severidade"));
    return entry ? historySeverityValue(entry[1]) : null;
  }
  return null;
}

function isAcknowledgementEvent(eventType: string) {
  return /acknowledged|ack_message|ack/i.test(eventType);
}

function isRecoveryEvent(eventType: string) {
  return /recovered|recovery|resolved|normaliz/i.test(eventType);
}

function historyOrigin(item: AlertHistoryItem) {
  if (item.legacy) return "Histórico legado";
  return safeDisplayText(item.source, "OneView").toLowerCase() === "zabbix" ? "Zabbix" : "OneView";
}

function historyHasPartialEvidence(item: AlertHistoryItem) {
  return item.legacy
    || (!item.description && !item.comment && !historyValueIsMeaningful(item.previous_value) && !historyValueIsMeaningful(item.current_value));
}

type HistoryQuality = {
  kind: "complete" | "partial" | "legacy" | "unavailable";
  title: string;
  description: string;
};

function historyRecordCount(items: AlertHistoryItem[]) {
  return items.reduce((total, item) => total + Math.max(1, item.grouped_event_count ?? 1), 0);
}

function historyQualityFor(items: AlertHistoryItem[], markedPartial = false): HistoryQuality {
  if (!items.length) {
    return {
      kind: "unavailable",
      title: "Integridade do histórico",
      description: "Não existem eventos históricos estruturados para este alerta.",
    };
  }

  const legacyItems = items.filter((item) => item.legacy);
  const structuredItems = items.filter((item) => !item.legacy);

  if (!structuredItems.length) {
    return {
      kind: "legacy",
      title: "Integridade do histórico",
      description: "Este alerta possui registros anteriores ao modelo histórico atual.",
    };
  }

  const hasPartialEvidence = markedPartial || legacyItems.length > 0 || structuredItems.some(historyHasPartialEvidence);
  if (hasPartialEvidence) {
    return {
      kind: "partial",
      title: "Integridade do histórico",
      description: "Parte dos eventos possui dados estruturados. Informações ausentes não foram inferidas.",
    };
  }

  return {
    kind: "complete",
    title: "Integridade do histórico",
    description: "Os principais eventos possuem dados estruturados da origem.",
  };
}

function formalHistoryTitle(item: AlertHistoryItem, groupedEventCount: number) {
  const eventType = String(item.event_type || "").toLowerCase();
  if (eventType === "problem_seen" && groupedEventCount > 1) return "Ocorrência atualizada";
  if (/acknowledged|ack_message|ack/.test(eventType)) return "Alerta reconhecido na origem";
  if (/severity/.test(eventType)) return "Severidade alterada";
  if (/recovered|recovery|resolved|normaliz/.test(eventType)) return "Alerta resolvido";
  if (/maintenance|suppress/.test(eventType)) return "Evento de manutenção";
  if (/problem_seen|created|opened|reopened/.test(eventType)) return "Alerta identificado";
  return safeDisplayText(item.title, "Ocorrência atualizada");
}

function historyGroupEventCount(group: HistoryGroup) {
  return group.items.reduce((total, item) => total + Math.max(1, item.grouped_event_count ?? 1), 0);
}

function historyGroupMatchesFilter(group: HistoryGroup, filter: HistoryFilter) {
  if (filter === "all") return true;
  if (filter === "legacy") return group.items.some((item) => item.legacy);
  if (filter === "acknowledgements") return group.items.some((item) => isAcknowledgementEvent(item.event_type));
  if (filter === "recovery") return group.items.some((item) => isRecoveryEvent(item.event_type));
  return group.items.some((item) => /severity|status|suppress|maintenance|reopened/i.test(item.event_type));
}

type HistoryGroup = {
  key: string;
  primary: AlertHistoryItem;
  items: AlertHistoryItem[];
};

function historyGroupKey(item: AlertHistoryItem) {
  return [
    item.event_type,
    safeDisplayText(item.title),
    safeDisplayText(item.description, ""),
    historyValueText(item.previous_value),
    historyValueText(item.current_value),
    safeDisplayText(item.ack_actor_name || item.actor_name, ""),
    safeDisplayText(item.source),
    safeDisplayText(item.origin),
    String(item.legacy),
  ].join("|");
}

function groupHistoryItems(items: AlertHistoryItem[]): HistoryGroup[] {
  const sorted = [...items].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at));
  return sorted.reduce<HistoryGroup[]>((groups, item) => {
    const key = historyGroupKey(item);
    const current = groups.at(-1);
    if (current?.key === key) {
      current.items.push(item);
      return groups;
    }
    groups.push({ key, primary: item, items: [item] });
    return groups;
  }, []);
}

function customerSourceLabel(value?: string | null) {
  const labels: Record<string, string> = {
    problem_tag: "Tag do problema",
    host_group: "Grupo do host",
    datasource_fallback: "Fallback da fonte",
  };
  return value ? labels[value] ?? safeDisplayText(value) : "Enriquecimento pendente";
}

function confidenceLabel(value?: string | null) {
  if (value === "high") return "Alta";
  if (value === "low") return "Baixa";
  if (value === "medium") return "Média";
  return "Não classificado";
}

const enrichmentLabels: Record<OneViewAlert["enrichment_state"], string> = {
  complete: "Completo",
  partial: "Enriquecimento parcial",
  legacy: "Histórico legado",
  unclassified: "Não classificado",
};

const enrichmentExplanations: Record<OneViewAlert["enrichment_state"], string> = {
  complete: "Cliente, host e histórico estruturado estão disponíveis.",
  partial: "Cliente identificado, mas parte do contexto técnico ou do histórico ainda está incompleta.",
  legacy: "Registro anterior ao processo de enriquecimento atual.",
  unclassified: "Não há evidência suficiente para classificar o cliente com segurança.",
};

function customerPresentation(alert: OneViewAlert) {
  const normalizedCustomer = alert.customer_name?.trim().toLocaleLowerCase("pt-BR") ?? "";
  const unidentified = !normalizedCustomer
    || alert.customer_key?.trim().toLowerCase() === "unclassified"
    || alert.customer_source?.trim().toLowerCase() === "datasource_fallback"
    || ["cliente não classificado", "cliente nao classificado", "cliente não identificado", "cliente nao identificado"].includes(normalizedCustomer);

  if (unidentified) {
    const datasource = safeDisplayText(alert.datasource_name, "Fonte não identificada");
    return {
      name: "Cliente não identificado",
      hint: `A fonte ${datasource} não forneceu evidências suficientes para associar este alerta automaticamente a um cliente.`,
      enrichment: "unclassified" as const,
      unidentified: true,
    };
  }
  return {
    name: alert.customer_name as string,
    hint: null,
    enrichment: alert.enrichment_state === "complete" ? "complete" as const : "partial" as const,
    unidentified: false,
  };
}

function safeClassificationTags(alert: OneViewAlert) {
  const tags = [...(alert.event_tags ?? []), ...(alert.trigger_tags ?? []), ...(alert.host_tags ?? [])];
  const unique = new Map<string, { tag: string; value: string }>();
  for (const tag of tags) {
    const name = safeDisplayText(tag.tag, "", 80).trim();
    const value = safeDisplayText(tag.value, "", 120).trim();
    if (!name && !value) continue;
    unique.set(`${name.toLowerCase()}|${value.toLowerCase()}`, { tag: name, value });
  }
  return [...unique.values()].slice(0, 12);
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("pt-BR");
}

function formatRelative(value?: string | null) {
  if (!value) return "data indisponível";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "data indisponível";
  return formatDistanceToNow(date, { addSuffix: true, locale: ptBR });
}

function formatCountdown(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function latestCheckedAt(...values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function metaOf(response: { data_source?: OneViewDataSourceKind; checked_at?: string; fallback_code?: string | null }): MetaState {
  return { source: response.data_source, checkedAt: response.checked_at, fallbackCode: response.fallback_code };
}

function acknowledged(alert: OneViewAlert) {
  return Boolean(alert.acknowledged_internal || alert.acknowledged_source);
}

function sourceAcknowledged(alert: OneViewAlert | null | undefined) {
  return Boolean(alert?.acknowledged_source);
}

function internallyRecognized(alert: OneViewAlert | null | undefined) {
  return Boolean(alert?.acknowledged_internal);
}

function isResolvedAlert(alert: OneViewAlert | null | undefined) {
  if (!alert) return false;
  const sourceStatus = safeDisplayText(alert.status_source, "").toLowerCase();
  const internalStatus = safeDisplayText(alert.status_internal, "").toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function ackRequestAllowedFor(alert: OneViewAlert | null | undefined, requestEnabled: boolean) {
  return requestEnabled && !isResolvedAlert(alert) && alert?.datasource_name?.trim().toLowerCase() === "teletex-http";
}

const temporalDurations: Record<Exclude<ResolvedTemporalPreset, "all" | "custom">, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

const temporalLabels: Record<ResolvedTemporalPreset, string> = {
  all: "sem período",
  "15m": "nos últimos 15 minutos",
  "1h": "na última hora",
  "6h": "nas últimas 6 horas",
  "24h": "nas últimas 24 horas",
  "7d": "nos últimos 7 dias",
  "30d": "nos últimos 30 dias",
  custom: "no período personalizado",
};

function isCalendarDateOnly(value: Date) {
  return value.getHours() === 0
    && value.getMinutes() === 0
    && value.getSeconds() === 0
    && value.getMilliseconds() === 0;
}

function formatTemporalUrlValue(value: Date) {
  return isCalendarDateOnly(value) ? format(value, "yyyy-MM-dd") : value.toISOString();
}

function temporalBounds(preset: ResolvedTemporalPreset, range?: DateRange, now = Date.now()) {
  if (preset === "custom") {
    const from = range?.from
      ? (isCalendarDateOnly(range.from) ? startOfDay(range.from).toISOString() : range.from.toISOString())
      : undefined;
    const to = range?.to
      ? (isCalendarDateOnly(range.to) ? endOfDay(range.to).toISOString() : range.to.toISOString())
      : range?.from && isCalendarDateOnly(range.from)
        ? endOfDay(range.from).toISOString()
        : undefined;
    return { from, to };
  }
  if (preset === "all") return {};
  return { from: new Date(now - temporalDurations[preset]).toISOString() };
}

function temporalFilterActive(preset: ResolvedTemporalPreset, range?: DateRange) {
  if (preset === "all") return false;
  if (preset === "custom") return Boolean(range?.from || range?.to);
  return true;
}

function urlDate(value: string | null) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function rangeFromUrl(params: URLSearchParams, prefix: string): DateRange | undefined {
  const from = urlDate(params.get(`${prefix}_from`));
  const to = urlDate(params.get(`${prefix}_to`));
  return from || to ? { from, to } : undefined;
}

function temporalPresetFromUrl(value: string | null, resolved = false): ResolvedTemporalPreset {
  const allowed = resolved
    ? ["all", "15m", "1h", "6h", "24h", "7d", "30d", "custom"]
    : ["all", "15m", "1h", "6h", "24h", "7d", "custom"];
  return allowed.includes(value ?? "") ? value as ResolvedTemporalPreset : "all";
}

function queryEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function positiveQueryInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function historyEventIcon(eventType: string) {
  const normalized = eventType.toLowerCase();
  if (normalized.includes("ack")) return UserCheck;
  if (normalized.includes("resolved") || normalized.includes("normaliz")) return CheckCircle2;
  if (normalized.includes("severity") || normalized.includes("status")) return ArrowUpDown;
  if (normalized.includes("maintenance") || normalized.includes("suppress")) return ServerCog;
  if (normalized.includes("seen")) return Activity;
  if (normalized.includes("created") || normalized.includes("zabbix")) return Siren;
  return History;
}

export default function AlertsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQueryRef = useRef(new URLSearchParams(searchParams));
  const initialQuery = initialQueryRef.current;
  const requestedAlertId = searchParams.get("alert");
  const [alerts, setAlerts] = useState<OneViewAlert[]>([]);
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [operationsHealth, setOperationsHealth] = useState<OperationsHealthResponse | null>(null);
  const [pagination, setPagination] = useState<AlertPagination>(emptyPagination);
  const [filteredSummary, setFilteredSummary] = useState<AlertListResponse["filtered_summary"]>(undefined);
  const [temporalCounts, setTemporalCounts] = useState<AlertListResponse["temporal_counts"]>(undefined);
  const [snapshotCoverage, setSnapshotCoverage] = useState<{ partial: boolean; total_persisted: number; available_items: number } | null>(null);

  const [page, setPage] = useState(() => positiveQueryInteger(initialQuery.get("page"), 1, Number.MAX_SAFE_INTEGER));
  const [pageSize, setPageSize] = useState(() => Number(queryEnum(initialQuery.get("page_size"), ["25", "50", "100"] as const, "50")));
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>(() => initialQuery.getAll("customer").filter(Boolean));
  const [selectedDatasources, setSelectedDatasources] = useState<string[]>(() => initialQuery.getAll("datasource").filter(Boolean));
  const [selectedSeverities, setSelectedSeverities] = useState<OneViewSeverity[]>(() => initialQuery.getAll("severity").filter(isOneViewSeverity));
  const [sourceAckFilter, setSourceAckFilter] = useState<RecognitionFilter>(() => queryEnum(initialQuery.get("source_ack"), ["all", "acknowledged", "unacknowledged"] as const, "all"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => queryEnum(initialQuery.get("status"), ["active", "resolved", "all"] as const, "active"));
  const [sortField, setSortField] = useState<SortField>(() => queryEnum(initialQuery.get("sort"), ["last_seen_at", "first_seen_at", "resolved_at", "severity", "client", "datasource", "host", "problem", "duration", "status", "acknowledged_source"] as const, "last_seen_at"));
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => queryEnum(initialQuery.get("order"), ["asc", "desc"] as const, "desc"));
  const [hostSearch, setHostSearch] = useState(() => initialQuery.get("host") ?? "");
  const [problemSearch, setProblemSearch] = useState(() => initialQuery.get("problem") ?? "");
  const [debouncedHostSearch, setDebouncedHostSearch] = useState("");
  const [debouncedProblemSearch, setDebouncedProblemSearch] = useState("");
  const [datasourceSearch, setDatasourceSearch] = useState("");
  const [createdPreset, setCreatedPreset] = useState<TemporalPreset>(() => temporalPresetFromUrl(initialQuery.get("created")) as TemporalPreset);
  const [updatedPreset, setUpdatedPreset] = useState<TemporalPreset>(() => temporalPresetFromUrl(initialQuery.get("updated")) as TemporalPreset);
  const [resolvedPreset, setResolvedPreset] = useState<ResolvedTemporalPreset>(() => temporalPresetFromUrl(initialQuery.get("resolved"), true));
  const [ackPreset, setAckPreset] = useState<TemporalPreset>(() => temporalPresetFromUrl(initialQuery.get("ack")) as TemporalPreset);
  const [createdRange, setCreatedRange] = useState<DateRange>(() => rangeFromUrl(initialQuery, "created"));
  const [updatedRange, setUpdatedRange] = useState<DateRange>(() => rangeFromUrl(initialQuery, "updated"));
  const [resolvedRange, setResolvedRange] = useState<DateRange>(() => rangeFromUrl(initialQuery, "resolved"));
  const [ackRange, setAckRange] = useState<DateRange>(() => rangeFromUrl(initialQuery, "ack"));
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);

  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
  const [hasLoadedAlerts, setHasLoadedAlerts] = useState(false);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [clockTick, setClockTick] = useState(Date.now());

  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<OneViewAlert | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [ackDialogOpen, setAckDialogOpen] = useState(false);
  const [ackComment, setAckComment] = useState("");
  const [ackRequestKey, setAckRequestKey] = useState("");
  const [ackSubmitting, setAckSubmitting] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const [pendingAckRequests, setPendingAckRequests] = useState<Record<string, string>>({});

  const [alertsMeta, setAlertsMeta] = useState<MetaState>({});
  const [metricsMeta, setMetricsMeta] = useState<MetaState>({});
  const [healthMeta, setHealthMeta] = useState<MetaState>({});
  const [sourcesMeta, setSourcesMeta] = useState<MetaState>({});
  const [facetsMeta, setFacetsMeta] = useState<MetaState>({});
  const [operationsMeta, setOperationsMeta] = useState<MetaState>({});
  const [detailMeta, setDetailMeta] = useState<MetaState>({});
  const [historyMeta, setHistoryMeta] = useState<MetaState>({});

  const alertsRequestRef = useRef<AbortController | null>(null);
  const alertsRequestIdRef = useRef(0);
  const detailRequestRef = useRef<AbortController | null>(null);
  const summaryRequestRef = useRef<Promise<void> | null>(null);
  const summaryDeadlineRef = useRef(Date.now() + SUMMARY_REFRESH_MS);
  const alertsDeadlineRef = useRef(Date.now() + ALERTS_REFRESH_MS);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedHostSearch(hostSearch.trim());
      setDebouncedProblemSearch(problemSearch.trim());
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hostSearch, problemSearch]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (requestedAlertId) next.set("alert", requestedAlertId);
    if (page !== 1) next.set("page", String(page));
    if (pageSize !== 50) next.set("page_size", String(pageSize));
    selectedCustomerKeys.forEach((value) => next.append("customer", value));
    selectedDatasources.forEach((value) => next.append("datasource", value));
    selectedSeverities.forEach((value) => next.append("severity", value));
    next.set("status", statusFilter);
    if (sourceAckFilter !== "all") next.set("source_ack", sourceAckFilter);
    next.set("sort", sortField);
    next.set("order", sortOrder);
    if (hostSearch.trim()) next.set("host", hostSearch.trim());
    if (problemSearch.trim()) next.set("problem", problemSearch.trim());

    const appendTemporal = (prefix: string, preset: ResolvedTemporalPreset, range?: DateRange) => {
      if (preset === "all") return;
      next.set(prefix, preset);
      if (preset !== "custom") return;
      if (range?.from) next.set(`${prefix}_from`, formatTemporalUrlValue(range.from));
      if (range?.to) next.set(`${prefix}_to`, formatTemporalUrlValue(range.to));
    };
    appendTemporal("created", createdPreset, createdRange);
    appendTemporal("updated", updatedPreset, updatedRange);
    appendTemporal("resolved", resolvedPreset, resolvedRange);
    appendTemporal("ack", ackPreset, ackRange);

    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [ackPreset, ackRange, createdPreset, createdRange, hostSearch, page, pageSize, problemSearch, requestedAlertId, resolvedPreset, resolvedRange, searchParams, selectedCustomerKeys, selectedDatasources, selectedSeverities, setSearchParams, sortField, sortOrder, sourceAckFilter, statusFilter, updatedPreset, updatedRange]);

  const loadAlerts = useCallback(async () => {
    alertsRequestRef.current?.abort();
    const controller = new AbortController();
    alertsRequestRef.current = controller;
    const requestId = ++alertsRequestIdRef.current;
    setIsAlertsLoading(true);
    setAlertsError(null);
    try {
      // Presets relativos precisam acompanhar cada consulta. Calculá-los fora
      // daqui congelava "últimos 15 minutos/1 hora" no instante da seleção.
      const requestTime = Date.now();
      const createdBounds = temporalBounds(createdPreset, createdRange, requestTime);
      const updatedBounds = temporalBounds(updatedPreset, updatedRange, requestTime);
      const resolvedBounds = temporalBounds(resolvedPreset, resolvedRange, requestTime);
      const ackBounds = temporalBounds(ackPreset, ackRange, requestTime);
      const response = await fetchAlerts({
        page,
        pageSize,
        customers: selectedCustomerKeys,
        datasources: selectedDatasources,
        severities: selectedSeverities,
        status: statusFilter,
        acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
        hostSearch: debouncedHostSearch || undefined,
        problemSearch: debouncedProblemSearch || undefined,
        firstSeenFrom: createdBounds.from,
        firstSeenTo: createdBounds.to,
        lastSeenFrom: updatedBounds.from,
        lastSeenTo: updatedBounds.to,
        resolvedFrom: resolvedBounds.from,
        resolvedTo: resolvedBounds.to,
        acknowledgedFrom: ackBounds.from,
        acknowledgedTo: ackBounds.to,
        sort: sortField,
        order: sortOrder,
        signal: controller.signal,
      });
      if (requestId !== alertsRequestIdRef.current) return;
      const normalized = normalizeAlertResponse(response, page, pageSize);
      const safeResponse = response ?? ({} as AlertListResponse);
      setAlerts(normalized.items);
      setPagination(normalized.pagination);
      setFilteredSummary(safeResponse.filtered_summary);
      setTemporalCounts(safeResponse.temporal_counts);
      setSnapshotCoverage(safeResponse.snapshot_coverage ?? null);
      setAlertsMeta(metaOf(safeResponse));
      setHasLoadedAlerts(true);
      alertsDeadlineRef.current = Date.now() + ALERTS_REFRESH_MS;
    } catch (error) {
      if (controller.signal.aborted) return;
      setAlertsError(error instanceof Error ? error.message : "Não foi possível carregar os alertas.");
    } finally {
      if (requestId === alertsRequestIdRef.current) setIsAlertsLoading(false);
    }
  }, [ackPreset, ackRange, createdPreset, createdRange, debouncedHostSearch, debouncedProblemSearch, page, pageSize, resolvedPreset, resolvedRange, selectedCustomerKeys, selectedDatasources, selectedSeverities, sortField, sortOrder, sourceAckFilter, statusFilter, updatedPreset, updatedRange]);

  const loadSummaryResources = useCallback((force = false) => {
    if (summaryRequestRef.current) return summaryRequestRef.current;
    setIsSummaryLoading(true);
    setSummaryError(null);
    const request = (async () => {
      const results = await Promise.allSettled([
        fetchOneViewHealth(),
        fetchAlertMetrics({ refresh: force }),
        fetchDataSourcesWithMeta(),
        fetchOneViewFacets(),
        fetchOperationsHealth(),
      ]);

      if (results[0].status === "fulfilled") {
        setHealth(results[0].value);
        setHealthMeta(metaOf(results[0].value));
      }
      if (results[1].status === "fulfilled") {
        setMetrics(results[1].value);
        setMetricsMeta(metaOf(results[1].value));
      }
      if (results[2].status === "fulfilled") {
        setSourcesMeta(metaOf(results[2].value));
      }
      if (results[3].status === "fulfilled") {
        setFacets(results[3].value);
        setFacetsMeta(metaOf(results[3].value));
      }
      if (results[4].status === "fulfilled") {
        setOperationsHealth(results[4].value);
        setOperationsMeta(metaOf(results[4].value));
      }
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        setSummaryError(rejected.reason instanceof Error ? rejected.reason.message : "Falha ao atualizar o resumo operacional.");
      }
      summaryDeadlineRef.current = Date.now() + SUMMARY_REFRESH_MS;
      setIsSummaryLoading(false);
    })();
    summaryRequestRef.current = request;
    void request.finally(() => {
      if (summaryRequestRef.current === request) summaryRequestRef.current = null;
    });
    return request;
  }, []);

  const loadSelectedAlert = useCallback(async (id: string) => {
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setIsDetailLoading(true);
    setDetailError(null);
    const results = await Promise.allSettled([
      fetchAlert(id, controller.signal),
      fetchAlertHistory(id, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (results[0].status === "fulfilled") {
      setDetail(results[0].value);
      setDetailMeta(metaOf(results[0].value));
    } else {
      setDetailError(results[0].reason instanceof Error ? results[0].reason.message : "Detalhe indisponível.");
    }
    if (results[1].status === "fulfilled") {
      setHistory(results[1].value);
      setHistoryMeta(metaOf(results[1].value));
    } else if (results[0].status === "fulfilled") {
      setDetailError(results[1].reason instanceof Error ? results[1].reason.message : "Histórico indisponível.");
    }
    setIsDetailLoading(false);
  }, []);

  useEffect(() => {
    if (!requestedAlertId || requestedAlertId === selectedAlertId) return;
    setSelectedAlertId(requestedAlertId);
    setSelectedPreview(null);
    setDetail(null);
    setHistory(null);
    setHistoryFilter("all");
    setDetailMeta({});
    setHistoryMeta({});
    void loadSelectedAlert(requestedAlertId);
  }, [loadSelectedAlert, requestedAlertId, selectedAlertId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummaryResources(true), loadAlerts()]);
    if (selectedAlertId) await loadSelectedAlert(selectedAlertId);
  }, [loadAlerts, loadSelectedAlert, loadSummaryResources, selectedAlertId]);

  useEffect(() => {
    void loadSummaryResources();
  }, [loadSummaryResources]);

  useEffect(() => {
    void loadAlerts();
    return () => alertsRequestRef.current?.abort();
  }, [loadAlerts]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClockTick(now);
      if (isPaused || document.hidden) return;
      if (now >= summaryDeadlineRef.current) {
        summaryDeadlineRef.current = now + SUMMARY_REFRESH_MS;
        void loadSummaryResources();
      }
      if (now >= alertsDeadlineRef.current) {
        alertsDeadlineRef.current = now + ALERTS_REFRESH_MS;
        void loadAlerts();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPaused, loadAlerts, loadSummaryResources]);

  useEffect(() => () => {
    alertsRequestRef.current?.abort();
    detailRequestRef.current?.abort();
  }, []);

  const baseMetas = [alertsMeta, metricsMeta, healthMeta, sourcesMeta, facetsMeta, operationsMeta];
  const hasSnapshot = baseMetas.some((meta) => meta.source === "snapshot")
    || (selectedAlertId !== null && [detailMeta, historyMeta].some((meta) => meta.source === "snapshot"));
  const lastCheckedAt = latestCheckedAt(...baseMetas.map((meta) => meta.checkedAt), detailMeta.checkedAt, historyMeta.checkedAt);
  const fallbackCode = [...baseMetas, detailMeta, historyMeta].find((meta) => meta.source === "snapshot" && meta.fallbackCode)?.fallbackCode;

  const severityCounts = Object.fromEntries((metrics?.by_severity ?? []).map((item) => [item.severity, item.count]));
  const hasTemporalFilter = temporalFilterActive(createdPreset, createdRange)
    || temporalFilterActive(updatedPreset, updatedRange)
    || temporalFilterActive(resolvedPreset, resolvedRange)
    || temporalFilterActive(ackPreset, ackRange);
  const listTotal = pagination.total_items;
  // Com filtro temporal usamos filtered_summary. Enquanto ele não chega, mostramos
  // "…" (null) em vez de 0, para não confundir carregamento com resultado vazio real.
  const activeTotal = hasTemporalFilter ? (filteredSummary ? filteredSummary.active : null) : metrics?.active_total ?? health?.counts.active_alerts ?? 0;
  const pendingTotal = hasTemporalFilter ? (filteredSummary ? filteredSummary.unacknowledged_source : null) : metrics?.unacknowledged_total ?? 0;
  const acknowledgedTotal = hasTemporalFilter
    ? (filteredSummary ? filteredSummary.acknowledged_source : null)
    : Math.max(Number(activeTotal ?? 0) - Number(pendingTotal ?? 0), 0);
  const totalForCards = hasTemporalFilter
    ? (filteredSummary ? filteredSummary.total : (isAlertsLoading ? null : listTotal))
    : health?.counts.total_alerts ?? metrics?.alerts_total ?? 0;
  const highForCards = hasTemporalFilter ? (filteredSummary ? filteredSummary.by_severity.high : null) : severityCounts.high ?? 0;
  const disasterForCards = hasTemporalFilter ? (filteredSummary ? filteredSummary.by_severity.disaster : null) : severityCounts.disaster ?? 0;
  const temporalDescription = hasTemporalFilter ? "No período selecionado" : null;
  const formatCardValue = (value: number | null) => (value === null ? "…" : Number(value).toLocaleString("pt-BR"));
  const summaryCards = [
    { filter: "total" as const, title: "Total persistido", value: totalForCards, description: temporalDescription ?? "Alertas registrados no OneView", icon: Database, tone: "bg-primary/10 text-primary" },
    { filter: "active" as const, title: "Alertas ativos", value: activeTotal, description: temporalDescription ?? "Ocorrências em acompanhamento", icon: Activity, tone: "bg-amber-100 text-amber-700" },
    { filter: "acknowledged" as const, title: "Reconhecidos", value: acknowledgedTotal, description: temporalDescription ?? "Reconhecidos na origem", icon: UserCheck, tone: "bg-emerald-100 text-emerald-700" },
    { filter: "pending" as const, title: "Pendentes", value: pendingTotal, description: temporalDescription ?? "Aguardando tratamento", icon: TriangleAlert, tone: "bg-yellow-100 text-yellow-700" },
    { filter: "high" as const, title: "Alto", value: highForCards, description: temporalDescription ?? "Prioridade elevada", icon: ShieldAlert, tone: "bg-red-50 text-red-700" },
    { filter: "disaster" as const, title: "Desastre", value: disasterForCards, description: temporalDescription ?? "Prioridade máxima", icon: Siren, tone: "bg-red-100 text-red-950" },
  ];

  const customerCards = useMemo(() => [
    { key: "all", name: "Todos", alerts_count: metrics?.active_total ?? health?.counts.active_alerts ?? 0, enrichment_status: "enriched" as const },
    ...(facets?.customers ?? []).map((customer) => customer.key === "unclassified"
      ? { ...customer, name: "Cliente não identificado" }
      : customer),
  ], [facets?.customers, health?.counts.active_alerts, metrics?.active_total]);
  const selectedCustomerLabel = useMemo(() => {
    if (selectedCustomerKeys.length === 0) return "TODOS";
    if (selectedCustomerKeys.length > 1) return `${selectedCustomerKeys.length} CLIENTES`;
    const selected = customerCards.find((customer) => customer.key === selectedCustomerKeys[0]);
    return safeDisplayText(selected?.name, "CLIENTE").toUpperCase();
  }, [customerCards, selectedCustomerKeys]);
  const tableCustomerScope = useMemo(() => {
    if (selectedCustomerKeys.length === 0) return "todos os clientes";
    if (selectedCustomerKeys.length > 1) return `${selectedCustomerKeys.length} clientes selecionados`;
    const selected = customerCards.find((customer) => customer.key === selectedCustomerKeys[0]);
    return safeDisplayText(selected?.name, "cliente selecionado");
  }, [customerCards, selectedCustomerKeys]);

  const activeFilterChips = [
    selectedCustomerKeys.length ? { label: `${selectedCustomerKeys.length} cliente(s)`, remove: () => setSelectedCustomerKeys([]) } : null,
    selectedDatasources.length ? { label: `${selectedDatasources.length} fonte(s)`, remove: () => setSelectedDatasources([]) } : null,
    ...selectedSeverities.map((severity) => ({ label: severityCatalog[severity].label, remove: () => setSelectedSeverities((current) => current.filter((item) => item !== severity)) })),
    statusFilter !== "active" ? { label: `Status: ${statusFilter === "resolved" ? "Resolvidos" : "Todos"}`, remove: () => setStatusFilter("active") } : null,
    sourceAckFilter !== "all" ? { label: `ACK origem: ${sourceAckFilter === "acknowledged" ? "Reconhecido" : "Pendente"}`, remove: () => setSourceAckFilter("all") } : null,
    temporalFilterActive(createdPreset, createdRange) ? { label: `Criados ${temporalLabels[createdPreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`, remove: () => { setCreatedPreset("all"); setCreatedRange(undefined); } } : null,
    temporalFilterActive(updatedPreset, updatedRange) ? { label: `Atualizados ${temporalLabels[updatedPreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`, remove: () => { setUpdatedPreset("all"); setUpdatedRange(undefined); } } : null,
    temporalFilterActive(resolvedPreset, resolvedRange) ? { label: `Resolvidos ${temporalLabels[resolvedPreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`, remove: () => { setResolvedPreset("all"); setResolvedRange(undefined); } } : null,
    temporalFilterActive(ackPreset, ackRange) ? { label: `ACKs Zabbix ${temporalLabels[ackPreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`, remove: () => { setAckPreset("all"); setAckRange(undefined); } } : null,
    debouncedHostSearch ? { label: `Host: ${debouncedHostSearch}`, remove: () => setHostSearch("") } : null,
    debouncedProblemSearch ? { label: `Problema: ${debouncedProblemSearch}`, remove: () => setProblemSearch("") } : null,
  ].filter((chip): chip is { label: string; remove: () => void } => Boolean(chip));

  const firstVisible = pagination.total_items === 0 ? 0 : (pagination.page - 1) * pagination.page_size + 1;
  const lastVisible = pagination.total_items === 0 ? 0 : Math.min(firstVisible + alerts.length - 1, pagination.total_items);
  const summarySeconds = Math.ceil((summaryDeadlineRef.current - clockTick) / 1000);
  const alertsSeconds = Math.ceil((alertsDeadlineRef.current - clockTick) / 1000);
  const selectedAlert = detail?.item ?? selectedPreview;
  const selectedCustomer = selectedAlert ? customerPresentation(selectedAlert) : null;
  const selectedClassificationTags = selectedAlert ? safeClassificationTags(selectedAlert) : [];
  const groupedHistory = useMemo(() => groupHistoryItems(history?.items ?? []), [history?.items]);
  const v1HistoryGroups = useMemo(
    () => groupedHistory.filter((group) => group.primary.event_type !== "internal_acknowledged" && group.primary.origin !== "oneview_internal"),
    [groupedHistory],
  );
  const visibleHistoryGroups = useMemo(
    () => v1HistoryGroups.filter((group) => historyGroupMatchesFilter(group, historyFilter)),
    [historyFilter, v1HistoryGroups],
  );
  const visibleHistoryItems = visibleHistoryGroups.flatMap((group) => group.items);
  const firstHistoryEventAt = visibleHistoryItems.at(-1)?.occurred_at ?? null;
  const lastHistoryEventAt = visibleHistoryItems[0]?.occurred_at ?? null;
  const historyHasRecovery = history?.has_recovery ?? (history?.items ?? []).some((item) => /recovered|recovery|resolved|normaliz/i.test(item.event_type));
  const acknowledgementGroups = v1HistoryGroups.filter((group) => isAcknowledgementEvent(group.primary.event_type) && historyOrigin(group.primary) === "Zabbix");
  const historyHasAck = acknowledgementGroups.length > 0;
  const acknowledgementActors = [...new Set(acknowledgementGroups
    .map((group) => historyActorLabel(group.primary.ack_actor_name || group.primary.actor_name, { allowWorkerLabel: false }))
    .filter((actor): actor is string => Boolean(actor)))];
  const selectedSourceAck = sourceAckPresentation(selectedAlert);
  const sourceAckConfirmedWithoutHistory = Boolean(
    selectedAlert
    && selectedSourceAck.status === "acknowledged"
    && !historyHasAck
    && selectedSourceAck.historyAvailable === false,
  );
  const ackActorSummary = (() => {
    if (selectedAlert && sourceAcknowledged(selectedAlert)) {
      if (!historyHasAck) return "ACK atual confirmado pela origem";
      if (history?.ack_actor_summary === "Mais de um responsável" || acknowledgementActors.length > 1) {
        return "Mais de um responsável";
      }
      return acknowledgementActors[0] || selectedSourceAck.actorLabel || "Responsável não informado pela origem";
    }
    if (historyHasAck) {
      if (history?.ack_actor_summary === "Mais de um responsável" || acknowledgementActors.length > 1) {
        return "Mais de um responsável";
      }
      return acknowledgementActors[0] || "Responsável não informado pela origem";
    }
    return "Pendente";
  })();
  const sourceAcknowledgementComment = selectedSourceAck.comment
    || acknowledgementGroups.find((group) => historyOrigin(group.primary) === "Zabbix")?.primary.comment
    || null;
  const historyQuality = useMemo(
    () => historyQualityFor(v1HistoryGroups.flatMap((group) => group.items), history?.history_partial === true),
    [history?.history_partial, v1HistoryGroups],
  );
  const isRefreshing = isAlertsLoading || isSummaryLoading;
  const showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts.length === 0;
  const ackRequestsEnabled = health?.capabilities?.acknowledgement === true;
  const showIpColumn = useMemo(() => alerts.some((alert) => safeHostIp(alert.host_ip) !== null), [alerts]);
  const tableColumnCount = showIpColumn ? 10 : 9;
  const selectedSourceHealth = selectedAlert
    ? operationsHealth?.items.find((item) => item.name.trim().toLowerCase() === selectedAlert.datasource_name?.trim().toLowerCase())
    : undefined;
  const staleThresholdMinutes = health?.thresholds?.alert_stale_minutes ?? 15;
  const selectedLastSeenAt = selectedAlert ? Date.parse(selectedAlert.last_seen_at || "") : Number.NaN;
  const minutesWithoutConfirmation = Number.isNaN(selectedLastSeenAt)
    ? null
    : Math.max(0, Math.floor((Date.now() - selectedLastSeenAt) / 60_000));
  const freshnessState = !selectedAlert
    ? "Informação indisponível"
    : isResolvedAlert(selectedAlert)
      ? "Resolvido"
      : selectedSourceHealth?.operational_status === "error" || selectedSourceHealth?.operational_status === "stale"
        ? "Dados possivelmente desatualizados"
        : minutesWithoutConfirmation !== null && minutesWithoutConfirmation <= staleThresholdMinutes
          ? "Ativo e confirmado recentemente"
          : "Ativo, mas sem confirmação recente";

  const clearFilters = () => {
    setSelectedCustomerKeys([]);
    setSelectedDatasources([]);
    setSelectedSeverities([]);
    setSourceAckFilter("all");
    setStatusFilter("active");
    setSortField("last_seen_at");
    setSortOrder("desc");
    setHostSearch("");
    setProblemSearch("");
    setDatasourceSearch("");
    setCreatedPreset("all");
    setUpdatedPreset("all");
    setResolvedPreset("all");
    setAckPreset("all");
    setCreatedRange(undefined);
    setUpdatedRange(undefined);
    setResolvedRange(undefined);
    setAckRange(undefined);
    setPage(1);
  };

  const applySummaryFilter = (filter: SummaryFilter) => {
    setSelectedSeverities(filter === "high" ? ["high"] : filter === "disaster" ? ["disaster"] : []);
    setSourceAckFilter(filter === "acknowledged" ? "acknowledged" : filter === "pending" ? "unacknowledged" : "all");
    setStatusFilter(filter === "total" ? "all" : filter === "active" ? "active" : hasTemporalFilter ? statusFilter : "active");
    setSortField("last_seen_at");
    setSortOrder("desc");
    setHostSearch("");
    setProblemSearch("");
    setPage(1);
  };

  const summaryFilterIsActive = (filter: SummaryFilter) => {
    if (selectedSeverities.length > 1) return false;
    if (filter === "total") return statusFilter === "all" && sourceAckFilter === "all" && selectedSeverities.length === 0;
    if (filter === "active") return statusFilter === "active" && sourceAckFilter === "all" && selectedSeverities.length === 0;
    if (filter === "acknowledged") return statusFilter === "active" && sourceAckFilter === "acknowledged" && selectedSeverities.length === 0;
    if (filter === "pending") return statusFilter === "active" && sourceAckFilter === "unacknowledged" && selectedSeverities.length === 0;
    if (filter === "high") return statusFilter === "active" && sourceAckFilter === "all" && selectedSeverities[0] === "high";
    return statusFilter === "active" && sourceAckFilter === "all" && selectedSeverities[0] === "disaster";
  };

  const toggleCustomer = (key: string) => {
    setPage(1);
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const applyCreatedPreset = (preset: TemporalPreset) => {
    setCreatedPreset(preset);
    if (preset !== "custom") setCreatedRange(undefined);
    setPage(1);
  };

  const applyUpdatedPreset = (preset: TemporalPreset) => {
    setUpdatedPreset(preset);
    if (preset !== "custom") setUpdatedRange(undefined);
    setPage(1);
  };

  const applyResolvedPreset = (preset: ResolvedTemporalPreset) => {
    setResolvedPreset(preset);
    if (preset !== "custom") setResolvedRange(undefined);
    if (preset !== "all") setStatusFilter("resolved");
    setPage(1);
  };

  const openAlert = (alert: OneViewAlert) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("alert", alert.id);
    setSearchParams(nextSearchParams, { replace: true });
    setSelectedAlertId(alert.id);
    setSelectedPreview(alert);
    setDetail(null);
    setHistory(null);
    setHistoryFilter("all");
    setDetailMeta({});
    setHistoryMeta({});
    void loadSelectedAlert(alert.id);
  };

  const closeAlert = () => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("alert");
    setSearchParams(nextSearchParams, { replace: true });
    detailRequestRef.current?.abort();
    setSelectedAlertId(null);
    setSelectedPreview(null);
    setDetail(null);
    setHistory(null);
    setHistoryFilter("all");
    setDetailMeta({});
    setHistoryMeta({});
    setDetailError(null);
    setAckDialogOpen(false);
    setAckComment("");
    setAckRequestKey("");
    setAckError(null);
  };

  const openAckRequest = (alert: OneViewAlert) => {
    if (!ackRequestAllowedFor(alert, ackRequestsEnabled) || internallyRecognized(alert) || pendingAckRequests[alert.id] || ["pending", "processing", "recorded"].includes(alert.ack_request_status || "")) return;
    if (selectedAlertId !== alert.id) openAlert(alert);
    setAckComment("");
    setAckError(null);
    setAckRequestKey(globalThis.crypto?.randomUUID?.() ?? `ack-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    setAckDialogOpen(true);
  };

  const submitAckRequest = async () => {
    if (!ackRequestsEnabled || !selectedAlert || !ackRequestKey || ackSubmitting) return;
    setAckSubmitting(true);
    setAckError(null);
    try {
      const response = await requestAlertAcknowledgement(selectedAlert.id, ackComment.trim(), ackRequestKey);
      const acknowledgedAt = new Date().toISOString();
      setPendingAckRequests((current) => ({ ...current, [selectedAlert.id]: response.request_id }));
      setAlerts((current) => current.map((alert) => alert.id === selectedAlert.id ? {
        ...alert,
        acknowledged_internal: true,
        acknowledged_internal_at: acknowledgedAt,
        acknowledged_internal_by: response.actor_name,
        acknowledged_internal_comment: ackComment.trim(),
        ack_request_status: null,
      } : alert));
      setDetail((current) => current?.item.id === selectedAlert.id ? {
        ...current,
        item: {
          ...current.item,
          acknowledged_internal: true,
          acknowledged_internal_at: acknowledgedAt,
          acknowledged_internal_by: response.actor_name,
          acknowledged_internal_comment: ackComment.trim(),
          ack_request_status: null,
        },
      } : current);
      setAckDialogOpen(false);
      setAckComment("");
      toast.success(`O alerta foi reconhecido internamente por ${response.actor_name}. O ACK da origem não foi alterado.`);
      await Promise.all([
        loadSummaryResources(true),
        loadAlerts(),
        loadSelectedAlert(selectedAlert.id),
      ]);
    } catch (error) {
      setAckError(error instanceof Error ? error.message : "Não foi possível registrar a solicitação.");
    } finally {
      setAckSubmitting(false);
    }
  };

  const handlePause = () => {
    if (isPaused) {
      setIsPaused(false);
      void refreshAll();
      return;
    }
    setIsPaused(true);
  };

  const topbarControls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="flex items-center gap-2 text-[11px] leading-4 text-muted-foreground">
        <span>{hasSnapshot ? "Próxima tentativa" : "Resumo"} em {isPaused ? "pausa" : formatCountdown(summarySeconds)}</span>
        <span aria-hidden="true">·</span>
        <span>Alertas em {isPaused ? "pausa" : formatCountdown(alertsSeconds)}</span>
      </div>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-muted-foreground"
              aria-label="Atualizar dados"
              onClick={() => void refreshAll()}
              disabled={isRefreshing}
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Atualizar dados em segundo plano</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button type="button" variant={isPaused ? "default" : "outline"} size="sm" onClick={handlePause}>
        {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        {isPaused ? "Retomar" : "Pausar"}
      </Button>
    </div>
  );

  const toggleColumnSort = (field: SortField) => {
    setSortOrder((current) => sortField === field && current === "asc" ? "desc" : "asc");
    setSortField(field);
    setPage(1);
  };

  const sortableHeader = (label: string, field: SortField) => (
    <button
      type="button"
      className="group inline-flex min-w-0 items-center justify-center gap-1 font-semibold text-foreground transition-colors hover:text-primary"
      onClick={() => toggleColumnSort(field)}
      title={`Ordenar ${label}: ${sortField === field && sortOrder === "asc" ? "Z–A" : "A–Z"}`}
    >
      <span className="truncate">{label}</span>
      <ArrowUpDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary", sortField === field && "text-primary")} />
      {sortField === field ? <span className="sr-only">{sortOrder === "asc" ? "ordem crescente" : "ordem decrescente"}</span> : null}
    </button>
  );

  const visibleDatasourceOptions = (facets?.datasources ?? []).filter((source) =>
    source.name.toLocaleLowerCase("pt-BR").includes(datasourceSearch.trim().toLocaleLowerCase("pt-BR")),
  );

  const temporalOptionText = (subject: string, preset: ResolvedTemporalPreset, count?: number) => preset === "all"
    ? "Todos"
    : `${subject} ${temporalLabels[preset]} · ${(count ?? 0).toLocaleString("pt-BR")} alertas`;

  const clientSelector = (
    <Popover open={customerFilterOpen} onOpenChange={setCustomerFilterOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={customerFilterOpen}
          className="h-12 min-w-56 justify-between rounded-[10px] border-[1.5px] border-border/60 bg-white px-3 shadow-sm hover:border-black hover:bg-white"
        >
          <span className="flex min-w-0 items-center gap-3 text-left">
            <CustomerLogo
              customer={selectedCustomerKeys.length === 1 ? customerCards.find((customer) => customer.key === selectedCustomerKeys[0]) : { key: "all", name: "Todos" }}
            />
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cliente</span>
              <span className="block truncate text-sm font-semibold tracking-wide text-foreground">{selectedCustomerLabel}</span>
            </span>
          </span>
          <span className="ml-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border/60 bg-white text-muted-foreground">
            <ChevronsUpDown className="h-4 w-4" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[310px] p-0">
        <Command>
          <CommandInput placeholder="Buscar cliente..." className="h-10" />
          <CommandList>
            <CommandEmpty>Nenhum cliente encontrado.</CommandEmpty>
            <CommandGroup heading="Clientes disponíveis">
              {customerCards.map((customer) => {
                const selected = customer.key === "all"
                  ? selectedCustomerKeys.length === 0
                  : selectedCustomerKeys.includes(customer.key);
                return (
                  <CommandItem
                    key={customer.key}
                    value={`${customer.name} ${customer.key}`}
                    onSelect={() => {
                      toggleCustomer(customer.key);
                      if (customer.key === "all") setCustomerFilterOpen(false);
                    }}
                    className={cn(
                      "mx-1 my-1 gap-3 rounded-md border-[1.5px] border-transparent px-2 py-2 transition-colors",
                      selected && "border-black bg-white",
                      "data-[selected=true]:border-black data-[selected=true]:bg-white data-[selected=true]:text-foreground",
                    )}
                  >
                    <CustomerLogo customer={customer} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{safeDisplayText(customer.name, "Cliente não identificado")}</span>
                      <span className="text-[10px] text-muted-foreground">{customer.alerts_count.toLocaleString("pt-BR")} alertas</span>
                    </span>
                    <Check className={cn("h-4 w-4 text-primary", selected ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      clientSelect={clientSelector}
      topbarRightSection={topbarControls}
      contentClassName="gap-3 px-3 py-3 lg:px-4"
      title="Alertas"
    >
      {hasSnapshot ? (
        <Card className="rounded-[10px] border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div>
                <h2 className="text-sm font-semibold text-amber-900">Dados em modo de contingência</h2>
                <p className="text-sm text-amber-800">A conexão em tempo real está indisponível e os dados podem estar desatualizados.</p>
                <p className="mt-1 text-xs text-amber-700">
                  Consulta: {formatDateTime(lastCheckedAt)}{fallbackCode ? ` · Código: ${safeDisplayText(fallbackCode)}` : ""}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshAll()} disabled={isRefreshing}>
              <RefreshCcw className="h-4 w-4" /> Tentar novamente
            </Button>
          </div>
        </Card>
      ) : null}

      {summaryError ? (
        <div className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{summaryError}</div>
      ) : null}

      <section aria-label="Filtros rápidos por indicadores">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          {summaryCards.map((card) => {
            const Icon = card.icon;
            const selected = summaryFilterIsActive(card.filter);
            return (
              <button
                key={card.title}
                type="button"
                aria-pressed={selected}
                aria-label={`Filtrar alertas: ${card.title}`}
                onClick={() => applySummaryFilter(card.filter)}
                className={cn(
                  "rounded-[10px] border border-border/70 bg-card p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  selected && "border-foreground/50 ring-1 ring-foreground/20",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                    {isSummaryLoading && !health && !metrics ? <Skeleton className="mt-2 h-7 w-20" /> : (
                      <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">{formatCardValue(card.value)}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{card.description}</p>
                  </div>
                  <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", card.tone)}><Icon className="h-4 w-4" /></div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <Card className="overflow-hidden rounded-[10px] border border-border/70 bg-white shadow-sm">
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">{statusFilter === "resolved" ? "Alertas resolvidos" : "Alertas"} filtrados por {tableCustomerScope}</h2>
              <p className="text-xs text-muted-foreground">
                {isAlertsLoading && hasTemporalFilter
                  ? "Aplicando filtro de período…"
                  : `Exibindo ${firstVisible.toLocaleString("pt-BR")}–${lastVisible.toLocaleString("pt-BR")} de ${listTotal.toLocaleString("pt-BR")} ${statusFilter === "resolved" ? "alertas resolvidos" : "alertas"}`}
                {snapshotCoverage?.partial ? ` disponíveis na cópia · ${snapshotCoverage.total_persisted.toLocaleString("pt-BR")} persistidos` : ""}
              </p>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {activeFilterChips.map((chip) => (
                <Button
                  key={chip.label}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 rounded-full px-2.5 text-[11px]"
                  onClick={() => { chip.remove(); setPage(1); }}
                >
                  {chip.label}<X className="h-3 w-3" />
                </Button>
              ))}
              {activeFilterChips.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">Clique nos títulos das colunas para ordenar. Use as lupas para filtrar.</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-8 px-2.5 text-xs", hasTemporalFilter && "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")}
                  >
                    <CalendarRange className="h-3.5 w-3.5" />
                    Período{hasTemporalFilter ? ` · ${[temporalFilterActive(createdPreset, createdRange), temporalFilterActive(updatedPreset, updatedRange), temporalFilterActive(resolvedPreset, resolvedRange), temporalFilterActive(ackPreset, ackRange)].filter(Boolean).length}` : ""}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[340px] p-3">
                  <div className="mb-3">
                    <p className="text-sm font-semibold">Filtrar por período</p>
                    <p className="text-[11px] text-muted-foreground">Criação, atualização e resolução usam datas independentes.</p>
                  </div>
                  <Tabs defaultValue={resolvedPreset !== "all" ? "resolved" : updatedPreset !== "all" ? "updated" : "created"}>
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="created" className="gap-1 text-xs">Criados{temporalFilterActive(createdPreset, createdRange) ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}</TabsTrigger>
                      <TabsTrigger value="updated" className="gap-1 text-xs">Atualizados{temporalFilterActive(updatedPreset, updatedRange) ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}</TabsTrigger>
                      <TabsTrigger value="resolved" className="gap-1 text-xs">Resolvidos{temporalFilterActive(resolvedPreset, resolvedRange) ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="created" className="mt-3 space-y-2">
                      <Select value={createdPreset} onValueChange={(value) => applyCreatedPreset(value as TemporalPreset)}>
                        <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todos os criados</SelectItem>
                          {(["15m", "1h", "6h", "24h", "7d"] as const).map((preset) => (
                            <SelectItem key={preset} value={preset}>{temporalOptionText("Criados", preset, temporalCounts?.created[preset])}</SelectItem>
                          ))}
                          <SelectItem value="custom">Período personalizado</SelectItem>
                        </SelectContent>
                      </Select>
                      {createdPreset === "custom" ? <Calendar mode="range" numberOfMonths={1} locale={ptBR} selected={createdRange} onSelect={(range) => { setCreatedRange(range); setPage(1); }} /> : null}
                    </TabsContent>
                    <TabsContent value="updated" className="mt-3 space-y-2">
                      <Select value={updatedPreset} onValueChange={(value) => applyUpdatedPreset(value as TemporalPreset)}>
                        <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todos os atualizados</SelectItem>
                          {(["15m", "1h", "6h", "24h", "7d"] as const).map((preset) => (
                            <SelectItem key={preset} value={preset}>{temporalOptionText("Atualizados", preset, temporalCounts?.updated[preset])}</SelectItem>
                          ))}
                          <SelectItem value="custom">Período personalizado</SelectItem>
                        </SelectContent>
                      </Select>
                      {updatedPreset === "custom" ? <Calendar mode="range" numberOfMonths={1} locale={ptBR} selected={updatedRange} onSelect={(range) => { setUpdatedRange(range); setPage(1); }} /> : null}
                    </TabsContent>
                    <TabsContent value="resolved" className="mt-3 space-y-2">
                      <Select value={resolvedPreset} onValueChange={(value) => applyResolvedPreset(value as ResolvedTemporalPreset)}>
                        <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Todos os resolvidos</SelectItem>
                          {(["15m", "1h", "6h", "24h", "7d", "30d"] as const).map((preset) => (
                            <SelectItem key={preset} value={preset}>{temporalOptionText("Resolvidos", preset, temporalCounts?.resolved[preset])}</SelectItem>
                          ))}
                          <SelectItem value="custom">Período personalizado</SelectItem>
                        </SelectContent>
                      </Select>
                      {resolvedPreset === "custom" ? <Calendar mode="range" numberOfMonths={1} locale={ptBR} selected={resolvedRange} onSelect={(range) => { setResolvedRange(range); setPage(1); }} /> : null}
                    </TabsContent>
                  </Tabs>
                  {hasTemporalFilter ? (
                    <Button type="button" variant="ghost" size="sm" className="mt-2 h-8 w-full text-xs" onClick={() => {
                      setCreatedPreset("all"); setUpdatedPreset("all"); setResolvedPreset("all"); setAckPreset("all");
                      setCreatedRange(undefined); setUpdatedRange(undefined); setResolvedRange(undefined); setAckRange(undefined); setPage(1);
                    }}>Limpar períodos</Button>
                  ) : null}
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-8 px-2.5 text-xs", sourceAckFilter !== "all" && "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")}
                  >
                    <UserCheck className="h-3.5 w-3.5" /> ACK origem
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 space-y-3 p-3">
                  <div>
                    <p className="text-sm font-semibold">Filtrar ACK da origem</p>
                    <p className="text-[11px] text-muted-foreground">Estado confirmado pelo Zabbix.</p>
                  </div>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    ACK real
                    <Select value={sourceAckFilter} onValueChange={(value) => { setSourceAckFilter(value as RecognitionFilter); setPage(1); }}>
                      <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todos</SelectItem>
                        <SelectItem value="acknowledged">Reconhecidos na origem</SelectItem>
                        <SelectItem value="unacknowledged">Pendentes na origem</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </PopoverContent>
              </Popover>
              {activeFilterChips.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={clearFilters}>Limpar</Button>
              ) : null}
              <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                <SelectTrigger className="h-8 w-[76px] bg-white" aria-label="Itens por página"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {alertsError ? <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{alertsError}</div> : null}

        <div className="relative min-h-[360px] max-h-[calc(100vh-22rem)] overflow-auto" aria-busy={isAlertsLoading}>
          {isAlertsLoading && hasLoadedAlerts ? (
            <div className="sticky top-0 z-20 flex items-center justify-center gap-2 border-b border-border/50 bg-background/90 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" />
              Atualizando...
            </div>
          ) : null}
          {isAlertsLoading && alerts.length > 0 ? <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-1/3 animate-pulse bg-primary" /></div> : null}
          <Table className={cn(showIpColumn ? "min-w-[1420px]" : "min-w-[1340px]", "w-full table-fixed text-[11px]")}>
            <colgroup>
              <col className="w-[10%]" />
              <col className="w-[7%]" />
              <col className="w-[12%]" />
              {showIpColumn ? <col className="w-[6%]" /> : null}
              <col className="w-[7%]" />
              <col className={showIpColumn ? "w-[20%]" : "w-[25%]"} />
              <col className="w-[6%]" />
              <col className="w-[8%]" />
              <col className="w-[9%]" />
              <col className="w-[10%]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="border-border/70 bg-muted/80 text-[10px] text-muted-foreground hover:bg-muted/80">
                <TableHead className="px-3 text-center">{sortableHeader("Cliente", "client")}</TableHead>
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("Fonte", "datasource")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", selectedDatasources.length > 0 && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Filtrar fonte">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 p-2">
                        <Input value={datasourceSearch} onChange={(event) => setDatasourceSearch(event.target.value)} placeholder="Buscar fonte..." className="h-8" />
                        <div className="mt-2 max-h-52 space-y-1 overflow-auto">
                          {visibleDatasourceOptions.map((source) => {
                            const selected = selectedDatasources.includes(source.name);
                            return (
                              <Button
                                key={source.id}
                                type="button"
                                variant={selected ? "default" : "ghost"}
                                size="sm"
                                className="h-8 w-full justify-between px-2 text-xs"
                                onClick={() => {
                                  setSelectedDatasources((current) => selected ? current.filter((item) => item !== source.name) : [...current, source.name]);
                                  setPage(1);
                                }}
                              >
                                <span className="truncate">{safeDisplayText(source.name, "Fonte")}</span>
                                <span className="ml-2 tabular-nums opacity-70">{source.alerts_count.toLocaleString("pt-BR")}</span>
                              </Button>
                            );
                          })}
                          {visibleDatasourceOptions.length === 0 ? <p className="p-2 text-xs text-muted-foreground">Nenhuma fonte encontrada.</p> : null}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("Host", "host")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", debouncedHostSearch && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Pesquisar host">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 p-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          Pesquisar somente em host
                          <Input autoFocus value={hostSearch} onChange={(event) => { setHostSearch(event.target.value); setPage(1); }} placeholder="Nome visível ou técnico" className="mt-1 h-8" />
                        </label>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                {showIpColumn ? <TableHead className="px-3 text-center">IP</TableHead> : null}
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("Prioridade", "severity")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", selectedSeverities.length > 0 && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Filtrar prioridade">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-56 space-y-1 p-2">
                        {severityOrder.map((severity) => {
                          const selected = selectedSeverities.includes(severity);
                          return (
                            <Button
                              key={severity}
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn("h-8 w-full justify-start border px-2 text-xs", severityCatalog[severity].tone, selected && "ring-2 ring-primary/40")}
                              onClick={() => {
                                setSelectedSeverities((current) => selected ? current.filter((item) => item !== severity) : [...current, severity]);
                                setPage(1);
                              }}
                            >
                              {severityCatalog[severity].short} · {severityCatalog[severity].label}
                              {selected ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                            </Button>
                          );
                        })}
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("Problema", "problem")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", debouncedProblemSearch && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Pesquisar problema">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 p-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          Pesquisar somente em problema
                          <Input autoFocus value={problemSearch} onChange={(event) => { setProblemSearch(event.target.value); setPage(1); }} placeholder="Descrição do problema" className="mt-1 h-8" />
                        </label>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-center">{sortableHeader("Duração", "duration")}</TableHead>
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("Status", "status")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", statusFilter !== "active" && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Filtrar status">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-52 p-2">
                        <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value as StatusFilter); setPage(1); }}>
                          <SelectTrigger className="h-8 bg-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Ativos</SelectItem>
                            <SelectItem value="resolved">Resolvidos</SelectItem>
                            <SelectItem value="all">Todos</SelectItem>
                          </SelectContent>
                        </Select>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {sortableHeader("ACK origem", "acknowledged_source")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", sourceAckFilter !== "all" && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Filtrar ACK da origem">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-52 p-2">
                        <Select value={sourceAckFilter} onValueChange={(value) => { setSourceAckFilter(value as RecognitionFilter); setPage(1); }}>
                          <SelectTrigger className="h-8 bg-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Todos</SelectItem>
                            <SelectItem value="acknowledged">Reconhecidos na origem</SelectItem>
                            <SelectItem value="unacknowledged">Pendentes na origem</SelectItem>
                          </SelectContent>
                        </Select>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-center">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showAlertsSkeleton ? Array.from({ length: 8 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: tableColumnCount }).map((__, cell) => <TableCell key={cell} className="py-4"><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              )) : alerts.length === 0 ? (
                <TableRow><TableCell colSpan={tableColumnCount} className="py-16 text-center text-muted-foreground"><CircleAlert className="mx-auto mb-2 h-7 w-7" />Nenhum alerta corresponde aos filtros selecionados.</TableCell></TableRow>
              ) : alerts.map((alert) => {
                const priority = severityCatalog[normalizeOneViewSeverity(alert.severity)];
                const isResolved = isResolvedAlert(alert);
                const isActive = !isResolved;
                const customer = customerPresentation(alert);
                return (
                  <TableRow
                    key={alert.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={selectedAlertId === alert.id}
                    onClick={() => openAlert(alert)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAlert(alert); } }}
                    className={cn("cursor-pointer border-border/40 outline-none hover:bg-muted/40 focus-visible:bg-muted/60", selectedAlertId === alert.id && "bg-muted/60")}
                  >
                    <TableCell className="align-middle px-3 py-2.5">
                      <div className="flex flex-col items-center text-center">
                        <div className="flex items-center justify-center gap-2 text-left">
                          <CustomerLogo customer={{ key: alert.customer_key, name: alert.customer_name }} />
                          <div className="min-w-0">
                            <p className="font-semibold leading-4">{customer.name}</p>
                            {customer.hint ? <p className="mt-1 text-[9px] leading-3 text-muted-foreground">{customer.hint}</p> : null}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center font-medium">{safeDisplayText(alert.datasource_name, "Fonte não identificada")}</TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center"><p className="truncate font-semibold" title={safeDisplayText(alert.host_visible_name || alert.host_technical_name || alert.host_name)}>{safeDisplayText(alert.host_visible_name || alert.host_technical_name || alert.host_name)}</p>{alert.host_visible_name && alert.host_technical_name ? <p className="truncate font-mono text-[9px] text-muted-foreground">{safeDisplayText(alert.host_technical_name)}</p> : null}</TableCell>
                    {showIpColumn ? <TableCell className="align-middle px-3 py-2.5 text-center font-mono text-muted-foreground">{safeHostIp(alert.host_ip) ?? "-"}</TableCell> : null}
                    <TableCell className="align-middle px-3 py-2.5 text-center"><Badge className={cn("border text-[10px] hover:bg-inherit", priority.tone)}>{priority.label}</Badge></TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center"><p className="line-clamp-2 font-medium leading-4" title={safeDisplayText(alert.problem_name, "Alerta sem descrição")}>{safeDisplayText(alert.problem_name, "Alerta sem descrição", 220)}</p></TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center font-mono text-muted-foreground">{formatDurationSeconds(alert.duration_seconds)}</TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center"><p className={cn("font-medium", isActive ? "text-red-700" : "text-emerald-700")}>{isActive ? "Ativo" : "Resolvido"}</p><p className="text-[9px] text-muted-foreground">{isResolved ? `Resolvido em ${formatDateTime(alert.resolved_at)}` : formatDateTime(alert.last_seen_at)}</p></TableCell>
                    <TableCell className="overflow-hidden align-middle px-3 py-2.5 text-center">
                      {(() => {
                        const ack = sourceAckPresentation(alert);
                        return (
                          <>
                            <Badge className={cn("max-w-full whitespace-nowrap border text-[10px] hover:bg-inherit", ack.status === "acknowledged" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>
                              {ack.status === "acknowledged" ? "Reconhecido" : "Pendente"}
                            </Badge>
                            {ack.status === "acknowledged" ? (
                              <p className="mt-1 whitespace-normal break-words text-[9px] text-muted-foreground">
                                {ack.actorLabel ? `Por: ${ack.actorLabel}` : "Responsável não informado pela origem"}
                              </p>
                            ) : null}
                            {ack.status === "acknowledged" && ack.at ? <p className="text-[9px] text-muted-foreground">{formatDateTime(ack.at)}</p> : null}
                          </>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1 whitespace-nowrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label="Ver detalhes do alerta"
                          title="Ver detalhes do alerta"
                          onClick={(event) => {
                            event.stopPropagation();
                            openAlert(alert);
                          }}
                        >
                          <Eye className="h-3.5 w-3.5" />
                          <span className="sr-only">Ver detalhes do alerta</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">Página {pagination.total_pages === 0 ? 0 : pagination.page} de {pagination.total_pages}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!pagination.has_previous || isAlertsLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="h-4 w-4" />Anterior</Button>
            <Button type="button" variant="outline" size="sm" disabled={!pagination.has_next || isAlertsLoading} onClick={() => setPage((current) => current + 1)}>Próxima<ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </Card>

      <Sheet open={selectedAlertId !== null} onOpenChange={(open) => { if (!open) closeAlert(); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-2xl">
          {selectedAlert ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0"><SheetTitle className="text-xl">Detalhes do alerta</SheetTitle><SheetDescription>Informações operacionais seguras e histórico do OneView.</SheetDescription></div>
                  <Badge className={cn("shrink-0 whitespace-nowrap border hover:bg-inherit", isResolvedAlert(selectedAlert) ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>{isResolvedAlert(selectedAlert) ? "Resolvido" : "Em acompanhamento"}</Badge>
                </div>
              </SheetHeader>

              <Tabs defaultValue="summary" className="flex min-h-0 flex-1 flex-col">
                <TabsList className="mx-6 mt-4 grid w-auto grid-cols-3">
                  <TabsTrigger value="summary"><Eye className="mr-1.5 h-4 w-4" />Resumo</TabsTrigger>
                  <TabsTrigger value="history"><History className="mr-1.5 h-4 w-4" />Histórico</TabsTrigger>
                  <TabsTrigger value="technical"><Info className="mr-1.5 h-4 w-4" />Informações técnicas</TabsTrigger>
                </TabsList>

                {detailError ? <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailError}</div> : null}

                <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                  <TabsContent value="summary" className="mt-4 space-y-4">
                    {isDetailLoading && !detail ? <><Skeleton className="h-28 w-full" /><Skeleton className="h-52 w-full" /></> : (
                      <>
                        <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</p><p className="mt-2 text-base font-semibold leading-6">{safeDisplayText(selectedAlert.problem_name, "Alerta sem descrição")}</p></Card>
                        {selectedCustomer?.unidentified ? (
                          <section aria-label="Cliente não identificado" className="rounded-[10px] border border-border/70 bg-muted/20 p-4 shadow-sm">
                            <h3 className="text-sm font-semibold">Cliente não identificado</h3>
                            <p className="mt-1 text-sm text-muted-foreground">{selectedCustomer.hint}</p>
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                              <div><p className="text-[11px] text-muted-foreground">Fonte</p><p className="mt-1 font-semibold">{safeDisplayText(selectedAlert.datasource_name, "Fonte não identificada")}</p></div>
                              <div><p className="text-[11px] text-muted-foreground">Host visível</p><p className="mt-1 break-words font-semibold">{safeDisplayText(selectedAlert.host_visible_name || selectedAlert.host_name, "Host não identificado")}</p></div>
                            </div>
                            <div className="mt-4">
                              <p className="text-[11px] text-muted-foreground">Grupos disponíveis</p>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">{selectedAlert.host_groups?.length
                                ? selectedAlert.host_groups.map((group, index) => <Badge key={`${group.id ?? group.name}-${index}`} variant="outline">{safeDisplayText(group.name, "Grupo sem nome")}</Badge>)
                                : <span className="text-xs text-muted-foreground">Nenhum grupo disponível.</span>}</div>
                            </div>
                            <div className="mt-3">
                              <p className="text-[11px] text-muted-foreground">Tags disponíveis</p>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">{selectedClassificationTags.length
                                ? selectedClassificationTags.map((tag, index) => <Badge key={`${tag.tag}-${tag.value}-${index}`} variant="secondary">{tag.tag}{tag.value ? `: ${tag.value}` : ""}</Badge>)
                                : <span className="text-xs text-muted-foreground">Nenhuma tag disponível.</span>}</div>
                            </div>
                            <p className="mt-4 border-t border-border/70 pt-3 text-xs text-muted-foreground">Recomendação: revise as tags e os grupos na origem para permitir a associação automática do cliente.</p>
                          </section>
                        ) : null}
                        <section aria-label="Estado atual" className="space-y-2">
                          <h3 className="text-sm font-semibold">Estado atual</h3>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {[
                              ["Status", isResolvedAlert(selectedAlert) ? "Resolvido" : "Ativo"],
                              ["Prioridade", severityCatalog[normalizeOneViewSeverity(selectedAlert.severity)].label],
                              ["Supressão", selectedAlert.suppressed ? `Ativa${selectedAlert.suppressed_until ? ` até ${formatDateTime(selectedAlert.suppressed_until)}` : ""}` : "Sem supressão"],
                              ["Recovery", selectedAlert.resolved_at ? `Resolvido em ${formatDateTime(selectedAlert.resolved_at)}` : "Alerta ainda ativo"],
                            ].map(([label, value]) => <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 break-words font-semibold">{safeDisplayText(value, "Informação indisponível")}</p></Card>)}
                          </div>
                        </section>
                        <section aria-label="Identificação" className="space-y-2">
                          <h3 className="text-sm font-semibold">Identificação</h3>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">Cliente</p><p className="mt-1 break-words font-semibold">{selectedCustomer?.name ?? "Cliente não identificado"}</p></Card>
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">Fonte Zabbix</p><p className="mt-1 break-words font-semibold">{safeDisplayText(selectedAlert.datasource_name, "Fonte não identificada")}</p></Card>
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">Host</p><p className="mt-1 break-words font-semibold">{safeDisplayText(selectedAlert.host_visible_name || selectedAlert.host_technical_name || selectedAlert.host_name, "Host não identificado")}</p></Card>
                          </div>
                        </section>
                        <section aria-label="Linha do tempo essencial" className="space-y-2">
                          <h3 className="text-sm font-semibold">Linha do tempo essencial</h3>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {[
                              ["Primeira ocorrência", formatDateTime(selectedAlert.first_seen_at)],
                              ["Última ocorrência", formatDateTime(selectedAlert.last_seen_at)],
                              ["Duração", formatDurationSeconds(selectedAlert.duration_seconds)],
                              ["Persistido no OneView", formatDateTime(selectedAlert.created_at)],
                            ].map(([label, value]) => <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 break-words font-semibold">{safeDisplayText(value, "Informação indisponível")}</p></Card>)}
                          </div>
                        </section>
                        <section aria-label="Tratamento" className="space-y-2">
                          <h3 className="text-sm font-semibold">Tratamento</h3>
                          <div className="grid gap-3">
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                              <p className="text-[11px] text-muted-foreground">ACK na origem</p>
                              {(() => {
                                const ack = sourceAckPresentation(selectedAlert);
                                if (ack.status === "pending") {
                                  return <p className="mt-1 break-words font-semibold">Pendente</p>;
                                }
                                if (!ack.historyAvailable) {
                                  return (
                                    <>
                                      <p className="mt-1 break-words font-semibold">Reconhecido</p>
                                      <p className="mt-1 break-words text-sm">
                                        <span className="text-muted-foreground">Responsável:</span>{" "}
                                        {ack.actorLabel || "Responsável não informado pela origem"}
                                      </p>
                                      {ack.at ? (
                                        <p className="mt-1 break-words text-sm">
                                          <span className="text-muted-foreground">Data:</span>{" "}
                                          {formatDateTime(ack.at)}
                                        </p>
                                      ) : null}
                                      <p className="mt-3 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
                                        Detalhes históricos deste reconhecimento não estão disponíveis no registro legado.
                                      </p>
                                    </>
                                  );
                                }
                                return (
                                  <>
                                    <p className="mt-1 break-words font-semibold">
                                      {ack.actorLabel
                                        ? `Reconhecido por: ${ack.actorLabel}`
                                        : "Reconhecido"}
                                    </p>
                                    {ack.at ? (
                                      <p className="mt-1 break-words text-sm">
                                        <span className="text-muted-foreground">Data:</span>{" "}
                                        {formatDateTime(ack.at)}
                                      </p>
                                    ) : null}
                                    <p className="mt-2 break-words text-sm">
                                      <span className="text-muted-foreground">Comentário:</span>{" "}
                                      {ack.comment || sourceAcknowledgementComment
                                        ? safeDisplayText(ack.comment || sourceAcknowledgementComment)
                                        : "Sem comentário registrado na origem."}
                                    </p>
                                  </>
                                );
                              })()}
                            </Card>
                          </div>
                        </section>
                        <section aria-label="Frescor do dado" className="space-y-2">
                          <h3 className="text-sm font-semibold">Frescor do dado</h3>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                              <p className="text-[11px] text-muted-foreground">Estado de confirmação</p>
                              <p className={cn(
                                "mt-1 break-words font-semibold",
                                freshnessState === "Ativo e confirmado recentemente" && "text-emerald-700",
                                freshnessState === "Ativo, mas sem confirmação recente" && "text-amber-700",
                                freshnessState === "Dados possivelmente desatualizados" && "text-red-700",
                              )}>{freshnessState}</p>
                            </Card>
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                              <p className="text-[11px] text-muted-foreground">Última atualização</p>
                              <p className="mt-1 break-words font-semibold">{formatDateTime(selectedAlert.last_seen_at)}</p>
                            </Card>
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                              <p className="text-[11px] text-muted-foreground">Tempo sem confirmação</p>
                              <p className="mt-1 break-words font-semibold">{isResolvedAlert(selectedAlert)
                                ? "Alerta encerrado"
                                : minutesWithoutConfirmation === null
                                  ? "Horário indisponível"
                                  : formatDurationSeconds(minutesWithoutConfirmation * 60)}</p>
                            </Card>
                            <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                              <p className="text-[11px] text-muted-foreground">Duração do alerta</p>
                              <p className="mt-1 break-words font-semibold">{formatDurationSeconds(selectedAlert.duration_seconds)}</p>
                              <p className="mt-1 text-[10px] text-muted-foreground">Duração longa não indica falha de sincronização.</p>
                            </Card>
                          </div>
                        </section>
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="history" className="mt-4 space-y-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">Linha do tempo do alerta</p>
                      {history?.history_available === true ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Histórico do banco</Badge> : null}
                    </div>
                    {isDetailLoading && !history ? (
                      <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                    ) : (
                      <>
                        <section aria-label="Resumo do histórico" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {[
                            ["Eventos registrados", String(historyRecordCount(v1HistoryGroups.flatMap((group) => group.items)))],
                            ["Primeira ocorrência", formatDateTime(history?.first_event_at ?? firstHistoryEventAt)],
                            ["Última ocorrência", formatDateTime(history?.last_event_at ?? lastHistoryEventAt)],
                            ["ACK atual", sourceAcknowledged(selectedAlert) && !historyHasAck
                              ? "ACK atual confirmado pela origem"
                              : ackActorSummary],
                            ["Recovery", historyHasRecovery ? "Sim" : "Não"],
                            ["Integridade do histórico", historyQuality.kind === "complete" ? "Completo" : historyQuality.kind === "partial" ? "Parcial" : historyQuality.kind === "legacy" ? "Legado" : "Indisponível"],
                          ].map(([label, value]) => (
                            <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-3 shadow-sm">
                              <p className="text-[10px] text-muted-foreground">{label}</p>
                              <p className="mt-1 break-words text-xs font-semibold">{value}</p>
                            </Card>
                          ))}
                        </section>

                        <section aria-label="Integridade do histórico" className={cn(
                          "rounded-[10px] border p-4 shadow-sm",
                          historyQuality.kind === "complete" && "border-border/70 bg-white",
                          historyQuality.kind === "partial" && "border-amber-200 bg-amber-50",
                          historyQuality.kind === "legacy" && "border-orange-200 bg-orange-50",
                          historyQuality.kind === "unavailable" && "border-border/70 bg-muted/20",
                        )}>
                          <h3 className="text-sm font-semibold">{historyQuality.title}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">{historyQuality.description}</p>
                        </section>

                        {sourceAckConfirmedWithoutHistory ? (
                          <section aria-label="ACK atual confirmado pela origem" className="rounded-[10px] border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                            <h3 className="text-sm font-semibold text-emerald-900">ACK atual confirmado pela origem</h3>
                            <p className="mt-1 text-sm text-emerald-800">Detalhes históricos deste reconhecimento não estão disponíveis no registro legado.</p>
                          </section>
                        ) : null}

                        {v1HistoryGroups.length ? (
                          <>
                            <div className="flex flex-wrap gap-2" aria-label="Filtros rápidos do histórico">
                              {[
                                ["all", "Todos"],
                                ["acknowledgements", "Reconhecimentos"],
                                ["changes", "Mudanças"],
                                ["recovery", "Recovery"],
                                ["legacy", "Legado"],
                              ].map(([value, label]) => (
                                <Button
                                  key={value}
                                  type="button"
                                  size="sm"
                                  variant={historyFilter === value ? "default" : "outline"}
                                  className="h-8 rounded-full px-3 text-xs"
                                  onClick={() => setHistoryFilter(value as HistoryFilter)}
                                >
                                  {label}
                                </Button>
                              ))}
                            </div>

                            {visibleHistoryGroups.length ? <ol className="relative ml-3 border-l border-border pl-8">
                              {visibleHistoryGroups.map((group, index) => {
                                const item = group.primary;
                                const TimelineIcon = historyEventIcon(item.event_type);
                                const groupedEventCount = historyGroupEventCount(group);
                                const isSeenGroup = item.event_type.toLowerCase() === "problem_seen" && groupedEventCount > 1;
                                const isAckEvent = isAcknowledgementEvent(item.event_type);
                                const previousValueVisible = historyValueIsMeaningful(item.previous_value);
                                const currentValueVisible = historyValueIsMeaningful(item.current_value);
                                const previousSeverity = historySeverityValue(item.previous_value);
                                const currentSeverity = historySeverityValue(item.current_value);
                                const ackActor = historyActorLabel(item.ack_actor_name || item.actor_name, { allowWorkerLabel: false });
                                const nonAckActor = historyActorLabel(item.actor_name);
                                const occurrenceTimes = group.items
                                  .flatMap((occurrence) => [occurrence.first_occurred_at, occurrence.last_occurred_at, occurrence.occurred_at])
                                  .filter((value): value is string => Boolean(value))
                                  .sort((left, right) => Date.parse(left) - Date.parse(right));
                                const firstOccurrence = occurrenceTimes[0] ?? item.occurred_at;
                                const lastOccurrence = occurrenceTimes.at(-1) ?? item.occurred_at;
                                return (
                                  <li key={`${group.key}-${item.id}`} className={cn("relative pb-6", index === visibleHistoryGroups.length - 1 && "pb-0")}>
                                    <span className="absolute -left-[45px] top-0 flex h-7 w-7 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary ring-4 ring-background">
                                      <TimelineIcon className="h-3.5 w-3.5" />
                                    </span>
                                    <div className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <p className="font-semibold">{formalHistoryTitle(item, groupedEventCount)}</p>
                                          {groupedEventCount > 1 ? <Badge variant="secondary" className="text-[10px]">{groupedEventCount} registros consolidados</Badge> : null}
                                        </div>
                                        <Badge variant="outline" className="text-[10px]">{formatRelative(item.occurred_at)}</Badge>
                                      </div>

                                      {item.description ? <p className="mt-3 text-sm text-muted-foreground">{safeDisplayText(item.description)}</p> : null}

                                      {isAckEvent ? (
                                        <div className="mt-3 space-y-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                                          <p><span className="font-medium">Responsável:</span>{" "}{ackActor || "Responsável não informado pela origem"}</p>
                                          <p>
                                            <span className="font-medium">Comentário:</span>{" "}
                                            {item.comment
                                              ? safeDisplayText(item.comment)
                                              : "Sem comentário registrado na origem."}
                                          </p>
                                          <p><span className="font-medium">Horário da origem:</span>{" "}{formatDateTime(item.occurred_at)}</p>
                                          <p><span className="font-medium">Registrado no OneView:</span>{" "}{formatDateTime(item.created_at)}</p>
                                          {previousSeverity || currentSeverity ? (
                                            <p><span className="font-medium">Mudança de severidade:</span>{" "}{previousSeverity ?? "-"} → {currentSeverity ?? "-"}</p>
                                          ) : null}
                                        </div>
                                      ) : null}

                                      {!isAckEvent && (previousValueVisible || currentValueVisible) ? (
                                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                          {previousValueVisible ? <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Valor anterior</p>
                                            <p className="mt-1 break-words text-xs">{historyValueText(item.previous_value)}</p>
                                          </div> : null}
                                          {currentValueVisible ? <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Valor atual</p>
                                            <p className="mt-1 break-words text-xs">{historyValueText(item.current_value)}</p>
                                          </div> : null}
                                        </div>
                                      ) : null}

                                      <div className="mt-3 space-y-0.5 text-[11px] text-muted-foreground">
                                        {!isAckEvent ? (
                                          <>
                                            <p>Horário da origem: {formatDateTime(item.occurred_at)}</p>
                                            <p>Registrado no OneView: {formatDateTime(item.created_at)}</p>
                                            {nonAckActor === "Processado pelo Worker OneView"
                                              ? <p>Processamento: Processado pelo Worker OneView</p>
                                              : null}
                                          </>
                                        ) : null}
                                        {isSeenGroup ? <><p>Primeira observação: {formatDateTime(firstOccurrence)}</p><p>Última observação: {formatDateTime(lastOccurrence)}</p></> : null}
                                      </div>

                                      {group.items.length > 1 ? (
                                        <details className="mt-3 rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-xs">
                                          <summary className="cursor-pointer font-medium text-foreground">Ver horários das ocorrências agrupadas</summary>
                                          <ul className="mt-2 space-y-1 text-muted-foreground">
                                            {group.items.map((occurrence) => (
                                              <li key={occurrence.id} className="flex flex-wrap justify-between gap-2 border-t border-border/40 pt-1 first:border-0 first:pt-0">
                                                <span>{formatDateTime(occurrence.occurred_at)}</span>
                                                <span>{safeDisplayText(occurrence.source, "OneView")}{occurrence.legacy ? " · legacy" : ""}</span>
                                              </li>
                                            ))}
                                          </ul>
                                        </details>
                                      ) : null}
                                    </div>
                                  </li>
                                );
                              })}
                            </ol> : (
                              <Card className="rounded-[10px] border border-dashed border-border/70 bg-white p-6 text-center shadow-sm">
                                <p className="text-sm font-semibold">Nenhum evento corresponde ao filtro selecionado.</p>
                              </Card>
                            )}
                          </>
                        ) : (
                          <Card className="rounded-[10px] border border-dashed border-border/70 bg-white p-6 text-center shadow-sm">
                            <History className="mx-auto h-8 w-8 text-muted-foreground" />
                            <p className="mt-3 text-sm font-semibold">
                              {sourceAckConfirmedWithoutHistory
                                ? "Não há eventos estruturados de reconhecimento no histórico deste alerta."
                                : "Nenhum evento estruturado foi encontrado para este alerta. O estado atual do alerta continua disponível no resumo."}
                            </p>
                          </Card>
                        )}
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="technical" className="mt-4 space-y-3">
                    <details open className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Origem</summary>
                      <dl className="mt-4 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Fonte Zabbix</dt><dd>{safeDisplayText(selectedAlert.datasource_name, "Fonte não identificada")}</dd></div><div><dt className="text-xs text-muted-foreground">Evento de origem</dt><dd className="break-all font-mono">{safeDisplayText(selectedAlert.source_event_id, "Não informado")}</dd></div></dl>
                    </details>
                    <details className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Host</summary>
                      <dl className="mt-4 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Nome visível</dt><dd>{safeDisplayText(selectedAlert.host_visible_name || selectedAlert.host_name, "Host não identificado")}</dd></div><div><dt className="text-xs text-muted-foreground">Nome técnico</dt><dd>{safeDisplayText(selectedAlert.host_technical_name, "Não informado")}</dd></div><div><dt className="text-xs text-muted-foreground">Grupos</dt><dd className="mt-1 flex flex-wrap gap-2">{selectedAlert.host_groups?.length ? selectedAlert.host_groups.map((group, index) => <Badge key={`${group.id ?? "group"}-${index}`} variant="outline">{safeDisplayText(group.name)}</Badge>) : <span className="text-muted-foreground">Nenhum grupo enriquecido.</span>}</dd></div></dl>
                    </details>
                    <details className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Trigger e item</summary>
                      <dl className="mt-4 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Descrição do trigger</dt><dd>{safeDisplayText(selectedAlert.trigger_description, "Não informada")}</dd></div><div><dt className="text-xs text-muted-foreground">Item</dt><dd>{safeDisplayText(selectedAlert.item_name, "Não informado")}</dd></div><div><dt className="text-xs text-muted-foreground">Chave do item</dt><dd className="break-all font-mono">{safeDisplayText(selectedAlert.item_key, "Não informada")}</dd></div></dl>
                    </details>
                    <details className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Classificação</summary>
                      <dl className="mt-4 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Cliente interno</dt><dd className="font-semibold">{selectedCustomer?.name ?? "Cliente não identificado"}</dd></div><div><dt className="text-xs text-muted-foreground">Enriquecimento</dt><dd>{selectedCustomer ? enrichmentLabels[selectedCustomer.enrichment] : "Não classificado"}</dd></div><div><dt className="text-xs text-muted-foreground">Origem da classificação</dt><dd>{customerSourceLabel(selectedAlert.customer_source)}</dd></div><div><dt className="text-xs text-muted-foreground">Confiança</dt><dd>{confidenceLabel(selectedAlert.customer_confidence)}</dd></div><div><dt className="text-xs text-muted-foreground">Tags seguras</dt><dd className="mt-1 space-y-2">{[["Evento", selectedAlert.event_tags], ["Trigger", selectedAlert.trigger_tags], ["Host", selectedAlert.host_tags]].map(([label, tags]) => <div key={String(label)}><p className="text-xs text-muted-foreground">{String(label)}</p><div className="mt-1 flex flex-wrap gap-1.5">{Array.isArray(tags) && tags.length ? tags.map((tag, index) => <Badge key={`${tag.tag}-${index}`} variant="secondary">{safeDisplayText(tag.tag)}: {safeDisplayText(tag.value)}</Badge>) : <span className="text-xs text-muted-foreground">Sem tags.</span>}</div></div>)}</dd></div></dl>
                    </details>
                    <details className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Auditoria temporal</summary>
                      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Primeira ocorrência</dt><dd>{formatDateTime(selectedAlert.first_seen_at)}</dd></div><div><dt className="text-xs text-muted-foreground">Última ocorrência</dt><dd>{formatDateTime(selectedAlert.last_seen_at)}</dd></div><div><dt className="text-xs text-muted-foreground">Persistido no OneView</dt><dd>{formatDateTime(selectedAlert.created_at)}</dd></div><div><dt className="text-xs text-muted-foreground">Eventos históricos</dt><dd>{detail?.item.history_count ?? history?.total_items ?? 0}</dd></div></dl>
                    </details>
                  </TabsContent>
                </div>
              </Tabs>

              <div className="border-t border-border/70 px-6 py-4">
                <TooltipProvider>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Tooltip><TooltipTrigger asChild><span><Button type="button" variant="outline" disabled className="w-full"><UserCheck className="h-4 w-4" />Atribuir</Button></span></TooltipTrigger><TooltipContent>Atribuição operacional em preparação.</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><span><Button type="button" variant="outline" disabled className="w-full"><MessageSquare className="h-4 w-4" />Comentar</Button></span></TooltipTrigger><TooltipContent>{ONEVIEW_READ_ONLY_MESSAGE}</TooltipContent></Tooltip>
                  </div>
                </TooltipProvider>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          )}
        </SheetContent>
      </Sheet>

    </AppLayout>
  );
}
