import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ExternalLink, Radio } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { AlertDetailDrawer } from "@/components/oneview/AlertDetailDrawer";
import { FilterBar } from "@/components/oneview/FilterBar";
import { facetCustomerDisplayName, operationalClientLabel } from "@/components/oneview/ClientIdentity";
import { OperationalEmptyState } from "@/components/oneview/OperationalEmptyState";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { OperationalSegmentedControl } from "@/components/oneview/OperationalSegmentedControl";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { TruncatedText } from "@/components/oneview/TruncatedText";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { OV_FILTER_CONTROL } from "@/lib/oneview-operational-ui";
import { isDatasourceOnlyFilterValue, zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import { buildProductionServiceNowIncidentLink } from "@/lib/oneview-inc-correlation";
import {
  AlertDetailResponse,
  AlertHistoryResponse,
  fetchAlert,
  fetchAlertHistory,
  fetchOperatorQueue,
  formatOneViewSeverityLabel,
  type OperatorQueueItem,
  type OperatorQueueResponse,
  type OperatorQueueTab,
} from "@/lib/oneview-api";

const PAGE_SIZE = 50;
const ALL_VALUE = "all";
/** OV-P0-255 — polling operacional 10s (AppLayout auto-refresh fica desligado). */
const OPERATORS_REFRESH_MS = 10_000;

const TAB_OPTIONS: Array<{ value: OperatorQueueTab; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "unassigned", label: "Sem responsável" },
  { value: "following", label: "Em acompanhamento" },
  { value: "recent", label: "Recentes" },
];

const COLUMNS = [
  "Cliente",
  "Operadora/tag",
  "Alerta",
  "Host",
  "Severity",
  "INC",
  "Status do INC",
  "Analista responsável",
  "Grupo",
  "Última atualização",
  "Tempo desde última atualização",
  "Ações",
] as const;

function displayValue(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text || text === "undefined" || text === "null") return "—";
  return text;
}

function parseTab(value: string | null): OperatorQueueTab {
  if (value === "unassigned" || value === "following" || value === "recent" || value === "all") return value;
  return "all";
}

