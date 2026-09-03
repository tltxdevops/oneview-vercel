import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DateRange } from "react-day-picker";
import { format, isSameDay, startOfDay, endOfDay, subDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarRange, History, Siren } from "lucide-react";
import {
  ClientIdentity,
  canonicalClientName,
  canonicalHostName,
  facetCustomerDisplayName,
  historyEventClientLabel,
} from "@/components/oneview/ClientIdentity";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { ZabbixSourceFilter } from "@/components/oneview/ZabbixSourceFilter";
import { AppLayout } from "@/components/layout/AppLayout";
import { FilterBar } from "@/components/oneview/FilterBar";
import { OperationalCta } from "@/components/oneview/OperationalCta";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { OV_CTA, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  applyHistoryRiskPreset,
  HISTORY_RISK_PRESETS,
  isRiskSummaryPreset,
  type HistoryRiskPreset,
} from "@/lib/historico-query";
import { isDatasourceOnlyFilterValue, zabbixSourceKey } from "@/lib/oneview-zabbix-source";
import {
  AlertHistoryItem,
  fetchAlert,
  fetchAlertHistory,
  fetchAlerts,
  fetchGlobalHistory,
  fetchOneViewFacets,
  formatOneViewSeverityLabel,
  GlobalHistoryItem,
  ONEVIEW_V1_FILTER_SEVERITIES,
  OneViewAlert,
  OneViewFacetsResponse,
  type OneViewSeverity,
} from "@/lib/oneview-api";

const HISTORY_REFRESH_MS = 60_000;

const ACTION_EVENT_TYPES = new Set([
  "acknowledged",
  "ack_message",
  "severity_changed",
  "recovered",
  "maintenance",
  "suppressed",
  "unsuppressed",
]);

const EVENT_TYPE_FILTERS = [
  { value: "actions", label: "Todas as ações" },
  { value: "acks", label: "ACK realizados" },
  { value: "ack", label: "Reconhecimentos" },
  { value: "ack_comment", label: "Comentários" },
  { value: "severity", label: "Mudanças de severidade" },
  { value: "resolution", label: "Recuperações" },
  { value: "maintenance", label: "Manutenção e supressão" },
] as const;

const PERIOD_PRESETS = [
  { value: "all", label: "Todo o período" },
  { value: "1h", label: "Última 1 h" },
  { value: "6h", label: "Últimas 6 h" },
  { value: "24h", label: "Últimas 24 h" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "custom", label: "Personalizado" },
] as const;

const ALERT_STATUS_FILTERS = [
  { value: "all", label: "Ativos e resolvidos" },
  { value: "active", label: "Ativos" },
  { value: "resolved", label: "Resolvidos" },
] as const;

const ACK_FILTERS = [
  { value: "all", label: "ACK: todos" },
  { value: "true", label: "Com ACK" },
  { value: "false", label: "Sem ACK" },
] as const;

const SEVERITY_FILTERS = [
  { value: "all", label: "Todas as severidades" },
  { value: "disaster,high", label: "Disaster e High" },
  ...ONEVIEW_V1_FILTER_SEVERITIES.map((value) => ({
    value,
    label: formatOneViewSeverityLabel(value),
  })),
] as const;

const PAGE_SIZE = 50;
const TECHNICAL_NOISE = /upsert|backfill|reconcil|retry|outbox|cache|payload|worker|sync[_ ]?log|sincroniza/i;

type HistoryTab = "alertas" | "eventos";
type EventTypeFilter = (typeof EVENT_TYPE_FILTERS)[number]["value"];
type PeriodPreset = (typeof PERIOD_PRESETS)[number]["value"];
type AlertStatusFilter = (typeof ALERT_STATUS_FILTERS)[number]["value"];
type AckFilter = (typeof ACK_FILTERS)[number]["value"];

function periodBounds(period: PeriodPreset, range?: DateRange): { from?: string; to?: string } {
  if (period === "all") return {};
  if (period === "custom") {
    if (!range?.from) return {};
    const from = startOfDay(range.from).toISOString();
    const to = endOfDay(range.to ?? range.from).toISOString();
    return { from, to };
  }
  const hours = period === "1h" ? 1 : period === "6h" ? 6 : period === "24h" ? 24 : period === "7d" ? 24 * 7 : 24 * 30;
  const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return { from, to: new Date().toISOString() };
}

function formatClock(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatWhen(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function queryEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function rangeFromUrl(params: URLSearchParams): DateRange | undefined {
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  if (!fromRaw) return undefined;
  const from = new Date(`${fromRaw}T00:00:00`);
  if (Number.isNaN(from.getTime())) return undefined;
  const to = toRaw ? new Date(`${toRaw}T00:00:00`) : from;
  if (Number.isNaN(to.getTime())) return { from };
  return { from, to };
}

function safeActorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  if (/^\d+$/.test(candidate)) return null;
  if (/worker|oneview|sistema|system|reconcil/i.test(candidate)) return null;
  return candidate;
}

function isValidOperationalComment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(null|undefined|n\/a|na|-|none)$/i.test(trimmed)) return false;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return false;
  }
  if (TECHNICAL_NOISE.test(trimmed)) return false;
  const normalized = trimmed.toLowerCase();
  if (["alerta reconhecido", "reconhecimento registrado", "observação do reconhecimento", "observacao do reconhecimento"].includes(normalized)) {
    return false;
  }
  return true;
}

function severityFromHistoryValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? formatOneViewSeverityLabel(trimmed) : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["severity", "new_severity", "previous_severity", "severidade"]) {
      if (typeof record[key] === "string" && record[key].trim()) {
        return formatOneViewSeverityLabel(record[key]);
      }
    }
    const entry = Object.entries(record).find(([key]) => /severity|severidade/i.test(key));
    if (entry) return severityFromHistoryValue(entry[1]);
  }
  return null;
}

function formalOperationalTitle(item: GlobalHistoryItem): string {
  const eventType = String(item.event_type || "").toLowerCase();
  const actor = safeActorName(item.actor_name);

  if (eventType === "acknowledged") {
    return actor ? `Reconhecido por ${actor}` : "Reconhecido";
  }
  if (eventType === "ack_message") {
    return "Comentário registrado no Zabbix";
  }
  if (eventType === "severity_changed") {
    const from = severityFromHistoryValue(item.previous_value);
    const to = severityFromHistoryValue(item.current_value);
    if (from && to && from !== "—" && to !== "—") {
      return `Severidade alterada de ${from} para ${to}`;
    }
    return "Severidade alterada";
  }
  if (eventType === "recovered") {
    return "Recuperação confirmada";
  }
  if (eventType === "maintenance") return "Alerta colocado em manutenção";
  if (eventType === "suppressed") return "Alerta suprimido";
  if (eventType === "unsuppressed") return "Supressão removida";
  return "";
}

function isActionHistoryItem(item: GlobalHistoryItem): boolean {
  const eventType = String(item.event_type || "").toLowerCase();
  if (!ACTION_EVENT_TYPES.has(eventType)) return false;
  if (TECHNICAL_NOISE.test(eventType)) return false;
  if (TECHNICAL_NOISE.test(item.title || "")) return false;
  if (TECHNICAL_NOISE.test(item.description || "")) return false;
  return true;
}

function canonicalCustomerName(value?: string | null, customerKey?: string | null): string {
  return canonicalClientName({ key: customerKey, name: value });
}

function dayGroupLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  if (isSameDay(date, now)) return "Hoje";
  if (isSameDay(date, subDays(now, 1))) return "Ontem";
  return format(date, "dd 'de' MMMM 'de' yyyy", { locale: ptBR });
}

function dayGroupKey(value?: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return format(startOfDay(date), "yyyy-MM-dd");
}

function alertStatusLabel(alert: OneViewAlert): string {
  const status = String(alert.status_source || "").toLowerCase();
  if (status === "resolved" || status === "ok" || Boolean(alert.resolved_at)) return "Resolvido";
  return "Ativo";
}

function parseSeverities(params: URLSearchParams): OneViewSeverity[] {
  const values = params.getAll("severity").flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase());
  return values.filter((value): value is OneViewSeverity => (
    (ONEVIEW_V1_FILTER_SEVERITIES as readonly string[]).includes(value)
  ));
}

function severitySelectValue(severities: OneViewSeverity[]): string {
  if (!severities.length) return "all";
  if (severities.length === 2 && severities.includes("disaster") && severities.includes("high")) {
    return "disaster,high";
  }
  if (severities.length === 1) return severities[0];
  return severities.join(",");
}

/**
 * Consolidação leve na página atual: une acknowledged + ack_message do mesmo alerta
 * quando compartilham ator/horário próximo — só para exibição; totais vêm do BFF.
 */
