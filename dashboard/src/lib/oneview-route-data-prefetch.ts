import { defaultAlertsFetchParams } from "@/lib/alerts-query";
import {
  bucketOneViewReadNow,
  DEFAULT_CANONICAL_LINKS_QUERY,
  DEFAULT_INCIDENTS_FETCH_PARAMS,
  fetchAlerts,
  fetchCanonicalLinks,
  fetchIncidents,
  ONEVIEW_READ_CACHE_TTL_MS,
} from "@/lib/oneview-api";
import { getOneViewFacets } from "@/lib/oneview-facets-store";
import {
  DEFAULT_HOME_ALERT_MODE,
  DEFAULT_HOME_OPERATIONAL_WINDOW,
  HOME_ALERTS_PAGE_SIZE,
  fetchHomeAlerts,
  homeOperationalWindowMs,
} from "@/lib/oneview-home";
import {
  DEFAULT_MONITOR_WINDOW,
  MONITOR_ALERT_MODE,
  MONITOR_QUEUE_LIMIT,
  fetchMonitoringAlerts,
  monitorWindowMs,
} from "@/lib/oneview-monitoring";

export const ONEVIEW_ROUTE_DATA_PREFETCH_DEBOUNCE_MS = 300;

export const ONEVIEW_DATA_PREFETCH_ROUTES = [
  "/",
  "/monitoramento",
  "/alertas",
  "/chamados",
  "/operadoras",
  "/historico",
] as const;

type PrefetchRoute = (typeof ONEVIEW_DATA_PREFETCH_ROUTES)[number];

const warmedAt = new Map<string, number>();
const pending = new Map<string, number>();

function isPrefetchRoute(path: string): path is PrefetchRoute {
  return (ONEVIEW_DATA_PREFETCH_ROUTES as readonly string[]).includes(path);
}

function isFresh(path: string, now = Date.now()) {
  const warmed = warmedAt.get(path);
  return typeof warmed === "number" && now - warmed < ONEVIEW_READ_CACHE_TTL_MS;
}

async function warmRouteData(path: PrefetchRoute) {
  const now = bucketOneViewReadNow();
  if (path === "/") {
    await Promise.allSettled([
      getOneViewFacets(),
      fetchHomeAlerts({
        mode: DEFAULT_HOME_ALERT_MODE,
        status: "active",
        limit: HOME_ALERTS_PAGE_SIZE,
        windowMs: homeOperationalWindowMs(DEFAULT_HOME_OPERATIONAL_WINDOW),
        now,
      }),
    ]);
    return;
  }
  if (path === "/monitoramento") {
    await Promise.allSettled([
      getOneViewFacets(),
      fetchMonitoringAlerts({
        mode: MONITOR_ALERT_MODE.prioritary,
        limit: MONITOR_QUEUE_LIMIT,
        windowMs: monitorWindowMs(DEFAULT_MONITOR_WINDOW),
        now,
      }),
    ]);
    return;
  }
  if (path === "/alertas") {
    await Promise.allSettled([
      getOneViewFacets(),
      fetchAlerts(defaultAlertsFetchParams(now)),
    ]);
    return;
  }
  if (path === "/chamados") {
    await Promise.allSettled([fetchIncidents(DEFAULT_INCIDENTS_FETCH_PARAMS)]);
    return;
  }
  if (path === "/operadoras") {
    await Promise.allSettled([fetchCanonicalLinks({ ...DEFAULT_CANONICAL_LINKS_QUERY })]);
    return;
  }
  await Promise.allSettled([getOneViewFacets()]);
}

export function clearOneViewRouteDataPrefetch() {
  warmedAt.clear();
  if (typeof window !== "undefined") {
    for (const timer of pending.values()) window.clearTimeout(timer);
  }
  pending.clear();
}

export function prefetchOneViewRouteData(path: string, options?: { immediate?: boolean }) {
  const route = path.split("?")[0];
  if (!isPrefetchRoute(route) || isFresh(route)) return;
  if (typeof window === "undefined") {
    warmedAt.set(route, Date.now());
    void warmRouteData(route);
    return;
  }
  const existing = pending.get(route);
  if (existing) window.clearTimeout(existing);
  const run = () => {
    pending.delete(route);
    if (isFresh(route)) return;
    warmedAt.set(route, Date.now());
    void warmRouteData(route);
  };
  if (options?.immediate) {
    run();
    return;
  }
  pending.set(route, window.setTimeout(run, ONEVIEW_ROUTE_DATA_PREFETCH_DEBOUNCE_MS));
}
