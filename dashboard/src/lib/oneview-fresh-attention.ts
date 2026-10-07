/**
 * OV-P0-116 — destaque temporário de High/Disaster novos no Monitoramento.
 * Seen-state só em memória. Timer não reinicia no poll.
 */

export const FRESH_ATTENTION_DURATION_MS = 60_000;
/** Janela curta para considerar first_seen_at recém-chegado (slack do poll 30s). */
export const FRESH_ATTENTION_DETECT_WINDOW_MS = 90_000;

export type FreshAttentionTone = "high" | "disaster";

export type FreshAttentionAlert = {
  id?: string | null;
  severity?: string | null;
  first_seen_at?: string | null;
};

export type FreshAttentionState = {
  knownIds: Set<string>;
  attentionStartedAt: Map<string, number>;
};

export function isFreshAttentionSeverity(severity?: string | null): boolean {
  const value = String(severity || "").trim().toLowerCase();
  return value === "high" || value === "disaster" || value === "critical";
}

export function freshAttentionTone(severity?: string | null): FreshAttentionTone | null {
  const value = String(severity || "").trim().toLowerCase();
  if (value === "disaster") return "disaster";
  if (value === "high" || value === "critical") return "high";
  return null;
}

export function isFreshByFirstSeen(
  firstSeenAt?: string | null,
  now = Date.now(),
  windowMs = FRESH_ATTENTION_DETECT_WINDOW_MS,
): boolean {
  const seen = Date.parse(String(firstSeenAt || ""));
  if (!Number.isFinite(seen)) return false;
  const age = now - seen;
  return age >= 0 && age < windowMs;
}

export function remainingFreshAttentionMs(
  startedAt: number,
  now = Date.now(),
  durationMs = FRESH_ATTENTION_DURATION_MS,
): number {
  if (!Number.isFinite(startedAt)) return 0;
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : FRESH_ATTENTION_DURATION_MS;
  return Math.max(0, safeDuration - (now - startedAt));
}

export function activeFreshAttentionIds(
  attentionStartedAt: Map<string, number>,
  now = Date.now(),
  durationMs = FRESH_ATTENTION_DURATION_MS,
): Set<string> {
  const active = new Set<string>();
  for (const [id, startedAt] of attentionStartedAt) {
    if (remainingFreshAttentionMs(startedAt, now, durationMs) > 0) active.add(id);
  }
  return active;
}

function alertId(alert: FreshAttentionAlert): string {
  return String(alert?.id || "").trim();
}

/**
 * Primeiro snapshot: grava IDs; só pulsa High/Disaster com first_seen recente.
 * Snapshots seguintes: ID novo + first_seen recente inicia o timer uma vez.
 * IDs já vistos nunca reanimam, mesmo se saírem e voltarem à fila.
 */
export function reconcileFreshAttention(input: {
  alerts?: FreshAttentionAlert[] | null;
  knownIds: Set<string>;
  attentionStartedAt: Map<string, number>;
  isFirstSnapshot: boolean;
  now?: number;
}): FreshAttentionState {
  const now = input.now ?? Date.now();
  const nextKnown = new Set(input.knownIds);
  const nextAttention = new Map(input.attentionStartedAt);

  for (const alert of Array.isArray(input.alerts) ? input.alerts : []) {
    const id = alertId(alert);
    if (!id) continue;

    const alreadyKnown = nextKnown.has(id);
    nextKnown.add(id);

    if (!isFreshAttentionSeverity(alert.severity)) continue;
    if (nextAttention.has(id)) continue;

    const freshByTime = isFreshByFirstSeen(alert.first_seen_at, now);
    const newlyAppeared = !alreadyKnown && !input.isFirstSnapshot;
    const firstPaintFresh = input.isFirstSnapshot && freshByTime;

    if (!firstPaintFresh && !(newlyAppeared && (freshByTime || !alert.first_seen_at))) continue;

    nextAttention.set(id, now);
  }

  return { knownIds: nextKnown, attentionStartedAt: nextAttention };
}

export function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
