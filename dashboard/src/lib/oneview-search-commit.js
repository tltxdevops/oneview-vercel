export const ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS = 250;
export const ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS = 150;

/** Pure controller so UI and focused tests share debounce/cancel semantics. */
export function createOneViewSearchCommitter({
  onCommit,
  delay = ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS,
  schedule = (callback, wait) => setTimeout(callback, wait),
  clear = (timer) => clearTimeout(timer),
} = {}) {
  let timer = null;
  const cancel = () => {
    if (timer !== null) clear(timer);
    timer = null;
  };
  const commit = (value) => onCommit?.(String(value ?? "").trim());
  return {
    schedule(value) {
      cancel();
      timer = schedule(() => {
        timer = null;
        commit(value);
      }, delay);
    },
    commitNow(value) {
      cancel();
      commit(value);
    },
    cancel,
  };
}

/** Monotonic request gate: an earlier response cannot update newer search state. */
export function createOneViewLatestRequestGate() {
  let generation = 0;
  return {
    next: () => ++generation,
    isCurrent: (requestGeneration) => requestGeneration === generation,
    invalidate: () => ++generation,
  };
}
