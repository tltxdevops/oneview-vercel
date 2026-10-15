export type SuppressUiState =
  | "checking"
  | "requesting"
  | "awaiting"
  | "suppressed"
  | "refused"
  | "inconclusive";

export const SUPPRESS_DURATIONS = [
  { seconds: 1800, label: "30 minutos" },
  { seconds: 7200, label: "2 horas" },
  { seconds: 28800, label: "8 horas" },
  { seconds: 0, label: "Sem prazo definido" },
] as const;

export const DEFAULT_SUPPRESS_SECONDS = 7200;
export const DEFAULT_SUPPRESS_REASON = "Manutenção programada";

export function suppressUiState({
  phase,
  accepted = false,
  outboxStatus = null,
  confirmed = false,
  timedOut = false,
}: {
  phase?: string;
  accepted?: boolean;
  outboxStatus?: string | null;
  confirmed?: boolean;
  timedOut?: boolean;
} = {}): SuppressUiState {
  if (phase === "checking") return "checking";
  if (phase === "requesting") return "requesting";
  if (timedOut && confirmed !== true) return "inconclusive";
  if (outboxStatus === "failed" || outboxStatus === "cancelled") return "refused";
  if (outboxStatus === "success" && confirmed === true) return "suppressed";
  if (outboxStatus === "success") return "inconclusive";
  if (accepted || outboxStatus === "pending" || outboxStatus === "processing") return "awaiting";
  return "requesting";
}

export function nextActionAfterTimeout(): "reconcile" {
  return "reconcile";
}

export const SUPPRESS_STATE_LABEL: Record<SuppressUiState, string> = {
  checking: "Verificando permissão",
  requesting: "Solicitando",
  awaiting: "Aguardando confirmação do Zabbix",
  suppressed: "Suprimido",
  refused: "Operação recusada",
  inconclusive: "Resultado inconclusivo",
};
