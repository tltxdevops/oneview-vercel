import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateRange } from "react-day-picker";
import { endOfDay, format, formatDistanceToNow, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  AlertListResponse,
  AlertMetrics,
  AlertPagination,
  ONEVIEW_READ_ONLY_MESSAGE,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewHealthResponse,
  OneViewFacetsResponse,
  fetchAlert,
  fetchAlertHistory,
  fetchAlertMetrics,
  fetchAlerts,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchOneViewFacets,
  formatDurationSeconds,
  requestAlertAcknowledgement,
} from "@/lib/oneview-api";
import {
  Activity,
  ArrowDownAZ,
  ArrowUpDown,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ChevronsUpDown,
  Database,
  Eye,
  Filter,
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
} from "lucide-react";

type AckFilter = "all" | "acknowledged" | "unacknowledged";
type StatusFilter = "active" | "resolved" | "all";
type SortField = "last_seen_at" | "first_seen_at" | "severity" | "client" | "datasource" | "host" | "problem" | "duration";
type SortOrder = "asc" | "desc";
type ConfidenceFilter = "all" | "high" | "low" | "unclassified";
type TimePreset = "all" | "new_15m" | "new_1h" | "new_24h" | "updated_15m" | "updated_1h";
type NewTimePreset = Extract<TimePreset, "all" | `new_${string}`>;
type UpdatedTimePreset = Extract<TimePreset, "all" | `updated_${string}`>;
type HistoryFilter = "all" | "acknowledgements" | "changes" | "recovery" | "legacy";
type MetaState = { source?: OneViewDataSourceKind; checkedAt?: string; fallbackCode?: string | null };

const SUMMARY_REFRESH_MS = 60_000;
const ALERTS_REFRESH_MS = 120_000;
const FILTERS_STORAGE_KEY = "oneview.alerts.filtersCollapsed";

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

const priorityCatalog = {
  critical: { label: "Crítico", short: "P1", rawSeverities: ["disaster"], tone: "border-red-500 bg-red-100 text-red-950 shadow-sm" },
  high: { label: "Alto", short: "P2", rawSeverities: ["high"], tone: "border-red-200 bg-red-50 text-red-700" },
  medium: { label: "Médio", short: "P3", rawSeverities: ["average"], tone: "border-amber-200 bg-amber-50 text-amber-700" },
  low: { label: "Baixo", short: "P4", rawSeverities: ["warning", "information", "not_classified"], tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
} as const;

type Priority = keyof typeof priorityCatalog;
const priorityOrder: Priority[] = ["critical", "high", "medium", "low"];

function priorityForSeverity(value: string): Priority {
  if (value === "disaster") return "critical";
  if (value === "high") return "high";
  if (value === "average") return "medium";
  return "low";
}

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

function historyValueText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return safeDisplayText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 2) return "Detalhe estruturado";
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => historyValueText(item, depth + 1)).filter((item) => item !== "-");
    return items.length ? items.join(" · ") : "-";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .map(([key, child]) => `${safeDisplayText(key.replaceAll("_", " "), "Campo")}: ${historyValueText(child, depth + 1)}`);
    return entries.length ? entries.join(" · ") : "-";
  }
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
    disaster: "Crítico",
    high: "Alto",
    average: "Médio",
    warning: "Baixo",
    information: "Baixo",
    not_classified: "Baixo",
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
  if (alert.enrichment_state === "unclassified" || alert.customer_name === "Cliente não classificado") {
    return {
      name: "Cliente não classificado",
      hint: "A origem não possui evidências suficientes para identificação automática.",
      enrichment: "unclassified" as const,
    };
  }
  if (!alert.customer_name) {
    const isSharedDatasource = alert.datasource_name?.trim().toLowerCase() === "teletex-http";
    return {
      name: isSharedDatasource ? "Classificação histórica pendente" : "Dados históricos aguardando classificação",
      hint: null,
      enrichment: "legacy" as const,
    };
  }
  return {
    name: alert.customer_name,
    hint: null,
    enrichment: alert.enrichment_state === "complete" ? "complete" as const : "partial" as const,
  };
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

function ackRequestAllowedFor(alert: OneViewAlert | null | undefined, requestEnabled: boolean) {
  return requestEnabled && alert?.datasource_name?.trim().toLowerCase() === "teletex-http";
}

