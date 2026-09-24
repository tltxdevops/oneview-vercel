import {
  fetchOneViewFacets,
  ONEVIEW_FACETS_PATH,
  peekOneViewReadCache,
  type OneViewFacetsResponse,
} from "@/lib/oneview-api";

let inFlight: Promise<OneViewFacetsResponse> | null = null;
let snapshot: { value: OneViewFacetsResponse; freshUntil: number } | null = null;
const FACETS_REFRESH_MS = 60_000;

/** In-flight reads are session-scoped; never reuse one after logout/account swap. */
export function clearOneViewFacetsStore() {
  inFlight = null;
  snapshot = null;
}

export function peekOneViewFacets() {
  if (snapshot && snapshot.freshUntil > Date.now()) return snapshot.value;
  return peekOneViewReadCache<OneViewFacetsResponse>(ONEVIEW_FACETS_PATH);
}

export function getOneViewFacets(signal?: AbortSignal): Promise<OneViewFacetsResponse> {
  const fresh = peekOneViewFacets();
  if (fresh) return Promise.resolve(fresh);
  if (!signal && inFlight) return inFlight;
  const request = fetchOneViewFacets(signal).then((value) => {
    snapshot = { value, freshUntil: Date.now() + FACETS_REFRESH_MS };
    return value;
  });
  if (!signal) {
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }
  return request;
}
