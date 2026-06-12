import { query, transaction } from "../_lib/db.js";
import { insertAuditLog } from "../_lib/audit.js";
import { requireAuth } from "../_lib/auth.js";
import { DATA_SOURCE_FIELDS, sanitizeDataSource } from "../_lib/data-sources.js";
import { now } from "../_lib/ids.js";
import { getId, handleError, methodNotAllowed, operatorFrom, parseBody, sendJson } from "../_lib/http.js";

const UPDATABLE_FIELDS = [
  "name",
  "client_name",
  "environment",
  "api_url",
  "problem_group_filter",
  "status",
  "sync_enabled",
  "sync_interval_seconds",
  "via_vpn",
  "observation",
  "display_order",
];

export default async function handler(req, res) {
  const id = getId(req);

  if (req.method === "GET") {
    if (!(await requireAuth(req, res, { role: "viewer" }))) return;
    try {
      const result = await query(`select ${DATA_SOURCE_FIELDS} from data_sources where id = $1`, [id]);
      if (!result.rows[0]) return sendJson(res, 404, { error: "data_source_not_found" });
      return sendJson(res, 200, sanitizeDataSource(result.rows[0]));
    } catch (error) {
      return handleError(res, error);
    }
  }

  if (req.method === "PATCH") {
    if (!(await requireAuth(req, res, { role: "admin" }))) return;
    try {
      const body = parseBody(req);
      const operatorName = operatorFrom(req, body);
      const updated = await transaction(async (client) => {
        const existing = await client.query("select id from data_sources where id = $1", [id]);
        if (!existing.rows[0]) return null;

        const sets = [];
        const values = [];
        for (const field of UPDATABLE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(body, field)) {
            values.push(body[field]);
            sets.push(`${field} = $${values.length}`);
          }
        }
        if (!sets.length) {
          const result = await client.query(`select ${DATA_SOURCE_FIELDS} from data_sources where id = $1`, [id]);
          return sanitizeDataSource(result.rows[0]);
        }
        values.push(now());
        sets.push(`updated_at = $${values.length}`);
        values.push(id);

        const result = await client.query(
          `
            update data_sources
            set ${sets.join(", ")}
            where id = $${values.length}
            returning ${DATA_SOURCE_FIELDS}
          `,
          values,
        );
        await insertAuditLog(client, {
          actorName: operatorName,
          action: "data_source_updated",
          entityType: "data_source",
          entityId: id,
          dataSourceId: id,
          req,
        });
        return sanitizeDataSource(result.rows[0]);
      });

      if (!updated) return sendJson(res, 404, { error: "data_source_not_found" });
      return sendJson(res, 200, updated);
    } catch (error) {
      return handleError(res, error);
    }
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
