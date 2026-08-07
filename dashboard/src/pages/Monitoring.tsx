import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Expand, Loader2, Minimize2, RefreshCcw } from "lucide-react";
import { Sidebar } from "@/components/layout/Sidebar";
import { ClientFilterCombobox } from "@/components/oneview/ClientFilterCombobox";
import {
  ClientIdentity,
  UNCLASSIFIED_CLIENT_LABEL,
  canonicalClientName,
  canonicalHostName,
} from "@/components/oneview/ClientIdentity";
import { CompactMetricStrip } from "@/components/oneview/CompactMetricStrip";
import { PlatformHealthStrip } from "@/components/oneview/PlatformHealthStrip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AttentionRequiredResponse,
  OneViewAlert,
  OneViewFacetsResponse,
  OneViewSeverity,
  fetchAttentionRequired,
  fetchOneViewFacets,
  formatNullableCount,
  formatOneViewSeverityLabel,
  normalizeOneViewSeverity,
} from "@/lib/oneview-api";
import {
  HOME_WINDOW_OPTIONS,
  RecentOperationalMetrics,
  fetchRecentAlerts,
  fetchRecentOperationalMetrics,
  fetchRecentPriorityAlerts,
  homeWindowActiveLabel,
  homeWindowMs,
  homeWindowShortLabel,
  isoAgo,
  parseHomeWindow,
  queueOverflowLabel,
  type HomeWindowPreset,
} from "@/lib/oneview-recent";

const REFRESH_MS = 30_000;
const PRIORITY_LIMIT = 6;
const ATTENTION_LIMIT = 5;
const ATTENTION_FETCH_LIMIT = 20;
const EVENTS_LIMIT = 5;
const RECENT_LIMIT = EVENTS_LIMIT;
const HOSTS_LIMIT = 5;

/** OV-P0-43: faixa visual das cinco severidades (Not classified no chip discreto). */
const MONITOR_VISUAL_SEVERITY_STRIP: Array<Exclude<OneViewSeverity, "critical" | "not_classified">> = [
  "information",
  "warning",
  "average",
  "high",
  "disaster",
];

type AttentionItem = AttentionRequiredResponse["items"][number];
type SectionErrors = Partial<Record<"summary" | "priority" | "attention" | "recent" | "hosts", string | null>>;

const severityRank: Record<string, number> = {
  disaster: 0,
  critical: 1,
  high: 2,
  average: 3,
  warning: 4,
  information: 5,
  not_classified: 6,
};

function formatDurationSeconds(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rem = Math.round(seconds % 60);
    return rem ? `${minutes} min ${rem} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours} h ${remMin} min` : `${hours} h`;
}

function relativeTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : formatDistanceToNow(date, { addSuffix: true, locale: ptBR });
}

function severityTone(value: string) {
  const severity = normalizeOneViewSeverity(value);
  if (severity === "disaster") {
    return "text-red-700 border-red-300 bg-red-50 dark:text-red-300 dark:border-red-500/50 dark:bg-red-950/50";
  }
  if (severity === "critical") {
    return "text-red-700 border-red-300 bg-red-50 dark:text-red-200 dark:border-red-400/40 dark:bg-red-950/40";
  }
  if (severity === "high") {
    return "text-orange-700 border-orange-300 bg-orange-50 dark:text-orange-200 dark:border-orange-400/40 dark:bg-orange-950/40";
  }
  if (severity === "average") {
    return "text-amber-800 border-amber-300 bg-amber-50 dark:text-amber-200 dark:border-amber-400/40 dark:bg-amber-950/30";
  }
  if (severity === "warning") {
    return "text-yellow-800 border-yellow-300 bg-yellow-50 dark:text-yellow-100 dark:border-yellow-400/30 dark:bg-yellow-950/30";
  }
  return "text-slate-700 border-slate-300 bg-slate-50 dark:text-slate-200 dark:border-slate-500/40 dark:bg-slate-900/50";
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const leftRank = severityRank[normalizeOneViewSeverity(left.severity)] ?? 99;
  const rightRank = severityRank[normalizeOneViewSeverity(right.severity)] ?? 99;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.unacknowledged_minutes !== right.unacknowledged_minutes) {
    return right.unacknowledged_minutes - left.unacknowledged_minutes;
  }
  return Date.parse(left.first_seen_at || "") - Date.parse(right.first_seen_at || "");
}

