/** Bundle prefetch only; route data remains scoped to each existing BFF query. */
const routes: Record<string, () => Promise<unknown>> = {
  "/": () => import("@/pages/Index"), "/monitoramento": () => import("@/pages/Monitoring"),
  "/alertas": () => import("@/pages/Alerts"), "/historico": () => import("@/pages/Historico"),
  "/chamados": () => import("@/pages/Chamados"), "/operadoras": () => import("@/pages/Operadoras"),
  "/ui-kit": () => import("@/pages/UiKit"),
};
const warmed = new Set<string>();
export function prefetchOneViewRoute(path: string) { if (!warmed.has(path) && routes[path]) { warmed.add(path); void routes[path](); } }
