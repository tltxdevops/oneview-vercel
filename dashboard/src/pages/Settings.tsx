/**
 * OV-P0-110 — Configurações enxutas: Tema · Saúde da automação · Fontes de dados.
 * Sem controle falso de intervalo de sync Zabbix; sem banner de modo leitura;
 * sem ação manual de sync desabilitada nesta tela.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getStoredTheme, setStoredTheme, Theme } from "@/lib/settings";
import {
  DataSource,
  OneViewDataSourceKind,
  OneViewHealthResponse,
  OneViewSyncLog,
  OperationsHealthResponse,
  fetchDataSourcesWithMeta,
  fetchOneViewHealth,
  fetchOperationsHealth,
  fetchSyncLogs,
  RuntimeHealthResponse,
  fetchRuntimeHealth,
} from "@/lib/oneview-api";
import { runtimeStatusLabel, runtimeStatusTone } from "@/lib/runtime-health";
import {
  DEFAULT_SYNC_INTERVAL_SECONDS,
  HealthLevel,
  buildPlatformHealthSnapshot,
  findTeletexSource,
  formatPtBrDateTime,
  resolveSyncIntervalSeconds,
  statusLabel as platformStatusLabel,
} from "@/lib/platform-health";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const sourceStatusLabel: Record<DataSource["status"], string> = {
  active: "Ativa",
  inactive: "Inativa",
  error: "Erro",
};

/** OV-P0-105 — badges de status com tokens de tema. */
function sourceStatusClass(status: DataSource["status"]) {
  if (status === "active") return "border-border bg-success/10 text-success";
  if (status === "error") return "border-border bg-error/10 text-error";
  return "border-border bg-muted text-muted-foreground";
}

const THEME_TOGGLE_BASE =
  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const SETTINGS_REFRESH_SECONDS = 60;

function settingsHealthLabel(level: HealthLevel) {
  if (level === "ok") return "Operacional";
  if (level === "warn") return "Atenção";
  if (level === "down") return "Crítico";
  return "Sem informação";
}

function healthToneClass(level: HealthLevel) {
  if (level === "ok") return "text-success";
  if (level === "warn") return "text-amber-700 dark:text-amber-400";
  if (level === "down") return "text-error";
  return "text-muted-foreground";
}

function sourceDisplayName(name: string) {
  if (String(name || "").toLowerCase() === "teletex-http") return "Teletex";
  return name || "Fonte";
}

