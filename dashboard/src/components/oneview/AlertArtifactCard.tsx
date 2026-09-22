import { forwardRef } from "react";
import { SeverityBadge } from "@/components/badges/SeverityBadge";
import { cn } from "@/lib/utils";
import type { AlertArtifactModel } from "@/lib/oneview-alert-artifact";
import { normalizeOneViewSeverity, type OneViewSeverity } from "@/lib/oneview-api";

type Props = {
  model: AlertArtifactModel;
  className?: string;
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold text-foreground">{value || "—"}</dd>
    </div>
  );
}

export const AlertArtifactCard = forwardRef<HTMLDivElement, Props>(function AlertArtifactCard({ model, className }, ref) {
  const severity = normalizeOneViewSeverity(model.severity) as OneViewSeverity;
  return (
    <div
      ref={ref}
      className={cn("w-[640px] max-w-full rounded-[var(--ov-radius-surface)] border border-border bg-background p-5 shadow-sm", className)}
      aria-label="Artefato operacional do alerta"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{model.brandLabel}</p>
          <p className="mt-1 truncate text-lg font-semibold text-foreground">{model.customerName}</p>
          <p className="truncate text-sm text-foreground/80">{model.hostName}</p>
        </div>
        <SeverityBadge severity={severity} />
      </div>

      <section className="mt-4 space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Problema</h3>
        <p className="text-sm font-semibold leading-snug text-foreground">{model.problemName}</p>
      </section>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Severidade" value={model.severityLabel} />
        <Field label="Estado" value={model.stateLabel} />
        <Field label="Início" value={model.startedAtLabel} />
        <Field label="Duração" value={model.durationLabel} />
        <Field label="Chamado" value={model.incidentNumber} />
        <Field label="Grupo" value={model.assignmentGroup} />
        <Field label="Responsável" value={model.assignee} />
        <Field label="Gerado em" value={model.generatedAtLabel} />
      </dl>
    </div>
  );
});
