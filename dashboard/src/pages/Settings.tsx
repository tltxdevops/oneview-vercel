import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getStoredTheme, setStoredTheme, getStoredRefreshInterval, setStoredRefreshInterval, Theme } from "@/lib/settings";
import { DataSource, fetchDataSources, requestDataSourceSync } from "@/lib/oneview-api";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme());
  const [interval, setInterval] = useState<number>(getStoredRefreshInterval());
  const [saving, setSaving] = useState(false);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
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

  const loadDataSources = async () => {
    setLoadingSources(true);
    try {
      setDataSources(await fetchDataSources());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao carregar Data Sources");
    } finally {
      setLoadingSources(false);
    }
  };

  useEffect(() => {
    void loadDataSources();
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
      toast.success(`${source.name}: solicitacao enfileirada (${result.outbox_id})`);
      await loadDataSources();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao solicitar sincronizacao");
    } finally {
      setRunningAction(null);
    }
  };

  return (
    <AppLayout title="Configuracoes" description="Ajustes da dashboard e integracoes">
      <div className="space-y-6">
        <Card className="p-6">
          <h2 className="mb-3 text-lg font-semibold">Tema</h2>
          <p className="mb-3 text-sm text-muted-foreground">Escolha tema da dashboard</p>
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
          <h2 className="mb-3 text-lg font-semibold">Atualizacao automatica</h2>
          <p className="mb-3 text-sm text-muted-foreground">Intervalo em segundos para auto-refresh (minimo 5s)</p>
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
              <h2 className="text-lg font-semibold">Data Sources Zabbix</h2>
              <p className="text-sm text-muted-foreground">Solicitacoes manuais entram no outbox. Quem executa a sincronizacao e o Worker.</p>
            </div>
            <Button variant="outline" onClick={() => void loadDataSources()} disabled={loadingSources}>
              {loadingSources ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Atualizando...</> : "Atualizar lista"}
            </Button>
          </div>

          {loadingSources ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline-block h-4 w-4 animate-spin" />
              Carregando Data Sources...
            </div>
          ) : dataSources.length === 0 ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Nenhum Data Source cadastrado. Configure o piloto na DB VM, rode as migrations e execute database/scripts/seed_zabbix_data_sources.py.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs uppercase text-muted-foreground">
                    <th className="py-3 pr-3">Cliente</th>
                    <th className="py-3 pr-3">Ambiente</th>
                    <th className="py-3 pr-3">Status</th>
                    <th className="py-3 pr-3">Sync</th>
                    <th className="py-3 pr-3">Ultimo sucesso</th>
                    <th className="py-3 pr-3">Falhas</th>
                    <th className="py-3 pr-3">Detalhe</th>
                    <th className="py-3 text-right">Acoes</th>
                  </tr>
                </thead>
                <tbody>
                  {dataSources.map((source) => (
                    <tr key={source.id} className="border-b border-border/40 last:border-none">
                      <td className="py-3 pr-3 font-medium">{source.name}</td>
                      <td className="py-3 pr-3">{source.environment}{source.via_vpn ? " / VPN" : ""}</td>
                      <td className="py-3 pr-3">
                        <span className={`rounded px-2 py-1 text-xs font-medium ${
                          source.status === "active"
                            ? "bg-green-50 text-green-700"
                            : source.status === "error"
                              ? "bg-red-50 text-red-700"
                              : "bg-muted text-muted-foreground"
                        }`}>
                          {source.status}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-col">
                          <span>{source.sync_enabled ? "ativo" : "pausado"}</span>
                          <span className="text-xs text-muted-foreground">{source.sync_interval_seconds}s</span>
                          <span className="text-xs text-muted-foreground">{source.last_sync_at ? new Date(source.last_sync_at).toLocaleString("pt-BR") : "-"}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-3 text-muted-foreground">
                        {source.last_success_at ? new Date(source.last_success_at).toLocaleString("pt-BR") : "-"}
                      </td>
                      <td className="py-3 pr-3">{source.failure_count}</td>
                      <td className="max-w-[300px] truncate py-3 pr-3 text-muted-foreground">{source.last_error ?? source.last_sync_error ?? "-"}</td>
                      <td className="py-3">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" onClick={() => void handleRequestSync(source)} disabled={runningAction !== null || source.status !== "active" || !source.sync_enabled}>
                            {runningAction === `sync:${source.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            Enfileirar sync
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
