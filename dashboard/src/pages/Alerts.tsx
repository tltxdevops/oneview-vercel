import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateRange } from "react-day-picker";
import { endOfDay, format, formatDistanceToNow, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import {
  ClientIdentity,
  CLASSIFICATION_PENDING_LABEL,
  UNKNOWN_SCOPE_LABEL,
  canonicalClientName,
  canonicalHostName,
  displayHostField,
  facetCustomerDisplayName,
  normalizeOperationalScope,
  operationalClientLabel,
  isUnclassifiedClient,
} from "@/components/oneview/ClientIdentity";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AlertDetailResponse,
  AlertHistoryItem,
  AlertHistoryResponse,
  AlertListResponse,
  AlertMetrics,
  AlertPagination,
  ONEVIEW_V1_FILTER_SEVERITIES,
  OneViewAlert,
  OneViewDataSourceKind,
  OneViewSeverity,
  OneViewHealthResponse,
  OneViewFacetsResponse,
  fetchAlert,
  fetchAlertHistory,
  fetchAlertMetrics,
  fetchAlerts,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchOneViewFacets,
  fetchOperationsHealth,
  formatDurationSeconds,
  formatNullableCount,
  formatOneViewSeverityLabel,
  isOneViewSeverity,
  normalizeAlertSeveritySummary,
  normalizeOneViewSeverity,
  requestAlertAcknowledgement,
} from "@/lib/oneview-api";
import { ONEVIEW_SEVERITY_UI } from "@/lib/oneview-severity-visual";
import { OV_CTA, OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import {
  ALERTS_DATE_FIELD_OPTIONS,
  ALERTS_DATE_PRESET_OPTIONS,
  ALERTS_SEARCH_FIELD_OPTIONS,
  ALERTS_SORT_OPTIONS,
  alertsDateActive,
  alertsDateBounds,
  applyDateFieldToFetchParams,
  applySearchToFetchParams,
  parseAlertsDateUrlValue,
  sortOptionKey,
  writeAlertsUrlParams,
  type AlertsAckFilter,
  type AlertsDateField,
  type AlertsDatePreset,
  type AlertsSearchField,
  type AlertsSortKey,
} from "@/lib/alerts-query";
import {
  Activity,
  ArrowUpDown,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  History,
  Loader2,
  RefreshCcw,
  Search,
  ServerCog,
  Siren,
  SlidersHorizontal,
  UserCheck,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

type RecognitionFilter = AlertsAckFilter;
type StatusFilter = "active" | "resolved" | "all";
type AlertsView = "recent" | "open" | "priority" | "forgotten" | "resolved" | "all";
type SortField = AlertsSortKey | "client" | "datasource" | "host" | "problem" | "status" | "acknowledged_source" | "last_seen_at";
type SortOrder = "asc" | "desc";
type TemporalPreset = AlertsDatePreset;
type ResolvedTemporalPreset = AlertsDatePreset;
type HistoryFilter = "all" | "acknowledgements" | "changes" | "recovery" | "legacy";

const ALERTS_VIEWS: Array<{ id: AlertsView; label: string }> = [
  { id: "recent", label: "Recentes" },
  { id: "open", label: "Em aberto" },
  { id: "priority", label: "Prioritários" },
  { id: "forgotten", label: "Esquecidos" },
  { id: "resolved", label: "Resolvidos" },
  { id: "all", label: "Todos" },
];

function inferAlertsView(query: URLSearchParams): AlertsView {
  const explicit = query.get("view");
  if (explicit === "recent" || explicit === "open" || explicit === "priority" || explicit === "forgotten" || explicit === "resolved" || explicit === "all") {
    return explicit;
  }
  const status = queryEnum(query.get("status"), ["active", "resolved", "all"] as const, "active");
  const sort = query.get("sort");
  const order = query.get("order");
  const severities = query.getAll("severity");
  if (status === "resolved") return "resolved";
  if (status === "all") return "all";
  if (severities.includes("disaster") || severities.includes("high")) return "priority";
  if (sort === "first_seen_at" && order === "asc") return "forgotten";
  if (sort === "first_seen_at") return "recent";
  return "recent";
}
type MetaState = { source?: OneViewDataSourceKind; checkedAt?: string; fallbackCode?: string | null };
type SummaryFilter =
  | "total"
  | "active"
  | "acknowledged"
  | "pending"
  | "information"
  | "warning"
  | "average"
  | "high"
  | "disaster"
  | "not_classified";

/** Faixa visual obrigatória (OV-P0-41). Not classified fica fora. */
const VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];

/** OV-P0-255 — polling operacional 10s. */
const SUMMARY_REFRESH_MS = 10_000;
const ALERTS_REFRESH_MS = 10_000;

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

const severityCatalog = ONEVIEW_SEVERITY_UI;

/** OV-P0-07 backlog: adicionar ordenação composta no BFF: severity → unacknowledged → duration. */
const PRIORITY_VIEW_NOTE = "Prioritários usa sort=severity no BFF; desempate global por ACK/duração permanece em backlog.";

const severityOrder: OneViewSeverity[] = [...ONEVIEW_V1_FILTER_SEVERITIES];

function safeDisplayText(value: unknown, fallback = "-", maxLength = 500) {
  if (typeof value !== "string") return fallback;
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
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
  // source_ack é o reconhecimento selecionado pelo contrato atual.
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
      comment: typeof sourceAck.comment === "string" ? sourceAck.comment : null,
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

/** Comentário Zabbix: rejeita vazio, JSON, backfill/sync e frases genéricas. */
function isValidZabbixAckComment(value: unknown): value is string {
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
  if (/backfill|sincroniza|sync[_ ]?log|payload|outbox|reconcil|upsert|worker oneview/i.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (["alerta reconhecido", "reconhecimento registrado", "observação do reconhecimento", "observacao do reconhecimento"].includes(normalized)) {
    return false;
  }
  return true;
}

/**
 * Precedência: source_ack.comment → comentário Zabbix acknowledged/ack_message no histórico → ausente.
 * Não usa comentário interno do OneView.
 */
function resolveOfficialAckComment(
  sourceAckComment: string | null | undefined,
  historyItems: AlertHistoryItem[],
): { comment: string | null; fedBy: "source_ack.comment" | "history.comment" | null } {
  if (isValidZabbixAckComment(sourceAckComment)) {
    return { comment: sourceAckComment.trim(), fedBy: "source_ack.comment" };
  }
  for (const item of historyItems) {
    const eventType = String(item.event_type || "").toLowerCase();
    if (eventType !== "acknowledged" && eventType !== "ack_message") continue;
    if (historyOrigin(item) !== "Zabbix") continue;
    if (item.origin === "oneview_internal") continue;
    if (isValidZabbixAckComment(item.comment)) {
      return { comment: item.comment.trim(), fedBy: "history.comment" };
    }
  }
  return { comment: null, fedBy: null };
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
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? formatOneViewSeverityLabel(trimmed) : null;
  }
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
  const customer = {
    key: alert.customer_key,
    name: alert.customer_name,
    source: alert.customer_source,
  };
  const scope = normalizeOperationalScope(alert.operational_scope);
  const label = operationalClientLabel({
    ...customer,
    operational_scope: alert.operational_scope,
    operational_scope_label: alert.operational_scope_label,
  });

  if (scope === "platform" || scope === "test") {
    return {
      name: label,
      hint: null,
      enrichment: "complete" as const,
      unidentified: false,
    };
  }

  if (scope === "unknown") {
    return {
      name: label,
      hint: CLASSIFICATION_PENDING_LABEL,
      enrichment: "unclassified" as const,
      unidentified: true,
    };
  }

  const unidentified = isUnclassifiedClient(customer);
  if (unidentified) {
    return {
      name: label || UNKNOWN_SCOPE_LABEL,
      hint: CLASSIFICATION_PENDING_LABEL,
      enrichment: "unclassified" as const,
      unidentified: true,
    };
  }
  return {
    name: canonicalClientName(customer),
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
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

const temporalLabels: Record<ResolvedTemporalPreset, string> = {
  all: "sem período",
  "15m": "nos últimos 15 minutos",
  "30m": "nos últimos 30 minutos",
  "1h": "na última hora",
  "2h": "nas últimas 2 horas",
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

function temporalPresetFromUrl(value: string | null): ResolvedTemporalPreset {
  const allowed = ["all", "15m", "30m", "1h", "2h", "6h", "24h", "7d", "30d", "custom"];
  return allowed.includes(value ?? "") ? value as ResolvedTemporalPreset : "all";
}

function dateFieldFromUrl(value: string | null): AlertsDateField {
  return queryEnum(value, ["first_seen", "last_seen", "acknowledged", "resolved"] as const, "first_seen");
}

function searchFieldFromUrl(value: string | null): AlertsSearchField {
  return queryEnum(value, ["all", "host", "problem", "customer", "eventid"] as const, "all");
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
  const [pagination, setPagination] = useState<AlertPagination>(emptyPagination);
  const [filteredSummary, setFilteredSummary] = useState<AlertListResponse["filtered_summary"]>(undefined);
  const [temporalCounts, setTemporalCounts] = useState<AlertListResponse["temporal_counts"]>(undefined);
  const [snapshotCoverage, setSnapshotCoverage] = useState<{ partial: boolean; total_persisted: number; available_items: number } | null>(null);

  const [page, setPage] = useState(() => positiveQueryInteger(initialQuery.get("page"), 1, Number.MAX_SAFE_INTEGER));
  const [pageSize, setPageSize] = useState(() => Number(queryEnum(initialQuery.get("page_size"), ["25", "50", "100"] as const, "50")));
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>(() => initialQuery.getAll("customer").filter(Boolean));
  const [selectedDatasources, setSelectedDatasources] = useState<string[]>(() => initialQuery.getAll("datasource").filter(Boolean));
  const initialView = inferAlertsView(initialQuery);
  const [sourceAckFilter, setSourceAckFilter] = useState<RecognitionFilter>(() => {
    const ackSource = initialQuery.get("acknowledged_source");
    if (ackSource === "true") return "acknowledged";
    if (ackSource === "false") return "unacknowledged";
    if (initialQuery.get("source_ack")) {
      return queryEnum(initialQuery.get("source_ack"), ["all", "acknowledged", "unacknowledged"] as const, "all");
    }
    if (initialView === "priority" || initialView === "forgotten") return "unacknowledged";
    return "all";
  });
  const [alertsView, setAlertsView] = useState<AlertsView>(() => initialView);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (initialQuery.get("status")) return queryEnum(initialQuery.get("status"), ["active", "resolved", "all"] as const, "active");
    if (initialView === "resolved") return "resolved";
    if (initialView === "all") return "all";
    return "active";
  });
  const [sortField, setSortField] = useState<SortField>(() => {
    if (initialQuery.get("sort")) {
      return queryEnum(initialQuery.get("sort"), ["last_seen_at", "first_seen_at", "resolved_at", "severity", "client", "datasource", "host", "problem", "duration", "status", "acknowledged_source", "acknowledged_at"] as const, "first_seen_at");
    }
    if (initialView === "priority") return "severity";
    if (initialView === "resolved") return "resolved_at";
    if (initialView === "open" || initialView === "all") return "last_seen_at";
    return "first_seen_at";
  });
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => {
    if (initialQuery.get("order")) return queryEnum(initialQuery.get("order"), ["asc", "desc"] as const, "desc");
    if (initialView === "forgotten") return "asc";
    return "desc";
  });
  const [selectedSeverities, setSelectedSeverities] = useState<OneViewSeverity[]>(() => {
    // OV-P0-102: critical legado entra via expandHighFamilySeverities no fetch — sem chip Critical.
    const fromUrl = initialQuery.getAll("severity").filter(isOneViewSeverity).filter((s) => s !== "critical");
    if (fromUrl.length) return fromUrl;
    if (initialView === "priority") return ["disaster", "high"];
    return [];
  });
  const [searchField, setSearchField] = useState<AlertsSearchField>(() => {
    if (initialQuery.get("search_field")) return searchFieldFromUrl(initialQuery.get("search_field"));
    if (initialQuery.get("host")) return "host";
    if (initialQuery.get("problem")) return "problem";
    return "all";
  });
  const [searchQuery, setSearchQuery] = useState(() => initialQuery.get("search") ?? initialQuery.get("host") ?? initialQuery.get("problem") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [dateField, setDateField] = useState<AlertsDateField>(() => {
    if (initialQuery.get("date_field")) return dateFieldFromUrl(initialQuery.get("date_field"));
    if (initialQuery.get("updated") && initialQuery.get("updated") !== "all") return "last_seen";
    if (initialQuery.get("resolved") && initialQuery.get("resolved") !== "all") return "resolved";
    if (initialQuery.get("ack") && initialQuery.get("ack") !== "all") return "acknowledged";
    return "first_seen";
  });
  const [datePreset, setDatePreset] = useState<AlertsDatePreset>(() => {
    if (initialQuery.get("date_preset")) return temporalPresetFromUrl(initialQuery.get("date_preset"));
    if (initialQuery.get("date_from") || initialQuery.get("date_to")) return "custom";
    if (initialQuery.get("created")) return temporalPresetFromUrl(initialQuery.get("created"));
    if (initialQuery.get("updated")) return temporalPresetFromUrl(initialQuery.get("updated"));
    if (initialQuery.get("resolved")) return temporalPresetFromUrl(initialQuery.get("resolved"));
    if (initialQuery.get("ack")) return temporalPresetFromUrl(initialQuery.get("ack"));
    if (initialView === "recent") return "24h";
    if (initialView === "all") return "30d";
    return "all";
  });
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const from = parseAlertsDateUrlValue(initialQuery.get("date_from"));
    const to = parseAlertsDateUrlValue(initialQuery.get("date_to"));
    if (from || to) return { from, to };
    return rangeFromUrl(initialQuery, "created")
      || rangeFromUrl(initialQuery, "updated")
      || rangeFromUrl(initialQuery, "resolved")
      || rangeFromUrl(initialQuery, "ack");
  });
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);

  const [isAlertsLoading, setIsAlertsLoading] = useState(false);
  const [hasLoadedAlerts, setHasLoadedAlerts] = useState(false);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<OneViewAlert | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
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
      setDebouncedSearch(searchQuery.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const next = writeAlertsUrlParams({
      view: alertsView,
      customers: selectedCustomerKeys,
      severities: selectedSeverities,
      status: statusFilter,
      acknowledgedSource: sourceAckFilter,
      dateField,
      datePreset,
      dateRange,
      searchField,
      search: searchQuery,
      sort: (sortField === "acknowledged_at" || sortField === "duration" || sortField === "first_seen_at" || sortField === "last_seen_at" || sortField === "resolved_at" || sortField === "severity"
        ? sortField
        : "first_seen_at") as AlertsSortKey,
      order: sortOrder,
      page,
      pageSize,
      alert: requestedAlertId,
    });
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [alertsView, dateField, datePreset, dateRange, page, pageSize, requestedAlertId, searchField, searchParams, searchQuery, selectedCustomerKeys, selectedSeverities, setSearchParams, sortField, sortOrder, sourceAckFilter, statusFilter]);

  const loadAlerts = useCallback(async (options?: { quiet?: boolean }) => {
    if (options?.quiet && alertsRequestRef.current && !alertsRequestRef.current.signal.aborted) return;
    alertsRequestRef.current?.abort();
    const controller = new AbortController();
    alertsRequestRef.current = controller;
    const requestId = ++alertsRequestIdRef.current;
    if (!options?.quiet) {
      setIsAlertsLoading(true);
      setAlertsError(null);
    }
    try {
      const requestTime = Date.now();
      const configuredStale = Number(health?.thresholds?.alert_stale_minutes);
      const staleMinutes = Number.isFinite(configuredStale) && configuredStale > 0 ? configuredStale : null;
      if (alertsView === "forgotten" && staleMinutes == null) {
        if (requestId !== alertsRequestIdRef.current) return;
        setIsAlertsLoading(Boolean(health == null));
        return;
      }

      const dateBounds = alertsView === "forgotten"
        ? { to: new Date(requestTime - (staleMinutes as number) * 60_000).toISOString() }
        : alertsDateBounds(datePreset, dateRange, requestTime);

      let request: Parameters<typeof fetchAlerts>[0] = {
        page,
        pageSize,
        customers: selectedCustomerKeys,
        datasources: selectedDatasources,
        severities: selectedSeverities,
        status: statusFilter,
        acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
        sort: sortField as "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "duration" | "acknowledged_at",
        order: sortOrder,
        signal: controller.signal,
      };

      request = applySearchToFetchParams(request, searchField, debouncedSearch);
      if (alertsView === "forgotten") {
        request.firstSeenTo = dateBounds.to;
      } else if (alertsDateActive(datePreset, dateRange)) {
        request = applyDateFieldToFetchParams(request, dateField, dateBounds);
      }

      const response = await fetchAlerts(request);
      if (requestId !== alertsRequestIdRef.current) return;
      const normalized = normalizeAlertResponse(response, page, pageSize);
      const safeResponse = response ?? ({} as AlertListResponse);
      if (normalized.pagination.total_pages > 0 && page > normalized.pagination.total_pages) {
        setPage(normalized.pagination.total_pages);
        return;
      }
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
  }, [alertsView, dateField, datePreset, dateRange, debouncedSearch, health, page, pageSize, searchField, selectedCustomerKeys, selectedDatasources, selectedSeverities, sortField, sortOrder, sourceAckFilter, statusFilter]);

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
    const results = await Promise.allSettled([
      fetchAlert(id, controller.signal),
      fetchAlertHistory(id, controller.signal),
    ]);
    if (controller.signal.aborted) return;
    if (results[0].status === "fulfilled") {
      setDetail(results[0].value);
      setDetailMeta(metaOf(results[0].value));
      setDetailError(null);
    } else {
      setDetailError(results[0].reason instanceof Error ? results[0].reason.message : "Detalhe indisponível.");
    }
    if (results[1].status === "fulfilled") {
      setHistory(results[1].value);
      setHistoryMeta(metaOf(results[1].value));
      setHistoryLoadError(null);
    } else {
      setHistoryLoadError(results[1].reason instanceof Error ? results[1].reason.message : "Histórico indisponível.");
    }
    setIsDetailLoading(false);
  }, []);

  useEffect(() => {
    if (!requestedAlertId || requestedAlertId === selectedAlertId) return;
    setSelectedAlertId(requestedAlertId);
    setSelectedPreview(null);
    // OV-P0-108 — não limpa detail/history no deep-link; loadSelectedAlert atualiza in-place.
    setHistoryFilter("all");
    setDetailError(null);
    setHistoryLoadError(null);
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
      if (document.hidden) return;
      if (now >= summaryDeadlineRef.current) {
        summaryDeadlineRef.current = now + SUMMARY_REFRESH_MS;
        void loadSummaryResources();
      }
      if (now >= alertsDeadlineRef.current) {
        alertsDeadlineRef.current = now + ALERTS_REFRESH_MS;
        void loadAlerts({ quiet: true });
      }
    }, 1000);
    const onVisibility = () => {
      if (document.hidden) return;
      summaryDeadlineRef.current = Date.now() + SUMMARY_REFRESH_MS;
      alertsDeadlineRef.current = Date.now() + ALERTS_REFRESH_MS;
      void loadSummaryResources();
      void loadAlerts({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadAlerts, loadSummaryResources]);

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
  const hasTemporalFilter = alertsView !== "forgotten" && alertsDateActive(datePreset, dateRange);
  const hasActiveListFilters = Boolean(
    selectedCustomerKeys.length
    || selectedSeverities.length
    || sourceAckFilter !== "all"
    || statusFilter !== "active"
    || debouncedSearch
    || hasTemporalFilter
    || alertsView === "forgotten",
  );
  const listTotal = pagination.total_items;
  // Indicadores refletem os mesmos filtros da lista (filtered_summary do BFF).
  // Erro/ausência => "—"; zero válido => 0.
  const activeTotal = filteredSummary
    ? filteredSummary.active
    : (hasActiveListFilters ? null : (metrics?.active_total ?? health?.counts?.active_alerts ?? null));
  const pendingTotal = filteredSummary
    ? filteredSummary.unacknowledged_source
    : (hasActiveListFilters ? null : (metrics ? (metrics.unacknowledged_total ?? 0) : null));
  const acknowledgedTotal = filteredSummary
    ? filteredSummary.acknowledged_source
    : (hasActiveListFilters
      ? null
      : (activeTotal == null || pendingTotal == null
        ? null
        : Math.max(Number(activeTotal) - Number(pendingTotal), 0)));
  const temporalDescription = hasActiveListFilters ? "Nos filtros atuais" : null;
  const formatCardValue = (value: number | null | undefined) => formatNullableCount(value);
  const severitySummary = useMemo(
    () => (filteredSummary ? normalizeAlertSeveritySummary(filteredSummary) : null),
    [filteredSummary],
  );
  const severityCountFor = (severity: OneViewSeverity): number | null => {
    if (severitySummary) {
      if (severity === "not_classified") return severitySummary.not_classified;
      if (severity === "critical") return null;
      return severitySummary.by_severity?.[severity] ?? null;
    }
    if (hasActiveListFilters) return null;
    if (!metrics) return null;
    return severityCounts[severity] ?? 0;
  };
  // OV-P0-17 / OV-P0-41: faixa operacional + cinco severidades Zabbix; Not classified separado.
  const operationalCards = [
    {
      filter: "active" as const,
      title: "Em acompanhamento",
      value: activeTotal,
      description: temporalDescription ?? "Ocorrências atualmente mantidas como ativas no OneView.",
    },
    {
      filter: "acknowledged" as const,
      title: "Reconhecidos",
      value: acknowledgedTotal,
      description: temporalDescription ?? "Reconhecidos na origem",
    },
    {
      filter: "pending" as const,
      title: "Pendentes",
      value: pendingTotal,
      description: temporalDescription ?? "Aguardando tratamento",
    },
  ];
  const severityCards = VISUAL_SEVERITY_STRIP.map((severity) => ({
    filter: severity as SummaryFilter,
    title: severityCatalog[severity].label,
    value: severityCountFor(severity),
    description: temporalDescription ?? `Severidade ${severityCatalog[severity].label}`,
  }));
  const notClassifiedCard = {
    filter: "not_classified" as const,
    title: severityCatalog.not_classified.label,
    value: severityCountFor("not_classified"),
    description: temporalDescription ?? "Fora da faixa visual das cinco severidades",
  };

  const customerCards = useMemo(() => {
    const allCount = metrics?.active_total ?? health?.counts.active_alerts ?? null;
    const datasourceNames = new Set(
      (facets?.datasources ?? [])
        .map((row) => String(row.name || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const datasourceCards = (facets?.datasources ?? []).map((row) => ({
      key: String(row.name || "").trim(),
      name: String(row.name || "").trim(),
      alerts_count: row.alerts_count,
      enrichment_status: "enriched" as const,
    }));
    const customers = (facets?.customers ?? [])
      .filter((customer) => !datasourceNames.has(String(customer.key || "").trim().toLowerCase()))
      .map((customer) => ({
        ...customer,
        name: facetCustomerDisplayName(customer),
      }));
    return [
      {
        key: "all",
        name: "Todos",
        alerts_count: allCount,
        enrichment_status: "enriched" as const,
      },
      ...datasourceCards,
      ...customers,
    ];
  }, [facets?.customers, facets?.datasources, health?.counts.active_alerts, metrics?.active_total]);
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
    sourceAckFilter !== "all" ? { label: `ACK origem: ${sourceAckFilter === "acknowledged" ? "Com ACK" : "Sem ACK"}`, remove: () => setSourceAckFilter("all") } : null,
    hasTemporalFilter ? {
      label: `${ALERTS_DATE_FIELD_OPTIONS.find((item) => item.id === dateField)?.label ?? "Período"} ${temporalLabels[datePreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`,
      remove: () => { setDatePreset("all"); setDateRange(undefined); },
    } : null,
    debouncedSearch ? {
      label: `${ALERTS_SEARCH_FIELD_OPTIONS.find((item) => item.id === searchField)?.label ?? "Busca"}: ${debouncedSearch}`,
      remove: () => setSearchQuery(""),
    } : null,
  ].filter((chip): chip is { label: string; remove: () => void } => Boolean(chip));

  const firstVisible = pagination.total_items === 0 ? 0 : (pagination.page - 1) * pagination.page_size + 1;
  const lastVisible = pagination.total_items === 0 ? 0 : Math.min(firstVisible + alerts.length - 1, pagination.total_items);
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
  const sourceAcknowledgementComment = resolveOfficialAckComment(
    selectedSourceAck.comment,
    acknowledgementGroups.flatMap((group) => group.items),
  );
  const officialAckComment = sourceAcknowledgementComment.comment;
  const historyQuality = useMemo(
    () => historyQualityFor(v1HistoryGroups.flatMap((group) => group.items), history?.history_partial === true),
    [history?.history_partial, v1HistoryGroups],
  );
  const isRefreshing = isAlertsLoading || isSummaryLoading;
  const showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts.length === 0;
  const ackRequestsEnabled = health?.capabilities?.acknowledgement === true;
  const tableColumnCount = 10;

  const clearFilters = () => {
    setSelectedCustomerKeys([]);
    setSelectedDatasources([]);
    setSelectedSeverities([]);
    setSourceAckFilter("all");
    setAlertsView("recent");
    setStatusFilter("active");
    setSortField("first_seen_at");
    setSortOrder("desc");
    setSearchField("all");
    setSearchQuery("");
    setDateField("first_seen");
    setDatePreset("24h");
    setDateRange(undefined);
    setPage(1);
  };

  const applyAlertsView = (view: AlertsView) => {
    setAlertsView(view);
    setPage(1);
    setSourceAckFilter("all");
    setDateRange(undefined);
    if (view === "recent") {
      setStatusFilter("active");
      setSelectedSeverities([]);
      setDateField("first_seen");
      setDatePreset("24h");
      setSortField("first_seen_at");
      setSortOrder("desc");
      return;
    }
    if (view === "open") {
      setStatusFilter("active");
      setSelectedSeverities([]);
      setDateField("first_seen");
      setDatePreset("all");
      setSortField("last_seen_at");
      setSortOrder("desc");
      return;
    }
    if (view === "priority") {
      void PRIORITY_VIEW_NOTE;
      setStatusFilter("active");
      setSelectedSeverities(["disaster", "high"]);
      setSourceAckFilter("unacknowledged");
      setDateField("first_seen");
      setDatePreset("all");
      setSortField("severity");
      setSortOrder("desc");
      return;
    }
    if (view === "forgotten") {
      setStatusFilter("active");
      setSelectedSeverities([]);
      setSourceAckFilter("unacknowledged");
      setDateField("first_seen");
      setDatePreset("all");
      setSortField("first_seen_at");
      setSortOrder("asc");
      return;
    }
    if (view === "resolved") {
      setStatusFilter("resolved");
      setSelectedSeverities([]);
      setDateField("resolved");
      setDatePreset("all");
      setSortField("resolved_at");
      setSortOrder("desc");
      return;
    }
    setStatusFilter("all");
    setSelectedSeverities([]);
    setDateField("first_seen");
    setDatePreset("30d");
    setSortField("last_seen_at");
    setSortOrder("desc");
  };

  const applySummaryFilter = (filter: SummaryFilter) => {
    const severityFilters: OneViewSeverity[] = [
      "information",
      "warning",
      "average",
      "high",
      "disaster",
      "not_classified",
    ];
    if (severityFilters.includes(filter as OneViewSeverity)) {
      const severity = filter as OneViewSeverity;
      setSelectedSeverities((current) => (
        current.length === 1 && current[0] === severity ? [] : [severity]
      ));
      setPage(1);
      return;
    }
    setSelectedSeverities([]);
    setSourceAckFilter(filter === "acknowledged" ? "acknowledged" : filter === "pending" ? "unacknowledged" : "all");
    setStatusFilter(filter === "total" ? "all" : filter === "active" ? "active" : hasTemporalFilter ? statusFilter : "active");
    setAlertsView(filter === "total" ? "all" : "open");
    setSortField("last_seen_at");
    setSortOrder("desc");
    setSearchQuery("");
    setPage(1);
  };

  const summaryFilterIsActive = (filter: SummaryFilter) => {
    const severityFilters: OneViewSeverity[] = [
      "information",
      "warning",
      "average",
      "high",
      "disaster",
      "not_classified",
    ];
    if (severityFilters.includes(filter as OneViewSeverity)) {
      return selectedSeverities.length === 1 && selectedSeverities[0] === filter;
    }
    if (selectedSeverities.length > 0) return false;
    if (filter === "total") return statusFilter === "all" && sourceAckFilter === "all";
    if (filter === "active") return statusFilter === "active" && sourceAckFilter === "all";
    if (filter === "acknowledged") return statusFilter === "active" && sourceAckFilter === "acknowledged";
    if (filter === "pending") return statusFilter === "active" && sourceAckFilter === "unacknowledged";
    return false;
  };

  const toggleCustomer = (key: string) => {
    setPage(1);
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const applyDatePreset = (preset: AlertsDatePreset) => {
    setDatePreset(preset);
    if (preset !== "custom") setDateRange(undefined);
    if (dateField === "resolved" && preset !== "all") setStatusFilter("resolved");
    setPage(1);
  };

  const openAlert = (alert: OneViewAlert) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("alert", alert.id);
    setSearchParams(nextSearchParams, { replace: true });
    setSelectedAlertId(alert.id);
    setSelectedPreview(alert);
    // OV-P0-108 — não zera detail/history no open; mantém preview enquanto carrega.
    if (selectedAlertId !== alert.id) {
    setHistoryFilter("all");
    }
    setDetailError(null);
    setHistoryLoadError(null);
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
    setHistoryLoadError(null);
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

  const toggleColumnSort = (field: SortField) => {
    setSortOrder((current) => sortField === field && current === "asc" ? "desc" : "asc");
    setSortField(field);
    setPage(1);
  };

  const sortableHeader = (label: string, field: SortField) => (
    <button
      type="button"
      className="group inline-flex min-w-0 items-center justify-start gap-1 font-semibold text-foreground transition-colors hover:text-primary"
      onClick={() => toggleColumnSort(field)}
      title={`Ordenar ${label}: ${sortField === field && sortOrder === "asc" ? "Z–A" : "A–Z"}`}
    >
      <span className="truncate">{label}</span>
      <ArrowUpDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-primary", sortField === field && "text-primary")} />
      {sortField === field ? <span className="sr-only">{sortOrder === "asc" ? "ordem crescente" : "ordem decrescente"}</span> : null}
    </button>
  );

  const temporalOptionText = (subject: string, preset: ResolvedTemporalPreset, count?: number) => preset === "all"
    ? "Todos"
    : `${subject} ${temporalLabels[preset]} · ${(count ?? 0).toLocaleString("pt-BR")} alertas`;

  const clientSelector = (
    <ClientFilterCombobox
      open={customerFilterOpen}
      onOpenChange={setCustomerFilterOpen}
      options={customerCards}
      selectedKeys={selectedCustomerKeys}
      selectedLabel={selectedCustomerLabel}
      onToggle={toggleCustomer}
    />
  );

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      clientSelect={(
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight text-foreground">Alertas</h1>
          {clientSelector}
        </div>
      )}
      contentClassName="gap-3 p-3 lg:px-4"
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
            <Button type="button" variant="outline" size="sm" className="ov-error-action" onClick={() => void refreshAll()} disabled={isRefreshing}>
              <RefreshCcw className="h-4 w-4" /> Tentar novamente
            </Button>
          </div>
        </Card>
      ) : null}

      {summaryError ? <OperationalErrorBanner message={summaryError} /> : null}

      <div className="space-y-1.5">
        <CompactMetricStrip
          aria-label="Filtros rápidos por indicadores"
          items={[...operationalCards, ...severityCards].map((card) => {
            const showSkeleton = isSummaryLoading && !health && !metrics && card.value === null;
            const unknown = card.value === null && !showSkeleton;
            return {
              key: card.filter,
              label: card.title,
              value: formatCardValue(card.value),
              description: card.description,
              selected: summaryFilterIsActive(card.filter),
              unknown,
              loading: showSkeleton,
              onClick: () => applySummaryFilter(card.filter),
            };
          })}
          footer={temporalDescription ? (
            <p className="border-t border-border/50 px-2.5 py-1 text-[10px] text-muted-foreground">{temporalDescription}</p>
          ) : null}
        />
        <CompactMetricStrip
          aria-label="Severidade fora da faixa visual"
          className="border-dashed"
          items={[{
            key: notClassifiedCard.filter,
            label: notClassifiedCard.title,
            value: formatCardValue(notClassifiedCard.value),
            description: notClassifiedCard.description,
            selected: summaryFilterIsActive(notClassifiedCard.filter),
            unknown: notClassifiedCard.value === null && !(isSummaryLoading && !health && !metrics),
            loading: isSummaryLoading && !health && !metrics && notClassifiedCard.value === null,
            onClick: () => applySummaryFilter(notClassifiedCard.filter),
          }]}
        />
      </div>

      <Card className="overflow-hidden ov-panel">
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {ALERTS_VIEWS.find((item) => item.id === alertsView)?.label ?? "Alertas"} · filtrados por {tableCustomerScope}
              </h2>
              <p className="text-xs text-muted-foreground">
                {alertsView === "forgotten"
                  ? "Alertas ativos sem ACK acima do tempo esperado."
                  : "Fila por cliente para ação imediata"}
                {isAlertsLoading && hasTemporalFilter
                  ? " · Aplicando filtro de período…"
                  : ` · Exibindo ${firstVisible.toLocaleString("pt-BR")}–${lastVisible.toLocaleString("pt-BR")} de ${listTotal.toLocaleString("pt-BR")} ${statusFilter === "resolved" ? "alertas resolvidos" : "alertas"}`}
                {snapshotCoverage?.partial ? ` disponíveis na cópia · ${snapshotCoverage.total_persisted.toLocaleString("pt-BR")} persistidos` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Visualizações de alertas">
              {ALERTS_VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  role="tab"
                  aria-selected={alertsView === view.id}
                  onClick={() => applyAlertsView(view.id)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    alertsView === view.id
                      ? "border-foreground/30 bg-foreground text-background"
                      : "border-border/70 bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  {view.label}
                </button>
              ))}
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
                  className="h-7 rounded-md px-2.5 text-xs"
                  onClick={() => { chip.remove(); setPage(1); }}
                >
                  {chip.label}<X className="h-3 w-3" />
                </Button>
              ))}
              {activeFilterChips.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">Filtros server-side · alteração volta para a página 1</span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Select
                value={statusFilter}
                onValueChange={(value) => { setStatusFilter(value as StatusFilter); setPage(1); }}
              >
                <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-[120px]")} aria-label="Estado">
                  <SelectValue placeholder="Estado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativos</SelectItem>
                  <SelectItem value="resolved">Resolvidos</SelectItem>
                  <SelectItem value="all">Todos</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={sourceAckFilter}
                onValueChange={(value) => { setSourceAckFilter(value as RecognitionFilter); setPage(1); }}
              >
                <SelectTrigger className={cn(OV_FILTER_CONTROL, "w-[120px]")} aria-label="ACK da origem">
                  <SelectValue placeholder="ACK" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="acknowledged">Com ACK</SelectItem>
                  <SelectItem value="unacknowledged">Sem ACK</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex h-8 items-center gap-1 rounded-md border border-border/70 bg-white px-1">
                <Select
                  value={searchField}
                  onValueChange={(value) => { setSearchField(value as AlertsSearchField); setPage(1); }}
                >
                  <SelectTrigger className="h-7 w-[100px] border-0 bg-transparent px-2 text-xs shadow-none" aria-label="Campo de busca">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALERTS_SEARCH_FIELD_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={searchQuery}
                  onChange={(event) => { setSearchQuery(event.target.value); setPage(1); }}
                  placeholder="Buscar…"
                  className="h-7 w-[140px] border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
                  aria-label="Busca server-side"
                />
              </div>

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-8 px-2.5 text-xs", hasTemporalFilter && "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")}
                  >
                    <CalendarRange className="h-3.5 w-3.5" />
                    Período
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[340px] space-y-3 p-3">
                  <div>
                    <p className="text-sm font-semibold">Filtrar por período</p>
                    <p className="text-[11px] text-muted-foreground">Janelas rolantes a partir de agora (não desde meia-noite).</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Atalhos de período">
                    {([
                      { id: "24h", label: "Últimas 24 horas" },
                      { id: "30d", label: "Últimos 30 dias" },
                    ] as const).map((preset) => (
                      <Button
                        key={preset.id}
                        type="button"
                        size="sm"
                        variant={datePreset === preset.id ? "default" : "outline"}
                        className="h-7 px-2.5 text-[11px]"
                        aria-pressed={datePreset === preset.id}
                        onClick={() => applyDatePreset(preset.id)}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Campo
                    <Select
                      value={dateField}
                      onValueChange={(value) => { setDateField(value as AlertsDateField); setPage(1); }}
                    >
                      <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ALERTS_DATE_FIELD_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Janela
                    <Select value={datePreset} onValueChange={(value) => applyDatePreset(value as AlertsDatePreset)}>
                      <SelectTrigger className="h-9 bg-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Sem período</SelectItem>
                        {ALERTS_DATE_PRESET_OPTIONS.map((option) => (
                          <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                        ))}
                        <SelectItem value="custom">Personalizado</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  {datePreset === "custom" ? (
                    <Calendar
                      mode="range"
                      numberOfMonths={1}
                      locale={ptBR}
                      selected={dateRange}
                      onSelect={(range) => { setDateRange(range); setPage(1); }}
                    />
                  ) : null}
                  {hasTemporalFilter ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-full text-xs"
                      onClick={() => { setDatePreset("all"); setDateRange(undefined); setPage(1); }}
                    >
                      Limpar período
                    </Button>
                  ) : null}
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="h-8 px-2.5 text-xs">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    Mais filtros
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[280px] space-y-3 p-3">
                  <div>
                    <p className="text-sm font-semibold">Mais filtros</p>
                    <p className="text-[11px] text-muted-foreground">Ordenação e paginação da consulta.</p>
                  </div>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Ordenação
                    <Select
                      value={sortOptionKey(
                        (sortField === "acknowledged_at" || sortField === "duration" || sortField === "first_seen_at" || sortField === "last_seen_at" || sortField === "resolved_at" || sortField === "severity"
                          ? sortField
                          : "first_seen_at") as AlertsSortKey,
                        sortOrder,
                      )}
                      onValueChange={(value) => {
                        const [sort, order] = value.split(":") as [AlertsSortKey, SortOrder];
                        setSortField(sort);
                        setSortOrder(order);
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-9 bg-white text-xs" aria-label="Ordenação">
                        <SelectValue placeholder="Ordenação" />
                      </SelectTrigger>
                      <SelectContent>
                        {ALERTS_SORT_OPTIONS.map((option) => (
                          <SelectItem key={`${option.id}:${option.order}`} value={`${option.id}:${option.order}`}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Itens por página
                    <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                      <SelectTrigger className="h-9 bg-white" aria-label="Itens por página"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </PopoverContent>
              </Popover>

              {activeFilterChips.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" className={OV_CTA} onClick={clearFilters}>Limpar</Button>
              ) : null}
            </div>
          </div>
        </div>

        {alertsError ? <OperationalErrorBanner className="rounded-none border-x-0 border-t-0" message={alertsError} /> : null}

        <div className="relative min-h-[280px] max-h-[calc(100vh-16rem)] overflow-auto" aria-busy={isAlertsLoading}>
          {isAlertsLoading && hasLoadedAlerts ? (
            <div className="sticky top-0 z-20 flex items-center justify-center gap-2 border-b border-border/50 bg-background/90 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur">
              <Loader2 className="h-3 w-3 animate-spin" />
              Atualizando...
            </div>
          ) : null}
          {isAlertsLoading && alerts.length > 0 ? <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-1/3 animate-pulse bg-primary" /></div> : null}
          <TooltipProvider delayDuration={250}>
          <Table className="min-w-[1240px] w-full table-fixed text-[11px]">
            <colgroup>
              <col className="w-[8%]" />
              <col className="w-[11%]" />
              <col className="w-[12%]" />
              <col className="w-[20%]" />
              <col className="w-[9%]" />
              <col className="w-[7%]" />
              <col className="w-[11%]" />
              <col className="w-[9%]" />
              <col className="w-[7%]" />
              <col className="w-[6%]" />
            </colgroup>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="border-border/70 bg-muted/80 text-[10px] text-muted-foreground hover:bg-muted/80">
                <TableHead className="px-3 text-left">
                  <div className="flex items-center justify-start gap-1">
                    {sortableHeader("Severidade", "severity")}
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
                <TableHead className="px-3 text-left">Cliente</TableHead>
                <TableHead className="px-3 text-left">
                  <div className="flex items-center justify-start gap-1">
                    {sortableHeader("Host", "host")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", searchField === "host" && debouncedSearch && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Pesquisar host">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-72 p-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          Pesquisar somente em host
                          <Input
                            autoFocus
                            value={searchField === "host" ? searchQuery : ""}
                            onChange={(event) => {
                              setSearchField("host");
                              setSearchQuery(event.target.value);
                              setPage(1);
                            }}
                            placeholder="Nome visível ou técnico"
                            className="mt-1 h-8"
                          />
                        </label>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-left">
                  <div className="flex items-center justify-start gap-1">
                    {sortableHeader("Problema", "problem")}
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" className={cn("h-7 w-7 shrink-0", searchField === "problem" && debouncedSearch && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} aria-label="Pesquisar problema">
                          <Search className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 p-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          Pesquisar somente em problema
                          <Input
                            autoFocus
                            value={searchField === "problem" ? searchQuery : ""}
                            onChange={(event) => {
                              setSearchField("problem");
                              setSearchQuery(event.target.value);
                              setPage(1);
                            }}
                            placeholder="Descrição do problema"
                            className="mt-1 h-8"
                          />
                        </label>
                      </PopoverContent>
                    </Popover>
                  </div>
                </TableHead>
                <TableHead className="px-3 text-left">{sortableHeader("Início", "first_seen_at")}</TableHead>
                <TableHead className="px-3 text-right">{sortableHeader("Duração", "duration")}</TableHead>
                <TableHead className="px-3 text-left">{sortableHeader("ACK", "acknowledged_source")}</TableHead>
                <TableHead className="px-3 text-left">Chamado</TableHead>
                <TableHead className="px-3 text-left">{sortableHeader("Estado", "status")}</TableHead>
                <TableHead className="px-3 text-center">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {showAlertsSkeleton ? Array.from({ length: 8 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: tableColumnCount }).map((__, cell) => <TableCell key={cell} className="py-4"><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              )) : alerts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={tableColumnCount} className="p-0">
                    <OperationalEmptyState
                      compact
                      icon={<CircleAlert className="h-7 w-7" />}
                      title={hasLoadedAlerts ? "Nenhum alerta corresponde aos filtros selecionados." : "Carregando fila operacional..."}
                    />
                  </TableCell>
                </TableRow>
              ) : alerts.map((alert) => {
                const severityKey = normalizeOneViewSeverity(alert.severity);
                const isResolved = isResolvedAlert(alert);
                const isActive = !isResolved;
                const hostLabel = canonicalHostName(alert);
                const technicalHost = displayHostField(alert.host_technical_name, "");
                const clientLabel = operationalClientLabel({
                  key: alert.customer_key,
                  name: alert.customer_name,
                  source: alert.customer_source,
                  operational_scope: alert.operational_scope,
                  operational_scope_label: alert.operational_scope_label,
                });
                const problemLabel = safeDisplayText(alert.problem_name, "Alerta sem descrição", 220);
                const durationLabel = Number.isFinite(Number(alert.duration_seconds)) && Number(alert.duration_seconds) >= 0
                  ? formatDurationSeconds(Number(alert.duration_seconds))
                  : "—";
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
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <SeverityBadge severity={severityKey} />
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex max-w-full justify-center">
                            <ClientIdentity
                              customer={{
                                key: alert.customer_key,
                                name: alert.customer_name,
                                source: alert.customer_source,
                              }}
                              operationalScope={alert.operational_scope}
                              operationalScopeLabel={alert.operational_scope_label}
                              showName
                              nameClassName="max-w-[9rem] truncate text-left text-xs font-semibold"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs break-words">{clientLabel}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{hostLabel}</p>
                            {technicalHost && technicalHost !== hostLabel ? (
                              <p className="truncate font-mono text-[9px] text-muted-foreground">{technicalHost}</p>
                            ) : null}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs break-words">
                          {technicalHost && technicalHost !== hostLabel ? `${hostLabel} · ${technicalHost}` : hostLabel}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="line-clamp-2 font-medium leading-4">{problemLabel}</p>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-sm break-words">
                          {safeDisplayText(alert.problem_name, "Alerta sem descrição")}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left font-mono text-muted-foreground">
                      {alert.first_seen_at ? formatDateTime(alert.first_seen_at) : "—"}
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{durationLabel}</TableCell>
                    <TableCell className="overflow-hidden align-middle px-3 py-2.5 text-left">
                      {(() => {
                        const ack = sourceAckPresentation(alert);
                        if (ack.status !== "acknowledged") {
                          return <span className="text-[11px] font-medium text-amber-800">Pendente</span>;
                        }
                        const ackLabel = ack.actorLabel ? `Reconhecido por ${ack.actorLabel}` : "Reconhecido";
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="min-w-0">
                                <p className="truncate text-[11px] font-medium leading-4 text-foreground">{ackLabel}</p>
                                {ack.at ? <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{formatDateTime(ack.at)}</p> : null}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs break-words">
                              {ackLabel}{ack.at ? ` · ${formatDateTime(ack.at)}` : ""}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <AlertServiceNowReferenceCell reference={alert.servicenow_reference} />
                    </TableCell>
                    <TableCell className="align-middle px-3 py-2.5 text-left">
                      <p className={cn("font-medium", isActive ? "text-red-700" : "text-emerald-700")}>{isActive ? "Ativo" : "Resolvido"}</p>
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
          </TooltipProvider>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Página {pagination.total_pages === 0 ? 0 : pagination.page} de {pagination.total_pages}
            {" · "}
            {pagination.total_items.toLocaleString("pt-BR")} resultado{pagination.total_items === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!pagination.has_previous || isAlertsLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="h-4 w-4" />Anterior</Button>
            <Button type="button" variant="outline" size="sm" disabled={!pagination.has_next || isAlertsLoading} onClick={() => setPage((current) => current + 1)}>Próxima<ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </Card>

      <AlertDetailDrawer
        open={selectedAlertId !== null}
        onOpenChange={(next) => { if (!next) closeAlert(); }}
        alert={selectedAlert}
        historyItems={history?.items ?? []}
        isLoading={isDetailLoading}
        error={detailError || historyLoadError}
        description="Informações operacionais seguras e histórico do OneView."
      />

    </AppLayout>
  );
}
