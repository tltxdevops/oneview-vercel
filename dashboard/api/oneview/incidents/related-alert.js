import { createRelatedAlertHandler } from "../../_lib/oneview-incident-relation.js";
import { withBffPerformanceTelemetry } from "../../_lib/oneview-bff-performance.js";

export default withBffPerformanceTelemetry(createRelatedAlertHandler(), {
  route: "/api/oneview/incidents/related-alert",
});
