import type { OneViewAlert } from "@/lib/oneview-api";

/** Drawer live refresh while the source is still moving. Not a global poll. */
export const ALERT_DRAWER_POLL_MS = 2_000;
/** Light refresh of the current Alerts/Monitoring page. */
export const ALERT_LIST_LIVE_REFRESH_MS = 10_000;

export type AlertLiveTransition = {
  recovery: boolean;
  ackTerminal: boolean;
};

function text(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function oneViewAckLiveStatus(alert: OneViewAlert | null | undefined): string {
  const ack = text(alert?.oneview_ack?.status);
  if (ack && ack !== "none") return ack;
  return text(alert?.source_ack_status);
}

export function isAckInFlight(alert: OneViewAlert | null | undefined): boolean {
  return ["pending", "processing"].includes(oneViewAckLiveStatus(alert));
}

export function isAckTerminalStatus(status: string | null | undefined): boolean {
  return ["success", "cancelled", "failed"].includes(text(status));
}

export function isAckTerminal(alert: OneViewAlert | null | undefined): boolean {
  return isAckTerminalStatus(oneViewAckLiveStatus(alert));
}

export function isAlertSourceActive(alert: OneViewAlert | null | undefined): boolean {
  return text(alert?.status_source) === "active";
}

export function isAlertSourceResolved(alert: OneViewAlert | null | undefined): boolean {
  return text(alert?.status_source) === "resolved";
}

export function shouldPollAlertDrawer(alert: OneViewAlert | null | undefined): boolean {
  if (!alert) return false;
  return isAlertSourceActive(alert) || isAckInFlight(alert);
}

export function detectDrawerLiveTransition(
  previous: OneViewAlert | null | undefined,
  next: OneViewAlert | null | undefined,
): AlertLiveTransition {
  return {
    recovery: Boolean(previous) && isAlertSourceActive(previous) && isAlertSourceResolved(next),
    ackTerminal: isAckInFlight(previous) && isAckTerminal(next),
  };
}

export function shouldInvalidateAlertList(transition: AlertLiveTransition): boolean {
  return Boolean(transition.recovery || transition.ackTerminal);
}

type PollerTimers = {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type AlertDrawerPoller = {
  start: () => void;
  abort: () => void;
  tick: () => Promise<void>;
  inFlight: () => boolean;
};

export function createAlertDrawerPoller(options: {
  intervalMs?: number;
  shouldPoll?: () => boolean;
  currentAlert: () => OneViewAlert | null | undefined;
  refresh: (signal: AbortSignal) => Promise<OneViewAlert | null | undefined>;
  onTransition?: (transition: AlertLiveTransition, next: OneViewAlert) => void;
  timers?: Partial<PollerTimers>;
}): AlertDrawerPoller {
  const intervalMs = options.intervalMs ?? ALERT_DRAWER_POLL_MS;
  const setTimer = options.timers?.setInterval ?? setInterval;
  const clearTimer = options.timers?.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;
  let inFlight = false;
  let started = false;

  const activeController = () => {
    if (!controller) controller = new AbortController();
    return controller;
  };

  const tick = async () => {
    if (inFlight) return;
    if (options.shouldPoll && !options.shouldPoll()) return;
    const current = activeController();
    if (current.signal.aborted) return;
    inFlight = true;
    const previous = options.currentAlert();
    try {
      const next = await options.refresh(current.signal);
      if (current.signal.aborted || !next) return;
      const transition = detectDrawerLiveTransition(previous, next);
      if (shouldInvalidateAlertList(transition)) options.onTransition?.(transition, next);
    } catch {
      /* transient drawer refetch must not blank the current detail */
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (!controller || controller.signal.aborted) controller = new AbortController();
      timer = setTimer(() => void tick(), intervalMs);
    },
    abort() {
      started = false;
      controller?.abort();
      if (timer != null) clearTimer(timer);
      timer = null;
      inFlight = false;
    },
    tick,
    inFlight: () => inFlight,
  };
}
