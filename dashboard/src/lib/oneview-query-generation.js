/**
 * Coordinates a single in-flight read with changing query parameters.
 * A newer generation can never authorize an older result to render.
 */
export function createOneViewQueryGeneration() {
  let current = 0;
  let inFlight = null;
  let pending = null;

  return {
    advance() {
      current += 1;
      return current;
    },
    begin() {
      inFlight = current;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
    deferCurrentIfDifferent() {
      if (inFlight !== null && inFlight !== current) pending = current;
    },
    complete(generation) {
      if (inFlight === generation) inFlight = null;
      const shouldRefresh = pending === current;
      pending = null;
      return shouldRefresh;
    },
  };
}
