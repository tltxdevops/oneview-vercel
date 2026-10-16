import { prefetchOneViewRouteData } from "@/lib/oneview-route-data-prefetch";

/** Bundle prefetch plus cookie-authenticated warm reads for operational routes. */
const routes: Record<string, () => Promise<unknown>> = {
  "/": () => import("@/pages/Index"),
  "/monitoramento": () => import("@/pages/Monitoring"),
  "/central-alertas": () => import("@/pages/Alerts"),
  "/alertas": () => import("@/pages/Alerts"),
  "/alerts": () => import("@/pages/Alerts"),
  "/historico": () => import("@/pages/Alerts"),
  "/chamados": () => import("@/pages/Chamados"),
  "/operadoras": () => import("@/pages/Operadoras"),
  "/ui-kit": () => import("@/pages/UiKit"),
};
const warmed = new Set<string>();

export function prefetchOneViewRoute(path: string, options?: { dataImmediate?: boolean }) {
  const route = path.split("?")[0];
  if (!warmed.has(route) && routes[route]) {
    warmed.add(route);
    void routes[route]();
  }
  prefetchOneViewRouteData(route, { immediate: options?.dataImmediate === true });
}
