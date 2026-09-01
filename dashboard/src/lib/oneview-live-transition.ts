/**
 * OV-P0-268 — motor reutilizavel de transicoes ao vivo (ACK / Resolvido / Assumido).
 * So anima mudancas comprovadas entre snapshots por id. Sem flash no 1o load.
 */

/** ~2.7s ~= 3 pulsos discretos. */
export const LIVE_TRANSITION_DURATION_MS = 2700;

export type LiveTransitionKind = "acknowledged" | "resolved" | "assigned";

export type LiveEntitySnapshot = {
  id: string;
  status_source?: string | null;
  status_internal?: string | null;
  acknowledged_source?: boolean | null;
  acknowledged_internal?: boolean | null;
  assigned_to?: string | null;
  assigned_to_display?: string | null;
};

export type LiveTransition = {
  id: string;
  kind: LiveTransitionKind;
  versionKey: string;
  label: string;
  assigneeName?: string | null;
  startedAt: number;
  endsAt: number;
};

export type LiveTransitionFilterContext = {
  hideAcknowledged?: boolean;
  hideResolved?: boolean;
  hideAssigned?: boolean;
};

function text(value?: string | null) {
  return String(value || "").trim();
}

function lower(value?: string | null) {
  return text(value).toLowerCase();
}

export function isLiveEntityAcknowledged(entity?: LiveEntitySnapshot | null): boolean {
  if (!entity) return false;
  return Boolean(entity.acknowledged_source) || Boolean(entity.acknowledged_internal);
}

export function isLiveEntityResolved(entity?: LiveEntitySnapshot | null): boolean {
  if (!entity) return false;
  const source = lower(entity.status_source);
  const internal = lower(entity.status_internal);
  return source === "resolved" || internal === "resolved" || internal === "normalized";
}

export function isLiveEntityAssigned(entity?: LiveEntitySnapshot | null): boolean {
  return Boolean(text(entity?.assigned_to));
}

export function liveAssigneeLabel(entity?: LiveEntitySnapshot | null): string {
  const display = text(entity?.assigned_to_display);
  if (display) return display;
  const raw = text(entity?.assigned_to);
  return raw || "analista";
}

export function liveTransitionVersionKey(kind: LiveTransitionKind, entity: LiveEntitySnapshot): string {
  if (kind === "acknowledged") return entity.id + "::acknowledged::1";
  if (kind === "resolved") return entity.id + "::resolved::1";
  return entity.id + "::assigned::" + (lower(entity.assigned_to) || "x");
}

export function liveTransitionLabel(kind: LiveTransitionKind, entity?: LiveEntitySnapshot | null): string {
  if (kind === "acknowledged") return "✓ Reconhecido";
  if (kind === "resolved") return "✓ Resolvido";
  return "✓ Assumido por " + liveAssigneeLabel(entity);
}

export function snapshotFromAlert(alert: {
  id?: string | null;
  status_source?: string | null;
  status_internal?: string | null;
  acknowledged_source?: boolean | null;
  acknowledged_internal?: boolean | null;
  assigned_to?: string | null;
  assigned_to_display?: string | null;
} | null | undefined): LiveEntitySnapshot | null {
  const id = text(alert?.id);
  if (!id || !alert) return null;
  return {
    id,
    status_source: alert.status_source ?? null,
    status_internal: alert.status_internal ?? null,
    acknowledged_source: alert.acknowledged_source ?? null,
    acknowledged_internal: alert.acknowledged_internal ?? null,
    assigned_to: alert.assigned_to ?? null,
    assigned_to_display: alert.assigned_to_display ?? null,
  };
}

export function snapshotFromIncident(incident: {
  sys_id?: string | null;
  id?: string | null;
  assigned_to?: string | null;
  assigned_to_display?: string | null;
  state?: string | null;
  state_display?: string | null;
} | null | undefined): LiveEntitySnapshot | null {
  const id = text(incident?.sys_id || incident?.id);
  if (!id || !incident) return null;
  const state = lower(incident.state);
  const resolved =
    state === "6"
    || state === "7"
    || /resolv|encerr|closed|resolved/i.test(text(incident.state_display));
  return {
    id,
    status_source: resolved ? "resolved" : "active",
    status_internal: resolved ? "resolved" : "active",
    acknowledged_source: false,
    acknowledged_internal: false,
    assigned_to: incident.assigned_to ?? null,
    assigned_to_display: incident.assigned_to_display ?? null,
  };
}

export function toLiveSnapshotMap(
  entities: Array<LiveEntitySnapshot | null | undefined>,
): Map<string, LiveEntitySnapshot> {
  const map = new Map<string, LiveEntitySnapshot>();
  for (const entity of entities) {
    if (!entity?.id) continue;
    map.set(entity.id, entity);
  }
  return map;
}

