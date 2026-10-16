import { useEffect, useState } from "react";
import { OneViewButton } from "@/components/oneview/OneViewDesignSystem";
import { fetchMaintenanceCatalog, OneViewApiError, previewMaintenanceWindow, type MaintenanceCatalog, type MaintenancePreview } from "@/lib/oneview-api";

const BLOCKER_LABEL: Record<string, string> = {
  maintenance_writes_disabled: "Escrita no Zabbix desligada até o canário.",
  hostids_not_confirmed: "Os hosts ainda não têm hostid confirmado nesta origem.",
  live_version_not_confirmed: "A versão ao vivo deste Zabbix ainda não foi confirmada.",
  maintenance_permission_denied: "Este operador não tem permissão de manutenção.",
};

export function CentralMaintenancesPanel() {
  const [catalog, setCatalog] = useState<MaintenanceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState("");
  const [datasource, setDatasource] = useState("teletex-http");
  const [hosts, setHosts] = useState("");
  const [reason, setReason] = useState("");
  const [preset, setPreset] = useState("2h");
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchMaintenanceCatalog().then(setCatalog).catch((error) => {
      setLoadError(error instanceof OneViewApiError ? error.message : "Não foi possível carregar o contrato de manutenção.");
    });
    return () => controller.abort();
  }, []);

  async function submitPreview() {
    setBusy(true);
    setPreview(null);
    setPreviewError(null);
    const start = new Date(Date.now() + 5 * 60 * 1000);
    const hours = preset === "30m" ? 0.5 : preset === "8h" ? 8 : 2;
    const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
    try {
      const result = await previewMaintenanceWindow({
        customer,
        datasource,
        hosts: hosts.split(",").map((name) => ({ name: name.trim() })).filter((host) => host.name),
        reason,
        requester: "Operador OneView",
        duration_preset: preset === "30m" || preset === "8h" || preset === "2h" ? preset : "custom",
        collect_data: true,
        active_since: start.toISOString(),
        active_till: end.toISOString(),
      });
      setPreview(result);
    } catch (error) {
      setPreviewError(error instanceof OneViewApiError ? error.message : "A prévia foi recusada.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="ov-type-section-title">Manutenções programadas</h3>
          <p className="ov-type-caption text-muted-foreground">Janelas atuais, futuras e encerradas. Nenhuma manutenção é criada neste passo.</p>
        </div>
        <OneViewButton type="button" variant="secondary" onClick={() => setOpen((current) => !current)}>Nova manutenção</OneViewButton>
      </div>
      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="status">
        {catalog?.read_reason || loadError || "Escrita no Zabbix desligada. A coleta de dados permanece ligada na prévia."}
      </p>
      {catalog?.compatibility?.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {catalog.compatibility.map((item) => (
            <li key={item.datasource} className="rounded-md border border-border/70 px-3 py-2 text-sm">
              <span className="font-medium">{item.datasource}</span>
              <span className="text-muted-foreground"> · {item.expected_version}</span>
              <p className="text-xs text-muted-foreground">{item.maintenance_get ? "Leitura prevista" : "Leitura indisponível"} · escrita bloqueada</p>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-sm text-muted-foreground">Nenhuma janela ativa, agendada ou encerrada foi carregada do Zabbix.</p>
      {open ? (
        <form className="space-y-3 rounded-md border border-border/70 p-3" onSubmit={(event) => { event.preventDefault(); void submitPreview(); }}>
          <label className="block text-sm">Cliente<input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1" value={customer} maxLength={160} onChange={(event) => setCustomer(event.target.value)} /></label>
          <label className="block text-sm">Datasource
            <select className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1" value={datasource} onChange={(event) => setDatasource(event.target.value)}>
              {(catalog?.compatibility || [{ datasource: "teletex-http" }]).map((item) => <option key={item.datasource} value={item.datasource}>{item.datasource}</option>)}
            </select>
          </label>
          <label className="block text-sm">Hosts, separados por vírgula<input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1" value={hosts} maxLength={2000} onChange={(event) => setHosts(event.target.value)} /></label>
          <label className="block text-sm">Duração
            <select className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1" value={preset} onChange={(event) => setPreset(event.target.value)}>
              <option value="30m">30 minutos</option>
              <option value="2h">2 horas</option>
              <option value="8h">8 horas</option>
            </select>
          </label>
          <label className="block text-sm">Motivo<input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></label>
          <OneViewButton type="submit" variant="secondary" disabled={busy || !customer.trim() || !reason.trim() || !hosts.trim()}>Ver prévia</OneViewButton>
          {preview || previewError ? (
            <div className="text-sm" role="status">
              {previewError ? <p>{previewError}</p> : null}
              <p>Confirmação bloqueada. Nada foi enviado ao Zabbix.</p>
              <ul>
                {(preview?.operations || []).flatMap((operation) => operation.blockers).map((blocker) => (
                  <li key={blocker}>{BLOCKER_LABEL[blocker] || blocker}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
