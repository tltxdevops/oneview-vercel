const CACHE_SYMBOL = Symbol.for("oneview.runtime.cache");
const SUMMARY_CACHE_KEY = "dashboard-summary";

function state() {
  if (!globalThis[CACHE_SYMBOL]) {
    globalThis[CACHE_SYMBOL] = { entries: new Map(), pending: new Map() };
  }
  return globalThis[CACHE_SYMBOL];
}

export async function withOneViewSummaryCache(loader, { bypass = false, ttlMs = 15_000 } = {}) {
  const cache = state();
  if (bypass) cache.entries.delete(SUMMARY_CACHE_KEY);
  const cached = cache.entries.get(SUMMARY_CACHE_KEY);
  if (!bypass && cached && cached.expiresAt > Date.now()) return cached.value;
  if (!bypass && cache.pending.has(SUMMARY_CACHE_KEY)) return cache.pending.get(SUMMARY_CACHE_KEY);

  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.entries.set(SUMMARY_CACHE_KEY, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => cache.pending.delete(SUMMARY_CACHE_KEY));
  cache.pending.set(SUMMARY_CACHE_KEY, pending);
  return pending;
}

export function invalidateOneViewSummaryCache() {
  state().entries.delete(SUMMARY_CACHE_KEY);
}

export function resetOneViewRuntimeCacheForTests() {
  const cache = state();
  cache.entries.clear();
  cache.pending.clear();
}
