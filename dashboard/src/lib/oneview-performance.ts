export type OneViewPerformanceMark =
  | "oneview:bootstrap:start"
  | "oneview:runtime-config:ready"
  | "oneview:app-modules:ready"
  | "oneview:app:render-requested"
  | "oneview:auth:ready"
  | "oneview:home:mounted"
  | "oneview:home:alerts-ready"
  | "oneview:home:summary-ready"
  | "oneview:home:incidents-ready"
  | "oneview:home:operators-ready"
  | "oneview:home:events-ready"
  | "oneview:home:first-useful-painted";

export const ONEVIEW_HOME_FIRST_USEFUL_EVENT = "oneview:home-first-useful";

const recorded = new Set<OneViewPerformanceMark>();

/** Static names and numeric durations only; no user, filter, URL, or payload data. */
export function markOneViewPerformance(name: OneViewPerformanceMark) {
  if (typeof window === "undefined" || typeof performance === "undefined" || recorded.has(name)) return;
  recorded.add(name);
  try {
    performance.mark(name);
    performance.measure(`${name}:from-navigation`, { start: 0, end: performance.now() });
  } catch {
    // Performance marks are diagnostic only and must never affect the UI.
  }
}

export function announceOneViewHomeFirstUseful() {
  markOneViewPerformance("oneview:home:first-useful-painted");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ONEVIEW_HOME_FIRST_USEFUL_EVENT));
  }
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Runs non-critical work after Home content is useful, with a bounded fallback for other routes. */
export function runAfterOneViewFirstUseful(task: () => void, fallbackMs = 2_000) {
  if (typeof window === "undefined") return () => undefined;
  const idleWindow = window as IdleWindow;
  let finished = false;
  let idleHandle: number | null = null;

  const run = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener(ONEVIEW_HOME_FIRST_USEFUL_EVENT, schedule);
    window.clearTimeout(fallbackHandle);
    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(task, { timeout: 500 });
    } else {
      idleHandle = window.setTimeout(task, 0);
    }
  };
  const schedule = () => run();
  const alreadyReady = performance.getEntriesByName("oneview:home:first-useful-painted").length > 0;
  const fallbackHandle = window.setTimeout(run, alreadyReady ? 0 : fallbackMs);
  if (!alreadyReady) window.addEventListener(ONEVIEW_HOME_FIRST_USEFUL_EVENT, schedule, { once: true });

  return () => {
    finished = true;
    window.removeEventListener(ONEVIEW_HOME_FIRST_USEFUL_EVENT, schedule);
    window.clearTimeout(fallbackHandle);
    if (idleHandle != null) {
      if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleHandle);
      else window.clearTimeout(idleHandle);
    }
  };
}
