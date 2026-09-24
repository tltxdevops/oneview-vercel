import { createOneViewHandler } from "../_lib/oneview-response.js";
import { withBffPerformanceTelemetry } from "../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createOneViewHandler("alerts"), {
  route: "/api/oneview/alerts",
});
