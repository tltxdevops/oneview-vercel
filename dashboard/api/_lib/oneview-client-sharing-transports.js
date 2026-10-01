/**
 * Transport boundary.
 *
 * Teams strategy: Workflow Incoming Webhook.
 * Microsoft Graph channel delivery is out of scope for this adapter.
 * Live POST is allowed only for destination_id=ailos-teams (smoke and real send).
 * Webex remains dry-run and performs no network IO.
 */
import {
  isAilosTeamsSmokeDestination,
  resolveTeamsWorkflowWebhookUrl,
  teamsAlertCardModel,
  teamsWorkflowEnvName,
  teamsWorkflowTimeoutMs,
} from "./oneview-client-sharing.js";

export const TEAMS_TRANSPORT_STRATEGY = "teams_workflow_incoming_webhook";
export const TEAMS_WORKFLOW_TIMEOUT_MS = 8_000;

export function teamsWorkflowTarget(destination, env = process.env) {
  const destinationId = typeof destination?.destination_id === "string" ? destination.destination_id : null;
  if (!isAilosTeamsSmokeDestination(destinationId)) return null;
  if (!resolveTeamsWorkflowWebhookUrl(destinationId, env)) return null;
  return {
    strategy: TEAMS_TRANSPORT_STRATEGY,
    destination_id: destinationId,
    env_name: teamsWorkflowEnvName(destinationId, env),
  };
}

export function teamsWorkflowSmokePayload() {
  return teamsWorkflowAdaptiveCard([
    "Teste OneView - Ailos",
    "Integração OneView → Teams funcionando.",
  ]);
}

export function teamsWorkflowAlertPayload(message) {
  return teamsWorkflowAdaptiveCard(teamsAlertCardModel(message).lines);
}

function teamsWorkflowAdaptiveCard(lines) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: lines.map((text, index) => ({
            type: "TextBlock",
            weight: index === 0 ? "Bolder" : "Default",
            wrap: true,
            text,
          })),
        },
      },
    ],
  };
}

function classifyTeamsHttpStatus(status) {
  if (Number.isInteger(status) && status >= 200 && status < 300) {
    return { status: "sent", ambiguous: false };
  }
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { status: "rejected", ambiguous: false };
  }
  return { status: "ambiguous", ambiguous: true };
}

function sanitizeTeamsResponse(value) {
  if (typeof value !== "string") return null;
  return value.replace(/https?:\/\/\S+/gi, "[redacted]").trim().slice(0, 500) || null;
}

function teamsDelivery(partial) {
  return {
    transport: "teams",
    strategy: TEAMS_TRANSPORT_STRATEGY,
    destination_id: partial.destination_id || null,
    env_name: partial.env_name || null,
    status: partial.status,
    external_called: Boolean(partial.external_called),
    http_status: Number.isInteger(partial.http_status) ? partial.http_status : null,
    ambiguous: Boolean(partial.ambiguous),
    retryable: false,
    teams_response: partial.teams_response || null,
  };
}

// Live POST only. Never log `url` — it is the Teams webhook secret.
async function postTeamsWorkflowOnce({ url, payload, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timeout = null;
  try {
    const response = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error("timeout");
        error.name = "AbortError";
        reject(error);
      }, timeoutMs);
      Promise.resolve(fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      })).then(resolve, reject);
    });
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    const classified = classifyTeamsHttpStatus(response.status);
    return {
      status: classified.status,
      http_status: response.status,
      ambiguous: classified.ambiguous,
      teams_response: sanitizeTeamsResponse(text),
    };
  } catch (error) {
    const timeoutHit = error?.name === "AbortError";
    return {
      status: timeoutHit ? "timeout" : "network_error",
      http_status: null,
      ambiguous: true,
      teams_response: null,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function sendTeamsClientShare({
  destination,
  message,
  payload,
  live = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  const destinationId = typeof destination?.destination_id === "string" ? destination.destination_id : null;
  const envName = teamsWorkflowEnvName(destinationId, env);
  const dryRun = teamsDelivery({
    destination_id: destinationId,
    env_name: envName,
    status: "dry_run",
    external_called: false,
  });

  if (!live) return dryRun;
  if (!isAilosTeamsSmokeDestination(destinationId)) {
    return teamsDelivery({
      destination_id: destinationId,
      env_name: envName,
      status: "smoke_destination_not_allowed",
      external_called: false,
    });
  }

  const webhookUrl = resolveTeamsWorkflowWebhookUrl(destinationId, env);
  if (!webhookUrl) {
    return teamsDelivery({
      destination_id: destinationId,
      env_name: envName,
      status: "webhook_not_configured",
      external_called: false,
    });
  }

  const requestPayload = payload && typeof payload === "object"
    ? payload
    : (message ? teamsWorkflowAlertPayload(message) : teamsWorkflowSmokePayload());
  const result = await postTeamsWorkflowOnce({
    url: webhookUrl,
    payload: requestPayload,
    fetchImpl,
    timeoutMs: Number.isInteger(timeoutMs) ? timeoutMs : teamsWorkflowTimeoutMs(env),
  });
  return teamsDelivery({
    destination_id: destinationId,
    env_name: envName,
    status: result.status,
    external_called: true,
    http_status: result.http_status,
    ambiguous: result.ambiguous,
    teams_response: result.teams_response,
  });
}

export async function sendWebexClientShare({ destination } = {}) {
  return {
    transport: "webex",
    status: "dry_run",
    destination_id: destination?.destination_id || null,
    external_called: false,
  };
}
