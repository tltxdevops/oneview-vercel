import { sendJson } from "./_lib/http.js";

export default function handler(req, res) {
  return sendJson(res, 200, {
    status: "ok",
    service: "oneview-vercel-api",
    zabbix_access: false,
  });
}
