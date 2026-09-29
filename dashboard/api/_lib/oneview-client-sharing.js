import crypto from "node:crypto";

const DESTINATION_ENV = "ONEVIEW_CLIENT_SHARE_DESTINATIONS_JSON";
const FEATURE_ENV = "ONEVIEW_CLIENT_SHARING_ENABLED";
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
  return {
    client_key: clientKey,
    route_key: normalizedRoute,
    route_label: routeLabel,
    destination_id: destinationId,
    destination_name: destinationName,
    channel_type: channel,
    enabled: item.enabled === undefined ? true : bool(item.enabled),
    is_default: bool(item.is_default),
    teams_webhook_url: channel === "teams" ? secretHttpsUrl(item.teams_webhook_url) : null,
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

export function clientShareDestinationCatalog(env = process.env) {
  const raw = text(env[DESTINATION_ENV], 100_000);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeClientShareDestination).filter(Boolean);
  } catch {
    return [];
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
  const host = text(input.host, 240);
  const problem = text(input.problem, 1_000);
  const startedAt = optionalText(input.started_at, 80);
  const status = text(input.status, 80);
  const messageType = text(input.message_type, 24).toLowerCase();
  if (!clientKey || !clientName || !severity || !host || !problem || !startedAt || !status || !["alert", "resolved"].includes(messageType)) {
    throw destinationError("invalid_client_share_message");
  }
  return {
    client_key: clientKey,
    client_name: clientName,
    severity,
    host,
    problem,
    started_at: startedAt,
    status,
    incident_number: optionalText(input.incident_number, 80),
    servicenow_url: optionalText(input.servicenow_url, 1_000),
    oneview_url: optionalText(input.oneview_url, 1_000),
    message_type: messageType,
    route_key: routeKey(input.route_key) || null,
    snapshot: input.snapshot && typeof input.snapshot === "object" && !Array.isArray(input.snapshot) ? input.snapshot : null,
  };
}

export function clientSharePreview(message, destination) {
  const incident = message.incident_number ? `\nChamado: ${message.incident_number}` : "";
  const link = message.oneview_url ? `\nOneView: ${message.oneview_url}` : "";
  const selected = destination?.destination_id ? publicClientShareDestination(destination) : null;
  return {
    text: `[OneView] ${message.message_type === "resolved" ? "Normalizado" : "Alerta"}\nCliente: ${message.client_name}\nSeveridade: ${message.severity}\nHost: ${message.host}\nProblema: ${message.problem}\nInício: ${message.started_at}\nStatus: ${message.status}${incident}${link}`,
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

export function clientShareAuditRecord({ actor, message, destination, idempotencyKey, status, error = null }) {
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
      error: error || null,
    },
  };
}

export const CLIENT_SHARE_ENVS = Object.freeze({ feature: FEATURE_ENV, destinations: DESTINATION_ENV });