function attentionReason(item: AttentionItem, thresholds?: AttentionRequiredResponse["thresholds"]) {
  const severity = normalizeOneViewSeverity(item.severity);
  const minutes = Number(item.unacknowledged_minutes) || 0;
  if (severity === "disaster" || severity === "critical") {
    const threshold = thresholds?.disaster_minutes;
    return threshold != null
      ? `Disaster sem ACK há ${minutes} min · limiar ${threshold} min`
      : `Disaster sem ACK há ${minutes} min`;
  }
  if (severity === "high") {
    const threshold = thresholds?.high_minutes;
    return threshold != null
      ? `High sem ACK há ${minutes} min · limiar ${threshold} min`
      : `High sem ACK há ${minutes} min`;
  }
  if (severity === "average") {
    const threshold = thresholds?.average_minutes;
    return threshold != null
      ? `Average sem ACK há ${minutes} min · limiar ${threshold} min`
      : `Average sem ACK há ${minutes} min`;
  }
  return `Sem ACK há ${minutes} min`;
}

function normalizedClientKey(...values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function matchesCustomerFilter(
  selectedKeys: string[],
  customer: { key?: string | null; name?: string | null },
  cards: Array<{ key: string; name: string }>,
) {
  if (!selectedKeys.length) return true;
  const key = String(customer.key || "").toLowerCase();
  const name = normalizedClientKey(customer.name);
  return selectedKeys.some((selected) => {
    if (key && selected.toLowerCase() === key) return true;
    const card = cards.find((item) => item.key === selected);
    if (!card) return false;
    return name.includes(normalizedClientKey(card.name)) || normalizedClientKey(card.name).includes(name);
  });
}

function Panel({
  title,
  error,
  onRetry,
  overflow,
  empty,
  children,
  className,
}: {
  title: string;
  error?: string | null;
  onRetry?: () => void;
  overflow?: string | null;
  /** OV-P0-43: painel vazio não disputa altura no grid NOC. */
  empty?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-card/90",
        empty ? "shrink-0" : "min-h-0 flex-1",
        className,
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-foreground sm:text-base">{title}</h2>
          {overflow ? <p className="text-[11px] font-medium text-muted-foreground">{overflow}</p> : null}
        </div>
        {error ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={onRetry}
          >
            <RefreshCcw className="mr-1 h-3 w-3" />
            Tentar
          </Button>
        ) : null}
      </div>
      {error ? <p className="shrink-0 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-200/90">{error}</p> : null}
      <div className={cn("overflow-hidden px-3", empty ? "py-1.5" : "min-h-0 flex-1 py-1.5")}>{children}</div>
    </section>
  );
}

function AlertRow({
  alert,
  trailing,
  view = "recent",
}: {
  alert: OneViewAlert;
  trailing?: ReactNode;
  view?: "priority" | "recent";
}) {
  return (
    <Link
      to={`/alertas?alert=${encodeURIComponent(alert.id)}&view=${view}`}
      className="grid items-center gap-1 py-1.5 transition-colors hover:bg-muted/50 sm:grid-cols-[6.5rem_minmax(0,1fr)_5.5rem_auto] sm:gap-2"
    >
      <span className={cn("inline-flex h-fit w-fit shrink-0 self-start rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none", severityTone(alert.severity))}>
        {formatOneViewSeverityLabel(alert.severity)}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-start gap-2">
          <ClientIdentity
            customer={{
              key: alert.customer_key,
              name: alert.customer_name,
              source: alert.customer_source,
            }}
            size="sm"
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {canonicalClientName({
                key: alert.customer_key,
                name: alert.customer_name,
                source: alert.customer_source,
              })}
            </span>
            <span className="block truncate text-xs text-foreground/80">{canonicalHostName(alert)}</span>
            <span className="block truncate text-xs text-muted-foreground">{alert.problem_name}</span>
          </span>
        </span>
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{formatDurationSeconds(alert.duration_seconds)}</span>
      {trailing ?? (
        <span className="text-xs tabular-nums text-muted-foreground">{relativeTime(alert.first_seen_at)}</span>
      )}
    </Link>
  );
}

