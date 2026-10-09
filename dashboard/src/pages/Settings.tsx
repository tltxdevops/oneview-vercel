/**
 * Configurações: preferências do usuário primeiro; saúde compacta com Expandir;
 * Ajuda aponta problemas de desenvolvimento para o Webex.
 * Sem controle falso de intervalo de sync Zabbix; sem banner de modo leitura;
 * sem ação manual de sync desabilitada nesta tela.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { OperationalErrorBanner } from "@/components/oneview/OperationalErrorBanner";
import { SectionPanel } from "@/components/oneview/SectionPanel";
import { SectionAccentTitle } from "@/components/oneview/OneViewDesignSystem";
import { OneViewSortableHeader } from "@/components/oneview/ConfigurableTableTools";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthContext } from "@/context/AuthContext";
import {
  DataSource,
  fetchDataSourcesWithMeta,
  RuntimeHealthComponent,
  RuntimeHealthResponse,
  fetchRuntimeHealth,
} from "@/lib/oneview-api";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";
import {
  RUNTIME_CATEGORY_LABELS,
  operationalToneDotClass,
  operationalToneFromGroup,
  operationalToneFromStatus,
  operationalToneTextClass,
  runtimeStatusLabel,
  type OperationalTone,
} from "@/lib/runtime-health";
import { formatPtBrDateTime } from "@/lib/platform-health";
import { cn } from "@/lib/utils";
import {
  ONEVIEW_DASHBOARD_TEMPLATE_LABEL,
  ONEVIEW_DASHBOARD_TEMPLATES,
  readOneViewDashboardPreferences,
  resetOneViewDashboardPreferences,
  setOneViewDashboardPreferredTemplate,
  type OneViewDashboardPreferences,
  type OneViewDashboardPage,
  type OneViewDashboardTemplate,
} from "@/lib/oneview-dashboard-layout";
import { Switch } from "@/components/ui/switch";
import {
  readOneViewNotificationPreferences,
  SEVERITY_POPUP_LEVELS,
  setOneViewReminderLinkPopup,
  setOneViewReminderLinkSound,
  setOneViewSeverityPopupEnabled,
  toggleOneViewSeverityPopupLevel,
  type OneViewNotificationPreferences,
} from "@/lib/oneview-notification-preferences";
import { SEVERITY_POPUP_LABELS } from "@/lib/oneview-severity-popup";
import { playReminderLinkSound } from "@/lib/oneview-operator-reminder-notification";
import { ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

const sourceStatusLabel: Record<DataSource["status"], string> = {
  active: "Ativa",
  inactive: "Inativa",
  error: "Erro",
};

/** OV-P0-105 — badges de status com tokens de tema. */
function sourceStatusClass(status: DataSource["status"]) {
  if (status === "active") return "ov-status-monitoring-normalized";
  if (status === "error") return "ov-status-monitoring-down";
  return "border-border bg-muted text-muted-foreground";
}

const SETTINGS_REFRESH_SECONDS = 60;
const RUNTIME_CATEGORIES = ["PLATFORM", "ZABBIX", "SERVICENOW", "WORKERS", "INTEGRATIONS"] as const;
const HEALTH_DIMENSIONS = [
  ["SOURCE_CONNECTIVITY", "Rede"],
  ["SOURCE_API", "API"],
  ["SOURCE_AUTH", "Autenticação"],
  ["TLS_STRICT", "TLS estrito"],
  ["SYNC_PROCESS", "Sync Worker"],
  ["SOURCE_FRESHNESS", "Dados da origem"],
  ["ACTIVE_TRUTH", "Active truth"],
] as const;

type SourceSortKey = "name" | "status" | "enabled" | "success" | "alerts" | "failures";
type SortOrder = "asc" | "desc";

function sourceDisplayName(name: string) {
  const label = zabbixSourceDisplayName(name);
  return label || name || "Fonte";
}

function formatClock(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function compactHealthLabel(tone: OperationalTone) {
  if (tone === "ok") return "Saudável";
  if (tone === "partial" || tone === "stale") return "Atenção";
  if (tone === "down") return "Indisponível";
  return "Sem informação";
}

function latestSuccessAt(items: Array<{ last_success_at?: string | null }>) {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const timestamp = Date.parse(String(item.last_success_at || ""));
    if (Number.isNaN(timestamp) || timestamp <= bestMs) continue;
    bestMs = timestamp;
    best = item.last_success_at ?? null;
  }
  return best;
}

