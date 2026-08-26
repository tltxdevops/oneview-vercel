import { methodNotAllowed } from "../_lib/http.js";
import theoDispatchHandler from "../_lib/oneview-theo-dispatch.js";

/**
 * Vercel Cron invokes GET. Delegate only that authenticated invocation to the
 * existing POST dispatcher, which remains the sole CRON_SECRET gate.
 */
export function createTheoCronHandler({ dispatch = theoDispatchHandler } = {}) {
  return async function theoCronHandler(req, res) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    // IncomingMessage/VercelRequest fields can be inherited getters rather
    // than enumerable own properties. Forward the auth header explicitly;
    // spreading the request may otherwise turn a valid Vercel Cron into 401.
    return dispatch({
      method: "POST",
      headers: req.headers,
      query: req.query,
    }, res);
  };
}

export default createTheoCronHandler();
