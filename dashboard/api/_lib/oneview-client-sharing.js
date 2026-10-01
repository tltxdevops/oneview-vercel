import crypto from "node:crypto";

const DESTINATION_ENV = "ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON";
const FEATURE_ENV = "ONEVIEW_CLIENT_SHARING_ENABLED";
export const AILOS_TEAMS_DESTINATION_ID = "ailos-teams";
export const TEAMS_WORKFLOW_WEBHOOKS_ENV = "ONEVIEW_TEAMS_WORKFLOW_WEBHOOKS_JSON";
export const TEAMS_WORKFLOW_AILOS_ENV = "TEAMS_WORKFLOW_AILOS";
const TEAMS_WORKFLOW_TIMEOUT_ENV = "TEAMS_WORKFLOW_TIMEOUT_MS";
const TEAMS_WORKFLOW_DEFAULT_TIMEOUT_MS = 8_000;
export const AILOS_TEAMS_PILOT_DESTINATION = Object.freeze({
  client_key: "ailos",
  route_key: "noc",
  route_label: "Ailos",
  destination_id: AILOS_TEAMS_DESTINATION_ID,
  destination_name: "Ailos",
  channel_type: "teams",
  enabled: true,
  is_default: true,
  team_id: "bb8dcc45-957b-4aec-8c77-f28338d2444f",
  channel_id: "19:HnFt-pLXTtlhf2RRczlD0ZAjyy766IIWz-8vpNWn33k1@thread.tacv2",
  tenant_id: "9c36f529-164f-47cd-bca0-ba7c0d710407",
});
const TEXT_MAX = 500;
const DESTINATION_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const CHANNELS = new Set(["teams", "webex"]);
const SHEET_CLIENT = ["Cliente", "cliente", "client"];
const SHEET_ROUTE = ["SDC-Resp", "sdc_resp", "sdcResp", "sdc"];
const SHEET_GROUP = ["Grupo", "grupo", "group"];

function text(value, maximum = TEXT_MAX) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function optionalText(value, maximum = TEXT_MAX) {
  return text(value, maximum) || null;
}

function lineText(value, maximum = TEXT_MAX) {
  return text(value, maximum).replace(/\s+/g, " ");
}

function bool(value) {
  return value === true || ["1", "true", "yes", "sim"].includes(String(value ?? "").trim().toLowerCase());
}

