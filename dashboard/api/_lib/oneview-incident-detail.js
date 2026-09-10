import { getId, methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import { fetchReadModelIncidentDetail } from "./oneview-incidents-read-model.js";

const NO_CACHE = "no-store, no-cache, max-age=0, must-revalidate";
const SAFE_INCIDENT_ID = /^[a-z0-9._:-]{1,80}$/i;

export function createIncidentDetailHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  findIncident = fetchReadModelIncidentDetail,
  logger = (entry) => console.info(JSON.stringify(entry)),
} = {}) {
  return async function incidentDetailHandler(req, res) {
    const startedAt = Date.now();
    res.setHeader("Cache-Control", NO_CACHE);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res)) return;

    const id = String(getId(req, "id") || "").trim();
    if (!SAFE_INCIDENT_ID.test(id)) return sendJson(res, 400, { error: "invalid_query", data_source: "database" });

    try {
      const item = await findIncident(id);
      const status = item ? 200 : 404;
      logger({
        event: "oneview_incident_detail",
        route: "/api/oneview/incidents/detail/:id",
        status,
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
      return item
        ? sendJson(res, 200, { item, data_source: "database", checked_at: new Date().toISOString() })
        : sendJson(res, 404, { error: "incident_not_found", data_source: "database" });
    } catch (error) {
      const status = error?.code === "invalid_query" ? 400 : 503;
      return sendJson(res, status, { error: status === 400 ? "invalid_query" : "database_unavailable", data_source: "database" });
    }
  };
}

export default createIncidentDetailHandler();
