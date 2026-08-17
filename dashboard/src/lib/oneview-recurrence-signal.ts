/**
 * OV-P0-115 — sinal compacto de recorrência no drawer.
 * Identidade (OV-P0-87): data_source_id + source_host_id + source_trigger_id.
 * Episódio novo só conta após recovery do predecessor.
 */

export const RECURRENCE_MIN_COUNT_7D = 2;
export const RECURRENCE_FLAPPING_24H = 5;
export const RECURRENCE_FLAPPING_7D = 10;
export const RECURRENCE_COUNT_DISPLAY_CAP = 99;

export const RECURRENCE_SIGNAL_TOOLTIP =
  "Recorrência considera o mesmo host e trigger. Só conta um novo episódio após recovery.";

export type RecurrenceSignalKind = "recurrent" | "flapping";

export type AlertRecurrenceFields = {
  is_recurrent?: boolean | null;
  recurrence_count_7d?: number | null;
  recurrence_count_24h?: number | null;
  previous_occurrence_at?: string | null;
  previous_recovery_at?: string | null;
};

export type AlertRecurrenceSignalModel = {
  kind: RecurrenceSignalKind;
  headline: string;
  count_7d: number;
  count_label: string;
  previous_occurrence_at: string | null;
  previous_recovery_at: string | null;
};

export function formatRecurrenceCountLabel(count: number | null | undefined): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n >= 100 ? `${RECURRENCE_COUNT_DISPLAY_CAP}+` : String(n);
}

export function isRecurrenceFlapping(
  count24h: number | null | undefined,
  count7d: number | null | undefined,
): boolean {
  return Number(count24h || 0) >= RECURRENCE_FLAPPING_24H
    || Number(count7d || 0) >= RECURRENCE_FLAPPING_7D;
}

export function formatRecurrenceWhen(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

export function buildAlertRecurrenceSignal(
  alert?: AlertRecurrenceFields | null,
): AlertRecurrenceSignalModel | null {
  if (!alert) return null;
  const count7d = Number(alert.recurrence_count_7d || 0);
  const count24h = Number(alert.recurrence_count_24h || 0);
  const recurrent = Boolean(alert.is_recurrent) || count7d >= RECURRENCE_MIN_COUNT_7D;
  if (!recurrent) return null;

  const flapping = isRecurrenceFlapping(count24h, count7d);
  const countLabel = formatRecurrenceCountLabel(count7d);
  return {
    kind: flapping ? "flapping" : "recurrent",
    headline: `${flapping ? "Flapping" : "Recorrente"} · ${countLabel} ocorrências em 7 dias`,
    count_7d: count7d,
    count_label: countLabel,
    previous_occurrence_at: alert.previous_occurrence_at || null,
    previous_recovery_at: alert.previous_recovery_at || null,
  };
}
