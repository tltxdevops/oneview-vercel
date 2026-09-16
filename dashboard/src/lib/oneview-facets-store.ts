import {
  fetchOneViewFacets,
  ONEVIEW_FACETS_PATH,
  peekOneViewReadCache,
  type OneViewFacetsResponse,
} from "@/lib/oneview-api";

let inFlight: Promise<OneViewFacetsResponse> | null = null;

/** In-flight reads are session-scoped; never reuse one after logout/account swap. */
export function clearOneViewFacetsStore() {
  inFlight = null;
}

export function peekOneViewFacets() {
  return peekOneViewReadCache<OneViewFacetsResponse>(ONEVIEW_FACETS_PATH);
}

export function getOneViewFacets(signal?: AbortSignal): Promise<OneViewFacetsResponse> {
  const fresh = peekOneViewFacets();
  if (fresh) return Promise.resolve(fresh);
  if (!signal && inFlight) return inFlight;
  const request = fetchOneViewFacets(signal);
  if (!signal) {
    const tracked = request.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  }
  return request;
}