export function detectLiveTransitions(input: {
  previousById: Map<string, LiveEntitySnapshot>;
  nextById: Map<string, LiveEntitySnapshot>;
  previousSnapshotReady: boolean;
  consumedVersionKeys?: Set<string>;
  now?: number;
  durationMs?: number;
}): LiveTransition[] {
  if (!input.previousSnapshotReady) return [];
  const now = input.now ?? Date.now();
  const durationMs = input.durationMs ?? LIVE_TRANSITION_DURATION_MS;
  const consumed = input.consumedVersionKeys ?? new Set<string>();
  const detected: LiveTransition[] = [];

  for (const [id, next] of input.nextById) {
    const previous = input.previousById.get(id);
    if (!previous) continue;

    const push = (kind: LiveTransitionKind) => {
      const versionKey = liveTransitionVersionKey(kind, next);
      if (consumed.has(versionKey)) return;
      if (detected.some((item) => item.versionKey === versionKey)) return;
      detected.push({
        id,
        kind,
        versionKey,
        label: liveTransitionLabel(kind, next),
        assigneeName: kind === "assigned" ? liveAssigneeLabel(next) : null,
        startedAt: now,
        endsAt: now + durationMs,
      });
    };

    if (!isLiveEntityAcknowledged(previous) && isLiveEntityAcknowledged(next)) push("acknowledged");
    if (!isLiveEntityResolved(previous) && isLiveEntityResolved(next)) push("resolved");
    if (!isLiveEntityAssigned(previous) && isLiveEntityAssigned(next)) push("assigned");
  }

  return detected;
}

export function remainingLiveTransitionMs(transition: LiveTransition, now = Date.now()): number {
  return Math.max(0, transition.endsAt - now);
}

export function isLiveTransitionActive(transition: LiveTransition, now = Date.now()): boolean {
  return remainingLiveTransitionMs(transition, now) > 0;
}

export function reconcileLiveTransitions(input: {
  current: Map<string, LiveTransition>;
  detected: LiveTransition[];
  consumedVersionKeys: Set<string>;
  now?: number;
}): {
  active: Map<string, LiveTransition>;
  consumedVersionKeys: Set<string>;
} {
  const now = input.now ?? Date.now();
  const consumed = new Set(input.consumedVersionKeys);
  const active = new Map<string, LiveTransition>();

  for (const [id, transition] of input.current) {
    if (!isLiveTransitionActive(transition, now)) {
      consumed.add(transition.versionKey);
      continue;
    }
    active.set(id, transition);
  }

  for (const transition of input.detected) {
    if (consumed.has(transition.versionKey)) continue;
    const existing = active.get(transition.id);
    if (existing && existing.versionKey === transition.versionKey) continue;
    if (existing) {
      const rank = { resolved: 3, acknowledged: 2, assigned: 1 } as const;
      if (rank[existing.kind] >= rank[transition.kind]) continue;
    }
    active.set(transition.id, transition);
    consumed.add(transition.versionKey);
  }

  return { active, consumedVersionKeys: consumed };
}

export function shouldHoldForLiveTransition(
  transition: LiveTransition | undefined,
  filter: LiveTransitionFilterContext,
  now = Date.now(),
): boolean {
  if (!transition || !isLiveTransitionActive(transition, now)) return false;
  if (transition.kind === "acknowledged" && filter.hideAcknowledged) return true;
  if (transition.kind === "resolved" && filter.hideResolved) return true;
  if (transition.kind === "assigned" && filter.hideAssigned) return true;
  return false;
}

export function mergeLiveTransitionQueue<T extends { id?: string | null; sys_id?: string | null }>(input: {
  serverItems: T[];
  pinnedById: Map<string, T>;
  transitions: Map<string, LiveTransition>;
  passesFilter: (item: T) => boolean;
  filter: LiveTransitionFilterContext;
  now?: number;
  idOf?: (item: T) => string;
}): T[] {
  const now = input.now ?? Date.now();
  const idOf = input.idOf ?? ((item: T) => text(item.id || item.sys_id));
  const seen = new Set<string>();
  const display: T[] = [];

  for (const item of input.serverItems) {
    const id = idOf(item);
    if (!id) continue;
    const transition = input.transitions.get(id);
    if (input.passesFilter(item) || shouldHoldForLiveTransition(transition, input.filter, now)) {
      display.push(item);
      seen.add(id);
    }
  }

  for (const [id, pinned] of input.pinnedById) {
    if (seen.has(id)) continue;
    const transition = input.transitions.get(id);
    if (!shouldHoldForLiveTransition(transition, input.filter, now)) continue;
    display.push(pinned);
    seen.add(id);
  }

  return display;
}

export function prunePinnedByTransitions<T>(
  pinnedById: Map<string, T>,
  transitions: Map<string, LiveTransition>,
  now = Date.now(),
): Map<string, T> {
  const next = new Map<string, T>();
  for (const [id, item] of pinnedById) {
    const transition = transitions.get(id);
    if (transition && isLiveTransitionActive(transition, now)) next.set(id, item);
  }
  return next;
}

export function sameLiveTransitionMap(
  left: Map<string, LiveTransition>,
  right: Map<string, LiveTransition>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, transition] of left) {
    const other = right.get(id);
    if (!other) return false;
    if (other.versionKey !== transition.versionKey) return false;
    if (other.endsAt !== transition.endsAt) return false;
  }
  return true;
}
