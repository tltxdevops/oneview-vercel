import { methodNotAllowed, sendJson } from "../_lib/http.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  return sendJson(res, 200, {
    VITE_AZURE_CLIENT_ID: process.env.VITE_AZURE_CLIENT_ID || "",
    VITE_AZURE_TENANT_ID: process.env.VITE_AZURE_TENANT_ID || "",
    VITE_AZURE_AUTHORITY: process.env.VITE_AZURE_AUTHORITY || "",
    VITE_AZURE_REDIRECT_URI: process.env.VITE_AZURE_REDIRECT_URI || "",
    VITE_AZURE_POST_LOGOUT_URI: process.env.VITE_AZURE_POST_LOGOUT_URI || "",
    VITE_AZURE_SCOPES: process.env.VITE_AZURE_SCOPES || "",
    VITE_MSAL_LOG_LEVEL: process.env.VITE_MSAL_LOG_LEVEL || "",
  });
}
