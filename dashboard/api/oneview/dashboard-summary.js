import { createOneViewHandler } from "../_lib/oneview-response.js";

// Keep this entrypoint explicit so Vercel rebuilds the summary bundle when its
// shared database implementation changes.
const dashboardSummaryHandler = createOneViewHandler("dashboard-summary");

export default function dashboardSummary(req, res) {
  return dashboardSummaryHandler(req, res);
}
