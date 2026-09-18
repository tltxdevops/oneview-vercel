import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format, subDays } from "date-fns";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import { ConfigurableDashboard, ConfigurableDashboardWidget } from "@/components/oneview/ConfigurableDashboard";
import { ConfigurableTableColumns } from "@/components/oneview/ConfigurableTableTools";
import { FilterBar } from "@/components/oneview/FilterBar";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  fetchIncidentRelatedAlert,
  fetchIncidents,
  fetchServiceNowIncidentActionOptions,
  fetchServiceNowIncidentActionStatus,
  requestServiceNowIncidentAction,
  type DuplicateIncidentGroup,
  type IncidentDuplicatesResponse,
  type IncidentListResponse,
  type IncidentRelatedAlert,
  type OneViewIncident,
  type ServiceNowIncidentAction,
  type ServiceNowIncidentActionOptions,
  type ServiceNowIncidentActionStatus,
} from "@/lib/oneview-api";
import { parseAssignedToSysIds } from "@/lib/oneview-operational-incidents";
import { useOneViewDashboardLayout } from "@/lib/oneview-dashboard-controller";
import { useOneViewTableColumns } from "@/lib/oneview-table-preferences";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/context/AuthContext";

/** SN-P0-28 — busca ^INC\d+$ → number exato no BFF. */
const INCIDENT_EXACT_NUMBER_SEARCH_RE = /^INC\d+$/i;

function resolveIncidentSearch(search: string): { search?: string; number?: string } {
  const trimmed = search.trim();
  if (!trimmed) return {};
  if (INCIDENT_EXACT_NUMBER_SEARCH_RE.test(trimmed)) {
    return { number: trimmed.toUpperCase() };
  }
  return { search: trimmed };
}


const PAGE_SIZE = 25;

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

const INCIDENT_COLUMN_OPTIONS = [
  { id: "number", label: COLUMNS[0], required: true },
  { id: "client", label: COLUMNS[1] },
  { id: "description", label: COLUMNS[2] },
  { id: "state", label: COLUMNS[3] },
  { id: "priority", label: COLUMNS[4] },
  { id: "group", label: COLUMNS[5] },
  { id: "assignee", label: COLUMNS[6] },
  { id: "updated", label: COLUMNS[7] },
] as const;

type IncidentColumnId = typeof INCIDENT_COLUMN_OPTIONS[number]["id"];

/** Larguras fixas — tabela rola horizontalmente em vez de cortar colunas. */
const INCIDENT_COLUMN_WIDTH: Record<IncidentColumnId, string> = {
  number: "8%",
  client: "12%",
  description: "28%",
  state: "10%",
  priority: "9%",
  group: "12%",
  assignee: "12%",
  updated: "9%",
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

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{value}</p>
    </div>
  );
}

function alertSeverityLabel(value: string | null | undefined) {
  return displayValue(value);
}

function alertStatusLabel(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "active") return "Ativo";
  if (key === "resolved") return "Resolvido";
  return displayValue(value);
}