function healthCountLabel(components: RuntimeHealthComponent[]) {
  if (!components.length) return "Sem componentes observados";
  const healthy = components.filter((item) => item.status === "HEALTHY").length;
  const attention = components.length - healthy;
  if (attention === 0) return `${healthy} saudáveis`;
  if (healthy === 0) return `${attention} com atenção`;
  return `${healthy} saudáveis · ${attention} com atenção`;
}

function SettingsHealthCheckers({ runtimeHealth }: { runtimeHealth: RuntimeHealthResponse | null }) {
  return (
    <>
      {RUNTIME_CATEGORIES.map((category) => {
        const items = runtimeHealth?.components.filter((item) => item.category === category) ?? [];
        return (
          <section key={category} className="mb-5 last:mb-0">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
              {RUNTIME_CATEGORY_LABELS[category]}
            </h3>
            <div className="grid gap-2 md:grid-cols-2">
              {items.map((item) => {
                const tone = operationalToneFromStatus(item.status, item.last_success_at);
                const hasDimensions = Boolean(item.dimensions && Object.keys(item.dimensions).length);
                return (
                  <div key={item.id} className="ov-panel px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", operationalToneDotClass(tone))} />
                        <span className="truncate font-medium">{item.name}</span>
                        {item.badge ? (
                          <span className="ov-status-badge ov-status-classification-pending">
                            {item.badge_label || "Origem silenciosa"}
                          </span>
                        ) : null}
                      </span>
                      <span className={cn("shrink-0 text-xs font-medium", operationalToneTextClass(tone))}>
                        {runtimeStatusLabel(item.status)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Último sucesso: {formatPtBrDateTime(item.last_success_at) ?? "—"} · Última observação: {formatPtBrDateTime(item.last_observed_at) ?? "—"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Último dado origem: {formatPtBrDateTime(item.last_source_event_at) ?? "—"}
                      {" · "}
                      Último dado DB: {formatPtBrDateTime(item.last_db_event_at) ?? "—"}
                      {item.source_db_lag_seconds != null ? ` · Lag: ${item.source_db_lag_seconds}s` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Intervalo: {item.interval_seconds ? `${item.interval_seconds}s` : "—"}{item.detail ? ` · ${item.detail}` : ""}
                    </p>
                    {hasDimensions ? (
                      <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
                        {HEALTH_DIMENSIONS.map(([key, label]) => {
                          const dim = item.dimensions?.[key];
                          if (!dim) return null;
                          return (
                            <div key={key} className="flex items-center justify-between gap-2 rounded bg-muted/30 px-1.5 py-0.5">
                              <span className="truncate">{label}</span>
                              <span className="font-medium text-foreground">{dim.status}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {item.cause ? (
                      <p className="mt-1 text-xs text-[hsl(var(--ov-color-warning))]">Causa: {item.cause}</p>
                    ) : null}
                    {item.recommended_action ? (
                      <p className="mt-1 text-xs text-muted-foreground">Ação: {item.recommended_action}</p>
                    ) : null}
                    {item.warning ? (
                      <p className="mt-1 text-xs text-[hsl(var(--ov-color-warning))]">Warning: {item.warning}</p>
                    ) : null}
                    {item.current_error ? (
                      <p className="mt-1 text-xs text-error">
                        Erro atual: {item.current_error}{item.last_error_at ? ` · ${formatPtBrDateTime(item.last_error_at)}` : ""}
                      </p>
                    ) : null}
                    {item.last_historical_error ? (
                      <p className="mt-1 text-xs text-muted-foreground">Último erro histórico: {item.last_historical_error}</p>
                    ) : null}
                  </div>
                );
              })}
              {!items.length ? <p className="text-sm text-muted-foreground">Sem componentes observados.</p> : null}
            </div>
          </section>
        );
      })}
    </>
  );
}

export default function SettingsPage() {
  const { user } = useAuthContext();
  const actorId = user?.id || user?.email;
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [healthExpanded, setHealthExpanded] = useState(false);
  const hasSettingsDataRef = useRef(false);
  const [sourceSort, setSourceSort] = useState<SourceSortKey>("name");
  const [sourceOrder, setSourceOrder] = useState<SortOrder>("asc");
  const [dashboardPreferences, setDashboardPreferences] = useState<OneViewDashboardPreferences>(
    () => readOneViewDashboardPreferences(actorId),
  );
  const [notificationPreferences, setNotificationPreferences] = useState<OneViewNotificationPreferences>(
    () => readOneViewNotificationPreferences(actorId),
  );
  const loadRequestRef = useRef<Promise<void> | null>(null);
  const visibleDataSources = useMemo(() => {
    const statusRank: Record<DataSource["status"], number> = { error: 0, inactive: 1, active: 2 };
    const direction = sourceOrder === "asc" ? 1 : -1;
    return [...dataSources].sort((left, right) => {
      const numeric = (source: DataSource) => ({ status: statusRank[source.status], enabled: source.sync_enabled ? 1 : 0, success: Date.parse(source.last_success_at || source.last_sync_at || "") || 0, alerts: source.alerts_count || 0, failures: source.failure_count || 0 }[sourceSort] || 0);
      const comparison = sourceSort === "name"
        ? sourceDisplayName(left.name).localeCompare(sourceDisplayName(right.name), "pt-BR", { sensitivity: "base", numeric: true })
        : numeric(left) - numeric(right);
      return comparison * direction || String(left.id).localeCompare(String(right.id));
    });
  }, [dataSources, sourceOrder, sourceSort]);
  const toggleSourceSort = (field: SourceSortKey) => {
    setSourceOrder((current) => sourceSort === field ? current === "asc" ? "desc" : "asc" : field === "name" ? "asc" : "desc");
    setSourceSort(field);
  };

  useEffect(() => {
    setDashboardPreferences(readOneViewDashboardPreferences(actorId));
  }, [actorId]);

  useEffect(() => {
    setNotificationPreferences(readOneViewNotificationPreferences(actorId));
  }, [actorId]);

  const setDashboardTemplate = useCallback((page: OneViewDashboardPage, template: OneViewDashboardTemplate) => {
    setDashboardPreferences(setOneViewDashboardPreferredTemplate(page, template, actorId));
    toast.success("Preferência de painel salva para este usuário neste navegador.");
  }, [actorId]);

  const resetDashboardPreferences = useCallback(() => {
    setDashboardPreferences(resetOneViewDashboardPreferences(actorId));
    toast.success("Layouts do painel restaurados para o padrão operacional.");
  }, [actorId]);

  const loadPage = useCallback(() => {
    if (loadRequestRef.current) return loadRequestRef.current;
    if (!hasSettingsDataRef.current) setLoading(true);
    const request = (async () => {
      const results = await Promise.allSettled([fetchDataSourcesWithMeta(), fetchRuntimeHealth()]);
      const [sourcesResult, runtimeResult] = results;

      if (sourcesResult.status === "fulfilled") {
        setDataSources(sourcesResult.value.items);
        hasSettingsDataRef.current = true;
        setLoadError(null);
      } else {
        setLoadError(hasSettingsDataRef.current
          ? "Atualização falhou — exibindo último dado disponível"
          : "Não foi possível carregar as fontes de dados.");
        if (!hasSettingsDataRef.current) {
          toast.error(sourcesResult.reason instanceof Error
            ? sourcesResult.reason.message
            : "Erro ao carregar fontes de dados");
        }
      }

      if (runtimeResult.status === "fulfilled") {
        setRuntimeHealth(runtimeResult.value);
        hasSettingsDataRef.current = true;
      }
    })().finally(() => {
      setLoading(false);
      loadRequestRef.current = null;
    });
    loadRequestRef.current = request;
    return request;
  }, []);

  const healthComponents = runtimeHealth?.components ?? [];
  const healthTone = operationalToneFromGroup(healthComponents);
  const lastSyncAt = latestSuccessAt(healthComponents);

  return (
    <AppLayout
      clientSelect={<SectionAccentTitle level={1}>Configurações</SectionAccentTitle>}
      onRefresh={loadPage}
      refreshInterval={SETTINGS_REFRESH_SECONDS}
      showRefreshMeta={false}
    >
      <div className="space-y-6 text-foreground">
        {loadError ? <OperationalErrorBanner message={loadError} onRetry={() => void loadPage()} retryDisabled={loading} /> : null}
        <SectionPanel title="Conta" description="Identificação da sua sessão SSO." bodyClassName="p-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Nome</dt>
              <dd className="truncate text-sm font-medium text-foreground">{user?.name ?? "—"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">E-mail</dt>
              <dd className="truncate text-sm font-medium text-foreground">{user?.email ?? "—"}</dd>
            </div>
          </dl>
        </SectionPanel>

        <SectionPanel
          title="Preferências de painel"
          description="Salvas neste navegador para sua conta. Não alteram dados operacionais nem integrações."
          bodyClassName="space-y-4 p-4"
          aside={(
            <Button type="button" size="sm" variant="outline" onClick={resetDashboardPreferences}>
              Restaurar layouts
            </Button>
          )}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {([
              ["home", "Home"],
              ["monitoring", "Monitoramento"],
              ["alerts", "Alertas"],
              ["incidents", "Chamados"],
              ["history", "Histórico"],
              ["operators", "Links"],
            ] as Array<[OneViewDashboardPage, string]>).map(([page, label]) => (
              <label key={page} className="space-y-1.5">
                <span className="ov-typography-small font-medium text-foreground">{label}</span>
                <Select
                  value={dashboardPreferences.templates[page]}
                  onValueChange={(value) => setDashboardTemplate(page, value as OneViewDashboardTemplate)}
                >
                  <SelectTrigger className="ov-filter-control w-full" aria-label={`Template padrão de ${label}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ONEVIEW_DASHBOARD_TEMPLATES.filter((template) => template !== "wallboard").map((template) => (
                      <SelectItem key={template} value={template}>
                        {ONEVIEW_DASHBOARD_TEMPLATE_LABEL[template]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>
        </SectionPanel>

        <SectionPanel
          title="Notificações"
          description="O Webex/Theo segue independente. O pop-up aparece somente para quem criou o lembrete, em qualquer tela desta conta."
          bodyClassName="space-y-4 p-4"
        >
          <div className="space-y-3">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Pop-up de novos alertas</p>
                <p className="text-xs text-muted-foreground">
                  Avisa em Links e Alertas quando chegar um alerta Disaster, High ou Average nas severidades escolhidas.
                </p>
              </div>
              <Switch
                checked={notificationPreferences.severityPopup.enabled}
                onCheckedChange={(checked) => {
                  setNotificationPreferences(setOneViewSeverityPopupEnabled(checked, actorId));
                }}
                aria-label="Exibir pop-up de novos alertas"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {SEVERITY_POPUP_LEVELS.map((level) => {
                const selected = notificationPreferences.severityPopup.severities.includes(level);
                return (
                  <Button
                    key={level}
                    type="button"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    disabled={!notificationPreferences.severityPopup.enabled}
                    onClick={() => setNotificationPreferences(toggleOneViewSeverityPopupLevel(level, actorId))}
                    aria-pressed={selected}
                  >
                    {SEVERITY_POPUP_LABELS[level]}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Exibir pop-up de lembrete</p>
              <p className="text-xs text-muted-foreground">
                Permanece na tela até você fechar. Desligar aqui não cancela o lembrete nem a mensagem Webex.
              </p>
            </div>
            <Switch
              checked={notificationPreferences.reminderLinkPopup}
              onCheckedChange={(checked) => {
                setNotificationPreferences(setOneViewReminderLinkPopup(checked, actorId));
              }}
              aria-label="Exibir pop-up nos lembretes de link"
            />
          </div>
          <div className="flex flex-col gap-4 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Som nos lembretes de link</p>
              <p className="text-xs text-muted-foreground">
                O aviso na tela continua mesmo com o som desligado.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Switch
                checked={notificationPreferences.reminderLinkSound}
                onCheckedChange={(checked) => {
                  setNotificationPreferences(setOneViewReminderLinkSound(checked, actorId));
                }}
                aria-label="Ativar som nos lembretes de link"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => playReminderLinkSound(actorId, { force: true })}
              >
                Testar som
              </Button>
            </div>
          </div>
        </SectionPanel>

        <Collapsible open={healthExpanded} onOpenChange={setHealthExpanded}>
          <SectionPanel
            title="Saúde"
            description="Resumo do estado. Expandir mostra verificadores, últimos syncs e fontes."
            aria-label="Saúde"
            bodyClassName="p-4"
            aside={(
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadPage()} disabled={loading}>
                  {loading ? <><Loader2 className="h-4 w-4 animate-spin" />Atualizando...</> : "Atualizar"}
                </Button>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="outline" size="sm" aria-expanded={healthExpanded}>
                    {healthExpanded ? "Recolher" : "Expandir"}
                    <ChevronDown className={cn("h-4 w-4 transition-transform", healthExpanded && "rotate-180")} />
                  </Button>
                </CollapsibleTrigger>
              </div>
            )}
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="inline-flex items-center gap-2 font-medium">
                <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", operationalToneDotClass(healthTone))} />
                <span className={operationalToneTextClass(healthTone)}>{compactHealthLabel(healthTone)}</span>
              </span>
              <span className="text-muted-foreground">{healthCountLabel(healthComponents)}</span>
              <span className="tabular-nums text-muted-foreground" title={formatPtBrDateTime(lastSyncAt) || undefined}>
                Último sync {formatClock(lastSyncAt)}
              </span>
            </div>
            <CollapsibleContent>
              <div className="mt-5 border-t border-border/60 pt-5">
                <SettingsHealthCheckers runtimeHealth={runtimeHealth} />
              </div>
              <div className="mt-5 border-t border-border/60 pt-5">
                <h3 className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">Fontes de dados</h3>
                {loading && dataSources.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
                    Carregando fontes de dados...
                  </div>
                ) : dataSources.length === 0 ? (
                  <div className="ov-panel p-4 text-sm text-muted-foreground">
                    Nenhuma fonte de dados disponível na resposta atual.
                  </div>
                ) : (
                  <div className="overflow-x-auto ov-radius-md border border-border">
                    <table className="w-full min-w-[720px] text-sm text-foreground">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                          <th className="px-3 py-3" aria-sort={sourceSort === "name" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Fonte" active={sourceSort === "name"} direction={sourceOrder} onClick={() => toggleSourceSort("name")} /></th>
                          <th className="px-3 py-3" aria-sort={sourceSort === "status" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Status" active={sourceSort === "status"} direction={sourceOrder} onClick={() => toggleSourceSort("status")} /></th>
                          <th className="px-3 py-3" aria-sort={sourceSort === "enabled" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Sincronização habilitada" active={sourceSort === "enabled"} direction={sourceOrder} onClick={() => toggleSourceSort("enabled")} /></th>
                          <th className="px-3 py-3" aria-sort={sourceSort === "success" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Último sucesso" active={sourceSort === "success"} direction={sourceOrder} onClick={() => toggleSourceSort("success")} /></th>
                          <th className="px-3 py-3" aria-sort={sourceSort === "alerts" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Alertas ativos" active={sourceSort === "alerts"} direction={sourceOrder} onClick={() => toggleSourceSort("alerts")} /></th>
                          <th className="px-3 py-3" aria-sort={sourceSort === "failures" ? sourceOrder === "asc" ? "ascending" : "descending" : "none"}><OneViewSortableHeader label="Falhas" active={sourceSort === "failures"} direction={sourceOrder} onClick={() => toggleSourceSort("failures")} /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleDataSources.map((source) => (
                          <tr
                            key={source.id}
                            className="border-b border-border last:border-none hover:bg-muted/30"
                          >
                            <td className="px-3 py-3">
                              <div className="flex flex-col">
                                <span className="font-medium text-foreground">{sourceDisplayName(source.name)}</span>
                                <span className="font-mono text-xs text-muted-foreground">{source.name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <span
                                className={cn(
                                  "ov-status-badge",
                                  sourceStatusClass(source.status),
                                )}
                              >
                                {sourceStatusLabel[source.status]}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-xs text-foreground">{source.sync_enabled ? "Sim" : "Não"}</td>
                            <td className="px-3 py-3 text-xs text-foreground">
                              {source.last_success_at || source.last_sync_at
                                ? formatPtBrDateTime(source.last_success_at || source.last_sync_at)
                                : "—"}
                            </td>
                            <td className="px-3 py-3 font-medium tabular-nums text-foreground">
                              {source.alerts_count ?? "—"}
                            </td>
                            <td className="px-3 py-3 tabular-nums text-foreground">
                              {Number.isFinite(source.failure_count) ? source.failure_count : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </SectionPanel>
        </Collapsible>

        <SectionPanel
          title="Ajuda"
          description="Dúvida de produto, tela quebrada ou problema de desenvolvimento."
          bodyClassName="space-y-2 p-4"
        >
          <p className="text-sm text-foreground">
            Problemas de desenvolvimento ou da plataforma OneView: chamar no Webex{" "}
            <span className="font-medium">guilherme.franco.</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Saúde operacional (Zabbix, sync, fontes) está no bloco Saúde acima. Este contato é para bug, tela quebrada ou dúvida de produto.
          </p>
        </SectionPanel>
      </div>
    </AppLayout>
  );
}