function routeKey(value) {
  return text(value, 160)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function secretHttpsUrl(value) {
  const url = text(value, 2_000);
  return /^https:\/\/\S+$/i.test(url) ? url : null;
}

function sheetValue(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return "";
}

function destinationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function isClientSharingEnabled(env = process.env) {
  return bool(env[FEATURE_ENV]);
}

export function normalizeClientShareDestination(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const channel = text(item.channel_type, 16).toLowerCase();
  const clientKey = text(item.client_key, 160).toLowerCase();
  const normalizedRoute = routeKey(item.route_key);
  const destinationId = text(item.destination_id, 160);
  const destinationName = text(item.destination_name, 240);
  const routeLabel = text(item.route_label, 240) || destinationName;
  if (!CHANNELS.has(channel) || !clientKey || !normalizedRoute || !DESTINATION_ID.test(destinationId) || !destinationName) return null;
  const ailosPilot = destinationId === AILOS_TEAMS_DESTINATION_ID;
  return {
    client_key: clientKey,
    route_key: normalizedRoute,
    route_label: routeLabel,
    destination_id: destinationId,
    destination_name: destinationName,
    channel_type: channel,
    enabled: item.enabled === undefined ? true : bool(item.enabled),
    is_default: bool(item.is_default),
    team_id: optionalText(item.team_id, 80),
    channel_id: optionalText(item.channel_id, 240),
    tenant_id: optionalText(item.tenant_id, 80),
    teams_webhook_url: channel === "teams" && !ailosPilot ? secretHttpsUrl(item.teams_webhook_url) : null,
    webex_room_id: channel === "webex" ? optionalText(item.webex_room_id, 240) : null,
  };
}

export function publicClientShareDestination(item) {
  const destination = normalizeClientShareDestination(item);
  if (!destination) return null;
  return {
    client_key: destination.client_key,
    route_key: destination.route_key,
    route_label: destination.route_label,
    destination_id: destination.destination_id,
    destination_name: destination.destination_name,
    channel_type: destination.channel_type,
    enabled: destination.enabled,
    is_default: destination.is_default,
  };
}

function enabledTeamsDestinationIds(catalog) {
  return new Set(
    (Array.isArray(catalog) ? catalog : [])
      .map(normalizeClientShareDestination)
      .filter((item) => item && item.enabled && item.channel_type === "teams")
      .map((item) => item.destination_id),
  );
}

export function parseTeamsWorkflowWebhookRegistry(env = process.env, catalog = null) {
  const raw = text(env[TEAMS_WORKFLOW_WEBHOOKS_ENV], 100_000);
  const items = Array.isArray(catalog) ? catalog : clientShareDestinationCatalog(env);
  const enabled = enabledTeamsDestinationIds(items);
  if (!raw) {
    return { webhooks: Object.create(null), present: new Set(), error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { webhooks: Object.create(null), present: new Set(), error: "webhook_registry_invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { webhooks: Object.create(null), present: new Set(), error: "webhook_registry_invalid" };
  }
  const webhooks = Object.create(null);
  const present = new Set();
  for (const [key, value] of Object.entries(parsed)) {
    const id = text(key, 160);
    if (!DESTINATION_ID.test(id)) continue;
    present.add(id);
    if (!enabled.has(id)) continue;
    const url = secretHttpsUrl(value);
    if (!url) continue;
    webhooks[id] = url;
  }
  return { webhooks, present, error: null };
}

export function teamsWorkflowEnvName(destinationId, env = process.env, catalog = null) {
  const id = text(destinationId, 160);
  if (!id) return null;
  const registry = parseTeamsWorkflowWebhookRegistry(env, catalog);
  if (registry.error || registry.webhooks[id] || registry.present.has(id)) return TEAMS_WORKFLOW_WEBHOOKS_ENV;
  if (id === AILOS_TEAMS_DESTINATION_ID && secretHttpsUrl(env[TEAMS_WORKFLOW_AILOS_ENV])) return TEAMS_WORKFLOW_AILOS_ENV;
  return TEAMS_WORKFLOW_WEBHOOKS_ENV;
}

export function resolveTeamsWorkflowWebhookUrl(destinationId, env = process.env, catalog = null) {
  const id = text(destinationId, 160);
  if (!id) return null;
  const registry = parseTeamsWorkflowWebhookRegistry(env, catalog);
  if (registry.error) return null;
  if (registry.webhooks[id]) return registry.webhooks[id];
  if (registry.present.has(id)) return null;
  if (id === AILOS_TEAMS_DESTINATION_ID) return secretHttpsUrl(env[TEAMS_WORKFLOW_AILOS_ENV]);
  return null;
}

export function teamsWorkflowWebhookConfigError(destinationId, env = process.env, catalog = null) {
  const registry = parseTeamsWorkflowWebhookRegistry(env, catalog);
  if (registry.error) return registry.error;
  if (!resolveTeamsWorkflowWebhookUrl(destinationId, env, catalog)) return "webhook_not_configured";
  return null;
}

export function teamsWorkflowTimeoutMs(env = process.env) {
  const raw = Number.parseInt(String(env[TEAMS_WORKFLOW_TIMEOUT_ENV] || ""), 10);
  if (Number.isInteger(raw) && raw >= 1_000 && raw <= 30_000) return raw;
  return TEAMS_WORKFLOW_DEFAULT_TIMEOUT_MS;
}

export function isAilosTeamsSmokeDestination(destinationId) {
  return text(destinationId, 160) === AILOS_TEAMS_DESTINATION_ID;
}

export function isAilosTeamsLiveDestination(destinationId, env = process.env) {
  return isAilosTeamsSmokeDestination(destinationId) && Boolean(resolveTeamsWorkflowWebhookUrl(destinationId, env));
}

export function builtInClientShareDestinations() {
  return [normalizeClientShareDestination(AILOS_TEAMS_PILOT_DESTINATION)].filter(Boolean);
}

export function findEnabledClientShareDestination(destinationId, catalog) {
  const id = cleanDestinationId(destinationId);
  const matches = (Array.isArray(catalog) ? catalog : [])
    .map(normalizeClientShareDestination)
    .filter((item) => item && item.enabled && item.destination_id === id);
  if (matches.length !== 1) throw destinationError("invalid_destination_id");
  return matches[0];
}

export function clientShareDestinationCatalog(env = process.env) {
  const builtIn = builtInClientShareDestinations();
  const seen = new Set(builtIn.map((item) => item.destination_id));
  const raw = text(env[DESTINATION_ENV], 100_000);
  if (!raw) return builtIn;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return builtIn;
    const extra = parsed.map(normalizeClientShareDestination).filter((item) => item && !seen.has(item.destination_id));
    return [...builtIn, ...extra];
  } catch {
    return builtIn;
  }
}

/**
 * Future spreadsheet import. Expected columns: Cliente, SDC-Resp, Grupo.
 * Rows are supplied by the caller. This function does not embed a client catalog.
 * Webhook and token columns are ignored.
 */
export function clientShareCatalogFromSpreadsheet(rows, options = {}) {
  const fallbackChannel = text(options.channel_type, 16).toLowerCase() || "teams";
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const channel = text(row?.channel_type, 16).toLowerCase() || fallbackChannel;
    const client = routeKey(sheetValue(row, SHEET_CLIENT));
    const route = routeKey(sheetValue(row, SHEET_ROUTE));
    const group = text(sheetValue(row, SHEET_GROUP), 240);
    const explicitId = text(row?.destination_id, 160);
    return normalizeClientShareDestination({
      client_key: client,
      route_key: route,
      route_label: text(sheetValue(row, SHEET_ROUTE), 240) || group,
      destination_id: explicitId || [client, route, channel].filter(Boolean).join(":"),
      destination_name: group,
      channel_type: channel,
      enabled: row?.enabled,
      is_default: row?.is_default,
    });
  }).filter(Boolean);
}

