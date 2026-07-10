import { useCallback, useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getStoredTheme, setStoredTheme, getStoredRefreshInterval, setStoredRefreshInterval, Theme } from "@/lib/settings";
import { DataSource, OneViewDataSourceKind, fetchDataSourcesWithMeta, requestDataSourceSync } from "@/lib/oneview-api";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isReadOnlyMode, isSnapshotMode as isDemoMode } from "@/lib/demo-mode";
import { SNAPSHOT_READ_ONLY_MESSAGE } from "@/lib/demo-oneview-data";

const sourceStatusLabel: Record<DataSource["status"], string> = {
  active: "Ativa",
  inactive: "Inativa",
  error: "Erro",
};

const syncStatusLabel: Record<string, string> = {
  success: "Sucesso",
  failed: "Falha",
  running: "Em execução",
  pending: "Pendente",
  test_failed: "Falha no teste",
};

export default function SettingsPage() {
  const readOnlyMode = isDemoMode || isReadOnlyMode;
  const hideSensitiveColumns = isDemoMode || isReadOnlyMode;
  const [theme, setTheme] = useState<Theme>(getStoredTheme());
  const [interval, setInterval] = useState<number>(getStoredRefreshInterval());
  const [saving, setSaving] = useState(false);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [dataSource, setDataSource] = useState<OneViewDataSourceKind | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "oneview_theme") setTheme(getStoredTheme());
      if (event.key === "oneview_refresh_interval") setInterval(getStoredRefreshInterval());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const loadDataSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const response = await fetchDataSourcesWithMeta();
      setDataSources(response.items);
      setDataSource(response.data_source ?? null);
      setCheckedAt(response.checked_at ?? null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao carregar fontes de dados");
    } finally {
      setLoadingSources(false);
    }
  }, []);

  const applyTheme = (nextTheme: Theme) => {
    setStoredTheme(nextTheme);
    setTheme(nextTheme);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      setStoredRefreshInterval(interval);
    } finally {
      setSaving(false);
    }
  };

  const handleRequestSync = async (source: DataSource) => {
    setRunningAction(`sync:${source.id}`);
    try {
      const result = await requestDataSourceSync(source.id);
      toast.success(`${source.name}: solicitação enfileirada (${result.outbox_id})`);
      await loadDataSources();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao solicitar sincronização");
    } finally {
      setRunningAction(null);
    }
  };

  return (
    <AppLayout
      title="Configurações"
      description="Ajustes do painel e integrações"
      onRefresh={loadDataSources}
      refreshInterval={60}
      showRefreshMeta={false}
      dataSource={dataSource}
      checkedAt={checkedAt}
    >
      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="mb-3 text-lg font-semibold">Tema</h2>
          <p className="mb-3 text-sm text-muted-foreground">Escolha o tema do painel</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => applyTheme("light")}
              className={`rounded px-3 py-1 ${theme === "light" ? "bg-primary text-white" : "bg-gray-100"}`}
            >
              Claro
            </button>
            <button
              onClick={() => applyTheme("dark")}
              className={`rounded px-3 py-1 ${theme === "dark" ? "bg-primary text-white" : "bg-gray-100"}`}
            >
              Escuro
            </button>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="mb-3 text-lg font-semibold">Atualização automática</h2>
          <p className="mb-3 text-sm text-muted-foreground">Intervalo em segundos para atualização automática (mínimo de 5 segundos)</p>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={5}
              value={String(interval)}
              onChange={(event) => setInterval(Math.max(5, Number(event.target.value || 5)))}
              className="w-32"
            />
            <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
          </div>
        </Card>

        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Fontes de dados Zabbix</h2>
              <p className="text-sm text-muted-foreground">
                {readOnlyMode
                  ? "Fontes de dados carregadas em modo leitura. A interface não executa sync, ACK ou ações operacionais."
                  : "Solicitações manuais entram na fila. A sincronização é executada pelo serviço dedicado."}
              </p>
            </div>
            <Button variant="outline" onClick={() => void loadDataSources()} disabled={loadingSources}>
              {loadingSources ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Atualizando...</> : "Atualizar lista"}
            </Button>
          </div>

          {readOnlyMode ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {SNAPSHOT_READ_ONLY_MESSAGE}
            </div>
          ) : null}

          {loadingSources ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
              Carregando fontes de dados...
            </div>
          ) : dataSources.length === 0 ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Nenhuma fonte de dados disponível na cópia atual.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className={hideSensitiveColumns ? "w-full min-w-[1050px] text-sm" : "w-full min-w-[1180px] text-sm"}>
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase text-muted-foreground">
                    <th className="py-3 pr-3">Fonte de dados</th>
                    <th className="py-3 pr-3">Status</th>
                    <th className="py-3 pr-3">Sincronização habilitada</th>
                    {!hideSensitiveColumns ? <th className="py-3 pr-3">URL da API</th> : null}
                    {!hideSensitiveColumns ? <th className="py-3 pr-3">Token configurado</th> : null}
                    <th className="py-3 pr-3">Última sincronização</th>
                    <th className="py-3 pr-3">Alertas / Pendência</th>
                    <th className="py-3 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {dataSources.map((source) => (
                    <tr key={source.id} className="border-b border-border/40 last:border-none">
                      <td className="py-3 pr-3">
                        <div className="flex flex-col">
                          <span className="font-medium">{source.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{source.id}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <span className={`rounded px-2 py-1 text-xs font-medium ${
                          source.status === "active"
                            ? "bg-green-50 text-green-700"
                            : source.status === "error"
                              ? "bg-red-50 text-red-700"
                              : "bg-muted text-muted-foreground"
                        }`}>
                          {sourceStatusLabel[source.status]}
                        </span>
                      </td>
                      <td className="py-3 pr-3 text-xs">{source.sync_enabled ? "Sim" : "Não"}</td>
                      {!hideSensitiveColumns ? <td className="max-w-[300px] break-all py-3 pr-3 font-mono text-xs">{source.api_url}</td> : null}
                      {!hideSensitiveColumns ? <td className="py-3 pr-3 text-xs">{source.has_token === undefined ? "-" : source.has_token ? "Sim" : "Não"}</td> : null}
                      <td className="py-3 pr-3">
                        <div className="flex flex-col">
                          <span className={source.last_sync_status === "success" ? "font-medium text-success" : "font-medium text-error"}>{source.last_sync_status ? syncStatusLabel[source.last_sync_status] ?? source.last_sync_status : "-"}</span>
                          <span className="text-xs text-muted-foreground">{source.last_sync_at ? new Date(source.last_sync_at).toLocaleString("pt-BR") : "-"}</span>
                        </div>
                      </td>
                      <td className="max-w-[330px] py-3 pr-3">
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{source.alerts_count ?? "-"} alertas</span>
                          <span className="text-xs text-muted-foreground">{source.pending_reason ?? source.last_error ?? source.last_sync_error ?? "Sem pendências"}</span>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => void handleRequestSync(source)} disabled={readOnlyMode || runningAction !== null || source.status !== "active" || !source.sync_enabled} title={readOnlyMode ? SNAPSHOT_READ_ONLY_MESSAGE : "Enfileirar sincronização"}>
                            {runningAction === `sync:${source.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            Solicitar sincronização
                          </Button>
                        </div>
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
