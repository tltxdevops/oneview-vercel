import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ServiceNowDevLink } from "@/components/oneview/ServiceNowDevLink";
import { displayIncidentField } from "@/components/oneview/OperationalIncidentsQueueList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
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

function alertSeverityLabel(value: string | null | undefined) {
  return displayIncidentField(value);
}

function alertStatusLabel(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "active") return "Ativo";
  if (key === "resolved") return "Resolvido";
  return displayIncidentField(value);
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{value}</p>
    </div>
  );
}

export function IncidentQuickSheet({
  incident,
  onOpenChange,
}: {
  incident: OneViewIncident | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [relatedAlert, setRelatedAlert] = useState<IncidentRelatedAlert | null>(null);
  const [relatedAlertLoading, setRelatedAlertLoading] = useState(false);
  const [relatedAlertChecked, setRelatedAlertChecked] = useState(false);

  useEffect(() => {
    if (!incident) {
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(false);
      return;
    }
    const sysId = String(incident.sys_id || "").trim();
    const number = String(incident.number || "").trim();
    if (!sysId && !number) {
      setRelatedAlert(null);
      setRelatedAlertLoading(false);
      setRelatedAlertChecked(true);
      return;
    }
    const controller = new AbortController();
    setRelatedAlert(null);
    setRelatedAlertLoading(true);
    setRelatedAlertChecked(false);
    fetchIncidentRelatedAlert({ sysId, number }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setRelatedAlert(response.matched && response.alert ? response.alert : null);
        setRelatedAlertChecked(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRelatedAlert(null);
        setRelatedAlertChecked(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRelatedAlertLoading(false);
      });
    return () => controller.abort();
  }, [incident]);

  const descriptionText = incident
    ? displayIncidentField(incident.description, incident.short_description)
    : "—";
  const hasZabbixHost = Boolean(String(incident?.u_hostname_zabbix || "").trim());
  const hasZabbixIp = Boolean(String(incident?.u_ip_zabbix || "").trim());

  return (
    <Sheet open={incident !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-l border-border bg-background p-0 sm:max-w-xl">
        {incident ? (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 py-5 pl-6 pr-14 text-left">
              <SheetTitle className="font-mono text-lg">{displayIncidentField(incident.number)}</SheetTitle>
              <SheetDescription>{displayIncidentField(incident.company_display, incident.company)}</SheetDescription>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline">{displayIncidentField(incident.state_display, incident.state)}</Badge>
                <Badge variant="secondary">{displayIncidentField(incident.priority_display, incident.priority)}</Badge>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              <DetailField label="Descrição" value={descriptionText} />
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailField label="Grupo" value={displayIncidentField(incident.assignment_group_display, incident.assignment_group)} />
                <DetailField label="Responsável" value={displayIncidentField(incident.assigned_to_display, incident.assigned_to)} />
                <DetailField label="Abertura" value={formatDateTime(incident.opened_at)} />
                <DetailField label="Atualização" value={formatDateTime(incident.sys_updated_on)} />
                <DetailField label="Encerramento" value={formatDateTime(incident.closed_at || incident.resolved_at)} />
                <DetailField label="Caller" value={displayIncidentField(incident.caller_id_display, incident.caller_id)} />
                <DetailField label="Canal" value={displayIncidentField(incident.contact_type_display, incident.contact_type)} />
              </div>

              {hasZabbixHost || hasZabbixIp ? (
                <section aria-label="Dados Zabbix" className="space-y-3 rounded-md border border-border/70 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Zabbix</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {hasZabbixHost ? <DetailField label="Hostname Zabbix" value={displayIncidentField(incident.u_hostname_zabbix)} /> : null}
                    {hasZabbixIp ? <DetailField label="IP Zabbix" value={displayIncidentField(incident.u_ip_zabbix)} /> : null}
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
                      <DetailField label="Cliente" value={displayIncidentField(relatedAlert.customer)} />
                      <DetailField label="Host" value={displayIncidentField(relatedAlert.host)} />
                      <DetailField label="Problema" value={displayIncidentField(relatedAlert.problem)} />
                      <DetailField label="Severidade" value={alertSeverityLabel(relatedAlert.severity)} />
                      <DetailField label="Início" value={formatDateTime(relatedAlert.first_seen_at)} />
                      <DetailField label="Estado" value={alertStatusLabel(relatedAlert.status)} />
                    </div>
                    <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" asChild>
                      <Link to={`/alertas?alert=${encodeURIComponent(relatedAlert.id)}`}>
                        Ver alerta
                      </Link>
                    </Button>
                  </div>
                ) : relatedAlertChecked ? (
                  <p className="text-sm text-muted-foreground">Alerta relacionado não localizado</p>
                ) : null}
              </section>
            </div>

            <div className="border-t border-border/70 px-6 py-4">
              {incident.sys_id ? (
                <ServiceNowDevLink href={incident.servicenow_url} sysId={incident.sys_id} fullWidth />
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
  );
}