function cleanDestinationId(value) {
  const id = text(value, 160);
  if (!id) return "";
  if (!DESTINATION_ID.test(id)) throw destinationError("invalid_destination_id");
  return id;
}

function resolution(selection, reason, requiresSelection, destinations, selected) {
  return {
    selection,
    reason,
    requires_selection: requiresSelection,
    destinations,
    selected: selected ? publicClientShareDestination(selected) : null,
    selectedInternal: selected || null,
  };
}

export function resolveClientShareRoute({ clientKey, routeKey: hintedRoute, destinationId, catalog } = {}) {
  const key = text(clientKey, 160).toLowerCase();
  const enabled = (Array.isArray(catalog) ? catalog : [])
    .map(normalizeClientShareDestination)
    .filter((item) => item && item.client_key === key && item.enabled)
    .sort((left, right) => left.destination_name.localeCompare(right.destination_name, "pt"));
  const destinations = enabled.map(publicClientShareDestination);
  const requestedId = cleanDestinationId(destinationId);

  if (requestedId) {
    const matches = enabled.filter((item) => item.destination_id === requestedId);
    if (matches.length !== 1) throw destinationError("invalid_destination_id");
    return resolution("explicit", "destination_id", false, destinations, matches[0]);
  }
  if (enabled.length === 0) return resolution("none", "no_destination", false, [], null);
  if (enabled.length === 1) return resolution("auto", "single_destination", false, destinations, enabled[0]);

  const hinted = routeKey(hintedRoute);
  if (!hinted) return resolution("required", "multiple_destinations", true, destinations, null);
  const matches = enabled.filter((item) => item.route_key === hinted);
  if (matches.length === 1) return resolution("preselected", "route_key", false, destinations, matches[0]);
  if (matches.length === 0) return resolution("required", "unknown_route", true, destinations, null);
  return resolution("required", "ambiguous_route", true, destinations, null);
}

