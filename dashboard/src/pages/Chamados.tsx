import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format, subDays } from "date-fns";
import { ChamadosSearchField } from "@/components/chamados/ChamadosSearchField";
import { AppLayout } from "@/components/layout/AppLayout";
import { ConfigurableMetricStrip } from "@/components/oneview/ConfigurableMetricStrip";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableColumns, OneViewColumnFilterPopover, OneViewFilterableHeader, OneViewTableSortMenu } from "@/components/oneview/ConfigurableTableTools";
import { OneViewTableSearchField, useOneViewCommittedSearch } from "@/components/oneview/OneViewTableSearchField";
import { OperationalFacetChecklist, OperationalFacetMultiSelect } from "@/components/oneview/OperationalFacetMultiSelect";
import { OperationalFilterPanel } from "@/components/oneview/OperationalFilterPanel";
import { ClientFilterCombobox, type ClientFilterOption } from "@/components/oneview/ClientFilterCombobox";
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
  fetchIncidentSearchSuggestions,
  fetchIncidents,
  formatDurationSeconds,
  type DuplicateIncidentGroup,
  type IncidentDuplicatesResponse,
  type IncidentListResponse,
  type FetchIncidentSearchSuggestionsParams,
  type OneViewIncident,
} from "@/lib/oneview-api";
import { incidentSlaLabel } from "@/lib/oneview-incident-sla";
import { resolveIncidentSearch } from "@/lib/oneview-chamados-search";
import { parseAssignedToSysIds } from "@/lib/oneview-operational-incidents";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewMetricStrip } from "@/lib/oneview-metric-strip-preferences";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { operationalColumnPreferredWidth, useOperationalTableLayout } from "@/lib/oneview-operational-table-layout";
import { compactOperationalClientLabel } from "@/components/oneview/ClientIdentity";
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
  { id: "number", label: COLUMNS[0], required: true, minWidth: 112, preferredWidth: 132, responsivePriority: "essential" },
  { id: "client", label: COLUMNS[1], minWidth: 108, preferredWidth: 128, responsivePriority: "essential" },
  { id: "description", label: COLUMNS[2], minWidth: 260, preferredWidth: 380, responsivePriority: "essential" },
  { id: "state", label: COLUMNS[3], minWidth: 118, preferredWidth: 142, responsivePriority: "essential" },
  { id: "priority", label: COLUMNS[4], minWidth: 100, preferredWidth: 118, responsivePriority: "essential" },
  { id: "group", label: COLUMNS[5], minWidth: 132, preferredWidth: 168, responsivePriority: "secondary" },
  { id: "assignee", label: COLUMNS[6], minWidth: 128, preferredWidth: 156, responsivePriority: "intermediate" },
  { id: "duration", label: "Tempo aberto", minWidth: 108, preferredWidth: 124, responsivePriority: "intermediate" },
  { id: "sla", label: "SLA", minWidth: 112, preferredWidth: 138, responsivePriority: "intermediate" },
  { id: "updated", label: COLUMNS[7], minWidth: 126, preferredWidth: 148, responsivePriority: "secondary" },
  { id: "actions", label: "Ações", required: true, minWidth: 116, preferredWidth: 128, responsivePriority: "essential" },
] as const;

type IncidentColumnId = typeof INCIDENT_COLUMN_OPTIONS[number]["id"];
type IncidentSortKey = "updated" | "opened" | "number" | "client" | "description" | "state" | "priority" | "group" | "assignee";
type SortOrder = "asc" | "desc";

const INCIDENT_COLUMN_SORT: Partial<Record<IncidentColumnId, IncidentSortKey>> = {
  number: "number",
  client: "client",
  description: "description",
  state: "state",
  priority: "priority",
  group: "group",
  assignee: "assignee",
  updated: "updated",
};

const INCIDENT_SORT_OPTIONS = [
  { value: "updated:desc", label: "Atualização: mais novos" },
  { value: "updated:asc", label: "Atualização: mais antigos" },
  { value: "opened:desc", label: "Abertura: mais novos" },
  { value: "opened:asc", label: "Abertura: mais antigos" },
  { value: "number:asc", label: "Número: A–Z" },
  { value: "number:desc", label: "Número: Z–A" },
  { value: "client:asc", label: "Cliente: A–Z" },
  { value: "client:desc", label: "Cliente: Z–A" },
  { value: "description:asc", label: "Descrição: A–Z" },
  { value: "description:desc", label: "Descrição: Z–A" },
  { value: "state:asc", label: "Estado: operacional crescente" },
  { value: "state:desc", label: "Estado: operacional decrescente" },
  { value: "priority:asc", label: "Prioridade: maior primeiro" },
  { value: "priority:desc", label: "Prioridade: menor primeiro" },
  { value: "group:asc", label: "Grupo: A–Z" },
  { value: "group:desc", label: "Grupo: Z–A" },
  { value: "assignee:asc", label: "Responsável: A–Z" },
  { value: "assignee:desc", label: "Responsável: Z–A" },
] as const;

function incidentSortFromUrl(value: string | null): IncidentSortKey {
  return (["updated", "opened", "number", "client", "description", "state", "priority", "group", "assignee"] as const).includes(value as IncidentSortKey)
    ? value as IncidentSortKey
    : "updated";
}

