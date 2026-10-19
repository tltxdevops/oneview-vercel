import { OneViewSemanticStatusBadge } from "@/components/oneview/OneViewDesignSystem";
import type { AlertRelatedIncident, OneViewAlert } from "@/lib/oneview-api";
import {
  describeAlertOperationalDivergences,
  servicenowIncidentStateLabel,
  zabbixAlertOperationalStateLabel,
} from "@/lib/oneview-alert-operational-states";

type Props = {
  alert: OneViewAlert;
  incident?: Pick<AlertRelatedIncident, "state" | "state_display" | "number"> | null;
};

export function AlertOperationalStateCallout({ alert, incident }: Props) {
  const divergences = describeAlertOperationalDivergences(alert, incident);
  const incidentState = servicenowIncidentStateLabel(incident);

  return (
    <section aria-label="Estados do alerta e do chamado" className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[11px] text-muted-foreground">Estado do alerta (Zabbix)</dt>
          <dd className="mt-0.5 font-semibold">{zabbixAlertOperationalStateLabel(alert)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted-foreground">Estado do chamado (ServiceNow)</dt>
          <dd className="mt-0.5 font-semibold">{incidentState ?? "Sem chamado correlacionado"}</dd>
        </div>
      </dl>
      {divergences.map((item) => (
        <p key={item.kind} className="flex flex-wrap items-start gap-2 text-xs text-muted-foreground">
          <OneViewSemanticStatusBadge status="divergence" label="Divergência" />
          <span>{item.message}</span>
        </p>
      ))}
    </section>
  );
}