export function clientShareMessageContract(input = {}) {
  const clientKey = text(input.client_key, 160).toLowerCase();
  const clientName = text(input.client_name, 240);
  const severity = text(input.severity, 80);
  const host = lineText(input.host, 240);
  const equipment = lineText(input.equipment, 240) || host;
  const problem = text(input.problem, 1_000);
  const startedAt = optionalText(input.started_at, 80);
  const startedAtInstant = startedAt ? new Date(startedAt) : null;
  const status = text(input.status, 80);
  const messageType = text(input.message_type, 24).toLowerCase();
  if (!clientKey || !clientName || !severity || !host || !problem || !startedAt || !startedAtInstant || Number.isNaN(startedAtInstant.getTime()) || !status || !["alert", "resolved"].includes(messageType)) {
    throw destinationError("invalid_client_share_message");
  }
  const requestedIncidentNumber = lineText(input.incident_number, 80).toUpperCase();
  const incidentNumber = /^INC\d+$/.test(requestedIncidentNumber) ? requestedIncidentNumber : null;
  const action = lineText(input.action, 240)
    || (messageType === "resolved"
      ? "Alarme normalizado."
      : incidentNumber ? `Aberto chamado ${incidentNumber} para acompanhamento de alerta.` : "Alerta em análise.");
  const nextSteps = lineText(input.next_steps, 240)
    || (messageType === "resolved" ? "Acompanhamento concluído." : "Acompanhando alerta.");
  const followUp = resolveClientShareFollowUp(input.follow_up);
  return {
    client_key: clientKey,
    client_name: clientName,
    severity,
    host,
    equipment: formatClientShareEquipment(equipment, input.equipment_ip),
    problem,
    started_at: startedAt,
    status,
    action,
    next_steps: nextSteps,
    follow_up: followUp,
    incident_number: incidentNumber,
    incident_state: incidentNumber ? lineText(input.incident_state, 80) || null : null,
    servicenow_url: optionalText(input.servicenow_url, 1_000),
    oneview_url: optionalText(input.oneview_url, 1_000),
    message_type: messageType,
    route_key: routeKey(input.route_key) || null,
    snapshot: input.snapshot && typeof input.snapshot === "object" && !Array.isArray(input.snapshot) ? input.snapshot : null,
  };
}

function clientShareDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value, 80);
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")}/${part("month")}/${part("year")} - ${part("hour")}:${part("minute")}:${part("second")}`;
}

function isPlaceholderFollowUp(value) {
  const name = lineText(value, 120);
  return !name || /^equipe noc$/i.test(name) || /^oneview operator$/i.test(name);
}

export function resolveClientShareFollowUp(provided) {
  if (isPlaceholderFollowUp(provided)) return "Equipe NOC";
  return lineText(provided, 120);
}

export function clientShareSeverityIcon(severity) {
  const value = text(severity, 80).toLowerCase();
  if (["disaster", "high", "critical", "5", "4"].includes(value)) return "🔴";
  if (["average", "3"].includes(value)) return "🟠";
  if (["warning", "2"].includes(value)) return "🟡";
  if (["information", "info", "1"].includes(value)) return "🔵";
  return "⚪";
}

export function formatClientShareEquipment(equipment, ip) {
  const name = lineText(equipment, 240);
  const address = lineText(ip, 64);
  if (name && address && !name.includes(`(${address})`)) return `${name} (${address})`;
  return name;
}

export function clientShareNocLines(message) {
  const host = lineText(message?.host, 240);
  const problem = text(message?.problem, 1_000);
  const equipment = formatClientShareEquipment(message?.equipment || host, message?.equipment_ip);
  return [
    `${clientShareSeverityIcon(message?.severity)} ${host} - ${problem}`,
    `📟 Equipamento: ${equipment}`,
    `📅 Data/Hora: ${clientShareDateTime(message?.started_at)}`,
    `🛠️ Ação: ${lineText(message?.action, 240)}`,
    `🔄 Próximos Passos: ${lineText(message?.next_steps, 240)}`,
    `🔎 Acompanhamento: ${lineText(message?.follow_up, 120)}`,
  ];
}

export function teamsAlertCardModel(message) {
  const lines = clientShareNocLines(message);
  return {
    title: lines[0],
    facts: [],
    actions: [],
    lines,
    previewText: lines.join("\n"),
  };
}

export function clientSharePreview(message, destination) {
  const selected = destination?.destination_id ? publicClientShareDestination(destination) : null;
  return {
    text: teamsAlertCardModel(message).previewText,
    destination_id: selected?.destination_id || null,
    destinations: {
      teams: selected?.channel_type === "teams",
      webex: selected?.channel_type === "webex",
    },
  };
}

export function clientShareIdempotencyKey(value) {
  const raw = text(value, 200);
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(raw)) throw destinationError("invalid_idempotency_key");
  return raw;
}

