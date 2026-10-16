import { ArrowRight, Repeat2 } from "lucide-react";
import { Link } from "react-router-dom";
import { AlertServiceNowReferenceCell } from "@/components/oneview/AlertServiceNowReferenceCell";
import type { OneViewAlert } from "@/lib/oneview-api";
import { centralAlertasHistoryHref } from "@/lib/central-alertas-path";

const OPERATIONAL_TIME_ZONE = "America/Sao_Paulo";

function when(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("pt-BR", { timeZone: OPERATIONAL_TIME_ZONE });
}

function duration(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return "Duração indisponível";
  const minutes = Math.floor(value / 60);
  if (minutes < 1) return `${Math.round(value)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold text-foreground">{value}</dd>
      {hint ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={hint}>{hint}</p> : null}
    </div>
  );
}

export function AlertRecurrenceInvestigation({ alert }: { alert: OneViewAlert }) {
  const previous = alert.recurrence_previous;
  const href = alert.recurrence_key
    ? centralAlertasHistoryHref(new URLSearchParams({ recurrence_key: alert.recurrence_key }))
    : null;

  return (
    <section aria-label="Histórico de recorrência" className="rounded-xl border border-border/70 bg-muted/15 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 rounded-md border border-border/70 bg-background p-1.5 text-muted-foreground" aria-hidden="true">
            <Repeat2 className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">Recorrência deste alerta</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Mesmo datasource, host e trigger.</p>
          </div>
        </div>
      </div>

      {href ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-2">
            <Metric label="Últimas 24 horas" value={Number(alert.recurrence_count_24h || 0).toLocaleString("pt-BR")} />
            <Metric label="Últimos 7 dias" value={Number(alert.recurrence_count_7d || 0).toLocaleString("pt-BR")} />
          </dl>

          {previous ? (
            <div className="mt-3 rounded-lg border border-border/60 bg-background p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Ocorrência anterior</p>
              <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-muted-foreground">Início</dt><dd className="mt-0.5 font-medium">{when(previous.occurrence_at)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Recovery</dt><dd className="mt-0.5 font-medium">{when(previous.recovery_at)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Duração</dt><dd className="mt-0.5 font-medium">{duration(previous.duration_seconds)}</dd></div>
              </dl>
              {previous.acknowledged_by ? <p className="mt-2 text-xs text-muted-foreground">ACK por {previous.acknowledged_by}</p> : null}
              {previous.incident ? (
                <div className="mt-3 border-t border-border/60 pt-3">
                  <p className="mb-1 text-xs text-muted-foreground">Chamado da ocorrência anterior</p>
                  <AlertServiceNowReferenceCell reference={previous.incident} />
                </div>
              ) : null}
              {previous.temporal_integrity === "source_clock_inconsistent" ? <p className="mt-2 text-xs text-muted-foreground">Relógio da origem inconsistente.</p> : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Nenhuma ocorrência anterior registrada.</p>
          )}

          <Link to={href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-4 hover:underline">
            Ver períodos maiores no Histórico <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Identidade de recorrência indisponível; nenhum agrupamento foi inferido.</p>
      )}
    </section>
  );
}

export function AlertSameProblemContext({ alert }: { alert: OneViewAlert }) {
  const sameProblem = alert.same_problem;
  if (!sameProblem) return null;
  return (
    <section aria-label="Mesmo problema na operação" className="space-y-2">
      <h3 className="text-sm font-semibold">Mesmo problema na operação</h3>
      <p className="text-xs text-muted-foreground">Contexto técnico separado; não representa recorrência deste ativo.</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Outros hosts</dt><dd className="mt-0.5 font-semibold">{Number(sameProblem.other_hosts || 0).toLocaleString("pt-BR")}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Clientes</dt><dd className="mt-0.5 font-semibold">{Number(sameProblem.customers || 0).toLocaleString("pt-BR")}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Período</dt><dd className="mt-0.5 font-semibold">{when(sameProblem.period_from)} — {when(sameProblem.period_to)}</dd></div>
      </dl>
    </section>
  );
}
