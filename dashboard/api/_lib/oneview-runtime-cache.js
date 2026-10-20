const CACHE_SYMBOL = Symbol.for("oneview.runtime.cache");
const SUMMARY_CACHE_KEY = "dashboard-summary";
const DEFAULT_MAX_ENTRIES = 256;

function state() {
  if (!globalThis[CACHE_SYMBOL]) {
    globalThis[CACHE_SYMBOL] = { entries: new Map(), pending: new Map() };
  }
  return globalThis[CACHE_SYMBOL];
}

function positiveInt(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function removeExpiredEntries(cache, now) {
  for (const [key, entry] of cache.entries) {
    if (!entry || entry.expiresAt <= now) cache.entries.delete(key);
  }
}

function enforceEntryLimit(cache, maxEntries) {
  while (cache.entries.size > maxEntries) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) return;
    cache.entries.delete(oldest);
  }
}

/**
 * Backend-only bounded cache with TTL and in-flight request coalescing.
 * Failed loaders are deliberately never persisted.
 */
export async function withOneViewRuntimeCacheEntry(key, loader, {
  bypass = false,
  ttlMs = 15_000,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const cache = state();
  const cacheKey = String(key || "").trim();
  if (!cacheKey) throw new Error("oneview_cache_key_required");
  const currentTime = now();
  const ttl = positiveInt(ttlMs, 15_000, { min: 1, max: 3_600_000 });
  const limit = positiveInt(maxEntries, DEFAULT_MAX_ENTRIES, { min: 1, max: 10_000 });

  removeExpiredEntries(cache, currentTime);
  if (bypass) cache.entries.delete(cacheKey);
  const cached = cache.entries.get(cacheKey);
  if (!bypass && cached && cached.expiresAt > currentTime) {
    return { value: cached.value, cacheHit: true, deduplicated: false };
  }
  if (!bypass && cache.pending.has(cacheKey)) {
    return { value: await cache.pending.get(cacheKey), cacheHit: false, deduplicated: true };
  }

  const pending = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.entries.set(cacheKey, { value, expiresAt: now() + ttl });
      enforceEntryLimit(cache, limit);
      return value;
    })
    .finally(() => cache.pending.delete(cacheKey));
  cache.pending.set(cacheKey, pending);
  return { value: await pending, cacheHit: false, deduplicated: false };
}

export async function withOneViewRuntimeCache(key, loader, options = {}) {
  return (await withOneViewRuntimeCacheEntry(key, loader, options)).value;
}

export async function withOneViewSummaryCache(loader, { bypass = false, ttlMs = 30_000 } = {}) {
  return withOneViewRuntimeCache(SUMMARY_CACHE_KEY, loader, { bypass, ttlMs });
}

export function invalidateOneViewSummaryCache() {
  state().entries.delete(SUMMARY_CACHE_KEY);
}

export function resetOneViewRuntimeCacheForTests() {
  const cache = state();
  cache.entries.clear();
  cache.pending.clear();
}
