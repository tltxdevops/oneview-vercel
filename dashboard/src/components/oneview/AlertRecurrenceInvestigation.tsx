import { Link } from "react-router-dom";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import type { OneViewAlert } from "@/lib/oneview-api";

function when(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

function duration(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function Count({ label, value }: { label: string; value: number | null | undefined }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 font-semibold">{Number(value || 0).toLocaleString("pt-BR")}</dd></div>;
}

export function AlertRecurrenceInvestigation({ alert }: { alert: OneViewAlert }) {
  const previous = alert.recurrence_previous;
  const sameProblem = alert.same_problem;
  const href = alert.recurrence_key ? `/historico?tab=alertas&status=all&recurrence=${encodeURIComponent(alert.recurrence_key)}` : null;

  return (
    <div className="space-y-4">
      <section aria-label="Reincidência deste ativo" className="rounded-lg border border-border/70 bg-muted/20 p-3">
        <h3 className="text-sm font-semibold">Reincidência deste ativo</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Mesmo ativo e trigger; episódios só contam após recovery.</p>
        {href ? (
          <>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><Count label="Ocorrências 24 h" value={alert.recurrence_count_24h} /><Count label="Ocorrências 7 d" value={alert.recurrence_count_7d} /></dl>
            {previous ? <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Última ocorrência anterior</dt><dd className="mt-0.5 font-semibold">{when(previous.occurrence_at)}</dd></div><div><dt className="text-xs text-muted-foreground">Recovery</dt><dd className="mt-0.5 font-semibold">{when(previous.recovery_at)}</dd></div><div><dt className="text-xs text-muted-foreground">Duração</dt><dd className="mt-0.5 font-semibold">{duration(previous.duration_seconds)}</dd></div><div><dt className="text-xs text-muted-foreground">ACK actor</dt><dd className="mt-0.5 font-semibold">{previous.acknowledged_by || "—"}</dd></div></dl> : <p className="mt-3 text-xs text-muted-foreground">Nenhuma ocorrência anterior registrada.</p>}
            {previous?.incident ? <div className="mt-3"><p className="text-xs text-muted-foreground">INC relacionado</p><AlertServiceNowReferenceCell reference={previous.incident} /></div> : null}
            <Link to={href} className="mt-3 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">Ver histórico completo</Link>
          </>
        ) : <p className="mt-3 text-xs text-muted-foreground">Identidade de recorrência indisponível; nenhum agrupamento por host foi inferido.</p>}
      </section>

      <section aria-label="Mesmo problema na operação" className="rounded-lg border border-border/70 p-3">
        <h3 className="text-sm font-semibold">Mesmo problema na operação</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Informação separada; não representa reincidência deste ativo.</p>
        {sameProblem ? <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><Count label="Outros hosts" value={sameProblem.other_hosts} /><Count label="Clientes" value={sameProblem.customers} /><div><dt className="text-xs text-muted-foreground">Período</dt><dd className="mt-0.5 font-semibold">{when(sameProblem.period_from)} — {when(sameProblem.period_to)}</dd></div></dl> : <p className="mt-3 text-xs text-muted-foreground">Não há identidade de trigger para comparação operacional.</p>}
      </section>
    </div>
  );
}
