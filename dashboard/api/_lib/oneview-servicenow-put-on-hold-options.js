import { methodNotAllowed, sendJson } from "./http.js";
import { requireOneViewAuth } from "./oneview-auth.js";
import {
  getServiceNowExternalVendorsConfig,
  publicExternalVendorOptions,
} from "./oneview-servicenow-external-vendors.js";

export function createServiceNowPutOnHoldOptionsHandler({
  authorize = (req, res) => requireOneViewAuth(req, res, "viewer"),
  configProvider = getServiceNowExternalVendorsConfig,
} = {}) {
  return async function serviceNowPutOnHoldOptionsHandler(req, res) {
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    if (!await authorize(req, res)) return;
    return sendJson(res, 200, publicExternalVendorOptions(configProvider()));
  };
}

export default createServiceNowPutOnHoldOptionsHandler();
