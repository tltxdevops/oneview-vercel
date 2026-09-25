import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format, subDays } from "date-fns";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { ChamadosSearchField } from "@/components/chamados/ChamadosSearchField";
import { AppLayout } from "@/components/layout/AppLayout";
import { ConfigurableMetricStrip } from "@/components/oneview/ConfigurableMetricStrip";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableColumns } from "@/components/oneview/ConfigurableTableTools";
import { useOneViewCommittedSearch } from "@/components/oneview/OneViewTableSearchField";
import { FilterBar } from "@/components/oneview/FilterBar";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { IncidentDetailDrawer } from "@/components/oneview/IncidentDetailDrawer";
import { IncidentTableActionsCell } from "@/components/oneview/IncidentTableActionsCell";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchIncidentDuplicates,
  fetchIncidents,
  type DuplicateIncidentGroup,
  type IncidentDuplicatesResponse,
  type IncidentListResponse,
  type FetchIncidentSearchSuggestionsParams,
  type OneViewIncident,
} from "@/lib/oneview-api";
import { resolveIncidentSearch } from "@/lib/oneview-chamados-search";
import { parseAssignedToSysIds } from "@/lib/oneview-operational-incidents";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewMetricStrip } from "@/lib/oneview-metric-strip-preferences";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/context/AuthContext";

const PAGE_SIZE = 25;
const INCIDENT_LIST_REFRESH_MS = 15_000;

const COLUMNS = [
  "Número",
  "Cliente",
  "Descrição",
  "Estado",
  "Prioridade",
  "Grupo",
  "Responsável",
  "Atualização",
] as const;

const CHAMADOS_METRIC_OPTIONS = [
  { id: "total", label: "Total", required: true },
  { id: "open", label: "Abertos" },
  { id: "in_progress", label: "Em andamento" },
  { id: "resolved", label: "Resolvidos" },
  { id: "closed", label: "Encerrados" },
  { id: "unassigned", label: "Sem responsável" },
  { id: "manual", label: "Manuais" },
  { id: "duplicates", label: "Duplicados" },
] as const;

type ChamadosMetricId = typeof CHAMADOS_METRIC_OPTIONS[number]["id"];

const INCIDENT_COLUMN_OPTIONS = [
  { id: "number", label: COLUMNS[0], required: true },
  { id: "client", label: COLUMNS[1] },
  { id: "description", label: COLUMNS[2] },
  { id: "state", label: COLUMNS[3] },
  { id: "priority", label: COLUMNS[4] },
  { id: "group", label: COLUMNS[5] },
  { id: "assignee", label: COLUMNS[6] },
  { id: "updated", label: COLUMNS[7] },
  { id: "actions", label: "Ações", required: true },
] as const;

type IncidentColumnId = typeof INCIDENT_COLUMN_OPTIONS[number]["id"];

/** Larguras fixas — tabela rola horizontalmente em vez de cortar colunas. */
const INCIDENT_COLUMN_WIDTH: Record<IncidentColumnId, string> = {
  number: "8%",
  client: "12%",
  description: "35%",
  state: "10%",
  priority: "9%",
  group: "12%",
  assignee: "10%",
  updated: "8%",
  actions: "11%",
};

const STATE_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "1", label: "Novo" },
  { value: "2", label: "Em andamento" },
  { value: "3", label: "Em espera" },
  { value: "6", label: "Resolvido" },
  { value: "7", label: "Encerrado" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "all", label: "Todas" },
  { value: "1", label: "1 - Crítica" },
  { value: "2", label: "2 - Alta" },
  { value: "3", label: "3 - Moderada" },
  { value: "4", label: "4 - Baixa" },
  { value: "5", label: "5 - Planejamento" },
] as const;

