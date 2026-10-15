import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DateRange } from "react-day-picker";
import { endOfDay, format, formatDistanceToNow, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { ConfigurableTableToolbar, OneViewColumnFilterPopover, OneViewFilterableHeader, OneViewSortableHeader } from "@/components/oneview/ConfigurableTableTools";
import { OneViewTableSearchField, useOneViewCommittedSearch } from "@/components/oneview/OneViewTableSearchField";
import { OperationalFacetChecklist, OperationalFacetMultiSelect } from "@/components/oneview/OperationalFacetMultiSelect";
import { OperationalFilterSection } from "@/components/oneview/OperationalFilterPanel";
import {
  OneViewButton,
  OneViewPill,
  OneViewSemanticStatusBadge,
  OneViewSeverityBadge,
  OneViewTextAction,
} from "@/components/oneview/OneViewDesignSystem";
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
import { OperatorDisasterPopup, type OperatorSeverityPopupItem } from "@/components/oneview/OperatorDisasterPopup";
import { AlertSourceAckRowAction } from "@/components/oneview/AlertSourceAckAction";
import { AlertSuppressAction } from "@/components/oneview/AlertSuppressAction";
import { ConfigurableMetricStrip } from "@/components/oneview/ConfigurableMetricStrip";
import { IncidentTableActionsCell } from "@/components/oneview/IncidentTableActionsCell";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { PageHeader } from "@/components/oneview/PageHeader";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/context/AuthContext";
import { useAlertDrawerLiveRefresh } from "@/hooks/useAlertDrawerLiveRefresh";
import { useOneViewWarmRead } from "@/hooks/useOneViewWarmRead";
import { shouldInvalidateAlertList } from "@/lib/oneview-alert-live-refresh";
import { createLatestRequestGate } from "@/lib/oneview-latest-request";
import { formatSnapshotCopyClock } from "@/lib/oneview-snapshot-actions";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewMetricStrip } from "@/lib/oneview-metric-strip-preferences";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { operationalColumnPreferredWidth, useOperationalTableLayout } from "@/lib/oneview-operational-table-layout";
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
  fetchAlertSearchSuggestions,
  fetchAlerts,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchOperationsHealth,
  formatDurationSeconds,
  problemEpisodeDurationSeconds,
  problemIsResolved,
  formatNullableCount,
  formatOneViewSeverityLabel,
  isOneViewAbortError,
  isOneViewSeverity,
  invalidateOneViewReadCache,
  bucketOneViewReadNow,
  oneViewAlertsPath,
  normalizeAlertSeveritySummary,
  normalizeOneViewSeverity,
  requestAlertAcknowledgement,
  type AcknowledgeAlertResponse,
} from "@/lib/oneview-api";
import { buildAlertArtifactFromOneViewAlert } from "@/lib/oneview-alert-artifact";
import { getOneViewFacets } from "@/lib/oneview-facets-store";
import {
  sourceAckRowKind,
  sourceAckRowLabel,
  type SourceAckTerminalStatus,
} from "@/lib/oneview-alert-source-ack";
import {
  activeFreshAttentionIds,
  freshAttentionTone,
  reconcileFreshAttention,
  sameStringSet,
} from "@/lib/oneview-fresh-attention";
import {
  ONEVIEW_NOTIFICATION_PREFERENCES_EVENT,
  readOneViewNotificationPreferences,
  setOneViewSeverityPopupEnabled,
} from "@/lib/oneview-notification-preferences";
import {
  normalizeSeverityPopupLevel,
  readSeverityPopupSeen,
  severityPopupMatches,
  writeSeverityPopupSeen,
} from "@/lib/oneview-severity-popup";
import {
  detectLiveTransitions,
  isLiveTransitionActive,
  mergeLiveTransitionQueue,
  prunePinnedByTransitions,
  reconcileLiveTransitions,
  sameLiveTransitionMap,
  sourceConfirmedAlertSnapshot,
  toLiveSnapshotMap,
  type LiveTransition,
} from "@/lib/oneview-live-transition";
import { recoveryEvidenceCaption, suppressionCaption } from "@/lib/oneview-suppression-copy";
import { ONEVIEW_SEVERITY_UI } from "@/lib/oneview-severity-visual";
import {
  ALERTS_DATE_PRESET_OPTIONS,
  ALERTS_SEARCH_FIELD_OPTIONS,
  ALERTS_SORT_OPTIONS,
  alertsDateActive,
  alertsDateBounds,
  applyDateFieldToFetchParams,
  applySearchToFetchParams,
  firstAlertsFetchParams,
  FIRST_ALERTS_PAGE_SIZE,
  parseAlertsDateUrlValue,
  writeAlertsUrlParams,
  type AlertsAckFilter,
  type AlertsOneViewAckFilter,
  type AlertsDatePreset,
  type AlertsSearchField,
  type AlertsSortKey,
} from "@/lib/alerts-query";
import {
  augmentCustomerFacetsWithDedicatedDatasources,
  customerFilterCountNoun,
  isDatasourceOnlyFilterValue,
  splitLegacyCustomerQuery,
} from "@/lib/oneview-zabbix-source";
import {
  Activity,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  History,
  Loader2,
  RefreshCcw,
  ServerCog,
  Siren,
  UserCheck,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

type RecognitionFilter = AlertsAckFilter;
type OneViewAckFilter = AlertsOneViewAckFilter;
type StatusFilter = "active" | "resolved" | "all";
type AlertsView = "pending" | "acknowledged" | "suppressed" | "history" | "unconfirmed";
type SortField = AlertsSortKey | "client" | "datasource" | "host" | "problem" | "status" | "acknowledged_source" | "last_seen_at";
type SortOrder = "asc" | "desc";
type TemporalPreset = AlertsDatePreset;

const ALERT_TABLE_COLUMNS = [
  { id: "severity", label: "Severidade", minWidth: 104, preferredWidth: 118, responsivePriority: "essential" },
  { id: "client", label: "Cliente", minWidth: 112, preferredWidth: 140, responsivePriority: "essential" },
  { id: "host", label: "Host", minWidth: 138, preferredWidth: 172, responsivePriority: "intermediate" },
  { id: "problem", label: "Problema", required: true, minWidth: 270, preferredWidth: 390, responsivePriority: "essential" },
  { id: "started", label: "Início", minWidth: 126, preferredWidth: 146, responsivePriority: "secondary" },
  { id: "duration", label: "Duração", minWidth: 100, preferredWidth: 112, responsivePriority: "intermediate" },
  { id: "ack", label: "ACK", minWidth: 118, preferredWidth: 144, responsivePriority: "essential" },
  { id: "incident", label: "Chamado", minWidth: 112, preferredWidth: 132, responsivePriority: "intermediate" },
  { id: "status", label: "Estado", minWidth: 102, preferredWidth: 118, responsivePriority: "essential" },
  { id: "actions", label: "Ações", required: true, minWidth: 96, preferredWidth: 108, responsivePriority: "essential" },
] as const;

const ALERT_QUICK_INCIDENT_ACTIONS = ["claim"] as const;

type AlertTableColumnId = typeof ALERT_TABLE_COLUMNS[number]["id"];

const ALERT_COLUMN_SORT: Partial<Record<AlertTableColumnId, SortField>> = {
  client: "client",
  severity: "severity",
  host: "host",
  problem: "problem",
  started: "first_seen_at",
  duration: "duration",
  ack: "acknowledged_source",
  status: "status",
};
const ALERT_TABLE_SORT_OPTIONS = [
  { value: "first_seen_at:desc", label: "Início: mais novos" },
  { value: "first_seen_at:asc", label: "Início: mais antigos" },
  { value: "last_seen_at:desc", label: "Atualização: mais novos" },
  { value: "last_seen_at:asc", label: "Atualização: mais antigos" },
  { value: "client:asc", label: "Cliente: A–Z" },
  { value: "client:desc", label: "Cliente: Z–A" },
  { value: "host:asc", label: "Host: A–Z" },
  { value: "host:desc", label: "Host: Z–A" },
  { value: "problem:asc", label: "Problema: A–Z" },
  { value: "problem:desc", label: "Problema: Z–A" },
  { value: "severity:desc", label: "Maior severidade" },
  { value: "severity:asc", label: "Menor severidade" },
  { value: "duration:desc", label: "Maior duração" },
  { value: "duration:asc", label: "Menor duração" },
  { value: "acknowledged_source:desc", label: "ACK: reconhecidos primeiro" },
  { value: "acknowledged_source:asc", label: "ACK: pendentes primeiro" },
  { value: "status:desc", label: "Estado: resolvidos primeiro" },
  { value: "status:asc", label: "Estado: ativos primeiro" },
] as const;
type ResolvedTemporalPreset = AlertsDatePreset;
type HistoryFilter = "all" | "acknowledgements" | "changes" | "recovery" | "legacy";

const OPERATIONAL_QUEUES = ["pending", "acknowledged", "suppressed", "unconfirmed", "history"] as const;
type OperationalQueue = (typeof OPERATIONAL_QUEUES)[number];

const ALERTS_VIEWS: Array<{ id: OperationalQueue; label: string; description: string }> = [
  { id: "pending", label: "Pendentes", description: "Ativos na origem e sem ACK. Alta e Disaster reconhecidos ficam em Acompanhamento." },
  { id: "acknowledged", label: "Acompanhamento", description: "Ativos na origem e já reconhecidos, inclusive High e Disaster." },
  { id: "suppressed", label: "Suprimidos", description: "Problema ativo com supressão válida na origem. ACK e recovery não são supressão." },
  { id: "unconfirmed", label: "Em revisão", description: "Supressão não confirmada, problemas órfãos ou inconclusivos. Não são resolvidos nem ocultados." },
  { id: "history", label: "Histórico", description: "Resolvido com recovery comprovado ou registro legado, distinguido pela evidência." },
];

function isOperationalQueue(view: string): view is OperationalQueue {
  return (OPERATIONAL_QUEUES as readonly string[]).includes(view);
}

const ALERT_STATUS_OPTIONS = [
  { value: "active", label: "Ativo" },
  { value: "resolved", label: "Resolvido" },
] as const;
const INCIDENT_STATE_OPTIONS = [
  { value: "1", label: "Novo" },
  { value: "2", label: "Em andamento" },
  { value: "3", label: "Em espera" },
  { value: "6", label: "Resolvido" },
  { value: "7", label: "Encerrado" },
  { value: "8", label: "Cancelado" },
] as const;
const ACK_SOURCE_OPTIONS = [
  { value: "acknowledged", label: "Reconhecido" },
  { value: "unacknowledged", label: "Pendente" },
] as const;
const ONEVIEW_ACK_OPTIONS = [
  { value: "pending", label: "Pendente" },
  { value: "success", label: "Reconhecido" },
  { value: "cancelled", label: "Cancelado" },
  { value: "failed", label: "Falhou" },
] as const;

function inferAlertsView(query: URLSearchParams): AlertsView {
  const explicit = query.get("view");
  if (explicit && isOperationalQueue(explicit)) return explicit;
  if (explicit === "resolved" || query.get("status") === "resolved") return "history";
  if (explicit === "recent" || explicit === "recentes") return "pending";
  return "pending";
}
type MetaState = { source?: OneViewDataSourceKind; checkedAt?: string; fallbackCode?: string | null; copyGeneratedAt?: string };
type SummaryFilter =
  | "acknowledged"
  | "pending"
  | "suppressed"
  | "unconfirmed"
  | "information"
  | "warning"
  | "average"
  | "high"
  | "disaster"
  | "not_classified";

/** Cinco severidades operacionais; "Não classificados" integra a mesma faixa de KPIs. */
const VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];

