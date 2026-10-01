import { createClientSharingHandler } from "../../_lib/oneview-client-sharing-handler.js";
export default function handler(req, res) {
  req.query = { ...(req.query || {}), mode: "send", smoke: "1" };
  return createClientSharingHandler()(req, res);
}
