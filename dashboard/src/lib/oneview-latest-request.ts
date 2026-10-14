/**
 * Owns the one list request allowed to write state. A quiet refresh is skipped
 * only while that request is still running; once it settles the slot is free.
 */
export type LatestRequestGate = {
  shouldSkip: (options?: { quiet?: boolean; force?: boolean }) => boolean;
  begin: () => AbortController;
  finish: (controller: AbortController) => void;
  abort: () => void;
  current: () => AbortController | null;
};

export function createLatestRequestGate(): LatestRequestGate {
  let active: AbortController | null = null;
  return {
    shouldSkip(options) {
      return Boolean(options?.quiet && !options.force && active && !active.signal.aborted);
    },
    begin() {
      active?.abort();
      active = new AbortController();
      return active;
    },
    finish(controller) {
      // A superseded request must not release the slot of the one that replaced it.
      if (active === controller) active = null;
    },
    abort() {
      active?.abort();
      active = null;
    },
    current: () => active,
  };
}
