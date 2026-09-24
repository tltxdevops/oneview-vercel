import { createServiceNowMeHandler } from "../../_lib/oneview-servicenow-me.js";
import { withBffPerformanceTelemetry } from "../../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createServiceNowMeHandler(), {
  route: "/api/oneview/servicenow/me",
});