const PERIOD_OPTIONS = [
  { value: "all", label: "Todo o período" },
  { value: "24h", label: "Últimas 24 h" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
] as const;

type DraftFilters = {
  search: string;
  company: string;
  state: string;
  priority: string;
  assignedTo: string;
  callerId: string;
  contactType: string;
  period: string;
  unassigned: boolean;
};

const EMPTY_DRAFT: DraftFilters = {
  search: "",
  company: "",
  state: "all",
  priority: "all",
  assignedTo: "all",
  callerId: "all",
  contactType: "all",
  period: "all",
  unassigned: false,
};

function displayValue(value: string | null | undefined, fallback?: string | null) {
  const normalize = (raw: unknown) => {
    if (raw === undefined || raw === null) return "";
    if (typeof raw === "number" && !Number.isFinite(raw)) return "";
    const text = String(raw).trim();
    if (!text || text === "undefined" || text === "null" || text === "NaN") return "";
    return text;
  };
  return normalize(value) || normalize(fallback) || "—";
}

function formatDateTime(value: string | null | undefined) {
  return displayValue(value);
}

function safeCount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "—";
  return Math.trunc(parsed).toLocaleString("pt-BR");
}

function incidentKey(item: OneViewIncident, index: number) {
  return item.sys_id || item.number || `incident-${index}`;
}

function periodBounds(period: string): { openedFrom?: string; openedTo?: string } {
  if (period === "all") return {};
  const days = period === "24h" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 0;
  if (!days) return {};
  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), days), "yyyy-MM-dd");
  return { openedFrom: from, openedTo: to };
}

