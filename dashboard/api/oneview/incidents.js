import { createIncidentsHandler } from "../_lib/oneview-incidents.js";
import { withBffPerformanceTelemetry } from "../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createIncidentsHandler(), {
  route: "/api/oneview/incidents",
});
