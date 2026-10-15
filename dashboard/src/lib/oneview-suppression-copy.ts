import type { OneViewAlert } from "@/lib/oneview-api";

/** Display copy for a suppression read model already classified by the BFF. */
export function suppressionCaption(
  alert: Pick<OneViewAlert, "suppression">,
  formatWhen: (value: string) => string,
): string | null {
  const suppression = alert.suppression;
  if (!suppression || suppression.state === "none") return null;
  if (suppression.explicit_unconfirmed) {
    return "Supressão sem confirmação da origem. O valor não foi tratado como removido.";
  }
  if (suppression.state === "unavailable" && suppression.evidence !== "conflict") return null;
  if (suppression.evidence === "conflict") {
    return "Supressão divergente entre coluna e payload. A fila não a trata como válida.";
  }
  if (suppression.state === "expired") {
    const until = suppression.suppress_until ? ` A janela terminou em ${formatWhen(suppression.suppress_until)}.` : "";
    return `Supressão encerrada.${until} O problema ativo voltou para a fila de ação.`;
  }
  if (suppression.state !== "active") return null;
  const origin = suppression.origin === "maintenance"
    ? `Manutenção${suppression.maintenance_id ? ` ${suppression.maintenance_id}` : ""}`
    : suppression.origin === "manual"
      ? `Supressão manual${suppression.user_id ? ` · usuário ${suppression.user_id}` : ""}`
      : "Supressão na origem";
  const start = suppression.started_at ? ` · início ${formatWhen(suppression.started_at)}` : "";
  const until = suppression.suppress_until
    ? ` · fim ${formatWhen(suppression.suppress_until)}`
    : suppression.suppress_until_kind === "indefinite"
      ? " · sem prazo determinado"
      : " · sem término informado";
  const remaining = suppression.remaining_seconds == null
    ? ""
    : ` · restante ${formatRemaining(suppression.remaining_seconds)}`;
  return `${origin}${start}${until}${remaining}`;
}

function formatRemaining(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours} h ${rem} min` : `${hours} h`;
}

export function recoveryEvidenceCaption(alert: Pick<OneViewAlert, "recovery_evidence">): string | null {
  if (alert.recovery_evidence !== "legacy") return null;
  return "Histórico legado: resolvido sem source_recovery_event_id.";
}
