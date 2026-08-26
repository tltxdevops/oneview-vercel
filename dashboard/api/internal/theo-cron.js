import { methodNotAllowed } from "../_lib/http.js";
import theoDispatchHandler from "../_lib/oneview-theo-dispatch.js";

/**
 * Vercel Cron invokes GET. Delegate only that authenticated invocation to the
 * existing POST dispatcher, which remains the sole CRON_SECRET gate.
 */
export function createTheoCronHandler({ dispatch = theoDispatchHandler } = {}) {
  return async function theoCronHandler(req, res) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    return dispatch({ ...req, method: "POST" }, res);
  };
}

export default createTheoCronHandler();