const STATE_OPTIONS = [
  { value: "all", label: "Todos" },
  { value: "1", label: "Novo" },
  { value: "2", label: "Em andamento" },
  { value: "3", label: "Em espera" },
  { value: "6", label: "Resolvido" },
  { value: "7", label: "Encerrado" },
  { value: "8", label: "Cancelado(a)" },
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
  { value: "custom", label: "Personalizado" },
] as const;

type DraftFilters = {
  search: string;
  numberSearch: string;
  descriptionSearch: string;
  companies: string[];
  states: string[];
  priorities: string[];
  assignedTo: string[];
  assignmentGroups: string[];
  origin: "all" | "manual" | "automatic";
  period: string;
  customFrom: string;
  customTo: string;
  unassigned: boolean;
};

const EMPTY_DRAFT: DraftFilters = {
  search: "",
  numberSearch: "",
  descriptionSearch: "",
  companies: [],
  states: [],
  priorities: [],
  assignedTo: [],
  assignmentGroups: [],
  origin: "all",
  period: "all",
  customFrom: "",
  customTo: "",
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

function periodBounds(period: string, customFrom = "", customTo = ""): { openedFrom?: string; openedTo?: string } {
  if (period === "custom" && customFrom && customTo) return { openedFrom: customFrom, openedTo: customTo };
  if (period === "all") return {};
  const days = period === "24h" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 0;
  if (!days) return {};
  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), days), "yyyy-MM-dd");
  return { openedFrom: from, openedTo: to };
}