export default function ChamadosPage() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email || "anonymous";
  const dashboard = useOneViewDashboardLayout({ page: "incidents", actorId });
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
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<OneViewIncident | null>(null);
  const [relatedAlert, setRelatedAlert] = useState<IncidentRelatedAlert | null>(null);
  const [relatedAlertLoading, setRelatedAlertLoading] = useState(false);
  const [relatedAlertChecked, setRelatedAlertChecked] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "duplicates">("list");
  const [duplicatesLoading, setDuplicatesLoading] = useState(false);
  const [duplicatesError, setDuplicatesError] = useState<string | null>(null);
  const [duplicatesPayload, setDuplicatesPayload] = useState<IncidentDuplicatesResponse | null>(null);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<DuplicateIncidentGroup | null>(null);

  useEffect(() => {
    setPage(1);
  }, [incidentTablePageSize]);

  useEffect(() => {
    if (viewMode !== "list") return;
    const refresh = () => {
      if (document.visibilityState === "visible") setRefreshVersion((current) => current + 1);
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [viewMode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = draft.search.trim();
      if (search === applied.search) return;
      setPage(1);
      setApplied((current) => ({ ...current, search }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [applied.search, draft.search]);

  useEffect(() => {
    if (viewMode !== "list") return;
    const controller = new AbortController();
    if (payloadRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const period = periodBounds(applied.period);
    const searchParams = resolveIncidentSearch(applied.search);

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
      unassigned: applied.unassigned || undefined,
      updatedFrom: period.openedFrom,
      updatedTo: period.openedTo,
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        payloadRef.current = response;
        setPayload(response);
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
  }, [applied, incidentTablePageSize, page, refreshVersion, viewMode]);

  useEffect(() => {
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
  }, [applied, refreshVersion]);

  useEffect(() => {
    if (!selected) {
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(false);
      return;
    }

    const sysId = String(selected.sys_id || "").trim();
    const number = String(selected.number || "").trim();
    const sourceEventId = String(selected.zabbix_event_id || "").trim();
    if (!sysId && !number && !sourceEventId) {
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(true);
      return;
    }

    const controller = new AbortController();
    setRelatedAlert(null);
    setRelatedAlertLoading(true);
    setRelatedAlertChecked(false);

    fetchIncidentRelatedAlert({ sysId, number, sourceEventId }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setRelatedAlert(response.matched && response.alert ? response.alert : null);
        setRelatedAlertChecked(true);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRelatedAlert(null);
        setRelatedAlertChecked(true);
        void err;
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedAlertLoading(false);
      });

    return () => controller.abort();
  }, [selected]);

  const items = payload?.items ?? [];
  const pagination = payload?.pagination;
  const counts = payload?.counts;
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

  function applyFilters(next: DraftFilters = draft) {
    setPage(1);
    setApplied({
      ...next,
      search: next.search.trim(),
      company: next.company.trim(),
    });
  }

  function clearFilters() {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setPage(1);
  }

  function selectMetric(kind: "total" | "open" | "in_progress" | "resolved" | "closed" | "unassigned" | "duplicates") {
    if (kind === "duplicates") {
      setViewMode("duplicates");
      setSelected(null);
      setSelectedDuplicateGroup(null);
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
    applyFilters(next);
  }

  const descriptionText = selected
    ? displayValue(selected.description, selected.short_description)
    : "—";
  const hasZabbixHost = Boolean(String(selected?.u_hostname_zabbix || "").trim());
  const hasZabbixIp = Boolean(String(selected?.u_ip_zabbix || "").trim());

  return (
    <AppLayout
      enableAutoRefresh={false}
      showRefreshMeta={false}
      contentClassName="gap-2 p-2 sm:p-3"
      clientSelect={<SectionAccentTitle level={1}>Chamados</SectionAccentTitle>}
      wallboard={dashboard.isWallboard}
    >
      <ConfigurableDashboard controller={dashboard} className="min-w-0">
        <ConfigurableDashboardWidget id="operational-summary">
        <CompactMetricStrip
          aria-label="Indicadores de chamados"
          gridClassName="ov-chamados-metric-grid"
          items={[
            {
              key: "total",
              label: "Total",
              value: error ? "—" : safeCount(counts?.total ?? pagination?.total_items),
              tone: "info",
              loading,
              selected: viewMode === "list" && applied.state === "all" && !applied.unassigned,
              onClick: () => selectMetric("total"),
            },
            {
              key: "open",
              label: "Abertos",
              value: error ? "—" : safeCount(counts?.open),
              tone: "info",
              loading: viewMode === "list" && loading,
              selected: viewMode === "list" && applied.state === "1" && !applied.unassigned,
              onClick: () => selectMetric("open"),
            },
            {
              key: "in_progress",
              label: "Em andamento",
              value: error ? "—" : safeCount(counts?.in_progress),
              tone: "warning",
              loading: viewMode === "list" && loading,
              selected: viewMode === "list" && applied.state === "2" && !applied.unassigned,
              onClick: () => selectMetric("in_progress"),
            },
            {
              key: "resolved",
              label: "Resolvidos",
              value: error ? "—" : safeCount(counts?.resolved),
              tone: "success",
              loading: viewMode === "list" && loading,
              selected: viewMode === "list" && applied.state === "6" && !applied.unassigned,
              onClick: () => selectMetric("resolved"),
            },
            {
              key: "closed",
              label: "Encerrados",
              value: error ? "—" : safeCount(counts?.closed),
              tone: "neutral",
              loading: viewMode === "list" && loading,
              selected: viewMode === "list" && applied.state === "7" && !applied.unassigned,
              onClick: () => selectMetric("closed"),
            },
            {
              key: "unassigned",
              label: "Sem responsável",
              value: error ? "—" : safeCount(counts?.unassigned),
              tone: "danger",
              loading: viewMode === "list" && loading,
              selected: viewMode === "list" && applied.unassigned,
              onClick: () => selectMetric("unassigned"),
            },
            {
              key: "duplicates",
              label: "Duplicados",
              value: duplicatesError
                ? "—"
                : safeCount(duplicatesPayload?.stats?.duplicate_groups),
              tone: "recurrence",
              loading: viewMode === "duplicates" && duplicatesLoading,
              selected: viewMode === "duplicates",
              onClick: () => selectMetric("duplicates"),
            },
          ]}
        />
        </ConfigurableDashboardWidget>

        <ConfigurableDashboardWidget id="incidents-table">

        <FilterBar aria-label="Ferramentas da tabela de chamados" className="mb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label className="relative min-w-[16rem] flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="chamados-search"
                value={draft.search}
                onChange={(event) => setDraft((prev) => ({ ...prev, search: event.target.value }))}
                onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }}
                placeholder="Buscar na tabela por INC, cliente ou descrição…"
                className="ov-filter-control h-9 pl-9"
                aria-label="Buscar na tabela de chamados"
              />
            </label>

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
          title="Incidentes"
          aside={(
            <p className="text-xs leading-snug text-muted-foreground">
              {loading ? "Carregando…" : totalLabel}
              {!error && pagination
                ? ` · página ${safeCount(pagination.page)} de ${safeCount(Math.max(Number(pagination.total_pages) || 0, 1))}`
                : ""}
            </p>
          )}
        >
          <Table className={cn(
            "ov-operational-table w-full table-fixed",
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
                  <TableHead key={column.id} className="ov-type-caption px-3 font-semibold uppercase tracking-wide text-muted-foreground">
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
                      if (column === "number") return <TableCell key={column} className="whitespace-nowrap px-3 font-mono text-xs">{displayValue(item.number)}</TableCell>;
                      if (column === "client") return <TableCell key={column} className="max-w-0 truncate px-3 text-sm" title={displayValue(item.company_display, item.company)}>{displayValue(item.company_display, item.company)}</TableCell>;
                      if (column === "description") return <TableCell key={column} className="max-w-0 truncate px-3 text-sm" title={displayValue(item.short_description)}>{displayValue(item.short_description)}</TableCell>;
                      if (column === "state") return <TableCell key={column} className="whitespace-nowrap px-3 text-sm">{displayValue(item.state_display, item.state)}</TableCell>;
                      if (column === "priority") return <TableCell key={column} className="whitespace-nowrap px-3 text-sm">{displayValue(item.priority_display, item.priority)}</TableCell>;
                      if (column === "group") return <TableCell key={column} className="max-w-0 truncate px-3 text-sm" title={displayValue(item.assignment_group_display, item.assignment_group)}>{displayValue(item.assignment_group_display, item.assignment_group)}</TableCell>;
                      if (column === "assignee") return <TableCell key={column} className="max-w-0 truncate px-3 text-sm" title={displayValue(item.assigned_to_display, item.assigned_to)}>{displayValue(item.assigned_to_display, item.assigned_to)}</TableCell>;
                      return <TableCell key={column} className="whitespace-nowrap px-3 text-xs tabular-nums text-muted-foreground">{formatDateTime(item.sys_updated_on)}</TableCell>;
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

      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-xl">
          {selected ? (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
                <SheetTitle className="font-mono text-lg">{displayValue(selected.number)}</SheetTitle>
                <SheetDescription>{displayValue(selected.company_display, selected.company)}</SheetDescription>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant="outline">{displayValue(selected.state_display, selected.state)}</Badge>
                  <Badge variant="secondary">{displayValue(selected.priority_display, selected.priority)}</Badge>
                </div>
              </SheetHeader>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
                <DetailField label="Descrição" value={descriptionText} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <DetailField label="Grupo" value={displayValue(selected.assignment_group_display, selected.assignment_group)} />
                  <DetailField label="Responsável" value={displayValue(selected.assigned_to_display, selected.assigned_to)} />
                  <DetailField label="Abertura" value={formatDateTime(selected.opened_at)} />
                  <DetailField label="Atualização" value={formatDateTime(selected.sys_updated_on)} />
                  <DetailField label="Encerramento" value={formatDateTime(selected.closed_at || selected.resolved_at)} />
                  <DetailField label="Caller" value={displayValue(selected.caller_id_display, selected.caller_id)} />
                  <DetailField label="Canal" value={displayValue(selected.contact_type_display, selected.contact_type)} />
                </div>

                {hasZabbixHost || hasZabbixIp ? (
                  <section aria-label="Dados Zabbix" className="space-y-3 rounded-md border border-border/70 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Zabbix</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {hasZabbixHost ? <DetailField label="Hostname Zabbix" value={displayValue(selected.u_hostname_zabbix)} /> : null}
                      {hasZabbixIp ? <DetailField label="IP Zabbix" value={displayValue(selected.u_ip_zabbix)} /> : null}
                    </div>
                  </section>
                ) : null}

                <section aria-label="Alerta relacionado" className="space-y-3 rounded-md border border-border/70 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Alerta relacionado</p>
                  {relatedAlertLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-4 w-1/2" />
                      <Skeleton className="h-4 w-1/3" />
                    </div>
                  ) : relatedAlertChecked && relatedAlert ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <DetailField label="Cliente" value={displayValue(relatedAlert.customer)} />
                        <DetailField label="Host" value={displayValue(relatedAlert.host)} />
                        <DetailField label="Problema" value={displayValue(relatedAlert.problem)} />
                        <DetailField label="Severidade" value={alertSeverityLabel(relatedAlert.severity)} />
                        <DetailField label="Data/Hora" value={formatDateTime(relatedAlert.created_at || relatedAlert.first_seen_at)} />
                        <DetailField label="Estado" value={alertStatusLabel(relatedAlert.status)} />
                      </div>
                      <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" asChild>
                        <Link to={relatedAlert.oneview_link || `/alertas?alert=${encodeURIComponent(relatedAlert.id)}`}>
                          Abrir alerta no OneView
                        </Link>
                      </Button>
                    </div>
                  ) : relatedAlertChecked ? (
                    <p className="text-sm text-muted-foreground">Nenhum alerta relacionado localizado</p>
                  ) : null}
                </section>

                <IncidentOperationalActions incident={selected} />
              </div>

              <div className="border-t border-border/70 px-6 py-4">
                {selected.sys_id ? (
                  <ServiceNowDevLink href={selected.servicenow_url} sysId={selected.sys_id} fullWidth />
                ) : (
                  <p className="text-center text-xs text-muted-foreground">
                    Link do ServiceNow indisponível para este incidente.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}

function actionIdempotencyKey(action: ServiceNowIncidentAction) {
  const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `sn-action:${action}:${nonce}`;
}

function IncidentOperationalActions({ incident }: { incident: OneViewIncident }) {
  const [options, setOptions] = useState<ServiceNowIncidentActionOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [targetGroup, setTargetGroup] = useState("");
  const [workNote, setWorkNote] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [submitting, setSubmitting] = useState<ServiceNowIncidentAction | null>(null);
  const [result, setResult] = useState<ServiceNowIncidentActionStatus | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setOptions(null); setOptionsError(null); setResult(null); setResultError(null);
    setTargetGroup(""); setWorkNote(""); setHoldReason("");
    fetchServiceNowIncidentActionOptions(incident.sys_id, controller.signal)
      .then(setOptions)
      .catch((error: unknown) => { if (!controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Ações indisponíveis."); });
    return () => controller.abort();
  }, [incident.sys_id]);

  useEffect(() => {
    if (!result?.action_id || !["pending", "processing"].includes(result.status)) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchServiceNowIncidentActionStatus(incident.sys_id, result.action_id, controller.signal).then(setResult).catch(() => undefined);
    }, 5_000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [incident.sys_id, result?.action_id, result?.status]);

  async function submit(action: ServiceNowIncidentAction, payload: Record<string, string>, confirmation?: string) {
    if (!incident.sys_id || !incident.number || submitting) return;
    if (confirmation && !window.confirm(confirmation)) return;
    setSubmitting(action); setResultError(null);
    try {
      const response = await requestServiceNowIncidentAction({ sysId: incident.sys_id, incidentNumber: incident.number, action, payload, idempotencyKey: actionIdempotencyKey(action) });
      setResult(response);
      if (action === "servicenow.work_note") setWorkNote("");
    } catch (error) {
      setResultError(error instanceof Error ? error.message : "Não foi possível enviar a solicitação.");
    } finally { setSubmitting(null); }
  }

  const enabled = Boolean(options?.enabled && incident.sys_id && incident.number);
  const busy = submitting !== null;
  const resultLabel = result?.status === "succeeded" ? "Aplicada" : result?.status === "failed" ? "Falhou" : result ? "Solicitação enviada — aguardando Worker" : null;

  return (
    <section aria-label="Ações operacionais ServiceNow" className="space-y-3 rounded-md border border-border/70 p-3">
      <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ações operacionais</p><p className="text-xs text-muted-foreground">A solicitação é registrada no OneView; o incidente só muda após confirmação do Worker.</p></div>
      {optionsError ? <p className="text-xs text-muted-foreground">{optionsError}</p> : null}
      {!optionsError && !options ? <Skeleton className="h-20 w-full" /> : null}
      {options && !options.enabled ? <p className="text-xs text-muted-foreground">Solicitações ServiceNow indisponíveis neste ambiente.</p> : null}
      {options?.enabled ? <div className="space-y-3">
        <Button type="button" size="sm" variant="secondary" disabled={!enabled || busy} onClick={() => void submit("servicenow.assume_self", {}, "Enviar solicitação para assumir este chamado?")}>Assumir</Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={targetGroup} onValueChange={setTargetGroup} disabled={!enabled || busy || !options.assignable_groups.length}><SelectTrigger aria-label="Grupo de destino" className="flex-1"><SelectValue placeholder={options.assignable_groups.length ? "Selecionar grupo" : "Nenhum grupo homologado"} /></SelectTrigger><SelectContent>{options.assignable_groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}</SelectContent></Select>
          <Button type="button" size="sm" variant="outline" disabled={!enabled || busy || !targetGroup} onClick={() => void submit("servicenow.assign_group", { target_group: targetGroup }, "Enviar solicitação para atribuir este grupo?")}>Atribuir grupo</Button>
        </div>
        <div className="space-y-2"><Textarea aria-label="Nota de trabalho" value={workNote} maxLength={2000} onChange={(event) => setWorkNote(event.target.value)} disabled={!enabled || busy} placeholder="Adicionar nota de trabalho" /><Button type="button" size="sm" variant="outline" disabled={!enabled || busy || !workNote.trim()} onClick={() => void submit("servicenow.work_note", { work_note: workNote })}>Adicionar nota</Button></div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={holdReason} onValueChange={setHoldReason} disabled={!enabled || busy || !options.hold_reasons.length}><SelectTrigger aria-label="Motivo de espera" className="flex-1"><SelectValue placeholder={options.hold_reasons.length ? "Motivo homologado" : "Nenhum motivo homologado"} /></SelectTrigger><SelectContent>{options.hold_reasons.map((reason) => <SelectItem key={reason} value={reason}>{reason}</SelectItem>)}</SelectContent></Select>
          <Button type="button" size="sm" variant="outline" disabled={!enabled || busy || !holdReason} onClick={() => void submit("servicenow.hold", { hold_reason: holdReason }, "Enviar solicitação para colocar este chamado em espera?")}>Colocar em espera</Button>
        </div>
      </div> : null}
      {resultLabel ? <p className={result?.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{resultLabel}{result?.error_code ? ` (${result.error_code})` : ""}</p> : null}
      {resultError ? <p className="text-xs text-destructive">{resultError}</p> : null}
    </section>
  );
}
