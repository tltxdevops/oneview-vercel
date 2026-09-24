import { createLinksHandler } from "../_lib/oneview-links.js";
import { withBffPerformanceTelemetry } from "../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createLinksHandler(), {
  route: "/api/oneview/links",
});
