import { createClientSharingHandler } from "../../_lib/oneview-client-sharing-handler.js";
export default function handler(req, res) { req.query = { ...(req.query || {}), mode: "preview" }; return createClientSharingHandler()(req, res); }