function quickTimeParams(preset: TimePreset) {
  const now = Date.now();
  if (preset === "new_15m") return { firstSeenFrom: new Date(now - 15 * 60_000).toISOString() };
  if (preset === "new_1h") return { firstSeenFrom: new Date(now - 60 * 60_000).toISOString() };
  if (preset === "new_24h") return { firstSeenFrom: new Date(now - 24 * 60 * 60_000).toISOString() };
  if (preset === "updated_15m") return { lastSeenFrom: new Date(now - 15 * 60_000).toISOString() };
  if (preset === "updated_1h") return { lastSeenFrom: new Date(now - 60 * 60_000).toISOString() };
  return {};
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
  const [alerts, setAlerts] = useState<OneViewAlert[]>([]);
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [pagination, setPagination] = useState<AlertPagination>(emptyPagination);
  const [snapshotCoverage, setSnapshotCoverage] = useState<{ partial: boolean; total_persisted: number; available_items: number } | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>([]);
  const [selectedDatasources, setSelectedDatasources] = useState<string[]>([]);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [selectedPriorities, setSelectedPriorities] = useState<Priority[]>([]);
  const [ackFilter, setAckFilter] = useState<AckFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [sortField, setSortField] = useState<SortField>("last_seen_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [timeRange, setTimeRange] = useState<DateRange>();
  const [timePreset, setTimePreset] = useState<TimePreset>("all");
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(FILTERS_STORAGE_KEY) === "true";
  });

  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
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
  const [detailMeta, setDetailMeta] = useState<MetaState>({});
  const [historyMeta, setHistoryMeta] = useState<MetaState>({});

  const alertsRequestRef = useRef<AbortController | null>(null);
  const alertsRequestIdRef = useRef(0);
  const detailRequestRef = useRef<AbortController | null>(null);
  const summaryRequestRef = useRef<Promise<void> | null>(null);
  const summaryDeadlineRef = useRef(Date.now() + SUMMARY_REFRESH_MS);
  const alertsDeadlineRef = useRef(Date.now() + ALERTS_REFRESH_MS);

  const selectedRawSeverities = useMemo(
    () => selectedPriorities.flatMap((priority) => priorityCatalog[priority].rawSeverities),
    [selectedPriorities],
  );

  const dateFrom = timeRange?.from ? startOfDay(timeRange.from).toISOString() : undefined;
  const dateTo = timeRange?.to ? endOfDay(timeRange.to).toISOString() : undefined;
  const newTimePreset: NewTimePreset = timePreset.startsWith("new_") ? timePreset as NewTimePreset : "all";
  const updatedTimePreset: UpdatedTimePreset = timePreset.startsWith("updated_") ? timePreset as UpdatedTimePreset : "all";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, String(filtersCollapsed));
  }, [filtersCollapsed]);

  const loadAlerts = useCallback(async () => {
    alertsRequestRef.current?.abort();
    const controller = new AbortController();
    alertsRequestRef.current = controller;
    const requestId = ++alertsRequestIdRef.current;
    setIsAlertsLoading(true);
    setAlertsError(null);
    try {
      const quickTime = quickTimeParams(timePreset);
      const response = await fetchAlerts({
        page,
        pageSize,
        customers: selectedCustomerKeys,
        datasources: selectedDatasources,
        customerConfidences: confidenceFilter === "all" ? undefined : [confidenceFilter],
        severities: selectedRawSeverities,
        status: statusFilter,
        acknowledged: ackFilter === "all" ? undefined : ackFilter === "acknowledged",
        search: debouncedSearch || undefined,
        dateFrom,
        dateTo,
        ...quickTime,
        sort: sortField,
        order: sortOrder,
        signal: controller.signal,
      });
      if (requestId !== alertsRequestIdRef.current) return;
      const normalized = normalizeAlertResponse(response, page, pageSize);
      const safeResponse = response ?? ({} as AlertListResponse);
      setAlerts(normalized.items);
      setPagination(normalized.pagination);
      setSnapshotCoverage(safeResponse.snapshot_coverage ?? null);
      setAlertsMeta(metaOf(safeResponse));
      alertsDeadlineRef.current = Date.now() + ALERTS_REFRESH_MS;
    } catch (error) {
      if (controller.signal.aborted) return;
      setAlertsError(error instanceof Error ? error.message : "Não foi possível carregar os alertas.");
    } finally {
      if (requestId === alertsRequestIdRef.current) setIsAlertsLoading(false);
    }
  }, [ackFilter, confidenceFilter, dateFrom, dateTo, debouncedSearch, page, pageSize, selectedCustomerKeys, selectedDatasources, selectedRawSeverities, sortField, sortOrder, statusFilter, timePreset]);

  const loadSummaryResources = useCallback(() => {
    if (summaryRequestRef.current) return summaryRequestRef.current;
    setIsSummaryLoading(true);
    setSummaryError(null);
    const request = (async () => {
      const results = await Promise.allSettled([
        fetchOneViewHealth(),
        fetchAlertMetrics(),
        fetchDataSourcesWithMeta(),
        fetchOneViewFacets(),
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

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummaryResources(), loadAlerts()]);
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

  const baseMetas = [alertsMeta, metricsMeta, healthMeta, sourcesMeta, facetsMeta];
  const hasSnapshot = baseMetas.some((meta) => meta.source === "snapshot")
    || (selectedAlertId !== null && [detailMeta, historyMeta].some((meta) => meta.source === "snapshot"));
  const allBaseResourcesLoaded = baseMetas.every((meta) => meta.source === "database" || meta.source === "snapshot");
  const currentDataSource: OneViewDataSourceKind | null = hasSnapshot
    ? "snapshot"
    : allBaseResourcesLoaded && baseMetas.every((meta) => meta.source === "database") ? "database" : null;
  const lastCheckedAt = latestCheckedAt(...baseMetas.map((meta) => meta.checkedAt), detailMeta.checkedAt, historyMeta.checkedAt);
  const fallbackCode = [...baseMetas, detailMeta, historyMeta].find((meta) => meta.source === "snapshot" && meta.fallbackCode)?.fallbackCode;

  const severityCounts = Object.fromEntries((metrics?.by_severity ?? []).map((item) => [item.severity, item.count]));
  const activeTotal = metrics?.active_total ?? health?.counts.active_alerts ?? 0;
  const pendingTotal = metrics?.unacknowledged_total ?? 0;
  const summaryCards = [
    { title: "Total persistido", value: health?.counts.total_alerts ?? metrics?.alerts_total ?? 0, description: "Alertas registrados no OneView", icon: Database, tone: "bg-primary/10 text-primary" },
    { title: "Alertas ativos", value: activeTotal, description: "Ocorrências em acompanhamento", icon: Activity, tone: "bg-amber-100 text-amber-700" },
    { title: "Reconhecidos", value: Math.max(activeTotal - pendingTotal, 0), description: "Reconhecidos na origem", icon: UserCheck, tone: "bg-emerald-100 text-emerald-700" },
    { title: "Pendentes", value: pendingTotal, description: "Aguardando tratamento", icon: TriangleAlert, tone: "bg-yellow-100 text-yellow-700" },
    { title: "Alto", value: severityCounts.high ?? 0, description: "Prioridade elevada", icon: ShieldAlert, tone: "bg-red-50 text-red-700" },
    { title: "Crítico", value: severityCounts.disaster ?? 0, description: "Incidentes críticos", icon: Siren, tone: "bg-red-100 text-red-950" },
  ];

  const customerCards = useMemo(() => [
    { key: "all", name: "Todos", alerts_count: metrics?.active_total ?? health?.counts.active_alerts ?? 0, enrichment_status: "enriched" as const },
    ...(facets?.customers ?? []),
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

  const activeFilterCount = selectedCustomerKeys.length + selectedDatasources.length + selectedPriorities.length
    + (confidenceFilter === "all" ? 0 : 1)
    + (ackFilter === "all" ? 0 : 1) + (statusFilter === "active" ? 0 : 1)
    + (debouncedSearch ? 1 : 0) + (timeRange?.from || timeRange?.to ? 1 : 0)
    + (timePreset === "all" ? 0 : 1)
    + (sortField === "last_seen_at" && sortOrder === "desc" ? 0 : 1);

  const firstVisible = pagination.total_items === 0 ? 0 : (pagination.page - 1) * pagination.page_size + 1;
  const lastVisible = pagination.total_items === 0 ? 0 : Math.min(firstVisible + alerts.length - 1, pagination.total_items);
  const summarySeconds = Math.ceil((summaryDeadlineRef.current - clockTick) / 1000);
  const alertsSeconds = Math.ceil((alertsDeadlineRef.current - clockTick) / 1000);
  const selectedAlert = detail?.item ?? selectedPreview;
  const selectedCustomer = selectedAlert ? customerPresentation(selectedAlert) : null;
  const groupedHistory = useMemo(() => groupHistoryItems(history?.items ?? []), [history?.items]);
  const visibleHistoryGroups = useMemo(
    () => groupedHistory.filter((group) => historyGroupMatchesFilter(group, historyFilter)),
    [groupedHistory, historyFilter],
  );
  const visibleHistoryItems = visibleHistoryGroups.flatMap((group) => group.items);
  const firstHistoryEventAt = visibleHistoryItems.at(-1)?.occurred_at ?? null;
  const lastHistoryEventAt = visibleHistoryItems[0]?.occurred_at ?? null;
  const historyHasRecovery = history?.has_recovery ?? (history?.items ?? []).some((item) => /recovered|recovery|resolved|normaliz/i.test(item.event_type));
  const historyHasAck = history?.has_ack ?? (history?.items ?? []).some((item) => /acknowledged|ack_message|ack/i.test(item.event_type));
  const acknowledgementGroups = groupedHistory.filter((group) => isAcknowledgementEvent(group.primary.event_type));
  const acknowledgementActors = [...new Set(acknowledgementGroups
    .map((group) => safeActorName(group.primary.ack_actor_name || group.primary.actor_name))
    .filter((actor): actor is string => Boolean(actor)))];
  const acknowledgementCount = history?.acknowledgement_count ?? acknowledgementGroups.length;
  const firstAckAt = history?.first_ack_at ?? acknowledgementGroups.at(-1)?.primary.occurred_at ?? null;
  const latestAckAt = history?.latest_ack_at ?? acknowledgementGroups[0]?.primary.occurred_at ?? null;
  const hasAckComment = history?.has_ack_comment ?? acknowledgementGroups.some((group) => Boolean(group.primary.comment));
  const acknowledgedBy = safeActorName(acknowledgementGroups[0]?.primary.ack_actor_name || acknowledgementGroups[0]?.primary.actor_name)
    ?? safeActorName(selectedAlert?.acknowledged_by);
  const ackActorSummary = history?.ack_actor_summary === "Mais de um responsável"
    ? history.ack_actor_summary
    : acknowledgementActors.length > 1
      ? "Mais de um responsável"
      : acknowledgementActors[0] || (historyHasAck ? "Responsável não resolvido" : "Sem ACK");
  const historyIsPartial = history?.history_partial ?? (history?.items ?? []).some((item) => item.legacy);
  const isRefreshing = isAlertsLoading || isSummaryLoading;
  const ackRequestsEnabled = health?.capabilities?.acknowledgement === true;
  const showIpColumn = useMemo(() => alerts.some((alert) => safeHostIp(alert.host_ip) !== null), [alerts]);
  const tableColumnCount = showIpColumn ? 10 : 9;
  const selectedAckPending = selectedAlert
    ? Boolean(pendingAckRequests[selectedAlert.id] || ["pending", "processing"].includes(selectedAlert.ack_request_status || ""))
    : false;
  const selectedAckAllowed = ackRequestAllowedFor(selectedAlert, ackRequestsEnabled);

  const clearFilters = () => {
    setSelectedCustomerKeys([]);
    setSelectedDatasources([]);
    setConfidenceFilter("all");
    setSelectedPriorities([]);
    setAckFilter("all");
    setStatusFilter("active");
    setSortField("last_seen_at");
    setSortOrder("desc");
    setSearchTerm("");
    setTimeRange(undefined);
    setTimePreset("all");
    setPage(1);
  };

  const toggleCustomer = (key: string) => {
    setPage(1);
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const applyTimePreset = (preset: TimePreset) => {
    setTimePreset(preset);
    setTimeRange(undefined);
    setPage(1);
  };

  const openAlert = (alert: OneViewAlert) => {
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
    if (!ackRequestAllowedFor(alert, ackRequestsEnabled) || acknowledged(alert) || pendingAckRequests[alert.id] || ["pending", "processing"].includes(alert.ack_request_status || "")) return;
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
      setPendingAckRequests((current) => ({ ...current, [selectedAlert.id]: response.request_id }));
      setAckDialogOpen(false);
      setAckComment("");
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

  const clientSelector = (
    <Popover open={customerFilterOpen} onOpenChange={setCustomerFilterOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={customerFilterOpen}
          className="h-14 min-w-64 justify-between rounded-[10px] border-[1.5px] border-border/60 bg-white px-4 shadow-sm hover:border-black hover:bg-white"
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
                      <span className="block truncate text-sm font-medium">{safeDisplayText(customer.name, "Cliente não classificado")}</span>
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
      clientSelect={clientSelector}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      topbarRightSection={topbarControls}
      dataSource={currentDataSource}
      checkedAt={lastCheckedAt}
      contentClassName="gap-5 p-5"
      title="Alertas"
      description="Eventos Zabbix persistidos no OneView"
      headerAside={<p className="text-xs text-muted-foreground">Última consulta: {lastCheckedAt ? formatDateTime(lastCheckedAt) : "aguardando primeira resposta"}</p>}
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

      <section aria-labelledby="global-summary-title" className="space-y-2">
        <div>
          <h2 id="global-summary-title" className="text-base font-semibold text-foreground">Resumo global do OneView</h2>
          <p className="text-xs text-muted-foreground">Métricas de todo o ambiente; os filtros abaixo se aplicam somente à tabela de alertas.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {summaryCards.map((card) => {
            const Icon = card.icon;
            return (
              <Card key={card.title} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                    {isSummaryLoading && !health && !metrics ? <Skeleton className="mt-2 h-7 w-20" /> : (
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{card.value.toLocaleString("pt-BR")}</p>
                    )}
                    <p className="text-xs text-muted-foreground">{card.description}</p>
                  </div>
                  <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", card.tone)}><Icon className="h-4 w-4" /></div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <Collapsible open={!filtersCollapsed} onOpenChange={(open) => setFiltersCollapsed(!open)}>
        <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold text-foreground">Filtros de alertas</h2>
                {activeFilterCount > 0 ? <Badge variant="secondary">{activeFilterCount} ativos</Badge> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedCustomerKeys.length ? `${selectedCustomerKeys.length} cliente(s) selecionado(s)` : "Todos os clientes"} · {selectedDatasources.length ? `${selectedDatasources.length} fonte(s)` : "Todas as fontes"} · Status {statusFilter === "active" ? "ativo" : statusFilter === "resolved" ? "resolvido" : "todos"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {activeFilterCount > 0 ? <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Limpar filtros</Button> : null}
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <ChevronDown className={cn("h-4 w-4 transition-transform", !filtersCollapsed && "rotate-180")} />
                  {filtersCollapsed ? "Mostrar filtros" : "Ocultar filtros"}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>

          <CollapsibleContent className="pt-4">
            <div className="mb-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><ServerCog className="h-4 w-4" /> Fonte Zabbix</div>
              <ToggleGroup type="multiple" value={selectedDatasources} onValueChange={(values) => { setSelectedDatasources(values); setPage(1); }} className="flex flex-wrap justify-start gap-2">
                {(facets?.datasources ?? []).map((source) => (
                  <ToggleGroupItem key={source.id} value={source.name} className="h-8 rounded-full border border-border bg-white px-3 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                    {safeDisplayText(source.name, "Fonte")} · {source.alerts_count.toLocaleString("pt-BR")}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Buscar alerta
                <span className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={searchTerm} onChange={(event) => { setSearchTerm(event.target.value); setPage(1); }} placeholder="Host, problema, serviço ou cliente" className="h-9 pl-9" />
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Confiança da classificação
                <Select value={confidenceFilter} onValueChange={(value) => { setConfidenceFilter(value as ConfidenceFilter); setPage(1); }}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    <SelectItem value="high">Alta confiança</SelectItem>
                    <SelectItem value="low">Baixa confiança</SelectItem>
                    <SelectItem value="unclassified">Enriquecimento pendente</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
              <span className="text-xs font-medium text-muted-foreground">Prioridade</span>
              <ToggleGroup type="multiple" value={selectedPriorities} onValueChange={(values) => { setSelectedPriorities(values as Priority[]); setPage(1); }} className="flex flex-wrap justify-start gap-1.5">
                {priorityOrder.map((priority) => (
                  <ToggleGroupItem
                    key={priority}
                    value={priority}
                    className={cn(
                      "h-8 rounded-full border px-3 text-[10px] font-semibold",
                      priorityCatalog[priority].tone,
                      "data-[state=on]:ring-2 data-[state=on]:ring-primary/40",
                    )}
                  >
                    {priorityCatalog[priority].short} · {priorityCatalog[priority].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="text-[10px] text-muted-foreground">Baixo reúne avisos, informativos e não classificados recebidos do Zabbix.</span>
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Card className="overflow-hidden rounded-[10px] border border-border/70 bg-white shadow-sm">
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">Alertas filtrados por {tableCustomerScope}</h2>
              <p className="text-xs text-muted-foreground">
                Exibindo {firstVisible.toLocaleString("pt-BR")}–{lastVisible.toLocaleString("pt-BR")} de {pagination.total_items.toLocaleString("pt-BR")} alertas
                {snapshotCoverage?.partial ? ` disponíveis na cópia · ${snapshotCoverage.total_persisted.toLocaleString("pt-BR")} persistidos` : ""}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">Escopo desta tabela: filtros de cliente, fonte, status, prioridade, ACK e período selecionados.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Status
                <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value as StatusFilter); setPage(1); }}>
                  <SelectTrigger className="h-8 w-28 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="active">Ativos</SelectItem><SelectItem value="resolved">Resolvidos</SelectItem><SelectItem value="all">Todos</SelectItem></SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                ACK
                <Select value={ackFilter} onValueChange={(value) => { setAckFilter(value as AckFilter); setPage(1); }}>
                  <SelectTrigger className="h-8 w-36 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">Todos</SelectItem><SelectItem value="acknowledged">Reconhecidos</SelectItem><SelectItem value="unacknowledged">Pendentes</SelectItem></SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Novos
                <Select value={newTimePreset} onValueChange={(value) => applyTimePreset(value as NewTimePreset)}>
                  <SelectTrigger className="h-8 w-44 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="new_15m">Últimos 15 minutos</SelectItem>
                    <SelectItem value="new_1h">Última hora</SelectItem>
                    <SelectItem value="new_24h">Últimas 24 horas</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Atualizados
                <Select value={updatedTimePreset} onValueChange={(value) => applyTimePreset(value as UpdatedTimePreset)}>
                  <SelectTrigger className="h-8 w-40 bg-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="updated_15m">Últimos 15 minutos</SelectItem>
                    <SelectItem value="updated_1h">Última hora</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" size="sm" variant="outline" className="h-8">
                    <CalendarRange className="h-4 w-4" />
                    {timeRange?.from ? `${format(timeRange.from, "dd/MM/yyyy")}${timeRange.to ? ` – ${format(timeRange.to, "dd/MM/yyyy")}` : ""}` : "Intervalo da última atualização"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-auto p-0">
                  <Calendar
                    mode="range"
                    numberOfMonths={1}
                    locale={ptBR}
                    selected={timeRange}
                    onSelect={(range) => {
                      setTimeRange(range);
                      setTimePreset("all");
                      setPage(1);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border/60 bg-muted/20 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Ordenar</span>
              <Select value={sortField} onValueChange={(value) => { setSortField(value as SortField); setPage(1); }}>
                <SelectTrigger className="h-8 w-44 bg-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="last_seen_at">Última atualização</SelectItem><SelectItem value="first_seen_at">Criação do alerta</SelectItem>
                  <SelectItem value="severity">Prioridade</SelectItem><SelectItem value="client">Cliente</SelectItem>
                  <SelectItem value="datasource">Fonte Zabbix</SelectItem>
                  <SelectItem value="host">Host</SelectItem><SelectItem value="problem">Problema</SelectItem><SelectItem value="duration">Duração</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortOrder} onValueChange={(value) => { setSortOrder(value as SortOrder); setPage(1); }}>
                <SelectTrigger className="h-8 w-44 bg-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">{sortField === "severity" ? "Crítico → baixo" : "Decrescente"}</SelectItem>
                  <SelectItem value="asc">{sortField === "severity" ? "Baixo → crítico" : "Crescente"}</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center rounded-md border border-border/70 bg-white p-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant={sortField === "last_seen_at" && sortOrder === "desc" ? "default" : "ghost"}
                  className="h-7 rounded px-2.5 text-xs"
                  onClick={() => { setSortField("last_seen_at"); setSortOrder("desc"); setPage(1); }}
                >
                  <ArrowUpDown className="h-3.5 w-3.5" /> Mais recentemente atualizados
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={sortField === "first_seen_at" && sortOrder === "desc" ? "default" : "ghost"}
                  className="h-7 rounded px-2.5 text-xs"
                  onClick={() => { setSortField("first_seen_at"); setSortOrder("desc"); setPage(1); }}
                >
                  <Activity className="h-3.5 w-3.5" /> Mais novos
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={sortField === "first_seen_at" && sortOrder === "asc" ? "default" : "ghost"}
                  className="h-7 rounded px-2.5 text-xs"
                  onClick={() => { setSortField("first_seen_at"); setSortOrder("asc"); setPage(1); }}
                >
                  <ArrowDownAZ className="h-3.5 w-3.5" /> Mais antigos
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Itens por página</span>
              <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                <SelectTrigger className="h-8 w-20 bg-white"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="25">25</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {alertsError ? <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{alertsError}</div> : null}

        <div className="relative max-h-[68vh] overflow-auto" aria-busy={isAlertsLoading}>
          {isAlertsLoading && alerts.length > 0 ? <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-1/3 animate-pulse bg-primary" /></div> : null}
          <Table className={cn(showIpColumn ? "min-w-[1320px]" : "min-w-[1220px]", "text-xs")}>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="border-border/70 bg-muted/70 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted/70">
                <TableHead className="w-44">Cliente</TableHead><TableHead className="w-32">Fonte</TableHead><TableHead className="w-52">Host</TableHead>{showIpColumn ? <TableHead className="w-24">IP</TableHead> : null}
                <TableHead className="w-28">Prioridade</TableHead><TableHead className={cn(!showIpColumn && "min-w-[420px]")}>Problema</TableHead><TableHead className={cn(showIpColumn ? "w-24" : "w-32")}>Duração</TableHead>
                <TableHead className="w-32">Status</TableHead><TableHead className="w-24">ACK</TableHead><TableHead className="w-32 text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isAlertsLoading && alerts.length === 0 ? Array.from({ length: 8 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: tableColumnCount }).map((__, cell) => <TableCell key={cell} className="py-4"><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              )) : alerts.length === 0 ? (
                <TableRow><TableCell colSpan={tableColumnCount} className="py-16 text-center text-muted-foreground"><CircleAlert className="mx-auto mb-2 h-7 w-7" />Nenhum alerta corresponde aos filtros selecionados.</TableCell></TableRow>
              ) : alerts.map((alert) => {
                const priority = priorityCatalog[priorityForSeverity(alert.severity)];
                const isActive = alert.status_source === "active" && !alert.resolved_at;
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
                    <TableCell className="py-3">
                      <div className="flex items-start gap-2">
                        <CustomerLogo customer={{ key: alert.customer_key, name: alert.customer_name }} />
                        <div className="min-w-0">
                          <p className="font-semibold leading-4">{customer.name}</p>
                          {customer.hint ? <p className="mt-1 text-[9px] leading-3 text-muted-foreground">{customer.hint}</p> : null}
                        </div>
                      </div>
                      {alert.customer_confidence === "low" ? <Badge variant="outline" className="mt-1 border-amber-200 bg-amber-50 text-[9px] text-amber-700">Baixa confiança</Badge> : null}
                      {customer.enrichment !== "complete" ? (
                        <div className="mt-1">
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild><Badge variant="outline" className="border-border bg-muted text-[9px]">{enrichmentLabels[customer.enrichment]}</Badge></TooltipTrigger>
                              <TooltipContent side="right" className="max-w-xs"><p>{enrichmentExplanations[customer.enrichment]}</p></TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-3 font-medium">{safeDisplayText(alert.datasource_name, "Fonte não identificada")}</TableCell>
                    <TableCell className="py-3"><p className="truncate font-semibold" title={safeDisplayText(alert.host_visible_name || alert.host_technical_name || alert.host_name)}>{safeDisplayText(alert.host_visible_name || alert.host_technical_name || alert.host_name)}</p>{alert.host_visible_name && alert.host_technical_name ? <p className="truncate font-mono text-[9px] text-muted-foreground">{safeDisplayText(alert.host_technical_name)}</p> : null}<p className="font-mono text-[10px] text-muted-foreground">#{safeDisplayText(alert.source_event_id, "-", 48)}</p></TableCell>
                    {showIpColumn ? <TableCell className="py-3 font-mono text-muted-foreground">{safeHostIp(alert.host_ip) ?? "-"}</TableCell> : null}
                    <TableCell className="py-3"><Badge className={cn("border text-[10px] hover:bg-inherit", priority.tone)}>{priority.label}</Badge></TableCell>
                    <TableCell className={cn("py-3", !showIpColumn && "min-w-[420px]")}><p className="max-w-xl line-clamp-2 font-medium leading-5" title={safeDisplayText(alert.problem_name, "Alerta sem descrição")}>{safeDisplayText(alert.problem_name, "Alerta sem descrição", 220)}</p></TableCell>
                    <TableCell className={cn("py-3 font-mono text-muted-foreground", !showIpColumn && "min-w-32")}>{formatDurationSeconds(alert.duration_seconds)}</TableCell>
                    <TableCell className="py-3"><p className={cn("font-medium", isActive ? "text-red-700" : "text-emerald-700")}>{isActive ? "Ativo" : "Resolvido"}</p><p className="text-[10px] text-muted-foreground">{formatDateTime(alert.last_seen_at)}</p></TableCell>
                    <TableCell className="py-3"><Badge className={cn("border text-[10px] hover:bg-inherit", acknowledged(alert) ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>{acknowledged(alert) ? "Reconhecido" : "Pendente"}</Badge></TableCell>
                    <TableCell className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[10px]"
                          onClick={(event) => {
                            event.stopPropagation();
                            openAlert(alert);
                          }}
                        >
                          <Eye className="h-3.5 w-3.5" /> Ver
                        </Button>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-[10px]"
                                  disabled={!ackRequestAllowedFor(alert, ackRequestsEnabled) || acknowledged(alert) || Boolean(pendingAckRequests[alert.id]) || ["pending", "processing"].includes(alert.ack_request_status || "")}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openAckRequest(alert);
                                  }}
                                >
                                  <UserCheck className="h-3.5 w-3.5" /> ACK
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left"><p>{!ackRequestsEnabled
                              ? "Aguardando liberação operacional."
                              : pendingAckRequests[alert.id] || ["pending", "processing"].includes(alert.ack_request_status || "")
                              ? "Solicitação pendente de processamento."
                              : acknowledged(alert)
                                ? "Alerta já reconhecido."
                                : ackRequestAllowedFor(alert, ackRequestsEnabled)
                                  ? "Solicitar reconhecimento do alerta."
                                  : "Reconhecimento indisponível para esta fonte."}</p></TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
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
              <SheetHeader className="border-b border-border/70 px-6 py-5 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div><SheetTitle className="text-xl">Detalhes do alerta</SheetTitle><SheetDescription>Informações operacionais seguras e histórico do OneView.</SheetDescription></div>
                  <Badge className={cn("border hover:bg-inherit", acknowledged(selectedAlert) ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>{acknowledged(selectedAlert) ? "Reconhecido" : selectedAckPending ? "Solicitação pendente" : "Pendente"}</Badge>
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
                        {selectedCustomer?.hint ? <div className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{selectedCustomer.hint}</div> : null}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">Cliente</p><p className="mt-1 break-words font-semibold">{selectedCustomer?.name}</p></Card>
                          <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                            <p className="text-[11px] text-muted-foreground">Enriquecimento</p>
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild><p className="mt-1 cursor-help break-words font-semibold">{selectedCustomer ? enrichmentLabels[selectedCustomer.enrichment] : "-"}</p></TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-xs"><p>{selectedCustomer ? enrichmentExplanations[selectedCustomer.enrichment] : "Informação ainda não disponível."}</p></TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </Card>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {[
                            ["Fonte Zabbix", selectedAlert.datasource_name],
                            ["Host visível", selectedAlert.host_visible_name || selectedAlert.host_technical_name || selectedAlert.host_name],
                            ["Host técnico", selectedAlert.host_technical_name],
                            ["Prioridade", priorityCatalog[priorityForSeverity(selectedAlert.severity)].label],
                            ["Status", selectedAlert.status_source === "active" && !selectedAlert.resolved_at ? "Ativo" : "Resolvido"],
                            ["ACK", acknowledged(selectedAlert) ? `Reconhecido${acknowledgedBy ? ` por ${acknowledgedBy}` : " — responsável não resolvido no Zabbix"}${selectedAlert.acknowledged_at ? ` em ${formatDateTime(selectedAlert.acknowledged_at)}` : ""}` : "Pendente"],
                            ["Supressão", selectedAlert.suppressed ? `Ativa${selectedAlert.suppressed_until ? ` até ${formatDateTime(selectedAlert.suppressed_until)}` : ""}` : "Não"],
                            ["Primeira ocorrência", formatDateTime(selectedAlert.first_seen_at)],
                            ["Última ocorrência", formatDateTime(selectedAlert.last_seen_at)],
                            ["Recovery", selectedAlert.resolved_at ? formatDateTime(selectedAlert.resolved_at) : "Ainda ativo"],
                            ["Duração", formatDurationSeconds(selectedAlert.duration_seconds)],
                          ].map(([label, value]) => <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 break-words font-semibold">{safeDisplayText(value)}</p></Card>)}
                        </div>
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
                    ) : history?.items.length ? (
                      <>
                        <section aria-label="Resumo do histórico" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {[
                            ["Eventos exibidos", `${visibleHistoryGroups.length} de ${groupedHistory.length}`],
                            ["Primeiro evento", formatDateTime(firstHistoryEventAt)],
                            ["Último evento", formatDateTime(lastHistoryEventAt)],
                            ["Total de reconhecimentos", String(acknowledgementCount)],
                            ["Primeiro ACK", historyHasAck ? formatDateTime(firstAckAt) : "Sem ACK"],
                            ["ACK mais recente", historyHasAck ? formatDateTime(latestAckAt) : "Sem ACK"],
                            ["Responsável pelo ACK", ackActorSummary],
                            ["Possui comentário", hasAckComment ? "Sim" : "Não"],
                            ["Recovery", historyHasRecovery ? "Sim" : "Não"],
                          ].map(([label, value]) => (
                            <Card key={label} className="rounded-[10px] border border-border/70 bg-white p-3 shadow-sm">
                              <p className="text-[10px] text-muted-foreground">{label}</p>
                              <p className="mt-1 break-words text-xs font-semibold">{value}</p>
                            </Card>
                          ))}
                        </section>

                        {historyIsPartial ? (
                          <div className="rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                            Eventos anteriores ao enriquecimento podem possuir menos detalhes.
                          </div>
                        ) : null}

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
                                    <div>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="font-semibold">{isSeenGroup ? `Ocorrência atualizada ${groupedEventCount} vezes` : safeDisplayText(item.title, "Atualização do alerta")}</p>
                                        {!isSeenGroup && groupedEventCount > 1 ? <Badge variant="secondary" className="text-[10px]">{groupedEventCount} registros consolidados</Badge> : null}
                                        {item.legacy ? <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">Histórico legado</Badge> : null}
                                      </div>
                                      <p className="text-xs text-muted-foreground">Origem: {safeDisplayText(item.source, "OneView")} · {safeDisplayText(item.origin, item.legacy ? "legacy" : "OneView")}</p>
                                    </div>
                                    <Badge variant="outline" className="text-[10px]">{formatRelative(item.occurred_at)}</Badge>
                                  </div>

                                  {item.description ? <p className="mt-3 text-sm text-muted-foreground">{safeDisplayText(item.description)}</p> : null}

                                  {isAckEvent ? (
                                    <div className="mt-3 space-y-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                                      <p><span className="font-medium">Responsável:</span>{" "}{safeActorName(item.ack_actor_name || item.actor_name) ?? "Responsável não resolvido no Zabbix"}</p>
                                      <p><span className="font-medium">Data/hora:</span>{" "}{formatDateTime(item.occurred_at)}</p>
                                      {item.comment ? <p><span className="font-medium">Comentário:</span>{" "}{safeDisplayText(item.comment)}</p> : null}
                                      {previousSeverity || currentSeverity ? (
                                        <p><span className="font-medium">Mudança de severidade:</span>{" "}{previousSeverity ?? "-"} → {currentSeverity ?? "-"}</p>
                                      ) : null}
                                      <p><span className="font-medium">Origem:</span>{" "}{safeDisplayText(item.source, "OneView")}</p>
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
                                    <p>Horário original: {formatDateTime(item.occurred_at)}</p>
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
                      <Card className="rounded-[10px] border border-border/70 bg-white p-8 text-center shadow-sm">
                        <History className="mx-auto h-8 w-8 text-muted-foreground" />
                        <p className="mt-3 font-semibold">Nenhum evento histórico estruturado disponível.</p>
                      </Card>
                    )}
                  </TabsContent>

                  <TabsContent value="technical" className="mt-4 space-y-3">
                    <details className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <summary className="cursor-pointer text-sm font-semibold">Exibir informações técnicas</summary>
                      <div className="mt-4 space-y-3">
                    <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <h3 className="text-sm font-semibold">Classificação e identificadores</h3>
                      <dl className="mt-3 space-y-3 text-sm">
                        <div><dt className="text-xs text-muted-foreground">Cliente interno</dt><dd className="font-semibold">{selectedCustomer?.name}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Enriquecimento</dt><dd>{selectedCustomer ? enrichmentLabels[selectedCustomer.enrichment] : "-"}</dd></div>
                        {selectedCustomer?.enrichment === "legacy" ? <div><dt className="text-xs text-muted-foreground">Referência legada</dt><dd>{safeDisplayText(selectedAlert.client_name)}</dd></div> : null}
                        <div><dt className="text-xs text-muted-foreground">Origem da classificação</dt><dd>{customerSourceLabel(selectedAlert.customer_source)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Confiança</dt><dd>{confidenceLabel(selectedAlert.customer_confidence)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Source event ID</dt><dd className="break-all font-mono">{safeDisplayText(selectedAlert.source_event_id)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Trigger ID</dt><dd className="break-all font-mono">{safeDisplayText(selectedAlert.source_trigger_id)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Descrição do trigger</dt><dd>{safeDisplayText(selectedAlert.trigger_description)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Item</dt><dd>{safeDisplayText(selectedAlert.item_name)}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">Chave do item</dt><dd className="break-all font-mono">{safeDisplayText(selectedAlert.item_key)}</dd></div>
                      </dl>
                    </Card>
                    <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <h3 className="text-sm font-semibold">Grupos do host</h3>
                      <div className="mt-3 flex flex-wrap gap-2">{selectedAlert.host_groups?.length ? selectedAlert.host_groups.map((group, index) => <Badge key={`${group.id ?? "group"}-${index}`} variant="outline">{safeDisplayText(group.name)}</Badge>) : <span className="text-sm text-muted-foreground">Nenhum grupo enriquecido.</span>}</div>
                    </Card>
                    <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm">
                      <h3 className="text-sm font-semibold">Tags seguras</h3>
                      <div className="mt-3 space-y-3">
                        {[
                          ["Evento", selectedAlert.event_tags],
                          ["Trigger", selectedAlert.trigger_tags],
                          ["Host", selectedAlert.host_tags],
                        ].map(([label, tags]) => (
                          <div key={String(label)}><p className="text-xs text-muted-foreground">{String(label)}</p><div className="mt-1 flex flex-wrap gap-1.5">{Array.isArray(tags) && tags.length ? tags.map((tag, index) => <Badge key={`${tag.tag}-${index}`} variant="secondary">{safeDisplayText(tag.tag)}: {safeDisplayText(tag.value)}</Badge>) : <span className="text-xs text-muted-foreground">Sem tags.</span>}</div></div>
                        ))}
                      </div>
                    </Card>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-xs text-muted-foreground">Primeira ocorrência</p><p className="mt-1 font-semibold">{formatDateTime(selectedAlert.first_seen_at)}</p></Card>
                      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-xs text-muted-foreground">Persistido no OneView</p><p className="mt-1 font-semibold">{formatDateTime(selectedAlert.created_at)}</p></Card>
                      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-xs text-muted-foreground">Eventos históricos</p><p className="mt-1 text-xl font-semibold">{detail?.item.history_count ?? history?.total_items ?? 0}</p></Card>
                      <Card className="rounded-[10px] border border-border/70 bg-white p-4 shadow-sm"><p className="text-xs text-muted-foreground">Reconhecimentos</p><p className="mt-1 text-xl font-semibold">{detail?.item.acknowledgement_count ?? 0}</p></Card>
                    </div>
                      </div>
                    </details>
                  </TabsContent>
                </div>
              </Tabs>

              <div className="border-t border-border/70 px-6 py-4">
                <TooltipProvider>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Tooltip><TooltipTrigger asChild><span><Button
                      type="button"
                      variant="outline"
                      disabled={!selectedAckAllowed || acknowledged(selectedAlert) || selectedAckPending || ackSubmitting}
                      className="w-full"
                      onClick={() => openAckRequest(selectedAlert)}
                    ><CheckCircle2 className="h-4 w-4" />{selectedAckPending ? "Solicitação pendente" : "ACK"}</Button></span></TooltipTrigger><TooltipContent>{!ackRequestsEnabled
                      ? "Aguardando liberação operacional."
                      : selectedAckPending
                      ? "A execução aguarda processamento operacional."
                      : acknowledged(selectedAlert)
                        ? "Alerta já reconhecido."
                        : selectedAckAllowed
                          ? "Registrar solicitação de reconhecimento."
                          : "Reconhecimento indisponível para esta fonte."}</TooltipContent></Tooltip>
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

      <AlertDialog open={ackDialogOpen} onOpenChange={(open) => {
        if (ackSubmitting) return;
        setAckDialogOpen(open);
        if (!open) setAckError(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar solicitação de reconhecimento</AlertDialogTitle>
            <AlertDialogDescription>
              A solicitação será registrada para processamento. Nenhuma chamada ao Zabbix é executada por esta tela.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div className="rounded-[10px] border border-border/70 bg-muted/20 p-3 text-sm">
              <p className="font-semibold">{safeDisplayText(selectedAlert?.problem_name, "Alerta selecionado")}</p>
              <p className="mt-1 text-xs text-muted-foreground">Fonte: {safeDisplayText(selectedAlert?.datasource_name)}</p>
            </div>
            <div>
              <label htmlFor="ack-comment" className="text-sm font-medium">Comentário</label>
              <Textarea
                id="ack-comment"
                value={ackComment}
                onChange={(event) => setAckComment(event.target.value)}
                maxLength={500}
                disabled={ackSubmitting}
                placeholder="Contexto operacional para o reconhecimento (opcional)"
                className="mt-2 min-h-24 resize-none"
              />
              <p className="mt-1 text-right text-xs text-muted-foreground">{ackComment.length}/500</p>
            </div>
            {ackError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{ackError}</div> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ackSubmitting}>Cancelar</AlertDialogCancel>
            <Button type="button" onClick={() => void submitAckRequest()} disabled={ackSubmitting || !selectedAlert || !ackRequestsEnabled}>
              {ackSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
              {ackSubmitting ? "Registrando..." : "Confirmar solicitação"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