function consolidateAckEvents(items: GlobalHistoryItem[]): GlobalHistoryItem[] {
  const result: GlobalHistoryItem[] = [];
  const indexByKey = new Map<string, number>();

  for (const item of items) {
    const eventType = String(item.event_type || "").toLowerCase();
    if (eventType !== "acknowledged" && eventType !== "ack_message") {
      result.push(item);
      continue;
    }
    const actor = safeActorName(item.actor_name) || "";
    const occurredMinute = item.occurred_at ? item.occurred_at.slice(0, 16) : item.id;
    const key = `${item.alert_id}|${actor}|${occurredMinute}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push({
        ...item,
        event_type: "acknowledged",
        description: isValidOperationalComment(item.description) ? item.description : null,
      });
      continue;
    }
    const existing = result[existingIndex];
    const comment = isValidOperationalComment(item.description)
      ? item.description.trim()
      : (isValidOperationalComment(existing.description) ? existing.description : null);
    const actorName = safeActorName(existing.actor_name) || safeActorName(item.actor_name);
    result[existingIndex] = {
      ...existing,
      actor_name: actorName,
      description: comment,
      occurred_at: existing.occurred_at || item.occurred_at,
    };
  }
  return result;
}

/**
 * Histórico operacional — auditoria temporal de riscos e ACK (OV-P0-34 / OV-P0-81).
 * Clique na linha abre o drawer unificado (aba Histórico); não navega para Alertas.
 */
export default function HistoricoPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);

  const [eventItems, setEventItems] = useState<GlobalHistoryItem[]>([]);
  const [eventTotal, setEventTotal] = useState<number | null>(null);
  const [eventPages, setEventPages] = useState(1);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [alertItems, setAlertItems] = useState<OneViewAlert[]>([]);
  const [alertTotal, setAlertTotal] = useState<number | null>(null);
  const [alertPages, setAlertPages] = useState(1);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [filteredSummary, setFilteredSummary] = useState<{
    total: number;
    acknowledged_source: number;
    unacknowledged_source: number;
    by_severity: { disaster: number; high: number };
  } | null>(null);

  const [detail, setDetail] = useState<OneViewAlert | null>(null);
  const [detailHistory, setDetailHistory] = useState<AlertHistoryItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [searchDraft, setSearchDraft] = useState(() => searchParams.get("search") || "");
  const [actorDraft, setActorDraft] = useState(() => searchParams.get("actor") || "");
  const [customRange, setCustomRange] = useState<DateRange | undefined>(() => rangeFromUrl(searchParams));
  const eventsRequestRef = useRef<AbortController | null>(null);
  const alertsRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const eventsLoadedRef = useRef(false);
  const alertsLoadedRef = useRef(false);

  const tab = queryEnum(searchParams.get("tab"), ["alertas", "eventos"] as const, "alertas") as HistoryTab;
  const risk = queryEnum(
    searchParams.get("risk"),
    HISTORY_RISK_PRESETS.map((item) => item.value),
    "all",
  ) as HistoryRiskPreset;
  const clienteRaw = searchParams.get("customer") || "all";
  const cliente = isDatasourceOnlyFilterValue(clienteRaw) ? "all" : clienteRaw;
  const fonte = searchParams.get("datasource")
    || (isDatasourceOnlyFilterValue(clienteRaw) ? zabbixSourceKey(clienteRaw) : "all")
    || "all";
  const severities = parseSeverities(searchParams);
  const alertStatus = queryEnum(
    searchParams.get("status"),
    ALERT_STATUS_FILTERS.map((item) => item.value),
    "all",
  ) as AlertStatusFilter;
  const ackFilter = queryEnum(
    searchParams.get("acknowledged_source"),
    ACK_FILTERS.map((item) => item.value),
    "all",
  ) as AckFilter;
  const eventType = queryEnum(
    searchParams.get("event_type"),
    EVENT_TYPE_FILTERS.map((item) => item.value),
    "actions",
  ) as EventTypeFilter;
  const period = queryEnum(
    searchParams.get("period"),
    PERIOD_PRESETS.map((item) => item.value),
    tab === "eventos" ? "7d" : "all",
  ) as PeriodPreset;
  const search = searchParams.get("search") || "";
  const actor = searchParams.get("actor") || "";
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const selectedAlertId = searchParams.get("alert");
  const recurrenceKey = searchParams.get("recurrence") || null;

  const patchParams = useCallback((patch: Record<string, string | null | string[]>, options?: { resetPage?: boolean }) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (Array.isArray(value)) {
          next.delete(key);
          for (const entry of value) next.append(key, entry);
          continue;
        }
        const omitDefault = (
          value === null
          || value === ""
          || (key === "tab" && value === "alertas")
          || (key === "risk" && value === "all")
          || (key === "customer" && value === "all")
          || (key === "status" && value === "all")
          || (key === "acknowledged_source" && value === "all")
          || (key === "event_type" && value === "actions")
          || (key === "period" && value === "all")
          || (key === "page" && value === "1")
        );
        if (omitDefault) next.delete(key);
        else next.set(key, value);
      }
      if (options?.resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    setSearchDraft(search);
  }, [search]);

  useEffect(() => {
    setActorDraft(actor);
  }, [actor]);

  useEffect(() => {
    if (period === "custom") {
      setCustomRange(rangeFromUrl(searchParams) ?? customRange);
    }
  }, [period, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = searchDraft.trim();
      if (trimmed === search) return;
      patchParams({ search: trimmed || null }, { resetPage: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [patchParams, search, searchDraft]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = actorDraft.trim();
      if (trimmed === actor) return;
      patchParams({ actor: trimmed || null }, { resetPage: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [actor, actorDraft, patchParams]);

  useEffect(() => {
    void fetchOneViewFacets()
      .then(setFacets)
      .catch(() => undefined);
  }, []);

  const loadEvents = useCallback(async () => {
    eventsRequestRef.current?.abort();
    const controller = new AbortController();
    eventsRequestRef.current = controller;
    const quiet = eventsLoadedRef.current;
    if (!quiet) setEventsLoading(true);
    try {
      const bounds = periodBounds(period, customRange);
      if (period === "custom" && !bounds.from) {
        setEventItems([]);
        setEventTotal(0);
        setEventPages(1);
        setEventsError(null);
        eventsLoadedRef.current = true;
        setEventsLoaded(true);
        return;
      }
      const searchParts = [search, actor].map((value) => value.trim()).filter(Boolean);
      const response = await fetchGlobalHistory({
        page,
        pageSize: PAGE_SIZE,
        customers: cliente === "all" ? [] : [cliente],
        datasources: fonte === "all" ? [] : [fonte],
        eventType,
        search: searchParts.length ? searchParts.join(" ") : undefined,
        occurredFrom: bounds.from,
        occurredTo: bounds.to,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const actions = (response.items ?? []).filter((item) => isActionHistoryItem(item));
      setEventItems(eventType === "acks" ? consolidateAckEvents(actions) : actions);
      setEventTotal(response.pagination.total_items);
      setEventPages(response.pagination.total_pages);
      setEventsError(null);
      eventsLoadedRef.current = true;
      setEventsLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setEventsError(error instanceof Error ? error.message : "Não foi possível carregar os eventos.");
      }
    } finally {
      if (!controller.signal.aborted) setEventsLoading(false);
    }
  }, [actor, cliente, fonte, customRange, eventType, page, period, search]);

  const loadAlerts = useCallback(async () => {
    alertsRequestRef.current?.abort();
    const controller = new AbortController();
    alertsRequestRef.current = controller;
    const quiet = alertsLoadedRef.current;
    if (!quiet) setAlertsLoading(true);
    try {
      const bounds = periodBounds(period, customRange);
      if (period === "custom" && !bounds.from) {
        setAlertItems([]);
        setAlertTotal(0);
        setAlertPages(1);
        setFilteredSummary(null);
        setAlertsError(null);
        alertsLoadedRef.current = true;
        setAlertsLoaded(true);
        return;
      }

      let request = applyHistoryRiskPreset({
        page,
        pageSize: PAGE_SIZE,
        customers: cliente === "all" ? [] : [cliente],
        datasources: fonte === "all" ? [] : [fonte],
        severities: risk === "all" || risk === "no_ack" ? severities : undefined,
        status: risk === "all" || risk === "no_ack" ? alertStatus : undefined,
        acknowledgedSource: risk === "all"
          ? (ackFilter === "all" ? undefined : ackFilter === "true")
          : undefined,
        search: search || undefined,
        sort: "last_seen_at",
        order: "desc",
        signal: controller.signal,
        recurrenceKey: recurrenceKey || undefined,
      }, risk);

      if (bounds.from || bounds.to) {
        if (risk === "closed_ack" || alertStatus === "resolved") {
          request = { ...request, resolvedFrom: bounds.from, resolvedTo: bounds.to };
        } else {
          request = { ...request, firstSeenFrom: bounds.from, firstSeenTo: bounds.to };
        }
      }

      const response = await fetchAlerts(request);
      if (controller.signal.aborted) return;
      setAlertItems(response.items ?? []);
      setAlertTotal(response.pagination.total_items);
      setAlertPages(response.pagination.total_pages);
      const summary = response.filtered_summary;
      setFilteredSummary(summary ? {
        total: summary.total,
        acknowledged_source: summary.acknowledged_source,
        unacknowledged_source: summary.unacknowledged_source,
        by_severity: {
          disaster: summary.by_severity?.disaster ?? 0,
          high: summary.by_severity?.high ?? 0,
        },
      } : null);
      setAlertsError(null);
      alertsLoadedRef.current = true;
      setAlertsLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setAlertsError(error instanceof Error ? error.message : "Não foi possível carregar os alertas.");
      }
    } finally {
      if (!controller.signal.aborted) setAlertsLoading(false);
    }
  }, [ackFilter, alertStatus, cliente, fonte, customRange, page, period, recurrenceKey, risk, search, severities]);

  useEffect(() => {
    if (tab !== "eventos") return;
    void loadEvents();
    return () => eventsRequestRef.current?.abort();
  }, [loadEvents, tab]);

  useEffect(() => {
    if (tab !== "alertas") return;
    void loadAlerts();
    return () => alertsRequestRef.current?.abort();
  }, [loadAlerts, tab]);

  useEffect(() => {
    const refreshActiveTab = () => {
      if (document.hidden) return;
      if (tab === "eventos") void loadEvents();
      else void loadAlerts();
    };
    const timer = window.setInterval(refreshActiveTab, HISTORY_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshActiveTab);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshActiveTab);
    };
  }, [loadAlerts, loadEvents, tab]);

  useEffect(() => {
    if (!selectedAlertId) {
      setDetail(null);
      setDetailHistory([]);
      setDetailError(null);
      return;
    }
    const preview = alertItems.find((item) => item.id === selectedAlertId) || null;
    if (preview) setDetail((current) => current?.id === selectedAlertId ? current : preview);
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    setDetailError(null);
    void Promise.allSettled([
      fetchAlert(selectedAlertId, controller.signal),
      fetchAlertHistory(selectedAlertId, controller.signal),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      if (results[0].status === "fulfilled") {
        setDetail(results[0].value.item);
      } else if (!preview) {
        setDetailError(results[0].reason instanceof Error ? results[0].reason.message : "Não foi possível abrir o detalhe.");
      }
      if (results[1].status === "fulfilled") {
        setDetailHistory(results[1].value.items ?? []);
      }
      if (results[0].status === "rejected" && results[1].status === "rejected" && !preview) {
        setDetailError(results[0].reason instanceof Error ? results[0].reason.message : "Não foi possível abrir o detalhe.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
    // OV-P0-108 — não re-fetch em refresh da tabela (alertItems); só quando o alert ID muda.
  }, [selectedAlertId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupedEvents = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: GlobalHistoryItem[] }> = [];
    const indexByKey = new Map<string, number>();
    for (const item of eventItems) {
      const key = dayGroupKey(item.occurred_at);
      const existing = indexByKey.get(key);
      if (existing === undefined) {
        indexByKey.set(key, groups.length);
        groups.push({
          key,
          label: item.occurred_at ? dayGroupLabel(item.occurred_at) : "Data indisponível",
          items: [item],
        });
      } else {
        groups[existing].items.push(item);
      }
    }
    return groups;
  }, [eventItems]);

  const customerOptions = useMemo(() => (
    // OV-P0-102: só facets reais — sem opção artificial de unclassified.
    (facets?.customers ?? [])
      .filter((customer) => !isDatasourceOnlyFilterValue(customer.key) && !isDatasourceOnlyFilterValue(customer.name))
      .map((customer) => ({
      ...customer,
      name: facetCustomerDisplayName(customer),
    }))
  ), [facets?.customers]);

  const countLabel = tab === "alertas"
    ? (alertsError || alertTotal === null ? "— alertas registrados" : `${alertTotal.toLocaleString("pt-BR")} alertas registrados`)
    : (eventsError || eventTotal === null ? "— eventos registrados" : `${eventTotal.toLocaleString("pt-BR")} eventos registrados`);

  const clearFilters = () => {
    setSearchDraft("");
    setActorDraft("");
    setCustomRange(undefined);
    setSearchParams((current) => {
      const next = new URLSearchParams();
      const currentTab = current.get("tab");
      if (currentTab && currentTab !== "alertas") next.set("tab", currentTab);
      const alert = current.get("alert");
      if (alert) next.set("alert", alert);
      return next;
    }, { replace: true });
  };

  const changeFilter = (key: string, value: string) => {
    if (key === "customer") {
      patchParams({ customer: value === "all" ? null : value }, { resetPage: true });
      return;
    }
    if (key === "datasource") {
      patchParams({ datasource: value === "all" ? null : value }, { resetPage: true });
      return;
    }
    if (key === "period") {
      if (value !== "custom") {
        patchParams({ period: value, from: null, to: null }, { resetPage: true });
        setCustomRange(undefined);
        return;
      }
      patchParams({ period: "custom" }, { resetPage: true });
      return;
    }
    if (key === "severity") {
      if (value === "all") {
        patchParams({ severity: [], risk: risk === "current" || risk === "current_ack" || risk === "closed_ack" ? "all" : null }, { resetPage: true });
        return;
      }
      const next = value.split(",").filter(Boolean);
      patchParams({ severity: next, risk: "all" }, { resetPage: true });
      return;
    }
    if (key === "status" || key === "acknowledged_source") {
      patchParams({ [key]: value, risk: "all" }, { resetPage: true });
      return;
    }
    patchParams({ [key]: value }, { resetPage: true });
  };

  const applyRiskPreset = (value: HistoryRiskPreset) => {
    if (value === "all") {
      patchParams({
        risk: "all",
        status: "all",
        acknowledged_source: "all",
        severity: [],
      }, { resetPage: true });
      return;
    }
    if (value === "no_ack") {
      patchParams({
        risk: "no_ack",
        acknowledged_source: "false",
        status: null,
        severity: [],
      }, { resetPage: true });
      return;
    }
    if (value === "current") {
      patchParams({
        risk: "current",
        status: "active",
        acknowledged_source: "all",
        severity: ["disaster", "high"],
      }, { resetPage: true });
      return;
    }
    if (value === "current_ack") {
      patchParams({
        risk: "current_ack",
        status: "active",
        acknowledged_source: "true",
        severity: ["disaster", "high"],
      }, { resetPage: true });
      return;
    }
    patchParams({
      risk: "closed_ack",
      status: "resolved",
      acknowledged_source: "true",
      severity: ["disaster", "high"],
    }, { resetPage: true });
  };

  const applyCustomRange = (range: DateRange | undefined) => {
    setCustomRange(range);
    if (!range?.from) {
      patchParams({ from: null, to: null, period: "custom" }, { resetPage: true });
      return;
    }
    const from = format(range.from, "yyyy-MM-dd");
    const to = format(range.to ?? range.from, "yyyy-MM-dd");
    patchParams({ period: "custom", from, to }, { resetPage: true });
  };

  const switchTab = (next: string) => {
    const value = next === "eventos" ? "eventos" : "alertas";
    patchParams({
      tab: value,
      page: null,
    }, { resetPage: true });
  };

  const openAlertDetail = (alertId: string) => {
    patchParams({ alert: alertId });
  };

  const closeAlertDetail = () => {
    patchParams({ alert: null });
  };

  const showRiskSummary = tab === "alertas" && isRiskSummaryPreset(risk) && !alertsError;

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="gap-3 p-3 lg:px-4"
      clientSelect={(
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight text-foreground">Histórico</h1>
          <Badge variant="outline" className="text-[10px]">
            {countLabel}
          </Badge>
        </div>
      )}
    >
      <div className="min-w-0 space-y-3">
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList aria-label="Abas do histórico" className="w-full sm:w-auto">
            <TabsTrigger value="alertas">Alertas</TabsTrigger>
            <TabsTrigger value="eventos">Eventos</TabsTrigger>
          </TabsList>

          <TabsContent value="alertas" className="mt-4 min-w-0 space-y-4">
            {recurrenceKey ? <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">Histórico completo da reincidência deste ativo (mesma fonte, host e trigger).</div> : null}
            <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap" role="group" aria-label="Presets de risco">
              {HISTORY_RISK_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  size="sm"
                  variant={risk === preset.value ? "default" : "outline"}
                  className="shrink-0"
                  onClick={() => applyRiskPreset(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <FilterBar
              aria-label="Filtros de alertas do histórico"
              footer={(
                <Button type="button" variant="outline" size="sm" className={OV_CTA} onClick={clearFilters}>
                  Limpar filtros
                </Button>
              )}
            >
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-cliente">Cliente</Label>
                  <Select value={cliente} onValueChange={(value) => changeFilter("customer", value)}>
                    <SelectTrigger id="historico-alertas-cliente" aria-label="Filtrar por cliente" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="Cliente" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <span className="flex items-center gap-2">
                          <ClientIdentity customer={{ key: "all", name: "Todos" }} />
                          <span>Todos os clientes</span>
                        </span>
                      </SelectItem>
                      {customerOptions.map((customer) => (
                        <SelectItem key={customer.key} value={customer.key}>
                          <span className="flex items-center gap-2">
                            <ClientIdentity customer={customer} />
                            <span className="truncate">{customer.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-fonte">Fonte Zabbix</Label>
                  <ZabbixSourceFilter
                    id="historico-alertas-fonte"
                    value={fonte}
                    options={facets?.datasources ?? []}
                    onValueChange={(value) => changeFilter("datasource", value)}
                    triggerClassName="w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-severidade">Severidade</Label>
                  <Select value={severitySelectValue(severities)} onValueChange={(value) => changeFilter("severity", value)}>
                    <SelectTrigger id="historico-alertas-severidade" aria-label="Filtrar por severidade" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="Severidade" />
                    </SelectTrigger>
                    <SelectContent>
                      {SEVERITY_FILTERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-status">Estado</Label>
                  <Select value={alertStatus} onValueChange={(value) => changeFilter("status", value)}>
                    <SelectTrigger id="historico-alertas-status" aria-label="Filtrar por estado" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="Estado" />
                    </SelectTrigger>
                    <SelectContent>
                      {ALERT_STATUS_FILTERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-ack">ACK</Label>
                  <Select value={ackFilter} onValueChange={(value) => changeFilter("acknowledged_source", value)}>
                    <SelectTrigger id="historico-alertas-ack" aria-label="Filtrar por ACK" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="ACK" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACK_FILTERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-alertas-periodo">Período</Label>
                  <div className="flex gap-2">
                    <Select value={period} onValueChange={(value) => changeFilter("period", value)}>
                      <SelectTrigger id="historico-alertas-periodo" aria-label="Filtrar por período" className={cn(OV_FILTER_CONTROL, "flex-1")}>
                        <SelectValue placeholder="Período" />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_PRESETS.map((item) => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {period === "custom" ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" size="icon" aria-label="Selecionar intervalo personalizado">
                            <CalendarRange className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-auto p-3">
                          <Calendar
                            mode="range"
                            numberOfMonths={1}
                            locale={ptBR}
                            selected={customRange}
                            onSelect={applyCustomRange}
                          />
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-1.5 xl:col-span-3">
                  <Label htmlFor="historico-alertas-busca">Host / problema</Label>
                  <Input
                    id="historico-alertas-busca"
                    aria-label="Buscar alertas no histórico"
                    placeholder="Buscar host, problema ou cliente"
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                  />
                </div>
              </div>
            </FilterBar>

            {alertsError ? (
              <OperationalErrorBanner
                message={alertsError}
                retryLabel="Tentar novamente"
                onRetry={() => void loadAlerts()}
              />
            ) : null}

            {showRiskSummary ? (
              <div
                className="grid gap-2 rounded-[10px] border border-border/60 bg-background/40 px-3 py-2 text-xs sm:grid-cols-4"
                aria-label="Resumo da consulta de riscos"
              >
                <div>
                  <p className="text-muted-foreground">Disaster</p>
                  <p className="text-sm font-semibold tabular-nums">
                    {filteredSummary ? filteredSummary.by_severity.disaster.toLocaleString("pt-BR") : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">High</p>
                  <p className="text-sm font-semibold tabular-nums">
                    {filteredSummary ? filteredSummary.by_severity.high.toLocaleString("pt-BR") : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Com ACK</p>
                  <p className="text-sm font-semibold tabular-nums">
                    {filteredSummary ? filteredSummary.acknowledged_source.toLocaleString("pt-BR") : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Sem ACK</p>
                  <p className="text-sm font-semibold tabular-nums">
                    {filteredSummary ? filteredSummary.unacknowledged_source.toLocaleString("pt-BR") : "—"}
                  </p>
                </div>
              </div>
            ) : null}

            <SectionPanel className="overflow-hidden">
              {alertsLoading && !alertsLoaded ? (
                <div className="space-y-3 p-4" aria-label="Carregando alertas do histórico">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : alertItems.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cliente</TableHead>
                        <TableHead>Severidade</TableHead>
                        <TableHead>Host</TableHead>
                        <TableHead>Problema</TableHead>
                        <TableHead>Início</TableHead>
                        <TableHead>ACK</TableHead>
                        <TableHead>Chamado</TableHead>
                        <TableHead>Estado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {alertItems.map((alert) => {
                        const ackActor = alert.acknowledged_source
                          ? (safeActorName(alert.acknowledged_source_by) || safeActorName(alert.acknowledged_by) || "Reconhecido")
                          : null;
                        const ackAt = alert.acknowledged_source_at || alert.acknowledged_at;
                        return (
                          <TableRow
                            key={alert.id}
                            className="cursor-pointer hover:bg-muted/40"
                            tabIndex={0}
                            role="button"
                            aria-label={`Abrir detalhe de ${alert.problem_name || canonicalHostName(alert)}`}
                            onClick={() => openAlertDetail(alert.id)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openAlertDetail(alert.id);
                              }
                            }}
                          >
                            <TableCell className="max-w-[12rem]">
                              <ClientIdentity
                                customer={{
                                  key: alert.customer_key,
                                  name: alert.customer_name,
                                  source: alert.customer_source,
                                  operational_scope: alert.operational_scope,
                                  operational_scope_label: alert.operational_scope_label,
                                }}
                                operationalScope={alert.operational_scope}
                                operationalScopeLabel={historyEventClientLabel({
                                  key: alert.customer_key,
                                  name: alert.customer_name,
                                  operational_scope: alert.operational_scope,
                                  operational_scope_label: alert.operational_scope_label,
                                })}
                                showName
                                nameClassName="truncate text-sm"
                              />
                            </TableCell>
                            <TableCell>
                              <SeverityBadge severity={alert.severity} />
                            </TableCell>
                            <TableCell className="max-w-[12rem] truncate font-medium">
                              {canonicalHostName(alert)}
                            </TableCell>
                            <TableCell className="max-w-[18rem] truncate">
                              {alert.problem_name || "Problema não informado"}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {formatWhen(alert.first_seen_at)}
                            </TableCell>
                            <TableCell className="max-w-[10rem]">
                              {ackActor ? (
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium leading-tight">{ackActor}</p>
                                  {ackAt ? (
                                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{formatWhen(ackAt)}</p>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-sm font-medium text-amber-800">Pendente</span>
                              )}
                            </TableCell>
                            <TableCell className="max-w-[9rem]">
                              <AlertServiceNowReferenceCell reference={alert.servicenow_reference} />
                            </TableCell>
                            <TableCell>
                              <p className={cn(
                                "font-medium",
                                alertStatusLabel(alert) === "Ativo" ? "text-red-700" : "text-emerald-700",
                              )}>
                                {alertStatusLabel(alert)}
                              </p>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <OperationalEmptyState
                  icon={<Siren className="h-5 w-5" />}
                  title="Nenhum alerta encontrado para os filtros selecionados."
                  action={(
                    <Button type="button" variant="outline" size="sm" className={OV_CTA} onClick={clearFilters}>
                      Limpar filtros
                    </Button>
                  )}
                />
              )}
              {alertsLoaded && !alertsError && alertPages > 1 ? (
                <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Página {page} de {alertPages} · {countLabel}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page <= 1 || alertsLoading}
                      onClick={() => patchParams({ page: String(Math.max(1, page - 1)) })}
                    >
                      Anterior
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page >= alertPages || alertsLoading}
                      onClick={() => patchParams({ page: String(page + 1) })}
                    >
                      Próxima
                    </Button>
                  </div>
                </div>
              ) : null}
            </SectionPanel>
          </TabsContent>

          <TabsContent value="eventos" className="mt-4 min-w-0 space-y-4">
            <FilterBar
              aria-label="Filtros de eventos do histórico"
              footer={(
                <Button type="button" variant="outline" size="sm" className={OV_CTA} onClick={clearFilters}>
                  Limpar filtros
                </Button>
              )}
            >
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1.5">
                  <Label htmlFor="historico-eventos-cliente">Cliente</Label>
                  <Select value={cliente} onValueChange={(value) => changeFilter("customer", value)}>
                    <SelectTrigger id="historico-eventos-cliente" aria-label="Filtrar por cliente" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="Cliente" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <span className="flex items-center gap-2">
                          <ClientIdentity customer={{ key: "all", name: "Todos" }} />
                          <span>Todos os clientes</span>
                        </span>
                      </SelectItem>
                      {customerOptions.map((customer) => (
                        <SelectItem key={customer.key} value={customer.key}>
                          <span className="flex items-center gap-2">
                            <ClientIdentity customer={customer} />
                            <span className="truncate">{customer.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-eventos-fonte">Fonte Zabbix</Label>
                  <ZabbixSourceFilter
                    id="historico-eventos-fonte"
                    value={fonte}
                    options={facets?.datasources ?? []}
                    onValueChange={(value) => changeFilter("datasource", value)}
                    triggerClassName="w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-tipo">Tipo</Label>
                  <Select value={eventType} onValueChange={(value) => changeFilter("event_type", value)}>
                    <SelectTrigger id="historico-tipo" aria-label="Filtrar por tipo de evento" className={OV_FILTER_CONTROL}>
                      <SelectValue placeholder="Tipo de evento" />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_TYPE_FILTERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-periodo">Período</Label>
                  <div className="flex gap-2">
                    <Select value={period} onValueChange={(value) => changeFilter("period", value)}>
                      <SelectTrigger id="historico-periodo" aria-label="Filtrar por período" className={cn(OV_FILTER_CONTROL, "flex-1")}>
                        <SelectValue placeholder="Período" />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIOD_PRESETS.map((item) => (
                          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {period === "custom" ? (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" size="icon" aria-label="Selecionar intervalo personalizado">
                            <CalendarRange className="h-4 w-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-auto p-3">
                          <Calendar
                            mode="range"
                            numberOfMonths={1}
                            locale={ptBR}
                            selected={customRange}
                            onSelect={applyCustomRange}
                          />
                        </PopoverContent>
                      </Popover>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-busca">Host / problema</Label>
                  <Input
                    id="historico-busca"
                    aria-label="Buscar no histórico"
                    placeholder="Buscar host ou problema"
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="historico-ator">Ator</Label>
                  <Input
                    id="historico-ator"
                    aria-label="Filtrar por ator"
                    placeholder="Buscar ator"
                    value={actorDraft}
                    onChange={(event) => setActorDraft(event.target.value)}
                  />
                </div>
              </div>
            </FilterBar>

            {eventsError ? (
              <OperationalErrorBanner
                message={eventsError}
                retryLabel="Tentar novamente"
                onRetry={() => void loadEvents()}
              />
            ) : null}

            <SectionPanel>
              {eventsLoading && !eventsLoaded ? (
                <div className="space-y-3 p-4" aria-label="Carregando histórico operacional">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : eventItems.length ? (
                eventType === "acks" ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Cliente</TableHead>
                          <TableHead>Host</TableHead>
                          <TableHead>Problema</TableHead>
                          <TableHead>Ator</TableHead>
                          <TableHead>Comentário</TableHead>
                          <TableHead>Ocorrido em</TableHead>
                          <TableHead>Severidade</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {eventItems.map((item) => {
                          const actorName = safeActorName(item.actor_name);
                          const comment = isValidOperationalComment(item.description) ? item.description.trim() : null;
                          return (
                            <TableRow
                              key={item.id}
                              className="cursor-pointer hover:bg-muted/40"
                              tabIndex={0}
                              role="button"
                              aria-label={`Abrir detalhe de ${item.problem_name || canonicalHostName(item)}`}
                              onClick={() => openAlertDetail(item.alert_id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openAlertDetail(item.alert_id);
                                }
                              }}
                            >
                              <TableCell className="max-w-[12rem]">
                                <ClientIdentity
                                  customer={{
                                    key: item.customer_key,
                                    name: item.customer_name,
                                    operational_scope: item.operational_scope,
                                    operational_scope_label: item.operational_scope_label,
                                  }}
                                  operationalScope={item.operational_scope}
                                  operationalScopeLabel={
                                    item.operational_scope_label || historyEventClientLabel(item)
                                  }
                                  showName
                                  nameClassName="truncate text-sm"
                                />
                              </TableCell>
                              <TableCell className="max-w-[12rem] truncate">
                                {canonicalHostName(item)}
                              </TableCell>
                              <TableCell className="max-w-[16rem] truncate">
                                {item.problem_name || "Problema não informado"}
                              </TableCell>
                              <TableCell className="max-w-[10rem] truncate">{actorName || "—"}</TableCell>
                              <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                                {comment || "—"}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                {formatWhen(item.occurred_at)}
                              </TableCell>
                              <TableCell>
                                <SeverityBadge severity={item.severity} />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="divide-y divide-border/60">
                    {groupedEvents.map((group) => (
                      <section key={group.key} className="px-4 py-3">
                        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.label}
                        </h2>
                        <ol className="space-y-2">
                          {group.items.map((item) => {
                            const title = formalOperationalTitle(item);
                            const actorName = safeActorName(item.actor_name);
                            const comment = isValidOperationalComment(item.description) ? item.description.trim() : null;
                            const customer = historyEventClientLabel({
                              key: item.customer_key,
                              name: item.customer_name,
                              operational_scope: item.operational_scope,
                              operational_scope_label: item.operational_scope_label,
                            });
                            return (
                              <li
                                key={item.id}
                                className="cursor-pointer rounded-[10px] border border-border/60 bg-background/40 px-3 py-2.5 hover:bg-muted/40"
                                tabIndex={0}
                                role="button"
                                aria-label={`Abrir detalhe de ${item.problem_name || canonicalHostName(item)}`}
                                onClick={() => openAlertDetail(item.alert_id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openAlertDetail(item.alert_id);
                                  }
                                }}
                              >
                                <div className="min-w-0 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] tabular-nums text-muted-foreground">
                                      {formatClock(item.occurred_at)}
                                    </span>
                                    <p className="text-sm font-semibold">{title}</p>
                                    <SeverityBadge severity={item.severity} />
                                  </div>
                                  <p className="truncate text-sm font-medium">{item.problem_name || "Problema não informado"}</p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    Host: {canonicalHostName(item)} · {customer}
                                  </p>
                                  {actorName && String(item.event_type || "").toLowerCase() !== "acknowledged" ? (
                                    <p className="text-[11px] text-muted-foreground">Responsável: {actorName}</p>
                                  ) : null}
                                  {comment ? (
                                    <p className="line-clamp-2 text-xs text-muted-foreground">
                                      Comentário: {comment}
                                    </p>
                                  ) : null}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      </section>
                    ))}
                  </div>
                )
              ) : (
                <OperationalEmptyState
                  icon={<History className="h-5 w-5" />}
                  title="Nenhum evento encontrado para os filtros selecionados."
                  action={(
                    <Button type="button" variant="outline" size="sm" className={OV_CTA} onClick={clearFilters}>
                      Limpar filtros
                    </Button>
                  )}
                />
              )}
              {eventsLoaded && !eventsError && eventPages > 1 ? (
                <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Página {page} de {eventPages} · {countLabel}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page <= 1 || eventsLoading}
                      onClick={() => patchParams({ page: String(Math.max(1, page - 1)) })}
                    >
                      Anterior
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page >= eventPages || eventsLoading}
                      onClick={() => patchParams({ page: String(page + 1) })}
                    >
                      Próxima
                    </Button>
                  </div>
                </div>
              ) : null}
            </SectionPanel>
          </TabsContent>
        </Tabs>
      </div>

      <AlertDetailDrawer
        open={Boolean(selectedAlertId)}
        onOpenChange={(next) => { if (!next) closeAlertDetail(); }}
        alert={detail}
        historyItems={detailHistory}
        isLoading={detailLoading}
        error={detailError}
        description="Auditoria temporal do alerta — filtros do Histórico permanecem."
        defaultTab="history"
        auditEmphasis
        alertsQueueHref={
          detail?.id
            ? `/alertas?alert=${encodeURIComponent(detail.id)}&from=historico`
            : (selectedAlertId ? `/alertas?alert=${encodeURIComponent(selectedAlertId)}&from=historico` : null)
        }
      />
    </AppLayout>
  );
}