function formatLastUpdated(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function facetOptions(items: Array<{ value: string; label: string }> | undefined) {
  return [{ value: ALL_VALUE, label: "Todos" }, ...(items || [])];
}

export default function OperadorasPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedAlertId = searchParams.get("alert");
  const [tab, setTab] = useState<OperatorQueueTab>(() => parseTab(searchParams.get("tab")));
  const [operatorTag, setOperatorTag] = useState(searchParams.get("operator_tag") || ALL_VALUE);
  const [customer, setCustomer] = useState(searchParams.get("customer") || ALL_VALUE);
  const [datasource, setDatasource] = useState(searchParams.get("datasource") || ALL_VALUE);
  const [assignedTo, setAssignedTo] = useState(searchParams.get("assigned_to") || ALL_VALUE);
  const [state, setState] = useState(searchParams.get("state") || ALL_VALUE);
  const [severity, setSeverity] = useState(searchParams.get("severity") || ALL_VALUE);
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<OperatorQueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AlertDetailResponse | null>(null);
  const [history, setHistory] = useState<AlertHistoryResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  const loadQueue = useCallback(async (mode: "initial" | "quiet" | "manual" = "initial") => {
    if (mode === "quiet" && listRequest.current && !listRequest.current.signal.aborted) return;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    if (mode !== "quiet") {
      setLoading(true);
      setError(null);
    }
    try {
      const response = await fetchOperatorQueue({
        tab,
        operatorTag: operatorTag === ALL_VALUE ? undefined : operatorTag,
        customer: customer === ALL_VALUE ? undefined : customer,
        datasource: datasource === ALL_VALUE ? undefined : datasource,
        assignedTo: assignedTo === ALL_VALUE ? undefined : assignedTo,
        state: state === ALL_VALUE ? undefined : state,
        severity: severity === ALL_VALUE ? undefined : severity,
        page,
        pageSize: PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPayload(response);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (mode !== "quiet") setPayload(null);
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar a fila de operadoras.");
    } finally {
      if (!controller.signal.aborted && mode !== "quiet") setLoading(false);
    }
  }, [assignedTo, customer, datasource, operatorTag, page, severity, state, tab]);

  const loadSelectedAlert = useCallback(async (alertId: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setIsDetailLoading(true);
    setDetailError(null);
    try {
      const results = await Promise.allSettled([
        fetchAlert(alertId, controller.signal),
        fetchAlertHistory(alertId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const errors: string[] = [];
      if (results[0].status === "fulfilled") setDetail(results[0].value);
      else errors.push(results[0].reason instanceof Error ? results[0].reason.message : "Detalhe indisponível.");
      if (results[1].status === "fulfilled") setHistory(results[1].value);
      else errors.push(results[1].reason instanceof Error ? results[1].reason.message : "Histórico indisponível.");
      if (errors.length) setDetailError(errors[0]);
    } finally {
      if (!controller.signal.aborted) setIsDetailLoading(false);
    }
  }, []);

  const openAlert = useCallback((alertId: string) => {
    setSelectedAlertId(alertId);
    void loadSelectedAlert(alertId);
    const next = new URLSearchParams(searchParams);
    next.set("alert", alertId);
    setSearchParams(next, { replace: false });
  }, [loadSelectedAlert, searchParams, setSearchParams]);

  const closeAlert = useCallback(() => {
    detailRequest.current?.abort();
    setSelectedAlertId(null);
    setDetail(null);
    setHistory(null);
    setDetailError(null);
    setIsDetailLoading(false);
    if (searchParams.has("alert")) {
      const next = new URLSearchParams(searchParams);
      next.delete("alert");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    void loadQueue("initial");
    return () => listRequest.current?.abort();
  }, [loadQueue]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadQueue("quiet");
    }, OPERATORS_REFRESH_MS);
    const onVisibility = () => {
      if (document.hidden) return;
      void loadQueue("quiet");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadQueue]);

  useEffect(() => {
    if (!requestedAlertId) {
      if (selectedAlertId) {
        detailRequest.current?.abort();
        setSelectedAlertId(null);
        setDetail(null);
        setHistory(null);
        setDetailError(null);
        setIsDetailLoading(false);
      }
      return;
    }
    if (requestedAlertId === selectedAlertId) return;
    setSelectedAlertId(requestedAlertId);
    void loadSelectedAlert(requestedAlertId);
  }, [loadSelectedAlert, requestedAlertId, selectedAlertId]);

  const items = payload?.items || [];
  const counts = payload?.counts;
  const pagination = payload?.pagination;
  const selectedAlert = detail?.item || null;
  const historyItems = history?.items || [];

  const tabOptions = useMemo(() => TAB_OPTIONS.map((option) => {
    const count = counts?.[option.value];
    return {
      value: option.value,
      label: typeof count === "number" ? `${option.label} (${count})` : option.label,
    };
  }), [counts]);

  const changeTab = (value: OperatorQueueTab) => {
    setTab(value);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("tab");
    else next.set("tab", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <AppLayout
      title="Operadoras"
      description="Fila de follow-up de alertas identificados por tag de operadora."
      onRefresh={() => loadQueue("manual")}
      enableAutoRefresh={false}
      showRefreshMeta={false}
      dataSource={payload?.data_source === "snapshot" ? "snapshot" : payload ? "database" : null}
      checkedAt={payload?.checked_at}
    >
      <div className="space-y-3">
        <OperationalSegmentedControl
          aria-label="Abas da fila de operadoras"
          value={tab}
          options={tabOptions}
          onChange={changeTab}
        />

        <FilterBar aria-label="Filtros da fila de operadoras">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <FilterSelect
              id="operadoras-tag"
              label="Operadora/tag"
              value={operatorTag}
              options={facetOptions(payload?.facets.operator_tags)}
              onChange={(value) => { setOperatorTag(value); setPage(1); }}
            />
            <FilterSelect
              id="operadoras-cliente"
              label="Cliente"
              value={customer}
              options={facetOptions((payload?.facets.customers || [])
                .filter((item) => !isDatasourceOnlyFilterValue(item.value) && !isDatasourceOnlyFilterValue(item.label))
                .map((item) => ({
                  value: item.value,
                  label: facetCustomerDisplayName({ key: item.value, name: item.label }),
                })))}
              onChange={(value) => { setCustomer(value); setPage(1); }}
            />
            <FilterSelect
              id="operadoras-fonte"
              label="Fonte Zabbix"
              value={datasource}
              options={facetOptions((payload?.facets.datasources || []).map((item) => ({
                value: item.value,
                label: zabbixSourceDisplayName(item.value || item.label),
              })))}
              onChange={(value) => { setDatasource(value); setPage(1); }}
            />
            <FilterSelect
              id="operadoras-analista"
              label="Analista"
              value={assignedTo}
              options={facetOptions(payload?.facets.analysts)}
              onChange={(value) => { setAssignedTo(value); setPage(1); }}
            />
            <FilterSelect
              id="operadoras-status"
              label="Status"
              value={state}
              options={facetOptions(payload?.facets.states)}
              onChange={(value) => { setState(value); setPage(1); }}
            />
            <FilterSelect
              id="operadoras-severity"
              label="Severity"
              value={severity}
              options={facetOptions((payload?.facets.severities || []).map((item) => ({
                value: item.value,
                label: formatOneViewSeverityLabel(item.value),
              })))}
              onChange={(value) => { setSeverity(value); setPage(1); }}
            />
          </div>
        </FilterBar>

        {error ? <OperationalErrorBanner message={error} onRetry={() => void loadQueue()} /> : null}

        <SectionPanel
          title="Fila de operadoras"
          description="Somente alertas com tag objetiva de operadora. Sem classificação de atraso."
          aside={(
            <p className="text-xs text-muted-foreground">
              {loading ? "Carregando…" : `${(pagination?.total_items ?? 0).toLocaleString("pt-BR")} itens`}
            </p>
          )}
          bodyClassName="p-0"
        >
          {loading && !payload ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : items.length === 0 ? (
            <OperationalEmptyState
              compact
              icon={<Radio className="h-5 w-5" />}
              title="Nenhum alerta de operadora nesta visão"
              description="A fila usa apenas tags persistidas de operadora. Alertas sem essa tag não entram."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS.map((column) => (
                    <TableHead key={column} className="whitespace-nowrap text-xs">{column}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <OperatorQueueRow
                    key={item.alert_id || `${item.incident_number}-${item.operator_tag}`}
                    item={item}
                    selected={selectedAlertId === item.alert_id}
                    onOpenAlert={openAlert}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </SectionPanel>
      </div>

      <AlertDetailDrawer
        open={selectedAlertId !== null}
        onOpenChange={(next) => { if (!next) closeAlert(); }}
        alert={selectedAlert}
        historyItems={historyItems}
        isLoading={isDetailLoading}
        error={detailError}
        description="Consulta rápida sem sair da fila de operadoras."
      />
    </AppLayout>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground" htmlFor={id}>{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={cn(OV_FILTER_CONTROL, "w-full")}>
          <SelectValue placeholder="Todos" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function OperatorQueueRow({
  item,
  selected,
  onOpenAlert,
}: {
  item: OperatorQueueItem;
  selected: boolean;
  onOpenAlert: (alertId: string) => void;
}) {
  const servicenowUrl = buildProductionServiceNowIncidentLink(item.incident_sys_id) || item.servicenow_url;
  return (
    <TableRow
      className={cn("align-top", selected && "bg-muted/60")}
      data-selected={selected || undefined}
    >
      <TableCell className="max-w-[9rem] text-[12px]">
        <TruncatedText>
          {operationalClientLabel({
            key: item.customer_key,
            name: item.customer_name,
          })}
        </TruncatedText>
      </TableCell>
      <TableCell className="max-w-[12rem] text-[12px]"><TruncatedText>{displayValue(item.operator_tag)}</TruncatedText></TableCell>
      <TableCell className="max-w-[14rem] text-[12px]"><TruncatedText>{displayValue(item.problem_name)}</TruncatedText></TableCell>
      <TableCell className="max-w-[10rem] text-[12px]"><TruncatedText>{displayValue(item.host_name)}</TruncatedText></TableCell>
      <TableCell>{item.severity ? <SeverityBadge severity={item.severity} className="h-5 px-1.5" /> : "—"}</TableCell>
      <TableCell className="whitespace-nowrap text-[12px]">{displayValue(item.incident_number)}</TableCell>
      <TableCell>
        {item.incident_state_display ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{item.incident_state_display}</Badge>
        ) : "—"}
      </TableCell>
      <TableCell className="max-w-[10rem] text-[12px]"><TruncatedText>{item.analyst_label || "Sem responsável"}</TruncatedText></TableCell>
      <TableCell className="max-w-[10rem] text-[12px]"><TruncatedText>{displayValue(item.assignment_group_display)}</TruncatedText></TableCell>
      <TableCell className="whitespace-nowrap text-[12px] text-muted-foreground">{formatLastUpdated(item.last_updated_at)}</TableCell>
      <TableCell className="whitespace-nowrap text-[12px]">{displayValue(item.updated_ago_label)}</TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex flex-wrap gap-1">
          {item.alert_id ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => onOpenAlert(item.alert_id as string)}
            >
              Abrir alerta no OneView
            </Button>
          ) : null}
          {servicenowUrl ? (
            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]" asChild>
              <a href={servicenowUrl} target="_blank" rel="noopener noreferrer" aria-label={`Abrir chamado ${displayValue(item.incident_number)} no ServiceNow`}>
                <ExternalLink className="mr-1 h-3 w-3" />
                Abrir chamado no ServiceNow
              </a>
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