export function classifyClientShareOutcome(delivery, { live = false } = {}) {
  if (!live) {
    return { status: "dry_run", resultAction: "client_share_sent", ambiguous: false };
  }
  const raw = text(delivery?.status, 80);
  if (raw === "sent") return { status: "sent", resultAction: "client_share_sent", ambiguous: false };
  const posted = Boolean(delivery?.external_called);
  if (!posted || raw === "rejected" || raw === "definite_failure") {
    return { status: "definite_failure", resultAction: "client_share_failed", ambiguous: false };
  }
  return { status: "ambiguous", resultAction: "client_share_failed", ambiguous: true };
}

export function clientShareAuditRecord({ actor, message, destination, idempotencyKey, status, error = null, delivery = null, live = null }) {
  const selected = destination ? publicClientShareDestination(destination) : null;
  return {
    action: "client_share_requested",
    entity_type: "client_share",
    entity_id: crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32),
    actor_id: text(actor?.id, 160) || null,
    actor_name: text(actor?.name, 240) || "OneView operator",
    metadata: {
      idempotency_key: idempotencyKey,
      client_key: message.client_key,
      route_key: selected?.route_key || message.route_key || null,
      destination_id: selected?.destination_id || null,
      channel_type: selected?.channel_type || null,
      message_type: message.message_type,
      status,
      http_status: Number.isInteger(delivery?.http_status) ? delivery.http_status : null,
      external_called: Boolean(delivery?.external_called),
      ambiguous: Boolean(delivery?.ambiguous),
      live_send: live == null ? Boolean(delivery?.external_called) : Boolean(live),
      error: error || null,
    },
  };
}

export function clientShareResultAuditRecord({ actor, message, destination, idempotencyKey, status, error = null, delivery = null, action }) {
  const selected = destination ? publicClientShareDestination(destination) : null;
  const resultAction = action === "client_share_sent" || action === "client_share_failed"
    ? action
    : (status === "sent" || status === "dry_run" ? "client_share_sent" : "client_share_failed");
  return {
    action: resultAction,
    entity_type: "client_share",
    entity_id: crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32),
    actor_id: text(actor?.id, 160) || null,
    actor_name: text(actor?.name, 240) || "OneView operator",
    metadata: {
      idempotency_key: idempotencyKey,
      client_key: message?.client_key || selected?.client_key || null,
      route_key: selected?.route_key || message?.route_key || null,
      destination_id: selected?.destination_id || null,
      channel_type: selected?.channel_type || null,
      message_type: message?.message_type || null,
      status,
      http_status: Number.isInteger(delivery?.http_status) ? delivery.http_status : null,
      external_called: Boolean(delivery?.external_called),
      ambiguous: Boolean(delivery?.ambiguous) || status === "ambiguous",
      live_send: Boolean(delivery?.external_called) || status === "sent",
      error: error || null,
    },
  };
}

export function clientShareSmokeAuditRecord({ actor, destination, idempotencyKey, delivery }) {
  const selected = destination ? publicClientShareDestination(destination) : null;
  const status = text(delivery?.status, 80) || null;
  return {
    action: "client_share_smoke",
    entity_type: "client_share",
    entity_id: crypto.createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32),
    actor_id: text(actor?.id, 160) || null,
    actor_name: text(actor?.name, 240) || "OneView operator",
    metadata: {
      idempotency_key: idempotencyKey,
      client_key: selected?.client_key || "ailos",
      route_key: selected?.route_key || "noc",
      destination_id: selected?.destination_id || AILOS_TEAMS_DESTINATION_ID,
      channel_type: selected?.channel_type || "teams",
      smoke: true,
      status,
      http_status: Number.isInteger(delivery?.http_status) ? delivery.http_status : null,
      external_called: Boolean(delivery?.external_called),
      ambiguous: Boolean(delivery?.ambiguous),
      error: status && !["sent", "dry_run", "reserved"].includes(status) ? status : null,
    },
  };
}

export const CLIENT_SHARE_ENVS = Object.freeze({
  feature: FEATURE_ENV,
  destinations: DESTINATION_ENV,
  teamsWorkflowWebhooks: TEAMS_WORKFLOW_WEBHOOKS_ENV,
  teamsWorkflowAilos: TEAMS_WORKFLOW_AILOS_ENV,
  teamsWorkflowTimeoutMs: TEAMS_WORKFLOW_TIMEOUT_ENV,
});