function uniqueCompanies(values: string[]) {
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = String(value || "").trim();
    const key = normalized.toLocaleLowerCase("pt-BR");
    if (normalized && !unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

function repeatedFilterValues(params: URLSearchParams, key: string) {
  return [...new Set(params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
}

export default function ChamadosPage() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({ page: "incidents", actorId });
  const chamadosMetrics = useOneViewMetricStrip({ stripId: "incidents-summary", actorId, definitions: CHAMADOS_METRIC_OPTIONS });
  const incidentTablePageSize = dashboard.layout.widgets.find((item) => item.id === "incidents-table")?.itemLimit ?? PAGE_SIZE;
  const incidentColumns = useOneViewTableColumns({ tableId: "incidents", actorId, definitions: INCIDENT_COLUMN_OPTIONS });
  const incidentTableLayout = useOperationalTableLayout({ columns: incidentColumns.visibleColumns });
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilters = useMemo<DraftFilters>(() => {
    const companies = uniqueCompanies(searchParams.getAll("company"));
    const states = repeatedFilterValues(searchParams, "state").filter((value) => STATE_OPTIONS.some((option) => option.value === value));
    const priorities = repeatedFilterValues(searchParams, "priority").filter((value) => PRIORITY_OPTIONS.some((option) => option.value === value));
    const assignmentGroups = repeatedFilterValues(searchParams, "assignment_group");
    const temporal = searchParams.get("period") === "custom" && searchParams.get("from") && searchParams.get("to")
      ? { period: "custom", customFrom: searchParams.get("from") || "", customTo: searchParams.get("to") || "" }
      : {};
    const base = {
      ...EMPTY_DRAFT,
      ...temporal,
      search: searchParams.get("search") || "",
      numberSearch: searchParams.get("number_search") || "",
      descriptionSearch: searchParams.get("description_search") || "",
      companies,
      states,
      priorities,
      assignmentGroups,
      origin: (["manual", "automatic"] as const).includes(searchParams.get("origin") as "manual" | "automatic")
        ? searchParams.get("origin") as "manual" | "automatic"
        : "all",
      period: searchParams.get("period") || temporal.period || "all",
    } satisfies DraftFilters;
    if (searchParams.get("unassigned") === "true") {
      return { ...base, unassigned: true };
    }
    const assignedIds = parseAssignedToSysIds(repeatedFilterValues(searchParams, "assigned_to").join(","));
    if (assignedIds.length) {
      return { ...base, assignedTo: assignedIds };
    }
    return base;
  }, [searchParams]);
  const [draft, setDraft] = useState<DraftFilters>(initialFilters);
  const [applied, setApplied] = useState<DraftFilters>(initialFilters);
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<IncidentSortKey>(() => incidentSortFromUrl(searchParams.get("sort")));
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => searchParams.get("order") === "asc" ? "asc" : "desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<IncidentListResponse | null>(null);
  const payloadRef = useRef<IncidentListResponse | null>(null);
  const metadataRefreshRef = useRef(-1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [metadataRefreshVersion, setMetadataRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [incidentSearchLoading, setIncidentSearchLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [clientFilterOpen, setClientFilterOpen] = useState(false);
  const [selected, setSelected] = useState<OneViewIncident | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "manual" | "duplicates">("list");
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState<string | null>(null);
  const [duplicatesPayload, setDuplicatesPayload] = useState<IncidentDuplicatesResponse | null>(null);
  const duplicatesPayloadRef = useRef<IncidentDuplicatesResponse | null>(null);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<DuplicateIncidentGroup | null>(null);

  useEffect(() => {
    setPage(1);
  }, [incidentTablePageSize]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (sortField !== "updated") next.set("sort", sortField); else next.delete("sort");
    if (sortOrder !== "desc") next.set("order", sortOrder); else next.delete("order");
    if (applied.search) next.set("search", applied.search);
    if (applied.numberSearch) next.set("number_search", applied.numberSearch);
    if (applied.descriptionSearch) next.set("description_search", applied.descriptionSearch);
    for (const value of applied.companies) next.append("company", value);
    for (const value of applied.states) next.append("state", value);
    for (const value of applied.priorities) next.append("priority", value);
    for (const value of applied.assignedTo) next.append("assigned_to", value);
    for (const value of applied.assignmentGroups) next.append("assignment_group", value);
    if (applied.origin !== "all") next.set("origin", applied.origin);
    if (applied.period !== "all") next.set("period", applied.period);
    if (applied.period === "custom" && applied.customFrom && applied.customTo) {
      next.set("from", applied.customFrom);
      next.set("to", applied.customTo);
    }
    if (applied.unassigned) next.set("unassigned", "true");
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [applied, searchParams, setSearchParams, sortField, sortOrder]);

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
    incidentSearchIntent.current = { id: ++incidentSearchIntentId.current, value: search };
    setIncidentSearchLoading(true);
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setApplied((current) => ({ ...current, search }));
  }, [applied.search]);
  const { cancelPending: cancelIncidentSearch } = useOneViewCommittedSearch(
    draft.search,
    commitIncidentSearch,
  );
  const incidentSearchIntent = useRef<{ id: number; value: string } | null>(null);
  const incidentSearchIntentId = useRef(0);

  useEffect(() => {
    if (viewMode === "duplicates") return;
    const controller = new AbortController();
    const searchIntent = incidentSearchIntent.current?.value === applied.search ? incidentSearchIntent.current : null;
    if (payloadRef.current) setRefreshing(true);
    else {
      setLoading(true);
      setError(null);
    }
    const period = periodBounds(applied.period, applied.customFrom, applied.customTo);
    const searchParams = resolveIncidentSearch(applied.search);
    // Poll de 15 s atualiza somente a tabela. Metadados globais são renovados
    // no primeiro load, em mudanças de filtro e após actions relevantes.
    const includeMetadata = !payloadRef.current || metadataRefreshRef.current !== metadataRefreshVersion;
    const listParams = {
      page,
      pageSize: incidentTablePageSize,
      search: searchParams.search,
      number: searchParams.number,
      numberSearch: applied.numberSearch || undefined,
      descriptionSearch: applied.descriptionSearch || undefined,
      companies: applied.companies,
      states: applied.states,
      priorities: applied.priorities,
      assignedToIds: applied.assignedTo,
      assignmentGroups: applied.assignmentGroups,
      origin: applied.origin === "all" ? undefined : applied.origin,
      manual: viewMode === "manual",
      unassigned: applied.unassigned && applied.assignedTo.length === 0 ? true : undefined,
      includeUnassigned: applied.unassigned && applied.assignedTo.length > 0 ? true : undefined,
      openedFrom: period.openedFrom,
      openedTo: period.openedTo,
      sort: sortField,
      order: sortOrder,
      signal: controller.signal,
    } as const;

    fetchIncidents({
      ...listParams,
      includeCounts: false,
      includeGlobalCounts: false,
      includeFacets: false,
    })
      .then((response) => {
        if (controller.signal.aborted) return null;
        const previous = payloadRef.current;
        const next = {
          ...response,
          counts: response.counts ?? previous?.counts,
          global_counts: response.global_counts ?? previous?.global_counts,
          facets: response.facets ?? previous?.facets,
        };
        payloadRef.current = next;
        setPayload(next);
        setLoading(false);
        if (!includeMetadata) return null;
        return fetchIncidents({
          ...listParams,
          includeItems: false,
          includeCounts: true,
          includeGlobalCounts: true,
          includeFacets: true,
        });
      })
      .then((meta) => {
        if (!meta || controller.signal.aborted) return;
        const table = payloadRef.current;
        const combined = {
          ...meta,
          items: table?.items ?? meta.items,
          pagination: table?.pagination ?? meta.pagination,
        };
        metadataRefreshRef.current = metadataRefreshVersion;
        payloadRef.current = combined;
        setPayload(combined);
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
        if (searchIntent && incidentSearchIntent.current?.id === searchIntent.id) {
          incidentSearchIntent.current = null;
          setIncidentSearchLoading(false);
        }
      });

    return () => controller.abort();
  }, [applied, incidentTablePageSize, metadataRefreshVersion, page, refreshVersion, sortField, sortOrder, viewMode]);

  useEffect(() => {
    if (viewMode !== "duplicates") return;
    const controller = new AbortController();
    if (!duplicatesPayloadRef.current) setDuplicatesLoading(true);
    fetchIncidentDuplicates({
      customers: applied.companies,
      assignedTo: applied.unassigned
        ? undefined
        : (applied.assignedTo.length ? applied.assignedTo.join(",") : undefined),
      priority: applied.priorities.length ? applied.priorities.join(",") : undefined,
      state: applied.unassigned ? undefined : (applied.states.length ? applied.states.join(",") : undefined),
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        duplicatesPayloadRef.current = response;
        setDuplicatesPayload(response);
        setDuplicatesError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDuplicatesError("Duplicados indisponíveis");
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) setDuplicatesLoading(false);
      });
    return () => controller.abort();
  }, [applied, refreshVersion, viewMode]);

  const items = payload?.items ?? [];
  const incidentSearchActivity = draft.search !== applied.search ? "pending" : incidentSearchLoading ? "searching" : "idle";
  const pagination = payload?.pagination;
  const globalCounts = payload?.global_counts;
  const visibleColumnIds = incidentTableLayout.visibleColumns.map((column) => column.id);
  const visibleColumnCount = visibleColumnIds.length;
  const activeFilterCount = Number(draft.companies.length > 0)
    + Number(Boolean(draft.numberSearch))
    + Number(Boolean(draft.descriptionSearch))
    + Number(draft.states.length > 0)
    + Number(draft.priorities.length > 0)
    + Number(draft.assignedTo.length > 0)
    + Number(draft.assignmentGroups.length > 0)
    + Number(draft.origin !== "all")
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

  const clientOptions = useMemo<ClientFilterOption[]>(() => {
    const map = new Map<string, ClientFilterOption>();
    map.set("all", { key: "all", name: "Todos" });
    for (const facet of payload?.facets?.companies ?? []) {
      const name = String(facet.display_value || facet.label || facet.value || "").trim();
      if (!name) continue;
      const key = name.toLocaleLowerCase("pt-BR");
      const previous = map.get(key);
      map.set(key, {
        key: name,
        name,
        alerts_count: (previous?.alerts_count ?? 0) + (Number(facet.count) || 0),
      });
    }
    for (const company of draft.companies) {
      const key = company.toLocaleLowerCase("pt-BR");
      if (!map.has(key)) map.set(key, { key: company, name: company });
    }
    return [...map.values()];
  }, [draft.companies, payload?.facets?.companies]);

  const selectedClientLabel = draft.companies.length === 0
    ? "TODOS"
    : draft.companies.length === 1
      ? compactOperationalClientLabel(draft.companies[0], draft.companies[0])
      : `${draft.companies.length} clientes`;

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
    for (const assignedTo of applied.assignedTo) {
      if (!map.has(assignedTo)) map.set(assignedTo, { value: assignedTo, label: assignedTo });
    }
    return [...map.values()];
  }, [payload?.facets?.assignees, applied.assignedTo]);

  const assignmentGroupOptions = useMemo(() => [{ value: "all", label: "Todos" }, ...(payload?.facets?.assignment_groups ?? []).map((facet) => ({
    value: String(facet.value), label: String(facet.display_value || facet.label || facet.value),
  }))], [payload?.facets?.assignment_groups]);

  const appliedFilterChips = [
    ...applied.companies.map((value) => ({ key: `company:${value}`, label: `Cliente: ${value}`, remove: () => applyColumnFilter({ companies: applied.companies.filter((item) => item !== value) }) })),
    ...applied.states.map((value) => ({ key: `state:${value}`, label: `Estado: ${STATE_OPTIONS.find((option) => option.value === value)?.label || value}`, remove: () => applyColumnFilter({ states: applied.states.filter((item) => item !== value) }) })),
    ...applied.priorities.map((value) => ({ key: `priority:${value}`, label: `Prioridade: ${PRIORITY_OPTIONS.find((option) => option.value === value)?.label || value}`, remove: () => applyColumnFilter({ priorities: applied.priorities.filter((item) => item !== value) }) })),
    ...applied.assignedTo.map((value) => ({ key: `assignee:${value}`, label: `Responsável: ${assigneeOptions.find((option) => option.value === value)?.label || value}`, remove: () => applyColumnFilter({ assignedTo: applied.assignedTo.filter((item) => item !== value) }) })),
    ...applied.assignmentGroups.map((value) => ({ key: `group:${value}`, label: `Grupo: ${assignmentGroupOptions.find((option) => option.value === value)?.label || value}`, remove: () => applyColumnFilter({ assignmentGroups: applied.assignmentGroups.filter((item) => item !== value) }) })),
    ...(applied.numberSearch ? [{ key: "number", label: `Número: ${applied.numberSearch}`, remove: () => applyColumnFilter({ numberSearch: "" }) }] : []),
    ...(applied.descriptionSearch ? [{ key: "description", label: `Descrição: ${applied.descriptionSearch}`, remove: () => applyColumnFilter({ descriptionSearch: "" }) }] : []),
    ...(applied.search ? [{ key: "search", label: `Busca: ${applied.search}`, remove: () => applyColumnFilter({ search: "" }) }] : []),
    ...(applied.origin !== "all" ? [{ key: "origin", label: `Origem: ${applied.origin === "manual" ? "Manual" : "Automática"}`, remove: () => applyColumnFilter({ origin: "all" }) }] : []),
    ...(applied.period !== "all" ? [{ key: "period", label: `Abertura: ${PERIOD_OPTIONS.find((option) => option.value === applied.period)?.label || applied.period}`, remove: () => applyColumnFilter({ period: "all", customFrom: "", customTo: "" }) }] : []),
    ...(applied.unassigned ? [{ key: "unassigned", label: "Sem responsável", remove: () => applyColumnFilter({ unassigned: false }) }] : []),
  ];

  const searchSuggestScope = useMemo((): Omit<FetchIncidentSearchSuggestionsParams, "q" | "limit" | "signal"> => {
    const period = periodBounds(applied.period, applied.customFrom, applied.customTo);
    return {
      // Não restringir sugestões ao cliente já selecionado: isso permite
      // adicionar outros clientes pela mesma barra de pesquisa.
      states: applied.states,
      priorities: applied.priorities,
      assignedToIds: applied.assignedTo,
      assignmentGroups: applied.assignmentGroups,
      origin: applied.origin === "all" ? undefined : applied.origin,
      manual: viewMode === "manual",
      unassigned: applied.unassigned && applied.assignedTo.length === 0 ? true : undefined,
      includeUnassigned: applied.unassigned && applied.assignedTo.length > 0 ? true : undefined,
      updatedFrom: period.openedFrom,
      updatedTo: period.openedTo,
    };
  }, [applied, viewMode]);

  const fetchIncidentNumberSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchIncidentSearchSuggestions({ ...searchSuggestScope, q, kind: "number", limit: 8, signal })
      .then((response) => (response.suggestions ?? []).filter((item) => item.kind === "number"))
  ), [searchSuggestScope]);
  const fetchIncidentDescriptionSuggestions = useCallback((q: string, signal: AbortSignal) => (
    fetchIncidentSearchSuggestions({ ...searchSuggestScope, q, kind: "description", limit: 8, signal })
      .then((response) => (response.suggestions ?? []).filter((item) => item.kind === "description"))
  ), [searchSuggestScope]);

  function applyFilters(next: DraftFilters = draft, _requestMode: "full" | "metric" = "full") {
    cancelIncidentSearch();
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setApplied({
      ...next,
      search: next.search.trim(),
      companies: uniqueCompanies(next.companies),
    });
  }

  function applyColumnFilter(patch: Partial<DraftFilters>) {
    setDraft((current) => ({ ...current, ...patch }));
    setApplied((current) => ({ ...current, ...patch }));
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
  }

  function clearFilters() {
    cancelIncidentSearch();
    setClientFilterOpen(false);
    incidentSearchIntent.current = null;
    setIncidentSearchLoading(false);
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setPage(1);
    setMetadataRefreshVersion((current) => current + 1);
    setViewMode("list");
  }

  function applyIncidentSort(value: string) {
    const [field, order] = value.split(":") as [IncidentSortKey, SortOrder];
    setSortField(incidentSortFromUrl(field));
    setSortOrder(order === "asc" ? "asc" : "desc");
    setPage(1);
  }

  function toggleIncidentSort(field: IncidentSortKey) {
    const defaultOrder: SortOrder = field === "updated" || field === "opened" || field === "priority" || field === "state" ? "desc" : "asc";
    setSortOrder((current) => sortField === field ? current === "asc" ? "desc" : "asc" : defaultOrder);
    setSortField(field);
    setPage(1);
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
      const next = { ...draft, states: [], unassigned: false, origin: "all" as const };
      setDraft(next);
      applyFilters(next, "metric");
      return;
    }
    setViewMode("list");
    setSelectedDuplicateGroup(null);
    const next: DraftFilters = {
      ...draft,
      unassigned: kind === "unassigned",
      assignedTo: kind === "unassigned" ? [] : draft.assignedTo,
      states: kind === "open"
        ? ["1"]
        : kind === "in_progress"
          ? ["2"]
          : kind === "resolved"
            ? ["6"]
            : kind === "closed"
              ? ["7"]
              : [],
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
      selected: viewMode === "list" && applied.states.length === 0 && !applied.unassigned,
      onClick: () => selectMetric("total"),
    },
    open: {
      key: "open",
      label: "Abertos",
      value: error ? "—" : safeCount(globalCounts?.open),
      tone: "info" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.states.length === 1 && applied.states[0] === "1" && !applied.unassigned,
      onClick: () => selectMetric("open"),
    },
    in_progress: {
      key: "in_progress",
      label: "Em andamento",
      value: error ? "—" : safeCount(globalCounts?.in_progress),
      tone: "warning" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.states.length === 1 && applied.states[0] === "2" && !applied.unassigned,
      onClick: () => selectMetric("in_progress"),
    },
    resolved: {
      key: "resolved",
      label: "Resolvidos",
      value: error ? "—" : safeCount(globalCounts?.resolved),
      tone: "success" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.states.length === 1 && applied.states[0] === "6" && !applied.unassigned,
      onClick: () => selectMetric("resolved"),
    },
    closed: {
      key: "closed",
      label: "Encerrados",
      value: error ? "—" : safeCount(globalCounts?.closed),
      tone: "neutral" as const,
      loading: viewMode === "list" && loading,
      selected: viewMode === "list" && applied.states.length === 1 && applied.states[0] === "7" && !applied.unassigned,
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
    applied.states,
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

  const incidentColumnFilter = (column: IncidentColumnId) => {
    if (column === "number") return (
      <OneViewColumnFilterPopover label="Filtrar número do incidente" kind="search" activeCount={applied.numberSearch ? 1 : 0}>
        <p className="mb-2 text-xs font-semibold">Número do incidente</p>
        <OneViewTableSearchField
          value={draft.numberSearch}
          onChange={(numberSearch) => setDraft((current) => ({ ...current, numberSearch: numberSearch.toUpperCase().slice(0, 40) }))}
          onSubmit={(numberSearch) => applyColumnFilter({ numberSearch: numberSearch.trim().toUpperCase().slice(0, 40) })}
          onSuggestionSelect={(item) => item.kind === "number" && applyColumnFilter({ numberSearch: item.value.toUpperCase() })}
          fetchSuggestions={fetchIncidentNumberSuggestions}
          placeholder="INC0094..."
          ariaLabel="Pesquisar número do incidente"
          getSuggestionActionLabel={(item) => item.kind === "number" ? "Filtrar incidente" : null}
        />
        {applied.numberSearch ? <Button type="button" variant="ghost" size="sm" className="mt-2 h-7" onClick={() => applyColumnFilter({ numberSearch: "" })}>Limpar</Button> : null}
      </OneViewColumnFilterPopover>
    );
    if (column === "client") return (
      <OneViewColumnFilterPopover label="Filtrar clientes" kind="search" activeCount={applied.companies.length}>
        <p className="mb-1 text-xs font-semibold">Clientes</p>
        <OperationalFacetChecklist
          options={clientOptions.filter((option) => option.key !== "all").map((option) => ({ value: option.key, label: option.name, count: option.alerts_count }))}
          selectedValues={applied.companies}
          onChange={(companies) => applyColumnFilter({ companies: uniqueCompanies(companies) })}
          allLabel="Todos os clientes"
          searchPlaceholder="Buscar cliente..."
        />
      </OneViewColumnFilterPopover>
    );
    if (column === "description") return (
      <OneViewColumnFilterPopover label="Filtrar descrição" kind="search" activeCount={applied.descriptionSearch ? 1 : 0}>
        <p className="mb-2 text-xs font-semibold">Descrição</p>
        <OneViewTableSearchField
          value={draft.descriptionSearch}
          onChange={(descriptionSearch) => setDraft((current) => ({ ...current, descriptionSearch: descriptionSearch.slice(0, 80) }))}
          onSubmit={(descriptionSearch) => applyColumnFilter({ descriptionSearch: descriptionSearch.trim().slice(0, 80) })}
          onSuggestionSelect={(item) => item.kind === "description" && applyColumnFilter({ descriptionSearch: item.value.slice(0, 80) })}
          fetchSuggestions={fetchIncidentDescriptionSuggestions}
          placeholder="Pesquisar descrição..."
          ariaLabel="Pesquisar descrição do chamado"
          normalizeInc={false}
          getSuggestionActionLabel={(item) => item.kind === "description" ? "Filtrar descrição" : null}
        />
        {applied.descriptionSearch ? <Button type="button" variant="ghost" size="sm" className="mt-2 h-7" onClick={() => applyColumnFilter({ descriptionSearch: "" })}>Limpar</Button> : null}
      </OneViewColumnFilterPopover>
    );
    if (column === "state") return (
      <OneViewColumnFilterPopover label="Filtrar estados" activeCount={applied.states.length}>
        <p className="mb-1 text-xs font-semibold">Estados</p>
        <OperationalFacetChecklist options={STATE_OPTIONS.filter((option) => option.value !== "all")} selectedValues={applied.states} onChange={(states) => applyColumnFilter({ states })} allLabel="Todos" searchPlaceholder="Buscar estado..." />
      </OneViewColumnFilterPopover>
    );
    if (column === "priority") return (
      <OneViewColumnFilterPopover label="Filtrar prioridades" activeCount={applied.priorities.length}>
        <p className="mb-1 text-xs font-semibold">Prioridades</p>
        <OperationalFacetChecklist options={PRIORITY_OPTIONS.filter((option) => option.value !== "all")} selectedValues={applied.priorities} onChange={(priorities) => applyColumnFilter({ priorities })} allLabel="Todas" searchPlaceholder="Buscar prioridade..." />
      </OneViewColumnFilterPopover>
    );
    if (column === "group") return (
      <OneViewColumnFilterPopover label="Filtrar grupos" activeCount={applied.assignmentGroups.length}>
        <p className="mb-1 text-xs font-semibold">Grupos</p>
        <OperationalFacetChecklist options={assignmentGroupOptions.filter((option) => option.value !== "all")} selectedValues={applied.assignmentGroups} onChange={(assignmentGroups) => applyColumnFilter({ assignmentGroups })} allLabel="Todos" searchPlaceholder="Buscar grupo..." />
      </OneViewColumnFilterPopover>
    );
    if (column === "assignee") {
      const selected = [...applied.assignedTo, ...(applied.unassigned ? ["__unassigned"] : [])];
      return (
        <OneViewColumnFilterPopover label="Filtrar responsáveis" activeCount={selected.length}>
          <p className="mb-1 text-xs font-semibold">Responsáveis</p>
          <OperationalFacetChecklist
            options={[{ value: "__unassigned", label: "Sem responsável" }, ...assigneeOptions.filter((option) => option.value !== "all")]}
            selectedValues={selected}
            onChange={(values) => applyColumnFilter({ assignedTo: values.filter((value) => value !== "__unassigned"), unassigned: values.includes("__unassigned") })}
            allLabel="Todos"
            searchPlaceholder="Buscar analista..."
          />
        </OneViewColumnFilterPopover>
      );
    }
    return null;
  };

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
          <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(18rem,1fr)_auto] lg:items-center">
            <ChamadosSearchField
              value={draft.search}
              onChange={(search) => setDraft((prev) => ({ ...prev, search }))}
              onSubmit={(search) => {
                cancelIncidentSearch();
                const next = { ...draft, search };
                incidentSearchIntent.current = { id: ++incidentSearchIntentId.current, value: search };
                setIncidentSearchLoading(true);
                setDraft(next);
                applyFilters(next);
              }}
              onSelect={(search) => {
                cancelIncidentSearch();
                const next = { ...draft, search };
                incidentSearchIntent.current = { id: ++incidentSearchIntentId.current, value: search };
                setIncidentSearchLoading(true);
                setDraft(next);
                applyFilters(next);
              }}
              onSuggestionSelect={(suggestion) => {
                cancelIncidentSearch();
                if (suggestion.kind === "company") {
                  incidentSearchIntent.current = null;
                  setIncidentSearchLoading(false);
                  const next = {
                    ...draft,
                    companies: uniqueCompanies([...draft.companies, suggestion.value]),
                    search: "",
                  };
                  setDraft(next);
                  applyFilters(next);
                  return;
                }
                const next = { ...draft, search: suggestion.value };
                incidentSearchIntent.current = { id: ++incidentSearchIntentId.current, value: suggestion.value };
                setIncidentSearchLoading(true);
                setDraft(next);
                applyFilters(next);
              }}
              scope={searchSuggestScope}
              selectedCompanies={draft.companies}
              activity={incidentSearchActivity}
              activityQuery={applied.search}
            />

            <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            <OperationalFilterPanel
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              activeFilterCount={activeFilterCount}
              description="Abra somente quando precisar refinar a fila."
              footer={(
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={clearFilters}>Limpar</Button>
                  <Button type="button" size="sm" onClick={() => { applyFilters(); setFiltersOpen(false); }}>Aplicar filtros</Button>
                </div>
              )}
            >
                <div className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                    <span className="block">Cliente</span>
                    <ClientFilterCombobox
                      open={clientFilterOpen}
                      onOpenChange={setClientFilterOpen}
                      options={clientOptions}
                      selectedKeys={draft.companies}
                      selectedLabel={selectedClientLabel}
                      onToggle={(company) => setDraft((prev) => ({
                        ...prev,
                        companies: company === "all"
                          ? []
                          : prev.companies.some((item) => item.toLocaleLowerCase("pt-BR") === company.toLocaleLowerCase("pt-BR"))
                            ? prev.companies.filter((item) => item.toLocaleLowerCase("pt-BR") !== company.toLocaleLowerCase("pt-BR"))
                            : uniqueCompanies([...prev.companies, company]),
                      }))}
                      triggerClassName="w-full"
                      countNoun="chamados neste filtro"
                    />
                  </div>
                  <label className="space-y-1 text-xs text-muted-foreground">Número do incidente
                    <Input value={draft.numberSearch} onChange={(event) => setDraft((prev) => ({ ...prev, numberSearch: event.target.value.toUpperCase().slice(0, 40) }))} placeholder="INC0094..." className="h-9" />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">Descrição
                    <Input value={draft.descriptionSearch} onChange={(event) => setDraft((prev) => ({ ...prev, descriptionSearch: event.target.value.slice(0, 80) }))} placeholder="Pesquisar descrição..." className="h-9" />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">Estado
                    <OperationalFacetMultiSelect label="Estado" options={STATE_OPTIONS.filter((option) => option.value !== "all")} selectedValues={draft.states} onChange={(states) => setDraft((prev) => ({ ...prev, states }))} allLabel="Todos" searchPlaceholder="Buscar estado..." />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">Prioridade
                    <OperationalFacetMultiSelect label="Prioridade" options={PRIORITY_OPTIONS.filter((option) => option.value !== "all")} selectedValues={draft.priorities} onChange={(priorities) => setDraft((prev) => ({ ...prev, priorities }))} allLabel="Todas" searchPlaceholder="Buscar prioridade..." />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">Analista
                    <OperationalFacetMultiSelect label="Analista" options={assigneeOptions.filter((option) => option.value !== "all")} selectedValues={draft.assignedTo} onChange={(assignedTo) => setDraft((prev) => ({ ...prev, assignedTo }))} allLabel="Todos" searchPlaceholder="Buscar analista..." />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">Grupo
                    <OperationalFacetMultiSelect label="Grupo" options={assignmentGroupOptions.filter((option) => option.value !== "all")} selectedValues={draft.assignmentGroups} onChange={(assignmentGroups) => setDraft((prev) => ({ ...prev, assignmentGroups }))} allLabel="Todos" searchPlaceholder="Buscar grupo..." />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Origem
                    <Select value={draft.origin} onValueChange={(value) => setDraft((prev) => ({ ...prev, origin: value as DraftFilters["origin"] }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="all">Todos</SelectItem><SelectItem value="automatic">Automático</SelectItem><SelectItem value="manual">Manual</SelectItem></SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    Abertura
                    <Select value={draft.period} onValueChange={(value) => setDraft((prev) => ({ ...prev, period: value }))}>
                      <SelectTrigger className="ov-filter-control"><SelectValue /></SelectTrigger>
                      <SelectContent>{PERIOD_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  {draft.period === "custom" ? (
                    <div className="grid grid-cols-2 gap-2 sm:col-span-2">
                      <label className="space-y-1 text-xs text-muted-foreground">De
                        <Input type="datetime-local" value={draft.customFrom.replace(/Z$/, "").slice(0, 16)} onChange={(event) => setDraft((prev) => ({ ...prev, customFrom: event.target.value ? new Date(event.target.value).toISOString() : "" }))} />
                      </label>
                      <label className="space-y-1 text-xs text-muted-foreground">Até
                        <Input type="datetime-local" value={draft.customTo.replace(/Z$/, "").slice(0, 16)} onChange={(event) => setDraft((prev) => ({ ...prev, customTo: event.target.value ? new Date(event.target.value).toISOString() : "" }))} />
                      </label>
                    </div>
                  ) : null}
                  <div className="flex items-end">
                    <Button type="button" variant={draft.unassigned ? "default" : "outline"} className="w-full" aria-pressed={draft.unassigned} onClick={() => setDraft((prev) => ({ ...prev, unassigned: !prev.unassigned }))}>
                      Sem responsável
                    </Button>
                  </div>
                </div>
            </OperationalFilterPanel>

            <OneViewTableSortMenu
              value={`${sortField}:${sortOrder}`}
              options={[...INCIDENT_SORT_OPTIONS]}
              onChange={applyIncidentSort}
              label="Ordenar chamados"
            />
            <ConfigurableTableColumns
              controller={incidentColumns}
              responsive={{
                autoHiddenCount: incidentTableLayout.autoHiddenColumns.length,
                showAllColumns: incidentTableLayout.showAllColumns,
                onShowAllColumnsChange: incidentTableLayout.setShowAllColumns,
              }}
            />

            {activeFilterCount > 0 ? <Button type="button" size="sm" variant="ghost" className="h-9" onClick={clearFilters}>Limpar filtros</Button> : null}
            {viewMode === "manual" ? <Badge variant="secondary">Manuais: Novo, Em andamento e Em espera</Badge> : null}
            </div>
          </div>
        </FilterBar>

        {appliedFilterChips.length ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Filtros ativos">
            {appliedFilterChips.map((chip) => <Button key={chip.key} type="button" size="sm" variant="outline" className="h-7 max-w-full truncate px-2 text-xs" onClick={chip.remove}>{chip.label} ×</Button>)}
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={clearFilters}>Limpar todos</Button>
          </div>
        ) : null}

        {viewMode === "duplicates" ? (
          <>
            {duplicatesError ? (
              <OperationalErrorBanner
                message={duplicatesError}
                onRetry={() => setRefreshVersion((current) => current + 1)}
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
              {duplicatesLoading && !duplicatesPayload?.groups?.length ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={`dup-skel-${index}`} className="h-28 w-full" />
                  ))}
                </div>
              ) : duplicatesError && !duplicatesPayload?.groups?.length ? (
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
          className="ov-operational-responsive min-w-0"
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
          <div ref={incidentTableLayout.containerRef} className="min-w-0 overflow-x-auto">
          <Table
            className="ov-operational-table ov-operational-table--dense w-full table-fixed"
            style={{ minWidth: `${incidentTableLayout.minimumTableWidth}px` }}
          >
            <colgroup>
              {incidentTableLayout.visibleColumns.map((column) => (
                <col key={column.id} style={{ width: `${operationalColumnPreferredWidth(column)}px` }} />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <TableRow className="bg-background/95 hover:bg-background/95">
                {incidentTableLayout.visibleColumns.map((column) => {
                  const field = INCIDENT_COLUMN_SORT[column.id];
                  const active = field === sortField;
                  return (
                    <TableHead
                      key={column.id}
                      aria-sort={field ? active ? sortOrder === "asc" ? "ascending" : "descending" : "none" : undefined}
                      className={cn(
                        "ov-type-caption overflow-hidden px-3 py-1.5 font-semibold uppercase tracking-wide text-muted-foreground",
                        column.id === "actions" && "sticky right-0 z-20 bg-inherit text-center",
                      )}
                    >
                      <OneViewFilterableHeader
                        label={column.label}
                        active={active}
                        direction={sortOrder}
                        onSort={field ? () => toggleIncidentSort(field) : undefined}
                        filter={incidentColumnFilter(column.id)}
                      />
                    </TableHead>
                  );
                })}
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
                    className="group cursor-pointer bg-background"
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
                            className="sticky right-0 z-10 bg-inherit px-2 py-1.5 align-middle transition-colors group-hover:bg-muted/50"
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
                      if (column === "client") {
                        const fullClientName = displayValue(item.company_display, item.company);
                        return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm font-medium" title={fullClientName}>{compactOperationalClientLabel(fullClientName, fullClientName)}</TableCell>;
                      }
                      if (column === "description") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.short_description)}>{displayValue(item.short_description)}</TableCell>;
                      if (column === "state") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-sm">{displayValue(item.state_display, item.state)}</TableCell>;
                      if (column === "priority") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-sm">{displayValue(item.priority_display, item.priority)}</TableCell>;
                      if (column === "group") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.assignment_group_display, item.assignment_group)}>{displayValue(item.assignment_group_display, item.assignment_group)}</TableCell>;
                      if (column === "assignee") return <TableCell key={column} className="max-w-0 truncate px-3 py-1.5 text-sm" title={displayValue(item.assigned_to_display, item.assigned_to)}>{displayValue(item.assigned_to_display, item.assigned_to)}</TableCell>;
                      if (column === "duration") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums">{formatDurationSeconds(item.open_duration_seconds)}</TableCell>;
                      if (column === "sla") return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-xs" title={item.sla_summary?.name || undefined}>{incidentSlaLabel(item.sla_summary)}</TableCell>;
                      return <TableCell key={column} className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-muted-foreground">{formatDateTime(item.sys_updated_on)}</TableCell>;
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          </div>

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