const ALERTS_METRIC_OPTIONS = [
  { id: "pending", label: "Pendentes de ação", defaultSpan: 2 },
  { id: "acknowledged", label: "Em acompanhamento", defaultSpan: 2 },
  { id: "suppressed", label: "Suprimidos", defaultSpan: 2 },
  { id: "unconfirmed", label: "Sem confirmação", defaultSpan: 2 },
  { id: "information", label: "Informação", defaultSpan: 1 },
  { id: "warning", label: "Warning", defaultSpan: 1 },
  { id: "average", label: "Average", defaultSpan: 1 },
  { id: "high", label: "High", defaultSpan: 1 },
  { id: "disaster", label: "Disaster", defaultSpan: 1 },
  { id: "not_classified", label: "Não classificados", defaultSpan: 1 },
] as const;

/** OV-P0-255 — polling operacional 10s. */
const SUMMARY_REFRESH_MS = 10_000;
const ALERTS_REFRESH_MS = 10_000;
const EMPTY_HISTORY_ITEMS: AlertHistoryItem[] = [];
const STABLE_SUMMARY_REFRESH_MS = 30_000;
/** Um destaque verde de 1,5s após mudança confirmada pelo backend. */
const ALERTS_SUCCESS_PULSE_DURATION_MS = 1_500;
const ALERTS_MISSING_PROOF_LIMIT = 3;
/** Quinze ciclos vermelhos de 1.2s para alertas novos. */
const ALERTS_FRESH_ATTENTION_DURATION_MS = 18_000;

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
  const candidateItems = Array.isArray(runtimeResponse.items)
    ? runtimeResponse.items
    : Array.isArray(runtimeResponse.alerts) ? runtimeResponse.alerts : [];
  // Um item inválido de uma resposta antiga/parcial não pode desmontar a página
  // ao trocar filtros. A falha de consulta continua exibida pelo banner normal.
  const items = candidateItems.filter((item): item is OneViewAlert => Boolean(item && typeof item === "object"));
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
      // O total/página calculados no mesmo payload são a fonte de verdade. Alguns
      // proxies antigos retornam has_next=false mesmo havendo páginas seguintes.
      has_next: page < totalPages || Boolean(rawPagination?.has_next),
      has_previous: page > 1 || Boolean(rawPagination?.has_previous),
    } satisfies AlertPagination,
  };
}

