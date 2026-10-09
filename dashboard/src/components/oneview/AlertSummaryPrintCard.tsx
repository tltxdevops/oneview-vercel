import { ClientIdentity, canonicalHostName, displayHostField, operationalClientLabel } from "@/components/oneview/ClientIdentity";
import { AlertRecurrenceSignal } from "@/components/oneview/AlertRecurrenceSignal";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatOneViewSeverityLabel, type AlertRelatedIncident, type OneViewAlert } from "@/lib/oneview-api";
import { sourceAckRowKind, sourceAckRowLabel } from "@/lib/oneview-alert-source-ack";
import { zabbixSourceDisplayName } from "@/lib/oneview-zabbix-source";

const ORIGIN_UNAVAILABLE = "Indisponível na origem";
const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";

type Props = {
  alert: OneViewAlert;
  relatedIncidents?: AlertRelatedIncident[];
};

function formatDateTime(value?: string | null) {
  if (!value) return ORIGIN_UNAVAILABLE;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ORIGIN_UNAVAILABLE
    : date.toLocaleString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE });
}

function isResolvedAlert(alert: OneViewAlert) {
  const sourceStatus = String(alert.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert.status_internal || "").trim().toLowerCase();
  return Boolean(alert.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

function actorName(alert: OneViewAlert) {
  const actor = String(alert.acknowledged_source_by || alert.acknowledged_by || "").trim();
  if (!actor || /^\d+$/.test(actor) || /worker|oneview|sistema|system|reconcil/i.test(actor)) {
    return "Sem responsável";
  }
  return actor;
}

function relatedIncidentLabel(items: AlertRelatedIncident[]) {
  const current = items.find((item) => !item.identity_conflict && String(item.number || "").trim()) || items[0];
  const number = String(current?.number || "").trim().toUpperCase();
  if (!number) return "Sem chamado relacionado";
  const state = String(current?.state_display || current?.state || "").trim();
  return state ? `${number} · ${state}` : number;
}

function PrintField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold text-zinc-900">{value}</dd>
    </div>
  );
}

export function AlertSummaryPrintCard({ alert, relatedIncidents = [] }: Props) {
  const customer = {
    key: alert.customer_key,
    name: alert.customer_name,
    source: alert.customer_source,
  };
  const clientName = operationalClientLabel({
    ...customer,
    operational_scope: alert.operational_scope,
    operational_scope_label: alert.operational_scope_label,
  });
  const hostVisible = displayHostField(alert.host_visible_name, canonicalHostName(alert));
  const hostTechnical = displayHostField(alert.host_technical_name, ORIGIN_UNAVAILABLE);
  const resolved = isResolvedAlert(alert);
  const originAck = sourceAckRowKind(alert);
  const ackPending = originAck === "pending";

  return (
    <article
      data-alert-summary-print-card
      className="w-[720px] rounded-xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-sm [font-synthesis:none] [-webkit-font-smoothing:antialiased]"
      aria-label="Resumo operacional para print"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ClientIdentity
          customer={customer}
          operationalScope={alert.operational_scope}
          operationalScopeLabel={alert.operational_scope_label}
          size="lg"
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold leading-tight">{clientName}</p>
          <p className="mt-0.5 truncate text-sm text-zinc-600">{hostVisible}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={alert.severity} />
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                resolved
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-700",
              )}
            >
              {resolved ? "Resolvido" : "Ativo"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                ackPending
                  ? "border-amber-200 bg-amber-50 text-amber-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700",
              )}
            >
              {ackPending ? "ACK pendente" : originAck === "acknowledged" ? "ACK" : "Sem ACK"}
            </Badge>
          </div>
        </div>
      </div>

      <section className="mt-5 space-y-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Identidade</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
          <PrintField label="Cliente" value={clientName} />
          <PrintField label="Fonte Zabbix" value={zabbixSourceDisplayName(alert.datasource_name)} />
          <PrintField label="Host" value={hostVisible} />
          <PrintField label="Host técnico" value={hostTechnical} />
          <PrintField
            label="Trigger/Problema"
            value={String(alert.problem_name || alert.trigger_description || "").trim() || "Alerta sem descrição"}
          />
          <PrintField label="Severidade" value={formatOneViewSeverityLabel(alert.severity)} />
        </dl>
      </section>

      <section className="mt-5 space-y-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Estado</h2>
        <AlertRecurrenceSignal alert={alert} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
          <PrintField label="Estado da origem" value={String(alert.status_source || "").trim() || ORIGIN_UNAVAILABLE} />
          <PrintField label="ACK origem" value={sourceAckRowLabel(originAck)} />
          <PrintField label="ACK OneView" value={alert.acknowledged_internal ? "Reconhecido" : "Não reconhecido"} />
          <PrintField label="Responsável" value={actorName(alert)} />
          <PrintField label="Primeira ocorrência" value={formatDateTime(alert.first_seen_at)} />
          <PrintField label="Última ocorrência" value={formatDateTime(alert.last_seen_at)} />
          <PrintField label="Recuperação" value={formatDateTime(alert.resolved_at)} />
          <PrintField label="Chamado relacionado" value={relatedIncidentLabel(relatedIncidents)} />
        </dl>
      </section>
    </article>
  );
}