export default function ChamadosPage() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({ page: "incidents", actorId });
  const chamadosMetrics = useOneViewMetricStrip({ stripId: "incidents-summary", actorId, definitions: CHAMADOS_METRIC_OPTIONS });
  const incidentTablePageSize = dashboard.layout.widgets.find((item) => item.id === "incidents-table")?.itemLimit ?? PAGE_SIZE;
  const incidentColumns = useOneViewTableColumns({ tableId: "incidents", actorId, definitions: INCIDENT_COLUMN_OPTIONS });
  const [searchParams] = useSearchParams();
  const initialFilters = useMemo<DraftFilters>(() => {
    if (searchParams.get("unassigned") === "true") {
      return { ...EMPTY_DRAFT, unassigned: true };
    }
    const assignedIds = parseAssignedToSysIds(searchParams.get("assigned_to"));
    if (assignedIds.length) {
      return { ...EMPTY_DRAFT, assignedTo: assignedIds.join(",") };
    }
    return EMPTY_DRAFT;
  }, [searchParams]);
  const [draft, setDraft] = useState<DraftFilters>(initialFilters);
  const [applied, setApplied] = useState<DraftFilters>(initialFilters);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<IncidentListResponse | null>(null);
  const payloadRef = useRef<IncidentListResponse | null>(null);
  const metadataRefreshRef = useRef(-1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [metadataRefreshVersion, setMetadataRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<OneViewIncident | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "manual" | "duplicates">("list");
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState<string | null>(null);
  const [duplicatesPayload, setDuplicatesPayload] = useState<IncidentDuplicatesResponse | null>(null);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<DuplicateIncidentGroup | null>(null);

  useEffect(() => {
    setPage(1);
  }, [incidentTablePageSize]);

  useEffect(() => {
    if (viewMode === "duplicates") return;
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshVersion((current) => current + 1);
    };
    const timer = window.setInterval(refresh, INCIDENT_LIST_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [viewMode]);

  const commitIncidentSearch = useCallback((search: string) => {
    if (search === applied.search) return;
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setApplied((current) => ({ ...current, search }));
  }, [applied.search]);
  const { cancelPending: cancelIncidentSearch } = useOneViewCommittedSearch(
    draft.search,
    commitIncidentSearch,
  );

  useEffect(() => {
    if (viewMode === "duplicates") return;
    const controller = new AbortController();
    if (payloadRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const period = periodBounds(applied.period);
    const searchParams = resolveIncidentSearch(applied.search);
    // Poll de 15 s atualiza somente a tabela. Metadados globais são renovados
    // no primeiro load, em mudanças de filtro e após actions relevantes.
    const includeMetadata = !payloadRef.current || metadataRefreshRef.current !== metadataRefreshVersion;

    fetchIncidents({
      page,
      pageSize: incidentTablePageSize,
      search: searchParams.search,
      number: searchParams.number,
      company: applied.company.trim() || undefined,
      state: applied.unassigned ? undefined : (applied.state !== "all" ? applied.state : undefined),
      priority: applied.priority !== "all" ? applied.priority : undefined,
      // SN-P0-28: assigned_to opcional (Analista).
      assignedTo: applied.unassigned
        ? undefined
        : (applied.assignedTo !== "all" ? applied.assignedTo : undefined),
      // OV-P0-265: caller e canal opcionais; "Todos" preserva o universo do read-model.
      callerId: applied.callerId !== "all" ? applied.callerId : undefined,
      contactType: applied.contactType !== "all" ? applied.contactType : undefined,
      manual: viewMode === "manual",
      unassigned: applied.unassigned || undefined,
      updatedFrom: period.openedFrom,
      updatedTo: period.openedTo,
      // KPI clicks always filter server-side. Reuse the already-rendered
      // global KPIs/facets, which are unrelated to the selected table filter.
      includeCounts: includeMetadata,
      includeGlobalCounts: includeMetadata,
      includeFacets: includeMetadata,
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        const previous = payloadRef.current;
        const next = {
          ...response,
          counts: response.counts ?? previous?.counts,
          global_counts: response.global_counts ?? previous?.global_counts,
          facets: response.facets ?? previous?.facets,
        };
        if (includeMetadata) metadataRefreshRef.current = metadataRefreshVersion;
        payloadRef.current = next;
        setPayload(next);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(payloadRef.current ? "Atualização falhou — exibindo último dado disponível" : "Chamados indisponíveis");
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [applied, incidentTablePageSize, metadataRefreshVersion, page, refreshVersion, viewMode]);

  useEffect(() => {
    if (viewMode !== "duplicates") return;
    const controller = new AbortController();
    setDuplicatesLoading(true);
    setDuplicatesError(null);
    fetchIncidentDuplicates({
      customer: applied.company.trim() || undefined,
      assignedTo: applied.unassigned
        ? undefined
        : (applied.assignedTo !== "all" ? applied.assignedTo : undefined),
      priority: applied.priority !== "all" ? applied.priority : undefined,
      state: applied.unassigned ? undefined : (applied.state !== "all" ? applied.state : undefined),
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setDuplicatesPayload(response);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDuplicatesPayload(null);
        setDuplicatesError("Duplicados indisponíveis");
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) setDuplicatesLoading(false);
      });
    return () => controller.abort();
  }, [applied, refreshVersion, viewMode]);

  const items = payload?.items ?? [];
  const pagination = payload?.pagination;
  const globalCounts = payload?.global_counts;
  const visibleColumnIds = incidentColumns.visibleColumns.map((column) => column.id);
  const visibleColumnCount = visibleColumnIds.length;
  const activeFilterCount = Number(Boolean(draft.company.trim()))
    + Number(!draft.unassigned && draft.state !== "all")
    + Number(draft.priority !== "all")
    + Number(!draft.unassigned && draft.assignedTo !== "all")
    + Number(draft.callerId !== "all")
    + Number(draft.contactType !== "all")
    + Number(draft.period !== "all")
    + Number(draft.unassigned);
  const totalLabel = useMemo(() => {
    if (error) return "—";
    if (!pagination) return "—";
    const total = safeCount(pagination.total_items);
    if (total === "—") return "—";
    const count = Math.trunc(Number(pagination.total_items));
    return `${total} encontrado${count === 1 ? "" : "s"}`;
  }, [error, pagination]);

  const callerOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    map.set("all", { value: "all", label: "Todos" });
    // SN-P0-33: sem seeds hardcoded — só facets do BFF (+ valor aplicado se ausente).
    for (const facet of payload?.facets?.callers ?? []) {
      const value = String(facet?.value || "").trim();
      if (!value) continue;
      map.set(value, {
        value,
        label: String(facet.display_value || facet.label || value).trim() || value,
      });
    }
    if (applied.callerId !== "all" && !map.has(applied.callerId)) {
      map.set(applied.callerId, { value: applied.callerId, label: applied.callerId });
    }
    return [...map.values()];
  }, [payload?.facets?.callers, applied.callerId]);

  const contactTypeOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    map.set("all", { value: "all", label: "Todos os canais" });
    for (const facet of payload?.facets?.contact_types ?? []) {
      const value = String(facet?.value || "").trim();
      if (!value) continue;
      const rawLabel = String(facet?.label || value).trim();
      const label = value === "__blank"
        ? "Sem canal informado"
        : rawLabel === "monitoring"
          ? "Monitoramento"
          : rawLabel;
      map.set(value, { value, label });
    }
    if (applied.contactType !== "all" && !map.has(applied.contactType)) {
      map.set(applied.contactType, {
        value: applied.contactType,
        label: applied.contactType === "__blank" ? "Sem canal informado" : applied.contactType,
      });
    }
    return [...map.values()];
  }, [payload?.facets?.contact_types, applied.contactType]);

  const assigneeOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    map.set("all", { value: "all", label: "Todos" });
    for (const facet of payload?.facets?.assignees ?? []) {
      const value = String(facet?.value || "").trim();
      if (!value) continue;
      map.set(value, {
        value,
        label: String(facet.display_value || facet.label || value).trim() || value,
      });
    }
    if (applied.assignedTo !== "all" && !map.has(applied.assignedTo)) {
      const ids = parseAssignedToSysIds(applied.assignedTo);
      map.set(applied.assignedTo, {
        value: applied.assignedTo,
        label: ids.length > 1 ? `${ids.length} analistas` : applied.assignedTo,
      });
    }
    return [...map.values()];
  }, [payload?.facets?.assignees, applied.assignedTo]);

  const searchSuggestScope = useMemo((): Omit<FetchIncidentSearchSuggestionsParams, "q" | "limit" | "signal"> => {
    const period = periodBounds(applied.period);
    return {
      company: applied.company.trim() || undefined,
      state: applied.unassigned ? undefined : (applied.state !== "all" ? applied.state : undefined),
      priority: applied.priority !== "all" ? applied.priority : undefined,
      assignedTo: applied.unassigned
        ? undefined
        : (applied.assignedTo !== "all" ? applied.assignedTo : undefined),
      callerId: applied.callerId !== "all" ? applied.callerId : undefined,
      contactType: applied.contactType !== "all" ? applied.contactType : undefined,
      manual: viewMode === "manual",
      unassigned: applied.unassigned || undefined,
      updatedFrom: period.openedFrom,
      updatedTo: period.openedTo,
    };
  }, [applied, viewMode]);

  function applyFilters(next: DraftFilters = draft, _requestMode: "full" | "metric" = "full") {
    cancelIncidentSearch();
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setApplied({
      ...next,
      search: next.search.trim(),
      company: next.company.trim(),
    });
  }

  function clearFilters() {
    cancelIncidentSearch();
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setViewMode("list");
  }

  function refreshAfterIncidentAction() {
    setMetadataRefreshVersion((current) => current + 1);
    setRefreshVersion((current) => current + 1);
  }

  function selectMetric(kind: "total" | "open" | "in_progress" | "resolved" | "closed" | "unassigned" | "manual" | "duplicates") {
    if (kind === "duplicates") {
      setViewMode("duplicates");
      setSelected(null);
      setSelectedDuplicateGroup(null);
      return;
    }
    if (kind === "manual") {
      setViewMode("manual");
      setSelected(null);
      setSelectedDuplicateGroup(null);
      const next = { ...draft, state: "all", unassigned: false };
      setDraft(next);
      applyFilters(next, "metric");
      return;
    }
    setViewMode("list");
    setSelectedDuplicateGroup(null);
    const next: DraftFilters = {
      ...draft,
      unassigned: kind === "unassigned",
      assignedTo: kind === "unassigned" ? "all" : draft.assignedTo,
      state: kind === "open"
        ? "1"
        : kind === "in_progress"
          ? "2"
          : kind === "resolved"
            ? "6"
            : kind === "closed"
              ? "7"
              : "all",
    };
    setDraft(next);
    applyFilters(next, "metric");
  }

  const chamadosMetricItemsById = useMemo(() => ({
    total: {
      key: "total",
      label: "Total",
      value: error ? "—" : safeCount(globalCounts?.total),
      tone: "info" as const,
      loading,
      selected: viewMode === "list" && applied.state === "all" && !applied.unassigned,
      onClick: () => selectMetric("total"),
    },
    open: {
      key: "open",
      label: "Abertos",
      value: error ? "—" : safeCount(globalCounts?.open),
      tone: "info" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.state === "1" && !applied.unassigned,
      onClick: () => selectMetric("open"),
    },
    in_progress: {
      key: "in_progress",
      label: "Em andamento",
      value: error ? "—" : safeCount(globalCounts?.in_progress),
      tone: "warning" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.state === "2" && !applied.unassigned,
      onClick: () => selectMetric("in_progress"),
    },
    resolved: {
      key: "resolved",
      label: "Resolvidos",
      value: error ? "—" : safeCount(globalCounts?.resolved),
      tone: "success" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.state === "6" && !applied.unassigned,
      onClick: () => selectMetric("resolved"),
    },
    closed: {
      key: "closed",
      label: "Encerrados",
      value: error ? "—" : safeCount(globalCounts?.closed),
      tone: "neutral" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.state === "7" && !applied.unassigned,
      onClick: () => selectMetric("closed"),
    },
    unassigned: {
      key: "unassigned",
      label: "Sem responsável",
      value: error ? "—" : safeCount(globalCounts?.unassigned),
      tone: "danger" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.unassigned,
      onClick: () => selectMetric("unassigned"),
    },
    manual: {
      key: "manual",
      label: "Manuais",
      value: error ? "—" : safeCount(globalCounts?.manual),
      tone: "info" as const,
      loading: viewMode === "manual" && loading,
      selected: viewMode === "manual",
      onClick: () => selectMetric("manual"),
    },
    duplicates: {
      key: "duplicates",
      label: "Duplicados",
      value: duplicatesError ? "—" : safeCount(duplicatesPayload?.stats?.duplicate_groups),
      tone: "recurrence" as const,
      loading: viewMode === "duplicates" && duplicatesLoading,
      selected: viewMode === "duplicates",
      onClick: () => selectMetric("duplicates"),
    },
  }), [
    applied.state,
    applied.unassigned,
    duplicatesError,
    duplicatesLoading,
    duplicatesPayload?.stats?.duplicate_groups,
    error,
    globalCounts?.closed,
    globalCounts?.in_progress,
    globalCounts?.manual,
    globalCounts?.open,
    globalCounts?.resolved,
    globalCounts?.total,
    globalCounts?.unassigned,
    loading,
    viewMode,
  ]);

  const chamadosMetricStripItems = useMemo(
    () => chamadosMetrics.visibleMetrics.map((metric) => ({
      ...chamadosMetricItemsById[metric.id],
      span: chamadosMetrics.span[metric.id] ?? 1,
      rowSpan: chamadosMetrics.rowSpan[metric.id] ?? 1,
    })),
    [chamadosMetricItemsById, chamadosMetrics.rowSpan, chamadosMetrics.span, chamadosMetrics.visibleMetrics],
  );

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="gap-2 p-2 sm:p-3"
      clientSelect={<SectionAccentTitle level={1}>Chamados</SectionAccentTitle>}
      wallboard={dashboard.isWallboard}
    >
      <ConfigurableDashboard controller={dashboard} className="min-w-0" metricStrip={chamadosMetrics}>
        <ConfigurableDashboardWidget id="operational-summary">
        <ConfigurableMetricStrip
          aria-label="Indicadores de chamados"
          controller={chamadosMetrics}
          editable={dashboard.isEditing}
          items={chamadosMetricStripItems}
        />
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="incidents-table">

        <FilterBar aria-label="Ferramentas da tabela de chamados" className="mb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ChamadosSearchField
              value={draft.search}
              onChange={(search) => setDraft((prev) => ({ ...prev, search }))}
              onSubmit={(search) => {
                cancelIncidentSearch();
                const next = { ...draft, search };
                setDraft(next);
                applyFilters(next);
              }}
              onSelect={(search) => {
                cancelIncidentSearch();
                const next = { ...draft, search };
                setDraft(next);
                applyFilters(next);
              }}
              scope={searchSuggestScope}
            />

            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant={activeFilterCount ? "default" : "outline"} className="h-9">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Filtros
                  {activeFilterCount > 0 ? <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{activeFilterCount}</Badge> : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(44rem,calc(100vw-2rem))] space-y-3 p-4">
                <div>
                  <p className="text-sm font-semibold">Filtros específicos</p>
                  <p className="text-[11px] text-muted-foreground">Abra somente quando precisar refinar a fila.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Cliente
                    <Input value={draft.company} onChange={(event) => setDraft((prev) => ({ ...prev, company: event.target.value }))} placeholder="Nome do cliente" className="ov-filter-control" />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Estado
                    <Select value={draft.unassigned ? "all" : draft.state} onValueChange={(value) => setDraft((prev) => ({ ...prev, state: value, unassigned: false }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{STATE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Prioridade
                    <Select value={draft.priority} onValueChange={(value) => setDraft((prev) => ({ ...prev, priority: value }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{PRIORITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Analista
                    <Select value={draft.unassigned ? "all" : draft.assignedTo} onValueChange={(value) => setDraft((prev) => ({ ...prev, assignedTo: value, unassigned: false }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{assigneeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Canal
                    <Select value={draft.contactType} onValueChange={(value) => setDraft((prev) => ({ ...prev, contactType: value }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{contactTypeOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Caller
                    <Select value={draft.callerId} onValueChange={(value) => setDraft((prev) => ({ ...prev, callerId: value }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{callerOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Última atualização
                    <Select value={draft.period} onValueChange={(value) => setDraft((prev) => ({ ...prev, period: value }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{PERIOD_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <div className="flex items-end">
                    <Button type="button" variant={draft.unassigned ? "default" : "outline"} className="w-full" aria-pressed={draft.unassigned} onClick={() => setDraft((prev) => ({ ...prev, unassigned: !prev.unassigned, assignedTo: "all", state: "all" }))}>
                      Sem responsável
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
                  <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>Limpar</Button>
                  <Button type="button" size="sm" onClick={() => { applyFilters(); setFiltersOpen(false); }}>Aplicar filtros</Button>
                </div>
              </PopoverContent>
            </Popover>

            <ConfigurableTableColumns controller={incidentColumns} />

            {activeFilterCount > 0 ? <Button type="button" size="sm" variant="ghost" className="h-9" onClick={clearFilters}>Limpar filtros</Button> : null}
            {viewMode === "manual" ? <Badge variant="secondary">Manuais: Novo, Em andamento e Em espera</Badge> : null}
            {refreshing ? <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Atualizando</span> : null}
          </div>
        </FilterBar>

        {viewMode === "duplicates" ? (
          <>
            {duplicatesError ? (
              <OperationalErrorBanner
                message={duplicatesError}
                onRetry={() => setViewMode("duplicates")}
              />
            ) : null}
            <SectionPanel
              className="min-w-0"
              bodyClassName="space-y-3 p-3"
              title="Duplicados"
              aside={(
                <p className="text-xs text-muted-foreground">
                  {duplicatesLoading
                    ? "Carregando…"
                    : `${safeCount(duplicatesPayload?.stats?.duplicate_groups)} grupo(s) · ${safeCount(duplicatesPayload?.stats?.incidents_in_duplicate_groups)} INC`}
                </p>
              )}
            >
              {duplicatesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={`dup-skel-${index}`} className="h-28 w-full" />
                  ))}
                </div>
              ) : duplicatesError ? (
                <p className="text-sm text-muted-foreground">Não foi possível carregar duplicados.</p>
              ) : !(duplicatesPayload?.groups?.length) ? (
                <OperationalEmptyState compact title="Nenhum grupo de duplicidade sugerida" />
              ) : (
                <div className="space-y-3">
                  {duplicatesPayload.groups.map((group) => {
                    const primary = group.primaryIncident;
                    const related = group.relatedIncidents || [];
                    return (
                      <div
                        key={group.duplicateKey}
                        className="rounded-lg border border-border/70 bg-card/40 p-3"
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {group.duplicateCount}x DUP
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            Duplicidade sugerida
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            Atualização: {formatDateTime(primary?.updatedAt)}
                          </span>
                        </div>
                        <p className="mb-2 text-sm font-medium text-foreground">
                          {displayValue(group.shortDescription || primary?.shortDescription)}
                        </p>
                        <p className="mb-2 font-mono text-[11px] text-muted-foreground" title="Chave de agrupamento">
                          chave: {group.duplicateKey}
                        </p>
                        <div className="grid gap-2 md:grid-cols-2">
                          <div className="rounded-md border border-border/60 p-2">
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Principal
                            </p>
                            <p className="font-mono text-sm">{displayValue(primary?.number)}</p>
                            <p className="text-xs text-muted-foreground">
                              Cliente: {displayValue(primary?.customer)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Analista: {displayValue(primary?.assignedTo)}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              <ServiceNowDevLink
                                href={primary?.servicenowUrl}
                                sysId={primary?.sysId}
                                identityConflict={primary?.identityConflict}
                                size="sm"
                              />
                              {primary?.relatedAlert?.link ? (
                                <Button asChild size="sm" variant="outline">
                                  <Link to={primary.relatedAlert.link}>Abrir alerta</Link>
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          <div className="rounded-md border border-border/60 p-2">
                            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Relacionados
                            </p>
                            <div className="space-y-2">
                              {related.map((item) => (
                                <div key={item.sysId || item.number || item.shortDescription} className="space-y-1">
                                  <p className="font-mono text-sm">{displayValue(item.number)}</p>
                                  <p className="text-xs text-muted-foreground">
                                    Cliente: {displayValue(item.customer)} · Analista: {displayValue(item.assignedTo)}
                                  </p>
                                  <ServiceNowDevLink
                                    href={item.servicenowUrl}
                                    sysId={item.sysId}
                                    identityConflict={item.identityConflict}
                                    size="sm"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="mt-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setSelectedDuplicateGroup(group)}
                          >
                            Ver evidência
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionPanel>

            <Sheet
              open={Boolean(selectedDuplicateGroup)}
              onOpenChange={(open) => { if (!open) setSelectedDuplicateGroup(null); }}
            >
              <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
                <SheetHeader>
                  <SheetTitle>Evidência de duplicidade</SheetTitle>
                  <SheetDescription>
                    Agrupamento POSSIBLE_DUPLICATE pela mesma descrição normalizada da extensão Snow Notifier.
                  </SheetDescription>
                </SheetHeader>
                {selectedDuplicateGroup ? (
                  <div className="mt-4 space-y-3 text-sm">
                    <div>
                      <p className="text-xs font-medium uppercase text-muted-foreground">duplicateKey</p>
                      <p className="break-all font-mono text-xs">{selectedDuplicateGroup.duplicateKey}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase text-muted-foreground">Descrição normalizada</p>
                      <p className="break-all font-mono text-xs">{selectedDuplicateGroup.duplicateKey}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase text-muted-foreground">Classificação</p>
                      <p>{selectedDuplicateGroup.classification}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase text-muted-foreground">Principal</p>
                      <p className="font-mono">{displayValue(selectedDuplicateGroup.primaryIncident?.number)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase text-muted-foreground">Relacionados</p>
                      <ul className="list-disc pl-4 font-mono text-xs">
                        {selectedDuplicateGroup.relatedIncidents.map((item) => (
                          <li key={item.sysId || item.number}>{displayValue(item.number)} · {displayValue(item.customer)}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </SheetContent>
            </Sheet>
          </>
        ) : (
        <>
        {error ? <OperationalErrorBanner message={error} onRetry={() => applyFilters()} /> : null}

        <SectionPanel
          className="min-w-0"
          bodyClassName="min-w-0 p-0"
          title={viewMode === "manual" ? "Chamados manuais abertos" : "Incidentes"}
          aside={(
            <p className="text-xs leading-snug text-muted-foreground">
              {loading ? "Carregando…" : viewMode === "manual" ? `${safeCount(pagination?.total_items)} manual(is) aberto(s)` : totalLabel}
              {!error && pagination
                ? ` · página ${safeCount(pagination.page)} de ${safeCount(Math.max(Number(pagination.total_pages) || 0, 1))}`
                : ""}
            </p>
          )}
        >
          <Table className={cn(
            "ov-operational-table ov-operational-table--dense w-full table-fixed",
            visibleColumnCount >= 7 ? "min-w-[72rem]" : visibleColumnCount >= 5 ? "min-w-[56rem]" : "min-w-[40rem]",
          )}>
            <colgroup>
              {visibleColumnIds.map((column) => (
                <col key={column} style={{ width: INCIDENT_COLUMN_WIDTH[column] }} />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <TableRow className="hover:bg-transparent">
                {incidentColumns.visibleColumns.map((column) => (
                  <TableHead key={column.id} className="ov-type-caption px-3 py-1.5 font-semibold uppercase tracking-wide text-muted-foreground">
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`skeleton-${index}`} className="hover:bg-transparent">
                    {visibleColumnIds.map((column) => (
                      <TableCell key={`${column}-${index}`}>
                        <Skeleton className="h-4 w-full max-w-[10rem]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : error ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={visibleColumnCount} className="p-4 text-sm text-muted-foreground">
                    Não foi possível carregar os chamados. Use Tentar novamente.
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={visibleColumnCount} className="p-0">
                    <OperationalEmptyState compact title="Nenhum chamado encontrado" />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item, index) => (
                  <TableRow
                    key={incidentKey(item, index)}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={`Abrir detalhes de ${displayValue(item.number)}`}
                    onClick={() => setSelected(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(item);
                      }
                    }}
                  >
                    {visibleColumnIds.map((column) => {
                      if (column === "actions") {
                        return (
                          <TableCell
                            key={column}
                            className="px-2 py-1.5 align-middle"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <IncidentTableActionsCell
                              incident={item}
                              onActionComplete={refreshAfterIncidentAction}
                            />
                          </TableCell>
                        );
                      }
                      if (column === "number") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{displayValue(item.number)}</TableCell>;
                      if (column === "client") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.company_display, item.company)}>{displayValue(item.company_display, item.company)}</TableCell>;
                      if (column === "description") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.short_description)}>{displayValue(item.short_description)}</TableCell>;
                      if (column === "state") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-sm">{displayValue(item.state_display, item.state)}</TableCell>;
                      if (column === "priority") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-sm">{displayValue(item.priority_display, item.priority)}</TableCell>;
                      if (column === "group") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.assignment_group_display, item.assignment_group)}>{displayValue(item.assignment_group_display, item.assignment_group)}</TableCell>;
                      if (column === "assignee") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.assigned_to_display, item.assigned_to)}>{displayValue(item.assigned_to_display, item.assigned_to)}</TableCell>;
                      return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-muted-foreground">{formatDateTime(item.sys_updated_on)}</TableCell>;
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {pagination && pagination.total_pages > 0 ? (
            <div className="flex items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading || !pagination.has_previous}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={loading || !pagination.has_next}
                onClick={() => setPage((current) => current + 1)}
              >
                Próxima
              </Button>
            </div>
          ) : null}
        </SectionPanel>
        </>
        )}
        </ConfigurableDashboardWidget>
      </ConfigurableDashboard>

      <IncidentDetailDrawer
        incident={selected}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        description="Consulta operacional do chamado."
        onActionComplete={refreshAfterIncidentAction}
      />
    </AppLayout>
  );
}
