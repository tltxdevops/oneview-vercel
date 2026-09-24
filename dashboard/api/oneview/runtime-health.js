import { createOneViewHandler } from "../_lib/oneview-response.js";
import { withBffPerformanceTelemetry } from "../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createOneViewHandler("runtime-health"), {
  route: "/api/oneview/runtime-health",
});
