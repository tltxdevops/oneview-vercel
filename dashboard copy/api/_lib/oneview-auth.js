import { requireAuth } from "./auth.js";

export async function requireOneViewAuth(req, res, role = "viewer") {
  return requireAuth(req, res, { role });
}
