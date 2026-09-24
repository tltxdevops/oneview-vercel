const PERFORMANCE_ROUTES = new Set([
  "/api/oneview/alerts",
  "/api/oneview/incidents",
  "/api/oneview/links",
  "/api/oneview/runtime-health",
  "/api/oneview/incidents/related-alert",
  "/api/oneview/servicenow/me",
]);

function statusCode(res, threw) {
  const value = Number(res?.statusCode);
  if (threw && (!Number.isInteger(value) || value < 400)) return 500;
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 200;
}
export function bffPerformanceErrorClass(status, threw = false) {
  if (threw) return "exception";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "none";
}

/**
 * Telemetria agregável sem observar req/query/body/headers ou response payload.
 * A rota é um template estático allow-listed, nunca o path recebido do cliente.
 */
export function withBffPerformanceTelemetry(handler, {
  route,
  logger = (entry) => console.info(JSON.stringify(entry)),
  now = () => Date.now(),
} = {}) {
  if (typeof handler !== "function") throw new TypeError("handler_required");
  if (!PERFORMANCE_ROUTES.has(route)) throw new TypeError("unsupported_performance_route");

  return async function bffPerformanceHandler(req, res) {
    if (String(req?.method || "GET").toUpperCase() !== "GET") return handler(req, res);
    const startedAt = now();
    let threw = false;
    try {
      return await handler(req, res);
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      const status = statusCode(res, threw);
      const duration = Number(now()) - Number(startedAt);
      const entry = {
        event: "oneview_bff_performance",
        route,
        status,
        duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0,
        error_class: bffPerformanceErrorClass(status, threw),
      };
      try {
        logger(entry);
      } catch {
        // Observabilidade nunca altera a resposta da API.
      }
    }
  };
}
