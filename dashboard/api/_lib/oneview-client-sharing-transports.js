/**
 * Transport boundary.
 *
 * Teams strategy: Workflow Incoming Webhook.
 * Microsoft Graph channel delivery is out of scope for this adapter.
 * Both adapters stay dry-run and perform no network IO.
 */
export const TEAMS_TRANSPORT_STRATEGY = "teams_workflow_incoming_webhook";

export function teamsWorkflowTarget(destination) {
  const url = typeof destination?.teams_webhook_url === "string" ? destination.teams_webhook_url.trim() : "";
  if (!url.startsWith("https://")) return null;
  return {
    strategy: TEAMS_TRANSPORT_STRATEGY,
    destination_id: typeof destination?.destination_id === "string" ? destination.destination_id : null,
  };
}

export async function sendTeamsClientShare({ destination } = {}) {
  const target = teamsWorkflowTarget(destination);
  return {
    transport: "teams",
    strategy: TEAMS_TRANSPORT_STRATEGY,
    status: "dry_run",
    destination_id: target?.destination_id || destination?.destination_id || null,
    external_called: false,
  };
}

export async function sendWebexClientShare({ destination } = {}) {
  return {
    transport: "webex",
    status: "dry_run",
    destination_id: destination?.destination_id || null,
    external_called: false,
  };
}