function formatClock(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function nextExpectedLabel(intervalSeconds: number) {
  const minutes = Math.max(1, Math.round(Math.max(1, intervalSeconds) / 60));
  return `~${minutes} min`;
}

function recoveryLabel(level: HealthLevel, failureCount: number | null | undefined) {
  const failures = Number.isFinite(failureCount) ? Math.max(0, Number(failureCount)) : 0;
  if (level === "down" || failures >= 3) return "Manual";
  if (level === "warn") return "Automático depois";
  return "Automático";
}

export default function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme());
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [dataSource, setDataSource] = useState<OneViewDataSourceKind | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [health, setHealth] = useState<OneViewHealthResponse | null>(null);
  const [operations, setOperations] = useState<OperationsHealthResponse | null>(null);
  const [syncLogs, setSyncLogs] = useState<OneViewSyncLog[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRequestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "oneview_theme") setTheme(getStoredTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const loadPage = useCallback(() => {
    if (loadRequestRef.current) return loadRequestRef.current;
    setLoading(true);
    const request = (async () => {
      const results = await Promise.allSettled([fetchDataSourcesWithMeta(), fetchRuntimeHealth()]);
      const [sourcesResult, runtimeResult] = results;

      if (sourcesResult.status === "fulfilled") {
        setDataSources(sourcesResult.value.items);
        setDataSource(sourcesResult.value.data_source ?? null);
        setCheckedAt(sourcesResult.value.checked_at ?? null);
      } else {
        toast.error(sourcesResult.reason instanceof Error
          ? sourcesResult.reason.message
          : "Erro ao carregar fontes de dados");
      }

      if (runtimeResult.status === "fulfilled") setRuntimeHealth(runtimeResult.value);
    })().finally(() => {
      setLoading(false);
      loadRequestRef.current = null;
    });
    loadRequestRef.current = request;
    return request;
  }, []);

  const applyTheme = (nextTheme: Theme) => {
    setStoredTheme(nextTheme);
    setTheme(nextTheme);
  };

  const healthSnapshot = useMemo(
    () => buildPlatformHealthSnapshot({
      health,
      operations,
      dataSources,
      syncLogs,
    }),
    [health, operations, dataSources, syncLogs],
  );

  const teletexOps = findTeletexSource(operations?.items);
  const teletexDs = findTeletexSource(dataSources);
  const intervalSeconds = resolveSyncIntervalSeconds(
    teletexOps?.sync_interval_seconds,
    teletexDs?.sync_interval_seconds,
    DEFAULT_SYNC_INTERVAL_SECONDS,
  );
  const failureCount = teletexOps?.failure_count ?? teletexDs?.failure_count ?? null;
  const teletexLevel = healthSnapshot.items.find((item) => item.key === "teletex")?.level ?? "unknown";

  return (
    <AppLayout
      title="Configurações"
      description="Tema, saúde da automação e fontes de dados"
      onRefresh={loadPage}
      refreshInterval={SETTINGS_REFRESH_SECONDS}
      showRefreshMeta={false}
      showHealthStrip={false}
      dataSource={dataSource}
      checkedAt={checkedAt}
    >
      <div className="space-y-6 text-foreground">
        <Card className="border-border bg-card p-6 text-card-foreground">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Tema</h2>
          <p className="mb-3 text-sm text-muted-foreground">Claro / Escuro</p>
          <div className="flex items-center gap-3" role="group" aria-label="Tema do painel">
            <button
              type="button"
              onClick={() => applyTheme("light")}
              aria-pressed={theme === "light"}
              className={cn(
                THEME_TOGGLE_BASE,
                theme === "light"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              Claro
            </button>
            <button
              type="button"
              onClick={() => applyTheme("dark")}
              aria-pressed={theme === "dark"}
              className={cn(
                THEME_TOGGLE_BASE,
                theme === "dark"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              Escuro
            </button>
          </div>
        </Card>

        <Card className="border-border bg-card p-6 text-card-foreground" aria-label="Saúde da aplicação">
          <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Saúde da aplicação</h2><p className="text-sm text-muted-foreground">Contrato Runtime Health V2.</p></div><Button variant="outline" onClick={() => void loadPage()} disabled={loading}>Atualizar</Button></div>
          {["PLATFORM", "ZABBIX", "SERVICENOW", "WORKERS", "INTEGRATIONS"].map((category) => {
            const items = runtimeHealth?.components.filter((item) => item.category === category) ?? [];
            return <section key={category} className="mb-5 last:mb-0"><h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">{category}</h3><div className="grid gap-2 md:grid-cols-2">{items.map((item) => <div key={item.id} className="rounded-md border border-border/70 px-3 py-2 text-sm"><div className="flex items-center justify-between gap-2"><span className="font-medium">{item.name}</span><span className={cn("inline-flex items-center gap-1", runtimeStatusTone(item.status).split(" ")[1])}><span className={cn("h-2 w-2 rounded-full", runtimeStatusTone(item.status).split(" ")[0])} />{runtimeStatusLabel(item.status)}</span></div><p className="mt-1 text-xs text-muted-foreground">Último sucesso: {formatPtBrDateTime(item.last_success_at) ?? "—"} · Intervalo: {item.interval_seconds ? `${item.interval_seconds}s` : "—"}</p>{item.last_error ? <p className="mt-1 text-xs text-error">Erro: {item.last_error}</p> : null}</div>)}{!items.length ? <p className="text-sm text-muted-foreground">Sem componentes observados.</p> : null}</div></section>;
          })}
        </Card>

        <Card className="border-border bg-card p-6 text-card-foreground" aria-label="Saúde da automação" hidden>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Saúde da automação</h2>
              <p className="text-sm text-muted-foreground">
                Estado do banco, worker e fonte Teletex. A sincronização é feita pelo worker.
              </p>
            </div>
            <Button variant="outline" onClick={() => void loadPage()} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Atualizando...
                </>
              ) : (
                "Atualizar"
              )}
            </Button>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            {healthSnapshot.items.map((item) => (
              <div
                key={item.key}
                className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2"
              >
                <dt className="text-sm text-muted-foreground">{item.name}</dt>
                <dd className={cn("text-sm font-medium", healthToneClass(item.level))}>
                  {settingsHealthLabel(item.level)}
                  <span className="sr-only"> ({platformStatusLabel(item.level)})</span>
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Último sync</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground" title={formatPtBrDateTime(healthSnapshot.lastSyncAt) || undefined}>
                {formatClock(healthSnapshot.lastSyncAt)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Próximo esperado</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">{nextExpectedLabel(intervalSeconds)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Falhas seguidas</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">
                {failureCount == null ? "—" : failureCount}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Recovery</dt>
              <dd className="text-sm font-medium text-foreground">{recoveryLabel(teletexLevel, failureCount)}</dd>
            </div>
          </dl>
        </Card>

        <Card className="border-border bg-card p-6 text-card-foreground">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">Fontes de dados</h2>
            <p className="text-sm text-muted-foreground">
              Status e última sincronização bem-sucedida. Sem ações manuais de sync nesta tela.
            </p>
          </div>

          {loading && dataSources.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
              Carregando fontes de dados...
            </div>
          ) : dataSources.length === 0 ? (
            <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              Nenhuma fonte de dados disponível na resposta atual.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[720px] text-sm text-foreground">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-3">Fonte</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Sincronização habilitada</th>
                    <th className="px-3 py-3">Último sucesso</th>
                    <th className="px-3 py-3">Alertas ativos</th>
                    <th className="px-3 py-3">Falhas</th>
                  </tr>
                </thead>
                <tbody>
                  {dataSources.map((source) => (
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
                            "inline-flex rounded-md border px-2 py-1 text-xs font-medium",
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
        </Card>
      </div>
    </AppLayout>
  );
}
