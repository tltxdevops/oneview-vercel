import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { displayIncidentField } from "@/components/oneview/OperationalIncidentsQueueList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  fetchIncidentRelatedAlert,
  type IncidentRelatedAlert,
  type OneViewIncident,
} from "@/lib/oneview-api";

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function alertStatusLabel(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "active") return "Ativo";
  if (key === "resolved") return "Resolvido";
  return displayIncidentField(value);
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-semibold">{value}</dd>
    </div>
  );
}

export function useIncidentRelatedAlert(incident: OneViewIncident | null) {
  const [relatedAlert, setRelatedAlert] = useState<IncidentRelatedAlert | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const sysId = String(incident?.sys_id || "").trim();
  const number = String(incident?.number || "").trim();
  const sourceEventId = String(incident?.zabbix_event_id || "").trim();
  const hasIncident = incident != null;

  useEffect(() => {
    if (!sysId && !number && !sourceEventId) {
      setRelatedAlert(null);
      setLoading(false);
      setChecked(hasIncident);
      return;
    }
    // Sem signal: GETs idênticos entram no cache/in-flight compartilhado de 8 s.
    let active = true;
    setRelatedAlert(null);
    setLoading(true);
    setChecked(false);
    fetchIncidentRelatedAlert({ sysId, number, sourceEventId })
      .then((response) => {
        if (!active) return;
        setRelatedAlert(response.matched && response.alert ? response.alert : null);
        setChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setRelatedAlert(null);
        setChecked(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [hasIncident, sysId, number, sourceEventId]);

  return { relatedAlert, loading, checked };
}

export type IncidentRelatedAlertState = ReturnType<typeof useIncidentRelatedAlert>;

export function IncidentRelatedAlertContent({
  relatedAlert,
  loading,
  checked,
}: IncidentRelatedAlertState) {

  return (
    <section aria-label="Alerta relacionado" className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Alerta relacionado</h3>
      {loading ? (
        <div className="space-y-2" aria-label="Carregando alerta relacionado">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : checked && relatedAlert ? (
        <div className="space-y-3 rounded-md border border-border/70 p-3">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <DetailField label="Cliente" value={displayIncidentField(relatedAlert.customer)} />
            <DetailField label="Host" value={displayIncidentField(relatedAlert.host)} />
            <DetailField label="Problema" value={displayIncidentField(relatedAlert.problem)} />
            <DetailField label="Severidade" value={displayIncidentField(relatedAlert.severity)} />
            <DetailField label="Início" value={formatDateTime(relatedAlert.created_at || relatedAlert.first_seen_at)} />
            <DetailField label="Estado" value={alertStatusLabel(relatedAlert.status)} />
          </dl>
          <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" asChild>
            <Link to={relatedAlert.oneview_link || `/alertas?alert=${encodeURIComponent(relatedAlert.id)}`}>
              Ver alerta
            </Link>
          </Button>
        </div>
      ) : checked ? (
        <div className="space-y-1 rounded-md border border-border/70 p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Sem alerta relacionado</p>
          <p>Este chamado não possui correlação com um alerta do OneView.</p>
        </div>
      ) : null}
    </section>
  );
}

export function IncidentRelatedAlertSection({ incident }: { incident: OneViewIncident }) {
  return <IncidentRelatedAlertContent {...useIncidentRelatedAlert(incident)} />;
}

export function IncidentDetailField({
  label,
  value,
  mono,
  pre,
}: {
  label: string;
  value: string;
  mono?: boolean;
  pre?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words font-semibold", mono && "font-mono", pre && "whitespace-pre-wrap")}>{value}</dd>
    </div>
  );
}