export default function MonitoringPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tvMode = searchParams.get("tv") === "1";
  const homeWindow = parseHomeWindow(searchParams.get("window"));
  const windowMs = homeWindowMs(homeWindow);
  const windowLabel = homeWindowShortLabel(homeWindow);

  const [recentMetrics, setRecentMetrics] = useState<RecentOperationalMetrics | null>(null);
  const [facets, setFacets] = useState<OneViewFacetsResponse | null>(null);
  const [attention, setAttention] = useState<AttentionRequiredResponse | null>(null);
  const [priorityAlerts, setPriorityAlerts] = useState<OneViewAlert[]>([]);
  const [priorityTotal, setPriorityTotal] = useState(0);
  const [attentionTotal, setAttentionTotal] = useState(0);
  const [recentAlerts, setRecentAlerts] = useState<OneViewAlert[]>([]);
  const [recentTotal, setRecentTotal] = useState(0);
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({});
  const [isUpdating, setIsUpdating] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [navOpen, setNavOpen] = useState(() => {
    try {
      const raw = sessionStorage.getItem("oneview-monitor-sidebar-open");
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {
      // sessionStorage pode estar indisponível.
    }
    return true;
  });
  const [customerFilterOpen, setCustomerFilterOpen] = useState(false);
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<string[]>(() =>
    searchParams.getAll("customer").filter(Boolean),
  );

  const inFlight = useRef<Promise<void> | null>(null);
  const openBeforeFullscreen = useRef(true);
  const wasFullscreen = useRef(false);
  const listsAbort = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);

  const setSectionError = useCallback((key: keyof SectionErrors, value: string | null) => {
    setSectionErrors((current) => (current[key] === value ? current : { ...current, [key]: value }));
  }, []);

  const setHomeWindow = useCallback((preset: HomeWindowPreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("window", parseHomeWindow(preset));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const raw = searchParams.get("window");
    const parsed = parseHomeWindow(raw);
    if (raw === parsed) return;
    const next = new URLSearchParams(searchParams);
    next.set("window", parsed);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("customer");
    selectedCustomerKeys.forEach((value) => next.append("customer", value));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, selectedCustomerKeys, setSearchParams]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  const customerCards = useMemo(() => {
    const by = recentMetrics?.by_severity;
    const known = by
      ? [by.information, by.warning, by.average, by.high, by.disaster, recentMetrics?.not_classified]
      : [];
    const total = known.length && known.every((value) => value != null)
      ? known.reduce<number>((sum, value) => sum + Number(value), 0)
      : 0;
    return [
      { key: "all", name: "Todos", alerts_count: total },
      ...(facets?.customers ?? []).map((customer) =>
        customer.key === "unclassified"
          ? { ...customer, name: UNCLASSIFIED_CLIENT_LABEL }
          : customer,
      ),
    ];
  }, [facets?.customers, recentMetrics]);

  const selectedCustomerLabel = useMemo(() => {
    if (selectedCustomerKeys.length === 0) return "TODOS";
    if (selectedCustomerKeys.length > 1) return `${selectedCustomerKeys.length} CLIENTES`;
    const selected = customerCards.find((customer) => customer.key === selectedCustomerKeys[0]);
    return (selected?.name || "CLIENTE").toUpperCase();
  }, [customerCards, selectedCustomerKeys]);

  const hasValidSummary = Boolean(recentMetrics);
  const severityStripLoading = isUpdating && !recentMetrics;
  const severityCounts = hasValidSummary ? recentMetrics?.by_severity ?? null : null;
  const severityStripItems = MONITOR_VISUAL_SEVERITY_STRIP.map((severity) => {
    const value = severityCounts?.[severity] ?? null;
    return {
      key: severity,
      label: formatOneViewSeverityLabel(severity),
      value: formatNullableCount(value),
      description: `${homeWindowActiveLabel(homeWindow)} · ${formatOneViewSeverityLabel(severity)}`,
      unknown: value == null && !severityStripLoading,
      loading: severityStripLoading,
    };
  });

  const attentionItems = useMemo(
    () =>
      [...(attention?.items ?? [])]
        .filter((item) => matchesCustomerFilter(selectedCustomerKeys, { name: item.customer_name }, customerCards))
        .sort(compareAttentionItems)
        .slice(0, ATTENTION_LIMIT),
    [attention, customerCards, selectedCustomerKeys],
  );

  const topHosts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const alert of [...priorityAlerts, ...recentAlerts]) {
      const host = canonicalHostName(alert);
      counts.set(host, (counts.get(host) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([host_name, count]) => ({ host_name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, HOSTS_LIMIT);
  }, [priorityAlerts, recentAlerts]);

  const priorityEmpty = hasLoaded && !priorityAlerts.length && !sectionErrors.priority;
  const attentionEmpty = hasLoaded && !attentionItems.length && !sectionErrors.attention;
  const recentEmpty = hasLoaded && !recentAlerts.length && !sectionErrors.recent;
  const hostsEmpty = hasLoaded && !topHosts.length;

  const toggleCustomer = (key: string) => {
    if (key === "all") {
      setSelectedCustomerKeys([]);
      return;
    }
    setSelectedCustomerKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const refreshAll = useCallback(async () => {
    if (inFlight.current) return inFlight.current;

    const request = (async () => {
      setIsUpdating(true);
      const isInitial = !hasDataRef.current;
      listsAbort.current?.abort();
      const controller = new AbortController();
      listsAbort.current = controller;
      const customers = selectedCustomerKeys.length ? selectedCustomerKeys : undefined;
      const now = Date.now();

      const results = await Promise.allSettled([
        fetchRecentOperationalMetrics({ customers, signal: controller.signal, now, windowMs }),
        fetchOneViewFacets(controller.signal),
        fetchAttentionRequired(ATTENTION_FETCH_LIMIT, {
          firstSeenFrom: isoAgo(windowMs, now),
          signal: controller.signal,
        }),
        fetchRecentPriorityAlerts({
          limit: PRIORITY_LIMIT,
          customers,
          signal: controller.signal,
          now,
          windowMs,
        }),
        fetchRecentAlerts({
          limit: RECENT_LIMIT,
          customers,
          signal: controller.signal,
          now,
          windowMs,
        }),
      ]);

      if (controller.signal.aborted) return;

      const [metricsResult, facetsResult, attentionResult, priorityResult, recentResult] = results;
      let anySuccess = false;

      if (metricsResult.status === "fulfilled") {
        setRecentMetrics(metricsResult.value);
        setSectionError("summary", null);
        anySuccess = true;
      } else {
        setSectionError(
          "summary",
          isInitial ? "Não foi possível carregar as métricas." : "Falha ao atualizar métricas. Valores anteriores mantidos.",
        );
      }

      if (facetsResult.status === "fulfilled") {
        setFacets(facetsResult.value);
        anySuccess = true;
      }

      if (attentionResult.status === "fulfilled") {
        setAttention(attentionResult.value);
        setAttentionTotal(Number(attentionResult.value.summary?.total) || attentionResult.value.items.length);
        setSectionError("attention", null);
        anySuccess = true;
      } else {
        setSectionError(
          "attention",
          isInitial ? "Não foi possível carregar a atenção necessária." : "Falha ao atualizar atenção. Valores anteriores mantidos.",
        );
      }

      if (priorityResult.status === "fulfilled") {
        setPriorityAlerts(priorityResult.value.items);
        setPriorityTotal(priorityResult.value.total);
        setSectionError("priority", null);
        anySuccess = true;
      } else {
        setSectionError(
          "priority",
          isInitial ? "Não foi possível carregar prioritários." : "Falha ao atualizar prioritários. Valores anteriores mantidos.",
        );
      }

      if (recentResult.status === "fulfilled") {
        setRecentAlerts(recentResult.value.items);
        setRecentTotal(recentResult.value.total);
        setSectionError("recent", null);
        anySuccess = true;
      } else {
        setSectionError(
          "recent",
          isInitial ? "Não foi possível carregar recentes." : "Falha ao atualizar recentes. Valores anteriores mantidos.",
        );
      }

      if (anySuccess) {
        hasDataRef.current = true;
        setHasLoaded(true);
      }
    })().finally(() => {
      setIsUpdating(false);
      inFlight.current = null;
    });

    inFlight.current = request;
    return request;
  }, [selectedCustomerKeys, setSectionError, windowMs]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshAll();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (isFullscreen === wasFullscreen.current) return;
    if (isFullscreen) {
      openBeforeFullscreen.current = navOpen;
      setNavOpen(false);
    } else {
      setNavOpen(openBeforeFullscreen.current);
    }
    wasFullscreen.current = isFullscreen;
  }, [isFullscreen, navOpen]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen pode ser bloqueado pelo navegador; a tela permanece utilizável.
    }
  }, []);

  return (
    <div
      className="noc-monitor flex h-[100dvh] w-[100vw] max-h-[100dvh] max-w-[100vw] overflow-hidden bg-background text-foreground antialiased"
      data-tv={tvMode ? "1" : "0"}
    >
      <Sidebar
        monitoringCollapse
        open={navOpen}
        onOpenChange={setNavOpen}
      />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[margin] duration-200",
          navOpen ? "ml-14" : "ml-0",
        )}
      >
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="shrink-0 text-xl font-semibold tracking-tight text-foreground">Monitoramento</h1>
          <ClientFilterCombobox
            open={customerFilterOpen}
            onOpenChange={setCustomerFilterOpen}
            options={customerCards}
            selectedKeys={selectedCustomerKeys}
            selectedLabel={selectedCustomerLabel}
            onToggle={toggleCustomer}
          />
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Janela temporal">
            {HOME_WINDOW_OPTIONS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={homeWindow === preset ? "default" : "outline"}
                className="h-7 px-2 text-[11px]"
                aria-pressed={homeWindow === preset}
                onClick={() => setHomeWindow(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <PlatformHealthStrip />
          {isUpdating ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Atualizando
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
            aria-pressed={isFullscreen}
            title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
          >
            {isFullscreen
              ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
              : <Expand className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex h-0 w-full max-w-[1920px] min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2 sm:p-3">
        <div className="shrink-0 space-y-1">
          <CompactMetricStrip
            aria-label="Severidades ativas na janela"
            items={severityStripItems}
          />
          {sectionErrors.summary ? (
            <p className="text-xs text-amber-700 dark:text-amber-200/90">{sectionErrors.summary}</p>
          ) : null}
        </div>

        <div className="grid min-h-0 flex-1 gap-2 overflow-hidden xl:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
            <Panel
              title={`Alertas prioritários · ${windowLabel}`}
              error={sectionErrors.priority}
              onRetry={() => void refreshAll()}
              overflow={queueOverflowLabel(priorityTotal, priorityAlerts.length)}
              empty={priorityEmpty}
            >
              {!hasLoaded && !priorityAlerts.length ? (
                <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : !priorityAlerts.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">Nenhum alerta prioritário recente.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden">
                  {priorityAlerts.map((alert) => (
                    <li key={alert.id}>
                      <AlertRow
                        alert={alert}
                        view="priority"
                        trailing={<span className="text-xs font-medium text-amber-700 dark:text-amber-300">Sem ACK</span>}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Atenção necessária"
              error={sectionErrors.attention}
              onRetry={() => void refreshAll()}
              overflow={queueOverflowLabel(attentionTotal, attentionItems.length)}
              empty={attentionEmpty}
            >
              {!hasLoaded && !attentionItems.length ? (
                <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : !attentionItems.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">Nenhum item acima do limiar.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden">
                  {attentionItems.map((item) => (
                    <li key={item.id} className="grid items-center gap-1 py-1.5 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-2">
                      <span className={cn("inline-flex h-fit w-fit shrink-0 self-start rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none", severityTone(item.severity))}>
                        {formatOneViewSeverityLabel(item.severity)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <ClientIdentity customer={{ name: item.customer_name }} />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {canonicalClientName({ name: item.customer_name })}
                            </p>
                            <p className="truncate text-sm font-medium text-foreground">{canonicalHostName(item)}</p>
                            <p className="truncate text-xs text-muted-foreground">{item.problem}</p>
                          </div>
                        </div>
                        <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-200/90">{attentionReason(item, attention?.thresholds)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
            <Panel
              title={`Recentes · ${windowLabel}`}
              error={sectionErrors.recent}
              onRetry={() => void refreshAll()}
              overflow={queueOverflowLabel(recentTotal, recentAlerts.length)}
              empty={recentEmpty}
            >
              {!hasLoaded && !recentAlerts.length ? (
                <p className="py-2 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : !recentAlerts.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">Sem alertas recentes na janela.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden">
                  {recentAlerts.map((alert) => (
                    <li key={alert.id}>
                      <AlertRow alert={alert} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Hosts mais impactados" empty={hostsEmpty}>
              {!hasValidSummary ? (
                <p className="py-1 text-center text-xs text-muted-foreground">Sem informação</p>
              ) : !topHosts.length ? (
                <p className="py-1 text-center text-xs text-muted-foreground">Sem hosts recentes.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden">
                  {topHosts.map((host) => (
                    <li key={host.host_name} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="truncate text-sm text-foreground">{host.host_name}</span>
                      <span className="text-sm font-semibold tabular-nums text-foreground">{Number(host.count).toLocaleString("pt-BR")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
