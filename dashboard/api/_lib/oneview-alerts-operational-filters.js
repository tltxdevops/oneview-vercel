/** ACK origem × fila operacional — evita interseções impossíveis no BFF. */
const QUEUE_ACK_VIEWS = new Set(["pending", "acknowledged"]);

export function operationalSourceAckConflictsQueue(operationalView, acknowledgedSource) {
  if (!operationalView || !QUEUE_ACK_VIEWS.has(operationalView)) return false;
  if (acknowledgedSource === "true") return operationalView === "pending";
  if (acknowledgedSource === "false") return operationalView === "acknowledged";
  return false;
}

/** @returns {"true"|"false"|null} null = omit query param */
export function effectiveOperationalSourceAckQuery(operationalView, acknowledgedSource) {
  if (!acknowledgedSource || !["true", "false"].includes(acknowledgedSource)) return null;
  if (operationalSourceAckConflictsQueue(operationalView, acknowledgedSource)) return null;
  if (operationalView === "pending" && acknowledgedSource === "false") return null;
  if (operationalView === "acknowledged" && acknowledgedSource === "true") return null;
  return acknowledgedSource;
}