const severityCatalog = ONEVIEW_SEVERITY_UI;

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
  status_source?: string | null;
  status_internal?: string | null;
  resolved_at?: string | null;
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
  if (sourceAck?.acknowledged) {
    return {
      status: "acknowledged" as const,
      actorLabel: historyActorLabel(sourceAck.actor_name, { allowWorkerLabel: false }),
      at: sourceAck.acknowledged_at || null,
      comment: typeof sourceAck.comment === "string" ? sourceAck.comment : null,
      historyAvailable: sourceAck.history_available === true,
    };
  }
  if (alert?.acknowledged_source) {
    const actorLabel = historyActorLabel(alert.acknowledged_source_by || alert.acknowledged_by, { allowWorkerLabel: false });
    return {
      status: "acknowledged" as const,
      actorLabel,
      at: alert.acknowledged_source_at || alert.acknowledged_at || null,
      comment: null as string | null,
      historyAvailable: false,
    };
  }
  const row = sourceAckRowKind(alert);
  return {
    status: row,
    actorLabel: null as string | null,
    at: null as string | null,
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

function metaOf(response: { data_source?: OneViewDataSourceKind; checked_at?: string; fallback_code?: string | null; generated_at?: string }): MetaState {
  return {
    source: response.data_source,
    checkedAt: response.checked_at,
    fallbackCode: response.fallback_code,
    copyGeneratedAt: response.data_source === "snapshot" ? response.generated_at : undefined,
  };
}

function acknowledged(alert: OneViewAlert) {
  return Boolean(alert.acknowledged_internal || alert.acknowledged_source || alert.source_ack?.acknowledged);
}

function sourceAcknowledged(alert: OneViewAlert | null | undefined) {
  return Boolean(alert?.acknowledged_source);
}

function internallyRecognized(alert: OneViewAlert | null | undefined) {
  return Boolean(alert?.acknowledged_internal);
}

function isResolvedAlert(alert: OneViewAlert | null | undefined) {
  return problemIsResolved(alert);
}

function liveDurationSeconds(alert: OneViewAlert, now: number) {
  // ACK mede tempo de resposta; não encerra a indisponibilidade.
  return problemEpisodeDurationSeconds(alert, now);
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
  "90d": 90 * 24 * 60 * 60_000,
  "365d": 365 * 24 * 60 * 60_000,
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
  "90d": "nos últimos 90 dias",
  "365d": "nos últimos 365 dias",
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
  const allowed = ["all", "15m", "30m", "1h", "2h", "6h", "24h", "7d", "30d", "90d", "365d", "custom"];
  return allowed.includes(value ?? "") ? value as ResolvedTemporalPreset : "all";
}

function searchFieldFromUrl(value: string | null): AlertsSearchField {
  return queryEnum(value, ["all", "host", "problem", "customer", "eventid"] as const, "all");
}

function queryEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function repeatedQueryValues(params: URLSearchParams, key: string) {
  return [...new Set(params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
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
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({
    page: "alerts",
    actorId,
  });
  const alertsMetrics = useOneViewMetricStrip({ stripId: "alerts-summary", actorId, definitions: ALERTS_METRIC_OPTIONS });
  const alertTableColumns = useOneViewTableColumns({
    tableId: "alerts",
    actorId,
    definitions: ALERT_TABLE_COLUMNS,
  });
  const alertTableLayout = useOperationalTableLayout({ columns: alertTableColumns.visibleColumns });
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQueryRef = useRef(new URLSearchParams(searchParams));
  const initialQuery = initialQueryRef.current;
  const requestedAlertId = searchParams.get("alert");
  const warmedAlerts = useOneViewWarmRead<AlertListResponse>({
    cachePath: oneViewAlertsPath(firstAlertsFetchParams(bucketOneViewReadNow())),
  });
  const [alerts, setAlerts] = useState<OneViewAlert[]>(() => warmedAlerts.data?.items ?? []);
  const [metrics, setMetrics] = useState<AlertMetrics | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [pagination, setPagination] = useState<AlertPagination>(emptyPagination);
  const [filteredSummary, setFilteredSummary] = useState<AlertListResponse["filtered_summary"]>(undefined);
  const [queueCounts, setQueueCounts] = useState<NonNullable<AlertListResponse["operational_queues"]> | null>(null);
  const [originSync, setOriginSync] = useState<NonNullable<AlertListResponse["origin_sync"]>>([]);
  const [temporalCounts, setTemporalCounts] = useState<AlertListResponse["temporal_counts"]>(undefined);
  const [snapshotCoverage, setSnapshotCoverage] = useState<{ partial: boolean; total_persisted: number; available_items: number } | null>(null);

  const [page, setPage] = useState(() => positiveQueryInteger(initialQuery.get("page"), 1, Number.MAX_SAFE_INTEGER));
  const [pageSize, setPageSize] = useState(() => Number(queryEnum(initialQuery.get("page_size"), ["50", "100"] as const, "50")));
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>(() => splitLegacyCustomerQuery(initialQuery.getAll("customer")).customers);
  const initialView = inferAlertsView(initialQuery);
  const [sourceAckFilter, setSourceAckFilter] = useState<RecognitionFilter>(() => {
    const ackSource = initialQuery.get("acknowledged_source");
    if (ackSource === "true") return "acknowledged";
    if (ackSource === "false") return "unacknowledged";
    if (initialQuery.get("source_ack")) {
      return queryEnum(initialQuery.get("source_ack"), ["all", "acknowledged", "unacknowledged"] as const, "all");
    }
    return "all";
  });
  const [oneviewAckStatuses, setOneviewAckStatuses] = useState<Array<Exclude<OneViewAckFilter, "all">>>(() => (
    repeatedQueryValues(initialQuery, "oneview_ack_status")
      .filter((value): value is Exclude<OneViewAckFilter, "all"> => ["pending", "success", "cancelled", "failed"].includes(value))
  ));
  const oneviewAckFilter: OneViewAckFilter = oneviewAckStatuses.length === 1 ? oneviewAckStatuses[0] : "all";
  const [ackActorFilter, setAckActorFilter] = useState(() => initialQuery.get("ack_actor")?.trim().slice(0, 160) || "");
  const [ackActorDraft, setAckActorDraft] = useState(() => initialQuery.get("ack_actor")?.trim().slice(0, 160) || "");
  const [alertsView, setAlertsView] = useState<AlertsView>(() => initialView);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    if (initialQuery.get("status")) return queryEnum(initialQuery.get("status"), ["active", "resolved", "all"] as const, "active");
    return "all";
  });
  const [incidentStates, setIncidentStates] = useState<string[]>(() => (
    repeatedQueryValues(initialQuery, "incident_state").filter((value) => INCIDENT_STATE_OPTIONS.some((option) => option.value === value))
  ));
  const incidentStateFilter: "all" | "8" = incidentStates.length === 1 && incidentStates[0] === "8" ? "8" : "all";
  const [incidentNumber, setIncidentNumber] = useState(() => initialQuery.get("incident_number")?.trim().toUpperCase().slice(0, 40) || "");
  const [incidentNumberDraft, setIncidentNumberDraft] = useState(() => initialQuery.get("incident_number")?.trim().toUpperCase().slice(0, 40) || "");
  const [hostColumnSearch, setHostColumnSearch] = useState(() => initialQuery.get("host_search")?.trim().slice(0, 200) || "");
  const [hostColumnDraft, setHostColumnDraft] = useState(() => initialQuery.get("host_search")?.trim().slice(0, 200) || "");
  const [problemColumnSearch, setProblemColumnSearch] = useState(() => initialQuery.get("problem_search")?.trim().slice(0, 200) || "");
  const [problemColumnDraft, setProblemColumnDraft] = useState(() => initialQuery.get("problem_search")?.trim().slice(0, 200) || "");
  const [sortField, setSortField] = useState<SortField>(() => {
    if (initialQuery.get("sort")) {
      return queryEnum(initialQuery.get("sort"), ["last_seen_at", "first_seen_at", "resolved_at", "severity", "client", "datasource", "host", "problem", "duration", "status", "acknowledged_source", "acknowledged_at"] as const, "first_seen_at");
    }
    if (initialView === "history") return "resolved_at";
    return "first_seen_at";
  });
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => {
    if (initialQuery.get("order")) return queryEnum(initialQuery.get("order"), ["asc", "desc"] as const, "desc");
    return "desc";
  });
  const [selectedSeverities, setSelectedSeverities] = useState<OneViewSeverity[]>(() => {
    // OV-P0-102: critical legado entra via expandHighFamilySeverities no fetch — sem chip Critical.
    const fromUrl = initialQuery.getAll("severity").filter(isOneViewSeverity).filter((s) => s !== "critical");
    if (fromUrl.length) return fromUrl;
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
  const [alertSearchLoading, setAlertSearchLoading] = useState(false);
  const [datePreset, setDatePreset] = useState<AlertsDatePreset>(() => {
    if (initialQuery.get("date_preset")) return temporalPresetFromUrl(initialQuery.get("date_preset"));
    if (initialQuery.get("date_from") || initialQuery.get("date_to")) return "custom";
    if (initialQuery.get("created")) return temporalPresetFromUrl(initialQuery.get("created"));
    if (initialQuery.get("updated")) return temporalPresetFromUrl(initialQuery.get("updated"));
    if (initialQuery.get("resolved")) return temporalPresetFromUrl(initialQuery.get("resolved"));
    if (initialQuery.get("ack")) return temporalPresetFromUrl(initialQuery.get("ack"));
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
  const [hasLoadedAlerts, setHasLoadedAlerts] = useState(() => Boolean(warmedAlerts.data?.items?.length));
  const [isAlertsFilling, setIsAlertsFilling] = useState(() => Boolean(warmedAlerts.data?.items?.length));
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [severityPopups, setSeverityPopups] = useState<OperatorSeverityPopupItem[]>([]);
  const [severityPopupEnabled, setSeverityPopupEnabled] = useState(() => readOneViewNotificationPreferences(actorId).severityPopup.enabled);

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
  const [freshAttentionIds, setFreshAttentionIds] = useState<Set<string>>(new Set());
  const [alertTransitions, setAlertTransitions] = useState<Map<string, LiveTransition>>(new Map());
  const [durationNow, setDurationNow] = useState(() => Date.now());

  const [alertsMeta, setAlertsMeta] = useState<MetaState>({});
  const [metricsMeta, setMetricsMeta] = useState<MetaState>({});
  const [healthMeta, setHealthMeta] = useState<MetaState>({});
  const [sourcesMeta, setSourcesMeta] = useState<MetaState>({});
  const [facetsMeta, setFacetsMeta] = useState<MetaState>({});
  const [operationsMeta, setOperationsMeta] = useState<MetaState>({});
  const [detailMeta, setDetailMeta] = useState<MetaState>({});
  const [historyMeta, setHistoryMeta] = useState<MetaState>({});

  const [alertsRequestGate] = useState(createLatestRequestGate);
  const healthRef = useRef<OneViewHealthResponse | null>(health);
  healthRef.current = health;
  const alertsRequestIdRef = useRef(0);
  const alertSearchIntent = useRef<{ id: number; value: string } | null>(null);
  const alertSearchIntentId = useRef(0);
  const detailRequestRef = useRef<AbortController | null>(null);
  const detailInFlightRef = useRef(false);
  const detailOwnerRef = useRef<object | null>(null);
  const summaryRequestRef = useRef<Promise<void> | null>(null);
  const summaryDeadlineRef = useRef(Date.now() + SUMMARY_REFRESH_MS);
  const stableSummaryDeadlineRef = useRef(Date.now());
  const alertsDeadlineRef = useRef(Date.now() + ALERTS_REFRESH_MS);
  const feedbackQueryKeyRef = useRef("");
  const freshKnownIdsRef = useRef<Set<string>>(new Set());
  const freshStartedAtRef = useRef<Map<string, number>>(new Map());
  const freshSeededRef = useRef(false);
  const severityPopupSeenRef = useRef<Set<string>>(readSeverityPopupSeen("alerts", actorId));
  const severityPopupAlertsRef = useRef(new Map<string, OneViewAlert>());
  const alertSnapshotReadyRef = useRef(false);
  const previousAlertsRef = useRef<Map<string, OneViewAlert>>(new Map());
  const alertConsumedKeysRef = useRef<Set<string>>(new Set());
  const alertTransitionsRef = useRef<Map<string, LiveTransition>>(new Map());
  const alertPinnedRef = useRef<Map<string, OneViewAlert>>(new Map());

  const commitAlertSearchValue = useCallback((value: string) => {
    if (value === debouncedSearch) return;
    alertSearchIntent.current = { id: ++alertSearchIntentId.current, value };
    setAlertSearchLoading(true);
    setDebouncedSearch(value);
  }, [debouncedSearch]);
  const { commitNow: commitAlertSearch, cancelPending: cancelAlertSearch } = useOneViewCommittedSearch(
    searchQuery,
    commitAlertSearchValue,
  );
  const feedbackQueryKey = useMemo(() => JSON.stringify({
    alertsView,
    page,
    pageSize,
    selectedCustomerKeys,
    selectedSeverities,
    statusFilter,
    incidentStates,
    incidentNumber,
    sourceAckFilter,
    oneviewAckStatuses,
    ackActorFilter,
    hostColumnSearch,
    problemColumnSearch,
    datePreset,
    dateFrom: dateRange?.from?.toISOString() ?? null,
    dateTo: dateRange?.to?.toISOString() ?? null,
    searchField,
    debouncedSearch,
    sortField,
    sortOrder,
  }), [ackActorFilter, alertsView, datePreset, dateRange?.from, dateRange?.to, debouncedSearch, hostColumnSearch, incidentNumber, incidentStates, oneviewAckStatuses, page, pageSize, problemColumnSearch, searchField, selectedCustomerKeys, selectedSeverities, sortField, sortOrder, sourceAckFilter, statusFilter]);

  useEffect(() => {
    const next = writeAlertsUrlParams({
      view: alertsView,
      customers: selectedCustomerKeys,
      severities: selectedSeverities,
      status: statusFilter,
      incidentState: incidentStateFilter,
      incidentStates,
      incidentNumber,
      acknowledgedSource: sourceAckFilter,
      oneviewAckStatus: oneviewAckFilter,
      oneviewAckStatuses,
      ackActor: ackActorFilter,
      hostSearch: hostColumnSearch,
      problemSearch: problemColumnSearch,
      dateField: "first_seen",
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
  }, [ackActorFilter, alertsView, datePreset, dateRange, hostColumnSearch, incidentNumber, incidentStateFilter, incidentStates, oneviewAckFilter, oneviewAckStatuses, page, pageSize, problemColumnSearch, requestedAlertId, searchField, searchParams, searchQuery, selectedCustomerKeys, selectedSeverities, setSearchParams, sortField, sortOrder, sourceAckFilter, statusFilter]);

  useEffect(() => {
    severityPopupSeenRef.current = readSeverityPopupSeen("alerts", actorId);
    const sync = () => {
      const enabled = readOneViewNotificationPreferences(actorId).severityPopup.enabled;
      setSeverityPopupEnabled(enabled);
      if (!enabled) setSeverityPopups([]);
    };
    sync();
    window.addEventListener(ONEVIEW_NOTIFICATION_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(ONEVIEW_NOTIFICATION_PREFERENCES_EVENT, sync);
  }, [actorId]);

  const loadAlerts = useCallback(async (options?: { quiet?: boolean; force?: boolean }) => {
    if (alertsRequestGate.shouldSkip(options)) return;
    if (feedbackQueryKeyRef.current !== feedbackQueryKey) {
      feedbackQueryKeyRef.current = feedbackQueryKey;
      freshKnownIdsRef.current = new Set();
      freshStartedAtRef.current = new Map();
      freshSeededRef.current = false;
      alertSnapshotReadyRef.current = false;
      previousAlertsRef.current = new Map();
      alertConsumedKeysRef.current = new Set();
      alertTransitionsRef.current = new Map();
      alertPinnedRef.current = new Map();
      setFreshAttentionIds(new Set());
      setAlertTransitions(new Map());
    }
    const controller = alertsRequestGate.begin();
    const requestId = ++alertsRequestIdRef.current;
    const searchIntent = alertSearchIntent.current?.value === debouncedSearch ? alertSearchIntent.current : null;
    if (!options?.quiet) {
      setIsAlertsLoading(true);
      setAlertsError(null);
    }
    try {
      const requestTime = Date.now();
      const dateBounds = alertsDateBounds(datePreset, dateRange, requestTime);

      let request: Parameters<typeof fetchAlerts>[0] = {
        page,
        pageSize,
        customers: selectedCustomerKeys,
        severities: selectedSeverities,
        status: statusFilter,
        operationalView: isOperationalQueue(alertsView) ? alertsView : undefined,
        incidentStates,
        incidentNumber: incidentNumber || undefined,
        acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
        oneviewAckStatuses,
        ackActor: ackActorFilter || undefined,
        hostSearch: hostColumnSearch || undefined,
        problemSearch: problemColumnSearch || undefined,
        sort: sortField as "last_seen_at" | "first_seen_at" | "resolved_at" | "severity" | "duration" | "acknowledged_at",
        order: sortOrder,
        signal: controller.signal,
      };

      request = applySearchToFetchParams(request, searchField, debouncedSearch);
      if (alertsDateActive(datePreset, dateRange)) {
        request = applyDateFieldToFetchParams(request, dateField, dateBounds);
      }

      const shouldPrime = !options?.quiet && page === 1;
      if (shouldPrime) {
        const primed = await fetchAlerts({
          ...request,
          page: 1,
          pageSize: FIRST_ALERTS_PAGE_SIZE,
          include: "items",
        });
        if (requestId !== alertsRequestIdRef.current) return;
        const primedNormalized = normalizeAlertResponse(primed, 1, FIRST_ALERTS_PAGE_SIZE);
        setAlerts(primedNormalized.items);
        setHasLoadedAlerts(true);
        setIsAlertsFilling(true);
        setAlertsMeta(metaOf(primed));
      }

      const response = await fetchAlerts(request);
      if (requestId !== alertsRequestIdRef.current) return;
      const normalized = normalizeAlertResponse(response, page, pageSize);
      const safeResponse = response ?? ({} as AlertListResponse);
      if (normalized.pagination.total_pages > 0 && page > normalized.pagination.total_pages) {
        setPage(normalized.pagination.total_pages);
        return;
      }

      const serverAlerts = normalized.items;
      const previousAlerts = previousAlertsRef.current;
      const nextAlertMap = new Map(serverAlerts.map((item) => [item.id, item]));
      const provenAlerts = new Map(nextAlertMap);
      const provenSnapshots = toLiveSnapshotMap(serverAlerts.map((item) => sourceConfirmedAlertSnapshot(item)));
      const missingIds = [...previousAlerts.keys()].filter((id) => !nextAlertMap.has(id));
      const shouldProveMissing = isOperationalQueue(alertsView)
        || statusFilter === "active"
        || sourceAckFilter === "unacknowledged"
        || oneviewAckStatuses.includes("pending");

      if (alertSnapshotReadyRef.current && shouldProveMissing && missingIds.length) {
        const proofs = await Promise.allSettled(
          missingIds.slice(0, ALERTS_MISSING_PROOF_LIMIT).map(async (id) => {
            const detailResponse = await fetchAlert(id, controller.signal);
            return detailResponse?.item ?? null;
          }),
        );
        if (controller.signal.aborted || requestId !== alertsRequestIdRef.current) return;
        for (const proof of proofs) {
          if (proof.status !== "fulfilled" || !proof.value?.id) continue;
          provenAlerts.set(proof.value.id, proof.value);
          const snapshot = sourceConfirmedAlertSnapshot(proof.value);
          if (snapshot) provenSnapshots.set(snapshot.id, snapshot);
        }
      }

      const detectedTransitions = detectLiveTransitions({
        previousById: toLiveSnapshotMap([...previousAlerts.values()].map((item) => sourceConfirmedAlertSnapshot(item))),
        nextById: provenSnapshots,
        previousSnapshotReady: alertSnapshotReadyRef.current,
        consumedVersionKeys: alertConsumedKeysRef.current,
        now: Date.now(),
        durationMs: ALERTS_SUCCESS_PULSE_DURATION_MS,
      }).filter((transition) => transition.kind !== "assigned");
      const reconciledTransitions = reconcileLiveTransitions({
        current: alertTransitionsRef.current,
        detected: detectedTransitions,
        consumedVersionKeys: alertConsumedKeysRef.current,
        now: Date.now(),
      });
      const nextPinnedAlerts = new Map(alertPinnedRef.current);
      for (const transition of reconciledTransitions.active.values()) {
        if (nextAlertMap.has(transition.id)) continue;
        const previous = previousAlerts.get(transition.id);
        const proven = provenAlerts.get(transition.id);
        if (!previous || !proven) continue;
        nextPinnedAlerts.set(transition.id, { ...previous, ...proven });
      }
      alertTransitionsRef.current = reconciledTransitions.active;
      alertConsumedKeysRef.current = reconciledTransitions.consumedVersionKeys;
      alertPinnedRef.current = prunePinnedByTransitions(nextPinnedAlerts, reconciledTransitions.active, Date.now());
      previousAlertsRef.current = nextAlertMap;
      alertSnapshotReadyRef.current = true;
      setAlertTransitions(new Map(reconciledTransitions.active));

      const isFirstAlertSnapshot = !freshSeededRef.current;
      const nextFresh = reconcileFreshAttention({
        alerts: serverAlerts,
        knownIds: freshKnownIdsRef.current,
        attentionStartedAt: freshStartedAtRef.current,
        isFirstSnapshot: isFirstAlertSnapshot,
      });
      freshKnownIdsRef.current = nextFresh.knownIds;
      freshStartedAtRef.current = nextFresh.attentionStartedAt;
      freshSeededRef.current = true;
      const activeFreshIds = activeFreshAttentionIds(
        nextFresh.attentionStartedAt,
        Date.now(),
        ALERTS_FRESH_ATTENTION_DURATION_MS,
      );
      setFreshAttentionIds((current) => sameStringSet(current, activeFreshIds) ? current : activeFreshIds);

      if (!isFirstAlertSnapshot && safeResponse.data_source !== "snapshot") {
        const nextPopups: OperatorSeverityPopupItem[] = [];
        for (const alert of serverAlerts) {
          if (!activeFreshIds.has(alert.id) || severityPopupSeenRef.current.has(alert.id)) continue;
          const level = normalizeSeverityPopupLevel(alert.severity);
          if (!severityPopupMatches(level, actorId) || !level) continue;
          severityPopupSeenRef.current.add(alert.id);
          severityPopupAlertsRef.current.set(alert.id, alert);
          nextPopups.push({
            key: alert.id,
            severity: level,
            customer: alert.customer_name || alert.client_name || "Cliente",
            title: alert.operator_link
              ? `Link de operadora · ${alert.operator_link.service_name || alert.problem_name}`
              : alert.problem_name,
          });
        }
        if (nextPopups.length) {
          writeSeverityPopupSeen("alerts", severityPopupSeenRef.current, actorId);
          setSeverityPopups((current) => [...nextPopups, ...current].slice(0, 4));
        }
      } else {
        for (const alert of serverAlerts) severityPopupSeenRef.current.add(alert.id);
        writeSeverityPopupSeen("alerts", severityPopupSeenRef.current, actorId);
      }

      setAlerts(normalized.items);
      setPagination(normalized.pagination);
      setFilteredSummary(safeResponse.filtered_summary);
      if (safeResponse.operational_queues) setQueueCounts(safeResponse.operational_queues);
      if (safeResponse.origin_sync) setOriginSync(safeResponse.origin_sync);
      setTemporalCounts(safeResponse.temporal_counts);
      setSnapshotCoverage(safeResponse.snapshot_coverage ?? null);
      setAlertsMeta(metaOf(safeResponse));
      setHasLoadedAlerts(true);
      setIsAlertsFilling(false);
      setAlertsError(null);
      alertsDeadlineRef.current = Date.now() + ALERTS_REFRESH_MS;
    } catch (error) {
      if (controller.signal.aborted || isOneViewAbortError(error)) return;
      setAlertsError("A sincronização não respondeu. A fila anterior foi mantida; isso não significa que não existam alertas.");
    } finally {
      alertsRequestGate.finish(controller);
      if (requestId === alertsRequestIdRef.current) setIsAlertsLoading(false);
      if (searchIntent && alertSearchIntent.current?.id === searchIntent.id) {
        alertSearchIntent.current = null;
        setAlertSearchLoading(false);
      }
    }
  }, [ackActorFilter, alertsView, dateField, datePreset, dateRange, debouncedSearch, feedbackQueryKey, hostColumnSearch, incidentNumber, incidentStates, oneviewAckStatuses, page, pageSize, problemColumnSearch, searchField, selectedCustomerKeys, selectedSeverities, sortField, sortOrder, sourceAckFilter, statusFilter]);

  const loadSummaryResources = useCallback((force = false, includeStable = true) => {
    if (summaryRequestRef.current) return summaryRequestRef.current;
    setIsSummaryLoading(true);
    setSummaryError(null);
    const request = (async () => {
      const results = await Promise.allSettled([
        fetchAlertMetrics({ refresh: force }),
        fetchOneViewHealth(),
        ...(includeStable ? [
          fetchDataSourcesWithMeta(),
          getOneViewFacets(),
          fetchOperationsHealth(),
        ] : []),
      ]);

      if (results[0].status === "fulfilled") {
        setMetrics(results[0].value);
        setMetricsMeta(metaOf(results[0].value));
      }
      if (results[1]?.status === "fulfilled") {
        setHealth(results[1].value);
        setHealthMeta(metaOf(results[1].value));
      }
      if (includeStable && results[2]?.status === "fulfilled") {
        setSourcesMeta(metaOf(results[2].value));
      }
      if (includeStable && results[3]?.status === "fulfilled") {
        setFacets(results[3].value);
        setFacetsMeta(metaOf(results[3].value));
      }
      if (includeStable && results[4]?.status === "fulfilled") {
        setOperationsMeta(metaOf(results[4].value));
      }
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        setSummaryError(rejected.reason instanceof Error ? rejected.reason.message : "Falha ao atualizar o resumo operacional.");
      }
      summaryDeadlineRef.current = Date.now() + SUMMARY_REFRESH_MS;
      if (includeStable) stableSummaryDeadlineRef.current = Date.now() + STABLE_SUMMARY_REFRESH_MS;
      setIsSummaryLoading(false);
    })();
    summaryRequestRef.current = request;
    void request.finally(() => {
      if (summaryRequestRef.current === request) summaryRequestRef.current = null;
    });
    return request;
  }, []);

  const loadSelectedAlert = useCallback(async (id: string, options?: { quiet?: boolean; signal?: AbortSignal; fresh?: boolean }) => {
    if (options?.quiet && detailInFlightRef.current) return null;
    if (!options?.quiet) detailRequestRef.current?.abort();
    const controller = options?.signal ? null : new AbortController();
    const signal = options?.signal ?? controller!.signal;
    if (controller) detailRequestRef.current = controller;
    const token = { id };
    detailOwnerRef.current = token;
    detailInFlightRef.current = true;
    if (!options?.quiet) setIsDetailLoading(true);
    try {
      const readOptions = { fresh: options?.fresh === true };
      const results = await Promise.allSettled([
        fetchAlert(id, signal, readOptions),
        fetchAlertHistory(id, signal, readOptions),
      ]);
      if (signal.aborted) return null;
      if (results[0].status === "fulfilled") {
        setDetail(results[0].value);
        setDetailMeta(metaOf(results[0].value));
        setDetailError(null);
      } else if (!options?.quiet) {
        setDetailError(results[0].reason instanceof Error ? results[0].reason.message : "Detalhe indisponível.");
      }
      if (results[1].status === "fulfilled") {
        setHistory(results[1].value);
        setHistoryMeta(metaOf(results[1].value));
        setHistoryLoadError(null);
      } else if (!options?.quiet) {
        setHistoryLoadError(results[1].reason instanceof Error ? results[1].reason.message : "Histórico indisponível.");
      }
      return results[0].status === "fulfilled" ? results[0].value.item : null;
    } finally {
      if (detailOwnerRef.current === token) {
        detailInFlightRef.current = false;
        if (!options?.quiet && !signal.aborted) setIsDetailLoading(false);
      }
    }
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
    if (!hasLoadedAlerts) return;
    void loadSummaryResources();
  }, [hasLoadedAlerts, loadSummaryResources]);

  useEffect(() => {
    void loadAlerts();
    return () => alertsRequestGate.abort();
  }, [alertsRequestGate, loadAlerts]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (document.hidden) return;
      if (now >= summaryDeadlineRef.current) {
        summaryDeadlineRef.current = now + SUMMARY_REFRESH_MS;
        void loadSummaryResources(false, now >= stableSummaryDeadlineRef.current);
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
      const refreshStable = Date.now() >= stableSummaryDeadlineRef.current;
      void loadSummaryResources(false, refreshStable);
      void loadAlerts({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadAlerts, loadSummaryResources]);

  useEffect(() => {
    if (!freshAttentionIds.size) return undefined;
    const timer = window.setInterval(() => {
      const active = activeFreshAttentionIds(
        freshStartedAtRef.current,
        Date.now(),
        ALERTS_FRESH_ATTENTION_DURATION_MS,
      );
      setFreshAttentionIds((current) => sameStringSet(current, active) ? current : active);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [freshAttentionIds.size]);

  useEffect(() => {
    if (!alertTransitions.size) return undefined;
    const timer = window.setInterval(() => {
      const tick = Date.now();
      const active = new Map(
        [...alertTransitionsRef.current].filter(([, transition]) => isLiveTransitionActive(transition, tick)),
      );
      alertTransitionsRef.current = active;
      alertPinnedRef.current = prunePinnedByTransitions(alertPinnedRef.current, active, tick);
      if (!sameLiveTransitionMap(alertTransitions, active)) setAlertTransitions(active);
    }, 250);
    return () => window.clearInterval(timer);
  }, [alertTransitions]);

  useEffect(() => () => {
    alertsRequestGate.abort();
    detailRequestRef.current?.abort();
  }, [alertsRequestGate]);

  const baseMetas = [alertsMeta, metricsMeta, healthMeta, sourcesMeta, facetsMeta, operationsMeta];
  const primaryMetas = [alertsMeta, metricsMeta];
  const hasSnapshot = primaryMetas.some((meta) => meta.source === "snapshot")
    || (selectedAlertId !== null && [detailMeta, historyMeta].some((meta) => meta.source === "snapshot"));
  const alertsAreCopy = alertsMeta.source === "snapshot";
  const detailIsCopy = selectedAlertId !== null && (detailMeta.source === "snapshot" || historyMeta.source === "snapshot");
  const liveStateUnavailable = alertsAreCopy || detailIsCopy;
  const snapshotCopyAt = [...primaryMetas, detailMeta, historyMeta].find((meta) => meta.source === "snapshot" && meta.copyGeneratedAt)?.copyGeneratedAt;
  const alertsWereCopyRef = useRef(false);
  useEffect(() => {
    const wasCopy = alertsWereCopyRef.current;
    alertsWereCopyRef.current = alertsAreCopy;
    if (wasCopy && !alertsAreCopy && selectedAlertId) void loadSelectedAlert(selectedAlertId);
  }, [alertsAreCopy, loadSelectedAlert, selectedAlertId]);
  const lastCheckedAt = latestCheckedAt(...baseMetas.map((meta) => meta.checkedAt), detailMeta.checkedAt, historyMeta.checkedAt);
  const fallbackCode = [...primaryMetas, detailMeta, historyMeta].find((meta) => meta.source === "snapshot" && meta.fallbackCode)?.fallbackCode;

  const severityCounts = Object.fromEntries((metrics?.by_severity ?? []).map((item) => [item.severity, item.count]));
  const hasTemporalFilter = alertsDateActive(datePreset, dateRange);
  const hasActiveListFilters = Boolean(
    selectedCustomerKeys.length
    || selectedSeverities.length
    || sourceAckFilter !== "all"
    || oneviewAckStatuses.length
    || Boolean(ackActorFilter)
    || incidentStates.length
    || Boolean(incidentNumber)
    || Boolean(hostColumnSearch)
    || Boolean(problemColumnSearch)
    || statusFilter !== "all"
    || debouncedSearch
    || hasTemporalFilter,
  );
  const listTotal = pagination.total_items;
  // Contadores das filas vêm do mesmo escopo BFF, sem reaproveitar "todos ativos".
  // Erro/ausência => "—"; zero válido => 0.
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
    if (alertsAreCopy || hasActiveListFilters) return null;
    if (!metrics) return null;
    return severityCounts[severity] ?? 0;
  };
  // OV-P0-17 / OV-P0-41: indicadores operacionais + severidades na mesma faixa oficial.
  const operationalCards = [
    {
      filter: "pending" as const,
      title: "Pendentes de ação",
      value: queueCounts?.pending ?? null,
      description: temporalDescription ?? "Ativos na origem, sem ACK e sem supressão vigente.",
    },
    {
      filter: "acknowledged" as const,
      title: "Em acompanhamento",
      value: queueCounts?.acknowledged ?? null,
      description: temporalDescription ?? "Reconhecidos na origem e ainda abertos.",
    },
    {
      filter: "suppressed" as const,
      title: "Suprimidos",
      value: queueCounts?.suppressed ?? null,
      description: temporalDescription ?? "Ativos com supressão confirmada na origem.",
    },
    {
      filter: "unconfirmed" as const,
      title: "Sem confirmação",
      value: queueCounts?.unconfirmed ?? null,
      description: temporalDescription ?? "Estados inconclusivos mantidos para revisão.",
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
    title: "Não classificados",
    value: severityCountFor("not_classified"),
    description: temporalDescription ?? "Sem classificação de severidade",
  };
  const summaryCards = [...operationalCards, ...severityCards, notClassifiedCard];
  const summaryTone = (filter: SummaryFilter): "neutral" | "danger" | "success" | "warning" | "info" => {
    if (filter === "high" || filter === "disaster") return "danger";
    if (filter === "acknowledged") return "success";
    if (filter === "pending" || filter === "unconfirmed" || filter === "warning" || filter === "average") return "warning";
    if (filter === "information") return "info";
    return "neutral";
  };

  const customerCards = useMemo(() => {
    const allCount = alertsAreCopy || hasTemporalFilter ? null : (metrics?.active_total ?? health?.counts.active_alerts ?? null);
    const customers = augmentCustomerFacetsWithDedicatedDatasources(
      (facets?.customers ?? [])
        .filter((customer) => !isDatasourceOnlyFilterValue(customer.key) && !isDatasourceOnlyFilterValue(customer.name))
        .map((customer) => ({
          ...customer,
          name: facetCustomerDisplayName(customer),
          alerts_count: alertsAreCopy || hasTemporalFilter ? null : customer.alerts_count,
        })),
      facets?.datasources,
    );
    return [
      {
        key: "all",
        name: "Todos",
        alerts_count: allCount,
        enrichment_status: "enriched" as const,
      },
      ...customers,
    ];
  }, [alertsAreCopy, facets?.customers, facets?.datasources, hasTemporalFilter, health?.counts.active_alerts, metrics?.active_total]);
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

  const operationalQueue = isOperationalQueue(alertsView) ? alertsView : undefined;
  const fetchAlertTableSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchAlertSearchSuggestions({
      q,
      limit: 10,
      customers: selectedCustomerKeys,
      severities: selectedSeverities,
      status: operationalQueue ? "all" : statusFilter,
      operationalView: operationalQueue,
      acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
      oneviewAckStatuses,
      signal,
    }).then((response) => response.suggestions ?? [])
  ), [oneviewAckStatuses, operationalQueue, selectedCustomerKeys, selectedSeverities, sourceAckFilter, statusFilter]);

  const localCustomerSearchSuggestions = useMemo(() => customerCards
    .filter((customer) => customer.key !== "all")
    .map((customer) => ({
      kind: "customer",
      value: customer.name,
      label: customer.name,
      customer_key: customer.key,
      hint: "Adicionar aos clientes selecionados",
    })), [customerCards]);

  const fetchAckActorSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchAlertSearchSuggestions({
      q,
      limit: 8,
      customers: selectedCustomerKeys,
      severities: selectedSeverities,
      status: operationalQueue ? "all" : statusFilter,
      operationalView: operationalQueue,
      acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
      oneviewAckStatuses,
      kind: "actor",
      signal,
    }).then((response) => (response.suggestions ?? []).filter((item) => item.kind === "actor"))
  ), [oneviewAckStatuses, operationalQueue, selectedCustomerKeys, selectedSeverities, sourceAckFilter, statusFilter]);

  const fetchHostColumnSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchAlertSearchSuggestions({
      q, kind: "host", limit: 8, customers: selectedCustomerKeys, severities: selectedSeverities,
      status: operationalQueue ? "all" : statusFilter,
      operationalView: operationalQueue, problemSearch: problemColumnSearch || undefined, incidentStates,
      incidentNumber: incidentNumber || undefined, oneviewAckStatuses,
      acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
      ackActor: ackActorFilter || undefined, signal,
    }).then((response) => response.suggestions ?? [])
  ), [ackActorFilter, incidentNumber, incidentStates, oneviewAckStatuses, operationalQueue, problemColumnSearch, selectedCustomerKeys, selectedSeverities, sourceAckFilter, statusFilter]);

  const fetchProblemColumnSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchAlertSearchSuggestions({
      q, kind: "problem", limit: 8, customers: selectedCustomerKeys, severities: selectedSeverities,
      status: operationalQueue ? "all" : statusFilter,
      operationalView: operationalQueue, hostSearch: hostColumnSearch || undefined, incidentStates,
      incidentNumber: incidentNumber || undefined, oneviewAckStatuses,
      acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
      ackActor: ackActorFilter || undefined, signal,
    }).then((response) => response.suggestions ?? [])
  ), [ackActorFilter, hostColumnSearch, incidentNumber, incidentStates, oneviewAckStatuses, operationalQueue, selectedCustomerKeys, selectedSeverities, sourceAckFilter, statusFilter]);

  const fetchIncidentNumberSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchAlertSearchSuggestions({
      q, kind: "number", limit: 8, customers: selectedCustomerKeys, severities: selectedSeverities,
      status: operationalQueue ? "all" : statusFilter,
      operationalView: operationalQueue, hostSearch: hostColumnSearch || undefined, problemSearch: problemColumnSearch || undefined,
      incidentStates, oneviewAckStatuses,
      acknowledgedSource: sourceAckFilter === "all" ? undefined : sourceAckFilter === "acknowledged",
      ackActor: ackActorFilter || undefined, signal,
    }).then((response) => response.suggestions ?? [])
  ), [ackActorFilter, hostColumnSearch, incidentStates, oneviewAckStatuses, operationalQueue, problemColumnSearch, selectedCustomerKeys, selectedSeverities, sourceAckFilter, statusFilter]);

  const applyAckActorFilter = useCallback((value: string) => {
    const next = value.trim().slice(0, 160);
    setAckActorDraft(next);
    setAckActorFilter(next);
    setPage(1);
  }, []);

  const activeFilterChips = [
    ...selectedCustomerKeys.map((customerKey) => ({
      key: `customer:${customerKey}`,
      label: customerCards.find((customer) => customer.key === customerKey)?.name ?? customerKey,
      remove: () => setSelectedCustomerKeys((current) => current.filter((item) => item !== customerKey)),
    })),
    ...selectedSeverities.map((severity) => ({ key: `severity:${severity}`, label: severityCatalog[severity].label, remove: () => setSelectedSeverities((current) => current.filter((item) => item !== severity)) })),
    statusFilter !== "all" ? { label: `Status: ${statusFilter === "resolved" ? "Resolvidos" : "Ativos"}`, remove: () => setStatusFilter("all") } : null,
    ...incidentStates.map((value) => ({ key: `incident-state:${value}`, label: `Chamado: ${INCIDENT_STATE_OPTIONS.find((option) => option.value === value)?.label ?? value}`, remove: () => setIncidentStates((current) => current.filter((item) => item !== value)) })),
    incidentNumber ? { label: `Chamado: ${incidentNumber}`, remove: () => { setIncidentNumber(""); setIncidentNumberDraft(""); } } : null,
    sourceAckFilter !== "all" ? { label: `ACK origem: ${sourceAckFilter === "acknowledged" ? "Com ACK" : "Sem ACK"}`, remove: () => setSourceAckFilter("all") } : null,
    ...oneviewAckStatuses.map((value) => ({ key: `oneview-ack:${value}`, label: `ACK OneView: ${ONEVIEW_ACK_OPTIONS.find((option) => option.value === value)?.label ?? value}`, remove: () => setOneviewAckStatuses((current) => current.filter((item) => item !== value)) })),
    ackActorFilter ? { label: `Analista ACK: ${ackActorFilter}`, remove: () => { setAckActorFilter(""); setAckActorDraft(""); } } : null,
    hostColumnSearch ? { label: `Host: ${hostColumnSearch}`, remove: () => { setHostColumnSearch(""); setHostColumnDraft(""); } } : null,
    problemColumnSearch ? { label: `Problema: ${problemColumnSearch}`, remove: () => { setProblemColumnSearch(""); setProblemColumnDraft(""); } } : null,
    hasTemporalFilter ? {
      label: `Período ${temporalLabels[datePreset]} · ${listTotal.toLocaleString("pt-BR")} alertas`,
      remove: () => { setDatePreset("all"); setDateRange(undefined); },
    } : null,
    debouncedSearch ? {
      label: `${ALERTS_SEARCH_FIELD_OPTIONS.find((item) => item.id === searchField)?.label ?? "Busca"}: ${debouncedSearch}`,
      remove: () => setSearchQuery(""),
    } : null,
  ].filter((chip): chip is { key?: string; label: string; remove: () => void } => Boolean(chip));

  const displayedAlerts = mergeLiveTransitionQueue({
    serverItems: alerts,
    pinnedById: alertPinnedRef.current,
    transitions: alertTransitions,
    passesFilter: () => true,
    filter: {
      hideAcknowledged: alertsView === "pending" || sourceAckFilter === "unacknowledged" || oneviewAckStatuses.includes("pending"),
      hideResolved: alertsView === "pending" || alertsView === "acknowledged" || (statusFilter === "active" && !isOperationalQueue(alertsView)),
      hideAssigned: false,
    },
  }).slice(0, pageSize);

  useEffect(() => {
    if (!displayedAlerts.some((alert) => !isResolvedAlert(alert))) return undefined;
    const timer = window.setInterval(() => setDurationNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [displayedAlerts]);

  const firstVisible = pagination.total_items === 0 ? 0 : (pagination.page - 1) * pagination.page_size + 1;
  const lastVisible = pagination.total_items === 0 ? 0 : Math.min(firstVisible + displayedAlerts.length - 1, pagination.total_items);
  // Detail/history of the previously opened alert stay in state until the new ones arrive.
  const selectedAlert = (detail?.item && detail.item.id === selectedAlertId ? detail.item : null) ?? selectedPreview;
  const selectedHistoryItems = history && history.alert_id === selectedAlertId ? history.items : EMPTY_HISTORY_ITEMS;
  useAlertDrawerLiveRefresh({
    alertId: selectedAlertId,
    alert: selectedAlert,
    refresh: (id, signal, fresh) => loadSelectedAlert(id, { quiet: true, signal, fresh }),
    onTransition: (transition) => {
      if (!shouldInvalidateAlertList(transition)) return;
      invalidateOneViewReadCache("/oneview/alerts");
      void loadAlerts({ quiet: true, force: true });
    },
  });
  const selectedCustomer = selectedAlert ? customerPresentation(selectedAlert) : null;
  const selectedClassificationTags = selectedAlert ? safeClassificationTags(selectedAlert) : [];
  const groupedHistory = useMemo(() => groupHistoryItems(selectedHistoryItems), [selectedHistoryItems]);
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
  const historyHasRecovery = (history?.alert_id === selectedAlertId ? history?.has_recovery : undefined) ?? selectedHistoryItems.some((item) => /recovered|recovery|resolved|normaliz/i.test(item.event_type));
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
    return selectedAlert ? sourceAckRowLabel(sourceAckRowKind(selectedAlert)) : "Sem ACK";
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
  const alertSearchActivity = searchQuery !== debouncedSearch ? "pending" : alertSearchLoading ? "searching" : "idle";
  const showAlertsSkeleton = isAlertsLoading && !hasLoadedAlerts && alerts.length === 0;
  const ackRequestsEnabled = health?.capabilities?.acknowledgement === true;
  const tableColumnCount = alertTableLayout.visibleColumns.length;

  const clearFilters = () => {
    cancelAlertSearch();
    alertSearchIntent.current = null;
    setAlertSearchLoading(false);
    setSelectedCustomerKeys([]);
    setSelectedSeverities([]);
    setSourceAckFilter("all");
    setOneviewAckStatuses([]);
    setAckActorFilter("");
    setAckActorDraft("");
    setAlertsView("pending");
    setStatusFilter("all");
    setIncidentStates([]);
    setIncidentNumber("");
    setIncidentNumberDraft("");
    setHostColumnSearch("");
    setHostColumnDraft("");
    setProblemColumnSearch("");
    setProblemColumnDraft("");
    setSortField("first_seen_at");
    setSortOrder("desc");
    setSearchField("all");
    setSearchQuery("");
    setDebouncedSearch("");
    setDatePreset("all");
    setDateRange(undefined);
    setPage(1);
  };

  const applyAlertsView = (view: AlertsView) => {
    if (!isOperationalQueue(view)) return;
    setAlertsView(view);
    setPage(1);
    if (view === "history") {
      setSortField("resolved_at");
      setSortOrder("desc");
      return;
    }
    if (view === "acknowledged" || view === "suppressed") {
      setSortField("last_seen_at");
      setSortOrder("desc");
      return;
    }
    setSortField("first_seen_at");
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
    applyAlertsView(filter);
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
    return alertsView === filter;
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

  const handleSourceAckRequestAccepted = useCallback((alert: OneViewAlert, result: AcknowledgeAlertResponse) => {
    if (result.status !== "pending" || result.acknowledged_source) return;
    const pending = (item: OneViewAlert) => item.id === alert.id ? {
      ...item,
      source_ack_status: "pending" as const,
      oneview_ack: {
        status: "pending",
        requested_at: new Date().toISOString(),
        processed_at: null,
        actor_name: result.actor_name || null,
        reason: null,
        message: null,
      },
    } : item;
    setAlerts((current) => current.map(pending));
    setSelectedPreview((current) => current ? pending(current) : current);
    setDetail((current) => current?.item.id === alert.id ? { ...current, item: pending(current.item) } : current);
  }, []);

  const handleSourceAcknowledged = useCallback(async (alert: OneViewAlert, _status: SourceAckTerminalStatus) => {
    invalidateOneViewReadCache("/oneview/alerts");
    invalidateOneViewReadCache(`/oneview/alerts/${alert.id}`);
    invalidateOneViewReadCache(`/oneview/alerts/${alert.id}/history`);
    await Promise.all([
      loadAlerts({ quiet: true, force: true }),
      selectedAlertId === alert.id ? loadSelectedAlert(alert.id) : Promise.resolve(),
    ]);
  }, [loadAlerts, loadSelectedAlert, selectedAlertId]);

  const commitHostColumnSearch = (value: string) => {
    const next = value.trim().slice(0, 200);
    setHostColumnDraft(next);
    setHostColumnSearch(next);
    setPage(1);
  };
  const commitProblemColumnSearch = (value: string) => {
    const next = value.trim().slice(0, 200);
    setProblemColumnDraft(next);
    setProblemColumnSearch(next);
    setPage(1);
  };
  const commitIncidentNumber = (value: string) => {
    const next = value.trim().toUpperCase().slice(0, 40);
    setIncidentNumberDraft(next);
    setIncidentNumber(next);
    setPage(1);
  };

  const ackColumnFilter = (
    <OneViewColumnFilterPopover label="Filtrar ACK" activeCount={(sourceAckFilter === "all" ? 0 : 1) + oneviewAckStatuses.length + Number(Boolean(ackActorFilter))} align="end">
      <div className="space-y-3">
        <div><p className="mb-1 text-xs font-semibold">ACK da origem</p><OperationalFacetChecklist options={ACK_SOURCE_OPTIONS} selectedValues={sourceAckFilter === "all" ? [] : [sourceAckFilter]} onChange={(values) => { setSourceAckFilter(values.length === 1 ? values[0] : "all"); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar estado..." /></div>
        <div><p className="mb-1 text-xs font-semibold">ACK OneView</p><OperationalFacetChecklist options={ONEVIEW_ACK_OPTIONS} selectedValues={oneviewAckStatuses} onChange={(values) => { setOneviewAckStatuses(values); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar status..." /></div>
        <div><p className="mb-1 text-xs font-semibold">Analista do ACK</p><OneViewTableSearchField value={ackActorDraft} onChange={setAckActorDraft} onSubmit={applyAckActorFilter} onSuggestionSelect={(suggestion) => suggestion.kind === "actor" && applyAckActorFilter(suggestion.value)} fetchSuggestions={fetchAckActorSuggestions} placeholder="Pesquisar analista..." ariaLabel="Filtrar analista do ACK" normalizeInc={false} className="w-full" /></div>
        {ackActorFilter ? <OneViewTextAction className="text-xs" onClick={() => applyAckActorFilter("")}>Limpar analista</OneViewTextAction> : null}
      </div>
    </OneViewColumnFilterPopover>
  );

  const alertColumnFilter = (column: AlertTableColumnId) => {
    if (column === "severity") return (
      <OneViewColumnFilterPopover label="Filtrar severidade" activeCount={selectedSeverities.length}>
        <OperationalFacetChecklist
          options={severityOrder.map((severity) => ({ value: severity, label: severityCatalog[severity].label }))}
          selectedValues={selectedSeverities}
          onChange={(values) => { setSelectedSeverities(values); setPage(1); }}
          allLabel="Todas"
          searchPlaceholder="Buscar severidade..."
        />
      </OneViewColumnFilterPopover>
    );
    if (column === "client") return (
      <OneViewColumnFilterPopover label="Filtrar clientes" activeCount={selectedCustomerKeys.length}>
        <OperationalFacetChecklist
          options={customerCards.filter((customer) => customer.key !== "all").map((customer) => ({ value: customer.key, label: customer.name, count: customer.alerts_count ?? undefined }))}
          selectedValues={selectedCustomerKeys}
          onChange={(values) => { setSelectedCustomerKeys(values); setPage(1); }}
          allLabel="Todos"
          searchPlaceholder="Buscar cliente..."
        />
      </OneViewColumnFilterPopover>
    );
    if (column === "host") return (
      <OneViewColumnFilterPopover label="Filtrar host" kind="search" activeCount={hostColumnSearch ? 1 : 0}>
        <OneViewTableSearchField
          value={hostColumnDraft}
          onChange={setHostColumnDraft}
          onSubmit={commitHostColumnSearch}
          onSuggestionSelect={(suggestion) => suggestion.kind === "host" && commitHostColumnSearch(suggestion.value)}
          fetchSuggestions={fetchHostColumnSuggestions}
          placeholder="Pesquisar host..."
          ariaLabel="Filtrar por host"
          normalizeInc={false}
          className="w-full"
        />
        {hostColumnSearch ? <OneViewTextAction className="mt-2 text-xs" onClick={() => commitHostColumnSearch("")}>Limpar</OneViewTextAction> : null}
      </OneViewColumnFilterPopover>
    );
    if (column === "problem") return (
      <OneViewColumnFilterPopover label="Filtrar problema" kind="search" activeCount={problemColumnSearch ? 1 : 0}>
        <OneViewTableSearchField
          value={problemColumnDraft}
          onChange={setProblemColumnDraft}
          onSubmit={commitProblemColumnSearch}
          onSuggestionSelect={(suggestion) => suggestion.kind === "problem" && commitProblemColumnSearch(suggestion.value)}
          fetchSuggestions={fetchProblemColumnSuggestions}
          placeholder="Pesquisar problema..."
          ariaLabel="Filtrar por problema"
          normalizeInc={false}
          className="w-full"
        />
        {problemColumnSearch ? <OneViewTextAction className="mt-2 text-xs" onClick={() => commitProblemColumnSearch("")}>Limpar</OneViewTextAction> : null}
      </OneViewColumnFilterPopover>
    );
    if (column === "started") return (
      <OneViewColumnFilterPopover label="Filtrar período do início" activeCount={hasTemporalFilter ? 1 : 0}>
        <p className="mb-2 text-xs font-semibold">Período do início</p>
        <Select value={datePreset} onValueChange={(value) => applyDatePreset(value as AlertsDatePreset)}>
          <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Sem período</SelectItem>{ALERTS_DATE_PRESET_OPTIONS.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}<SelectItem value="custom">Personalizado no painel</SelectItem></SelectContent>
        </Select>
      </OneViewColumnFilterPopover>
    );
    if (column === "ack") return ackColumnFilter;
    if (column === "incident") return (
      <OneViewColumnFilterPopover label="Filtrar chamado" activeCount={incidentStates.length + Number(Boolean(incidentNumber))} align="end">
        <div className="space-y-3">
          <OneViewTableSearchField value={incidentNumberDraft} onChange={(value) => setIncidentNumberDraft(value.toUpperCase().slice(0, 40))} onSubmit={commitIncidentNumber} onSuggestionSelect={(suggestion) => suggestion.kind === "number" && commitIncidentNumber(suggestion.value)} fetchSuggestions={fetchIncidentNumberSuggestions} placeholder="Pesquisar INC..." ariaLabel="Filtrar número do chamado" className="w-full" />
          <OperationalFacetChecklist options={INCIDENT_STATE_OPTIONS} selectedValues={incidentStates} onChange={(values) => { setIncidentStates(values); setPage(1); }} allLabel="Todos os estados" searchPlaceholder="Buscar estado..." />
          {incidentNumber ? <OneViewTextAction className="text-xs" onClick={() => commitIncidentNumber("")}>Limpar número</OneViewTextAction> : null}
        </div>
      </OneViewColumnFilterPopover>
    );
    if (column === "status") return (
      <OneViewColumnFilterPopover label="Filtrar estado do alerta" activeCount={statusFilter === "all" ? 0 : 1} align="end">
        <OperationalFacetChecklist options={ALERT_STATUS_OPTIONS} selectedValues={statusFilter === "all" ? [] : [statusFilter]} onChange={(values) => { setStatusFilter(values.length === 1 ? values[0] : "all"); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar estado..." />
      </OneViewColumnFilterPopover>
    );
    return null;
  };

  const toggleColumnSort = (field: SortField) => {
    setSortOrder((current) => sortField === field && current === "asc" ? "desc" : "asc");
    setSortField(field);
    setPage(1);
  };

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
      countNoun={customerFilterCountNoun("filter")}
      triggerClassName="h-9 w-full min-w-0 max-w-none justify-between"
    />
  );
  const configurableSummaryItems = alertsMetrics.visibleMetrics.flatMap((metric) => {
    const card = summaryCards.find((candidate) => candidate.filter === metric.id);
    if (!card) return [];
    return [{
      key: metric.id,
      label: card.title,
      value: formatCardValue(card.value),
      description: card.description,
      tone: summaryTone(metric.id as SummaryFilter),
      selected: summaryFilterIsActive(metric.id as SummaryFilter),
      onClick: () => applySummaryFilter(metric.id as SummaryFilter),
      span: alertsMetrics.span[metric.id] ?? 1,
      rowSpan: alertsMetrics.rowSpan[metric.id] ?? 1,
    }];
  });
  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      clientSelect={<PageHeader title="Central de Alertas" />}
      contentClassName="gap-2 p-2 sm:p-3"
      wallboard={dashboard.isWallboard}
    >
      {hasSnapshot ? (
        <section className="ov-callout-warning p-4 shadow-none" role="status">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <WifiOff className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <h2 className="ov-type-section-title">Dados em modo de contingência</h2>
                <p className="ov-type-body">A conexão em tempo real está indisponível. A tabela e os indicadores abaixo são uma cópia, não o estado operacional atual.</p>
                <p className="mt-1 text-sm font-semibold tabular-nums">{formatSnapshotCopyClock(snapshotCopyAt || lastCheckedAt)}</p>
                {fallbackCode ? <p className="mt-1 ov-type-caption">Código: {safeDisplayText(fallbackCode)}</p> : null}
              </div>
            </div>
            <OneViewButton type="button" variant="secondary" className="ov-error-action" onClick={() => void refreshAll()} disabled={isRefreshing}>
              <RefreshCcw className="h-4 w-4" /> Tentar novamente
            </OneViewButton>
          </div>
        </section>
      ) : null}

      <ConfigurableDashboard controller={dashboard} metricStrip={alertsMetrics}>
        <ConfigurableDashboardWidget id="operational-summary">
          <div className="space-y-2">
            {summaryError ? <OperationalErrorBanner message={summaryError} /> : null}
            <ConfigurableMetricStrip
              aria-label="Indicadores de alertas"
              controller={alertsMetrics}
              editable={dashboard.isEditing}
              gridProfile="twelve"
              gridClassName="ov-alerts-metric-grid"
              items={configurableSummaryItems}
            />
          </div>
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="alerts-table">
        <section className="ov-surface-official overflow-hidden">
        <header className="border-b border-border/70 px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="ov-type-section-title text-foreground">
                {ALERTS_VIEWS.find((item) => item.id === alertsView)?.label ?? "Alertas"} · filtrados por {tableCustomerScope}
              </h2>
              <p className="ov-type-caption text-muted-foreground">
                {alertsAreCopy
                  ? "Cópia da fila. Não é o estado operacional atual."
                  : (ALERTS_VIEWS.find((item) => item.id === alertsView)?.description ?? "Fila operacional")}
                {originSync.some((item) => item.last_success_at)
                  ? ` · Último sync ${formatSnapshotCopyClock(originSync.map((item) => item.last_success_at).filter((value): value is string => Boolean(value)).sort().at(-1) || "")}`
                  : " · Último sync da origem sem registro"}
                {isAlertsFilling
                  ? " · Exibindo os mais recentes · carregando o restante…"
                  : isAlertsLoading && hasTemporalFilter
                    ? " · Aplicando filtro de período…"
                    : ` · Exibindo ${firstVisible.toLocaleString("pt-BR")}–${lastVisible.toLocaleString("pt-BR")} de ${listTotal.toLocaleString("pt-BR")} alertas`}
                {snapshotCoverage?.partial ? ` disponíveis na cópia · ${snapshotCoverage.total_persisted.toLocaleString("pt-BR")} persistidos` : ""}
              </p>
            </div>
            <Tabs value={isOperationalQueue(alertsView) ? alertsView : "pending"} onValueChange={(value) => applyAlertsView(value as AlertsView)}>
              <TabsList aria-label="Filas operacionais de alertas" className="h-9 justify-start overflow-x-auto">
                {ALERTS_VIEWS.map((view) => (
                  <TabsTrigger key={view.id} value={view.id} className="h-7">
                    {view.label}
                    {queueCounts ? <span className="ml-1 tabular-nums text-muted-foreground">{queueCounts[view.id].toLocaleString("pt-BR")}</span> : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          {originSync.some((item) => item.stale) ? (
            <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100" role="status">
              Sincronização desatualizada em {originSync.filter((item) => item.stale).map((item) => item.datasource_name).join(", ")}. Os alertas ativos sem ACK continuam em Pendentes e nada foi marcado como resolvido.
            </p>
          ) : null}
        </header>

        <ConfigurableTableToolbar
          search={searchQuery}
          onSearchChange={(value) => { setSearchQuery(value); setPage(1); }}
          fetchSearchSuggestions={fetchAlertTableSuggestions}
          onSearchPick={(value) => { setSearchQuery(value); setPage(1); commitAlertSearch(value); }}
          onSearchSuggestionPick={(suggestion) => {
            if (suggestion.kind === "customer" && suggestion.customer_key) {
              cancelAlertSearch();
              alertSearchIntent.current = null;
              setAlertSearchLoading(false);
              setSearchQuery("");
              setDebouncedSearch("");
              setSelectedCustomerKeys((current) => current.includes(suggestion.customer_key!)
                ? current
                : [...current, suggestion.customer_key!]);
              setPage(1);
              return;
            }
            setSearchQuery(suggestion.value);
            setPage(1);
            commitAlertSearch(suggestion.value);
          }}
          onSearchSubmit={(value) => commitAlertSearch(value)}
          searchPlaceholder="Buscar alerta/host ou adicionar clientes…"
          searchLabel="Buscar na tabela de alertas"
          columns={alertTableColumns}
          responsiveColumns={{
            autoHiddenCount: alertTableLayout.autoHiddenColumns.length,
            showAllColumns: alertTableLayout.showAllColumns,
            onShowAllColumnsChange: alertTableLayout.setShowAllColumns,
          }}
          activeFilterCount={activeFilterChips.length}
          onClearFilters={clearFilters}
          searchActivity={alertSearchActivity}
          searchActivityQuery={debouncedSearch}
          localSearchSuggestions={localCustomerSearchSuggestions}
          getSearchSuggestionActionLabel={(suggestion) => suggestion.kind === "customer" ? "Aplicar Cliente" : "Pesquisar"}
          isSearchSuggestionSelected={(suggestion) => suggestion.kind === "customer" && Boolean(suggestion.customer_key) && selectedCustomerKeys.includes(suggestion.customer_key!)}
          scopeHint="Para filtrar clientes: digite 2 ou mais caracteres, escolha Aplicar Cliente e repita para adicionar outros."
          sort={{
            value: `${sortField}:${sortOrder}`,
            options: [...ALERT_TABLE_SORT_OPTIONS],
            onChange: (value) => {
              const [sort, order] = value.split(":");
              setSortField(sort as SortField);
              setSortOrder(order === "asc" ? "asc" : "desc");
              setPage(1);
            },
            label: "Ordenar alertas",
          }}
          filters={(
            <div className="grid min-w-0 grid-cols-1 gap-y-4">
              <OperationalFilterSection title="Escopo" gridClassName="lg:grid-cols-3">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Cliente{clientSelector}</label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Severidade
                  <OperationalFacetMultiSelect
                    label="Severidade"
                    options={severityOrder.map((severity) => ({ value: severity, label: severityCatalog[severity].label }))}
                    selectedValues={selectedSeverities}
                    onChange={(values) => { setSelectedSeverities(values); setPage(1); }}
                    allLabel="Todas"
                    searchPlaceholder="Buscar severidade..."
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Estado
                  <OperationalFacetMultiSelect label="Estado" options={ALERT_STATUS_OPTIONS} selectedValues={statusFilter === "all" ? [] : [statusFilter]} onChange={(values) => { setStatusFilter(values.length === 1 ? values[0] : "all"); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar estado..." />
                </label>
              </OperationalFilterSection>

              <OperationalFilterSection title="Chamado e ACK" gridClassName="lg:grid-cols-4">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Número do chamado
                  <OneViewTableSearchField value={incidentNumberDraft} onChange={(value) => setIncidentNumberDraft(value.toUpperCase().slice(0, 40))} onSubmit={commitIncidentNumber} onSuggestionSelect={(suggestion) => suggestion.kind === "number" && commitIncidentNumber(suggestion.value)} fetchSuggestions={fetchIncidentNumberSuggestions} placeholder="Pesquisar INC..." ariaLabel="Filtrar número do chamado" className="w-full min-w-0" />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Estado do chamado
                  <OperationalFacetMultiSelect label="Estado do chamado" options={INCIDENT_STATE_OPTIONS} selectedValues={incidentStates} onChange={(values) => { setIncidentStates(values); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar estado..." />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">ACK da origem
                  <Select value={sourceAckFilter} onValueChange={(value) => { setSourceAckFilter(value as RecognitionFilter); setPage(1); }}><SelectTrigger className="h-9 w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos</SelectItem><SelectItem value="acknowledged">Com ACK</SelectItem><SelectItem value="unacknowledged">Sem ACK</SelectItem></SelectContent></Select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Status do ACK OneView
                  <OperationalFacetMultiSelect label="Status do ACK OneView" options={ONEVIEW_ACK_OPTIONS} selectedValues={oneviewAckStatuses} onChange={(values) => { setOneviewAckStatuses(values); setPage(1); }} allLabel="Todos" searchPlaceholder="Buscar status..." />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground lg:col-span-2">Analista do ACK
                  <OneViewTableSearchField
                    value={ackActorDraft}
                    onChange={setAckActorDraft}
                    onSubmit={applyAckActorFilter}
                    onSuggestionSelect={(suggestion) => {
                      if (suggestion.kind === "actor") applyAckActorFilter(suggestion.value);
                    }}
                    fetchSuggestions={fetchAckActorSuggestions}
                    placeholder="Pesquisar analista que fez ACK..."
                    ariaLabel="Pesquisar analista do ACK"
                    normalizeInc={false}
                    getSuggestionActionLabel={(suggestion) => suggestion.kind === "actor" ? "Filtrar analista" : null}
                    className="w-full min-w-0"
                  />
                </label>
              </OperationalFilterSection>

              <OperationalFilterSection title="Busca e período" gridClassName="lg:grid-cols-4">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Campo da busca
                  <Select value={searchField} onValueChange={(value) => { setSearchField(value as AlertsSearchField); setPage(1); }}><SelectTrigger className="h-9 w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent>{ALERTS_SEARCH_FIELD_OPTIONS.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent></Select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Período do início
                  <Select value={datePreset} onValueChange={(value) => applyDatePreset(value as AlertsDatePreset)}><SelectTrigger className="h-9 w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Sem período</SelectItem>{ALERTS_DATE_PRESET_OPTIONS.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}<SelectItem value="custom">Personalizado</SelectItem></SelectContent></Select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Host
                  <OneViewTableSearchField value={hostColumnDraft} onChange={setHostColumnDraft} onSubmit={commitHostColumnSearch} onSuggestionSelect={(suggestion) => suggestion.kind === "host" && commitHostColumnSearch(suggestion.value)} fetchSuggestions={fetchHostColumnSuggestions} placeholder="Pesquisar host..." ariaLabel="Filtrar host" normalizeInc={false} className="w-full min-w-0" />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Problema
                  <OneViewTableSearchField value={problemColumnDraft} onChange={setProblemColumnDraft} onSubmit={commitProblemColumnSearch} onSuggestionSelect={(suggestion) => suggestion.kind === "problem" && commitProblemColumnSearch(suggestion.value)} fetchSuggestions={fetchProblemColumnSuggestions} placeholder="Pesquisar problema..." ariaLabel="Filtrar problema" normalizeInc={false} className="w-full min-w-0" />
                </label>
                {datePreset === "custom" ? <div className="min-w-0 [grid-column:1/-1]"><Calendar className="mx-auto max-w-full" mode="range" numberOfMonths={1} locale={ptBR} selected={dateRange} onSelect={(range) => { setDateRange(range); setPage(1); }} /></div> : null}
              </OperationalFilterSection>

              <OperationalFilterSection title="Exibição" gridClassName="lg:grid-cols-4">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Itens por página
                  <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger className="h-9 w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent></Select>
                </label>
              </OperationalFilterSection>
            </div>
          )}
        />
        {activeFilterChips.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5" aria-label="Filtros ativos">
            {activeFilterChips.map((chip) => <OneViewPill key={chip.key ?? chip.label} className="h-7 px-2" onClick={() => { chip.remove(); setPage(1); }}>{chip.label}<X className="h-3 w-3" /></OneViewPill>)}
            <OneViewTextAction className="text-xs" onClick={clearFilters}>Limpar todos</OneViewTextAction>
          </div>
        ) : null}

        {alertsError ? <OperationalErrorBanner className="rounded-none border-x-0 border-t-0" message={alertsError} onRetry={() => void loadAlerts()} /> : null}

        <div ref={alertTableLayout.containerRef} className="ov-operational-responsive relative min-h-[280px] max-h-[calc(100vh-16rem)] overflow-auto" aria-busy={isAlertsLoading || isAlertsFilling}>
          {(isAlertsLoading || isAlertsFilling) && alerts.length > 0 ? <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-primary/15"><div className="h-full w-1/3 animate-pulse bg-primary" /></div> : null}
          <TooltipProvider delayDuration={250}>
          <Table className="ov-operational-table w-full table-fixed" style={{ minWidth: `${alertTableLayout.minimumTableWidth}px` }}>
            <colgroup>
              {alertTableLayout.visibleColumns.map((column) => <col key={column.id} style={{ width: `${operationalColumnPreferredWidth(column)}px` }} />)}
            </colgroup>
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="border-border bg-muted/80 ov-type-caption text-muted-foreground hover:bg-muted/80">
                {alertTableLayout.visibleColumns.map((column) => (
                  <TableHead key={column.id} className={cn(
                    "overflow-visible font-semibold",
                    column.id === "duration" ? "text-right" : column.id === "actions" ? "text-center" : "text-left",
                    column.id === "actions" && "sticky right-0 z-20 bg-inherit",
                  )}>
                    <OneViewFilterableHeader
                      label={column.label}
                      active={Boolean(ALERT_COLUMN_SORT[column.id] && sortField === ALERT_COLUMN_SORT[column.id])}
                      direction={sortOrder}
                      onSort={ALERT_COLUMN_SORT[column.id] ? () => toggleColumnSort(ALERT_COLUMN_SORT[column.id]!) : undefined}
                      filter={alertColumnFilter(column.id)}
                    />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showAlertsSkeleton ? Array.from({ length: 8 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: tableColumnCount }).map((__, cell) => <TableCell key={cell} className="py-4"><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              )) : displayedAlerts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={tableColumnCount} className="p-0">
                    <OperationalEmptyState
                      compact
                      icon={<CircleAlert className="h-7 w-7" />}
                      title={alertsError
                        ? "A fila não foi atualizada porque a sincronização não respondeu."
                        : !hasLoadedAlerts
                          ? "Carregando fila operacional..."
                          : originSync.some((item) => item.stale)
                            ? "Nenhum alerta nesta fila. A sincronização da origem está desatualizada, então a ausência não confirma recuperação."
                            : alertsView === "pending"
                              ? "Nenhum alerta pendente de ação."
                              : "Nenhum alerta nesta fila para os filtros atuais."}
                    />
                  </TableCell>
                </TableRow>
              ) : displayedAlerts.map((alert) => {
                const severityKey = normalizeOneViewSeverity(alert.severity);
                const isResolved = isResolvedAlert(alert);
                const isActive = !isResolved;
                const liveTransition = alertTransitions.get(alert.id) ?? null;
                const attentionTone = isActive && !acknowledged(alert) && !liveTransition && freshAttentionIds.has(alert.id)
                  ? freshAttentionTone(alert.severity)
                  : null;
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
                const durationLabel = formatDurationSeconds(liveDurationSeconds(alert, durationNow));
                const suppressionText = suppressionCaption(alert, formatDateTime);
                const legacyText = recoveryEvidenceCaption(alert);
                const ackWait = alert.time_to_ack_seconds == null ? "" : ` · Tempo até ACK ${formatDurationSeconds(alert.time_to_ack_seconds)}`;
                const alertCells: Record<AlertTableColumnId, ReactNode> = {
                  severity: (
                    <TableCell key="severity" className="text-left">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <OneViewSeverityBadge severity={severityKey} />
                        {liveTransition ? <span className="ov-live-transition-badge" aria-live="polite">{liveTransition.label}</span> : null}
                      </span>
                    </TableCell>
                  ),
                  client: (
                    <TableCell key="client" className="text-left"><Tooltip><TooltipTrigger asChild><span className="inline-flex max-w-full justify-center"><ClientIdentity customer={{ key: alert.customer_key, name: alert.customer_name, source: alert.customer_source }} operationalScope={alert.operational_scope} operationalScopeLabel={alert.operational_scope_label} showName nameClassName="max-w-[9rem] truncate text-left ov-type-body font-semibold" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-xs break-words">{clientLabel}</TooltipContent></Tooltip></TableCell>
                  ),
                  host: (
                    <TableCell key="host" className="text-left"><Tooltip><TooltipTrigger asChild><p className="truncate ov-type-body font-semibold">{hostLabel}</p></TooltipTrigger><TooltipContent side="top" className="max-w-xs break-words">{technicalHost && technicalHost !== hostLabel ? `${hostLabel} · ${technicalHost}` : hostLabel}</TooltipContent></Tooltip></TableCell>
                  ),
                  problem: (
                    <TableCell key="problem" className="text-left">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="min-w-0">
                            <p className="truncate ov-type-body font-medium">{problemLabel}</p>
                            {suppressionText ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{suppressionText}</p> : null}
                            {legacyText ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{legacyText}</p> : null}
                            {alert.operator_link ? (
                              <p className="mt-0.5 truncate text-[11px] font-medium text-primary">
                                Link de operadora{[alert.operator_link.carrier_name, alert.operator_link.link_type, alert.operator_link.site_name].filter(Boolean).length
                                  ? ` · ${[alert.operator_link.carrier_name, alert.operator_link.link_type, alert.operator_link.site_name].filter(Boolean).join(" · ")}`
                                  : ""}
                              </p>
                            ) : null}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-sm break-words">{safeDisplayText(alert.problem_name, "Alerta sem descrição")}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  ),
                  started: <TableCell key="started" className="text-left font-mono ov-type-caption text-muted-foreground">{alert.first_seen_at ? formatDateTime(alert.first_seen_at) : "—"}</TableCell>,
                  duration: <TableCell key="duration" className="text-right font-mono ov-type-caption tabular-nums text-muted-foreground" title={isResolved ? "Duração até o recovery" : "Duração do problema ativo"}>{durationLabel}</TableCell>,
                  ack: (
                    <TableCell key="ack" className="overflow-hidden text-left">{(() => { const ack = sourceAckPresentation(alert); if (ack.status === "pending") return <OneViewSemanticStatusBadge status="incident-waiting" label="Pendente" />; if (ack.status !== "acknowledged") return <OneViewSemanticStatusBadge status="incident-closed" label="Sem ACK" />; const ackLabel = ack.actorLabel ? `Reconhecido por ${ack.actorLabel}` : "Reconhecido"; return <Tooltip><TooltipTrigger asChild><span className="inline-flex max-w-full"><OneViewSemanticStatusBadge status="incident-resolved" label="Reconhecido" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-xs break-words">{ackLabel}{ack.at ? ` · ${formatDateTime(ack.at)}` : ""}{ackWait}</TooltipContent></Tooltip>; })()}</TableCell>
                  ),
                  incident: <TableCell key="incident" className="text-left"><AlertServiceNowReferenceCell reference={alert.servicenow_reference} /></TableCell>,
                  status: <TableCell key="status" className="text-left"><OneViewSemanticStatusBadge status={isActive ? "monitoring-down" : "monitoring-normalized"} label={isActive ? "Ativo" : "Resolvido"} /></TableCell>,
                  actions: (
                    <TableCell key="actions" className="sticky right-0 z-10 bg-inherit px-2 py-2 align-middle text-right" onClick={(event) => event.stopPropagation()}>
                      <div className="flex flex-nowrap items-center justify-end gap-0.5">
                        {alert.servicenow_reference?.sys_id && alert.servicenow_reference?.number ? (
                          <IncidentTableActionsCell
                            incident={{
                              sys_id: alert.servicenow_reference.sys_id,
                              number: alert.servicenow_reference.number,
                            }}
                            alertArtifact={buildAlertArtifactFromOneViewAlert(alert, {
                              number: alert.servicenow_reference.number,
                            })}
                            visibleActions={ALERT_QUICK_INCIDENT_ACTIONS}
                            mutationsBlocked={alertsAreCopy}
                            onActionComplete={() => void loadAlerts({ quiet: true })}
                          />
                        ) : null}
                        <AlertSourceAckRowAction
                          alert={alert}
                          onOpenDetail={openAlert}
                          liveStateUnavailable={alertsAreCopy}
                        />
                        <AlertSuppressAction alert={alert} variant="row" />
                        <Tooltip><TooltipTrigger asChild><OneViewButton type="button" variant="ghost" size="icon" className="ov-control-official-compact h-7 min-h-7 w-7 px-0" aria-label="Ver detalhes" onClick={(event) => { event.stopPropagation(); openAlert(alert); }}><Eye className="h-4 w-4" /><span className="sr-only">Ver detalhes</span></OneViewButton></TooltipTrigger><TooltipContent>Ver detalhes</TooltipContent></Tooltip>
                      </div>
                    </TableCell>
                  ),
                };
                return (
                  <TableRow
                    key={alert.id}
                    role="button"
                    tabIndex={0}
                    aria-selected={selectedAlertId === alert.id}
                    aria-label={`${problemLabel}${liveTransition ? ` · ${liveTransition.label}` : attentionTone ? " · Novo alerta" : ""}`}
                    onClick={() => openAlert(alert)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAlert(alert); } }}
                    className={cn(
                      "cursor-pointer border-border/40 bg-card outline-none hover:bg-muted/40 focus-visible:bg-muted/60",
                      selectedAlertId === alert.id && "bg-muted/60",
                      attentionTone === "high" && "ov-alert-fresh-attention-high",
                      attentionTone === "disaster" && "ov-alert-fresh-attention-disaster",
                      liveTransition && "ov-alert-queue-confirm",
                    )}
                  >
                    {alertTableLayout.visibleColumns.map((column) => alertCells[column.id])}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </TooltipProvider>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="ov-type-caption text-muted-foreground">
            Página {pagination.total_pages === 0 ? 0 : pagination.page} de {pagination.total_pages}
            {" · "}
            {pagination.total_items.toLocaleString("pt-BR")} resultado{pagination.total_items === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <OneViewButton type="button" variant="secondary" disabled={!pagination.has_previous || isAlertsLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="h-4 w-4" />Anterior</OneViewButton>
            <OneViewButton type="button" variant="secondary" disabled={!pagination.has_next || isAlertsLoading} onClick={() => setPage((current) => current + 1)}>Próxima<ChevronRight className="h-4 w-4" /></OneViewButton>
          </div>
        </div>
        </section>
        </ConfigurableDashboardWidget>
      </ConfigurableDashboard>

      <AlertDetailDrawer
        open={selectedAlertId !== null}
        onOpenChange={(next) => { if (!next) closeAlert(); }}
        alert={selectedAlert}
        historyItems={selectedHistoryItems}
        isLoading={isDetailLoading}
        error={detailError || historyLoadError}
        description={alertsAreCopy ? "Cópia do alerta. Não é o estado operacional atual." : "Informações operacionais seguras e histórico do OneView."}
        onSourceAckRequestAccepted={handleSourceAckRequestAccepted}
        onSourceAcknowledged={handleSourceAcknowledged}
        onIncidentClaimed={() => { void loadAlerts({ quiet: true }); }}
        liveStateUnavailable={liveStateUnavailable}
      />
      <OperatorDisasterPopup
        items={severityPopupEnabled ? severityPopups : []}
        onOpen={(item) => {
          const alert = severityPopupAlertsRef.current.get(item.key) || alerts.find((row) => row.id === item.key);
          setSeverityPopups((current) => current.filter((entry) => entry.key !== item.key));
          if (alert) openAlert(alert);
        }}
        onDismiss={(key) => setSeverityPopups((current) => current.filter((item) => item.key !== key))}
        onDisable={() => {
          setSeverityPopups([]);
          setSeverityPopupEnabled(false);
          setOneViewSeverityPopupEnabled(false, actorId);
        }}
      />

    </AppLayout>
  );
}
