/** Canonical Zabbix source-ACK authorship from persisted payload_normalized.acknowledges. */

export const ZABBIX_ACK_ACTION_ACKNOWLEDGE = 2;
export const ZABBIX_ACK_ACTION_MESSAGE = 4;
export const ZABBIX_ACK_ACTION_UNACKNOWLEDGE = 16;

const TECHNICAL_USERNAME_PATTERN = /^(api\.|svc\.|service\.|zabbix\.|bot\.)/i;

function textValue(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim() || fallback;
}

function isNumericIdentifier(value) {
  return /^\d+$/.test(textValue(value));
}

function resolveAckActorName(...candidates) {
  for (const candidate of candidates) {
    const normalized = textValue(candidate).slice(0, 160);
    if (normalized && !isNumericIdentifier(normalized)) return normalized;
  }
  return null;
}

function parseActionBits(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareAckClock(left, right) {
  const leftClock = Number.parseInt(String(left?.clock ?? left?.acknowledgeid ?? "0"), 10);
  const rightClock = Number.parseInt(String(right?.clock ?? right?.acknowledgeid ?? "0"), 10);
  if (leftClock !== rightClock) return leftClock - rightClock;
  return textValue(left?.acknowledgeid).localeCompare(textValue(right?.acknowledgeid));
}

export function isZabbixAcknowledgeAction(action) {
  return (parseActionBits(action) & ZABBIX_ACK_ACTION_ACKNOWLEDGE) !== 0;
}

export function isZabbixAckMessageOnly(action) {
  const bits = parseActionBits(action);
  return (bits & ZABBIX_ACK_ACTION_MESSAGE) !== 0 && (bits & ZABBIX_ACK_ACTION_ACKNOWLEDGE) === 0;
}

/**
 * Replay Zabbix action bits in clock order and return the row that established the
 * current acknowledged_source=true state (bit 2), ignoring message-only rows (e.g. action 4).
 */
export function pickEffectiveZabbixAcknowledgement(rows, acknowledgedSource = true) {
  if (!acknowledgedSource) return null;
  const ordered = [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => row && typeof row === "object")
    .sort(compareAckClock);
  if (!ordered.length) return null;

  let acknowledged = false;
  let effectiveRow = null;
  for (const row of ordered) {
    const bits = parseActionBits(row.action);
    if (bits & ZABBIX_ACK_ACTION_UNACKNOWLEDGE) acknowledged = false;
    if (bits & ZABBIX_ACK_ACTION_ACKNOWLEDGE) {
      acknowledged = true;
      effectiveRow = row;
    }
  }
  return acknowledged ? effectiveRow : null;
}

export function isTechnicalZabbixAccount(username) {
  const normalized = textValue(username).toLowerCase();
  if (!normalized) return false;
  return TECHNICAL_USERNAME_PATTERN.test(normalized) || normalized === "api.tltx";
}

export function displayZabbixAckAuthor(username, userid) {
  const resolvedUsername = textValue(username);
  if (isTechnicalZabbixAccount(resolvedUsername)) {
    return Object.freeze({
      actor_name: "Conta técnica",
      author_username: resolvedUsername,
      technical_account: true,
      author_unresolved: false,
    });
  }
  const actorName = resolveAckActorName(resolvedUsername);
  if (actorName) {
    return Object.freeze({
      actor_name: actorName,
      author_username: resolvedUsername || null,
      technical_account: false,
      author_unresolved: false,
    });
  }
  const userId = textValue(userid);
  if (userId && /^\d+$/.test(userId)) {
    return Object.freeze({
      actor_name: "Autor não identificado",
      author_username: null,
      technical_account: false,
      author_unresolved: true,
      zabbix_userid: userId,
    });
  }
  return Object.freeze({
    actor_name: "Autor não identificado",
    author_username: null,
    technical_account: false,
    author_unresolved: true,
  });
}

function clockToIso(clock) {
  const seconds = Number.parseInt(String(clock ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function resolveZabbixPayloadAckAuthorship(payloadAcknowledges, acknowledgedSource) {
  const effective = pickEffectiveZabbixAcknowledgement(payloadAcknowledges, acknowledgedSource);
  if (!effective) return null;

  const username = textValue(effective.username || effective.alias);
  const userid = textValue(effective.userid);
  const display = displayZabbixAckAuthor(username, userid);
  const acknowledgeId = textValue(effective.acknowledgeid || effective.acknowledge_id);

  return Object.freeze({
    acknowledged: true,
    origin: "zabbix",
    actor_name: display.actor_name,
    author_username: display.author_username,
    zabbix_userid: userid || display.zabbix_userid || null,
    technical_account: display.technical_account,
    author_unresolved: display.author_unresolved,
    acknowledged_at: clockToIso(effective.clock),
    acknowledge_id: acknowledgeId || null,
    comment: textValue(effective.message) || null,
    history_available: true,
    canonical_from_payload: true,
    zabbix_action: parseActionBits(effective.action),
  });
}

export function resolveOneViewAckInitiator(alertFields = {}) {
  const status = textValue(alertFields.oneview_ack_status).toLowerCase();
  const operator = resolveAckActorName(alertFields.oneview_ack_actor_name);
  if (!operator) return null;
  if (!["success", "completed", "recorded", "processing", "pending"].includes(status) && !alertFields.oneview_ack_requested_at) {
    return null;
  }
  return Object.freeze({
    actor_name: operator,
    requested_at: alertFields.oneview_ack_requested_at || alertFields.oneview_ack_processed_at || null,
    status,
  });
}

/**
 * Merge canonical Zabbix authorship (payload bit 2) with optional OneView initiator metadata.
 */
export function mergeSourceAckAuthorship(canonical, historyResolved, oneviewInitiator) {
  const base = canonical || historyResolved;
  if (!base?.acknowledged) {
    return Object.freeze({
      acknowledged: false,
      actor_name: null,
      author_username: null,
      zabbix_userid: null,
      origin: null,
      technical_account: false,
      author_unresolved: false,
      acknowledged_at: null,
      acknowledge_id: null,
      comment: null,
      history_available: false,
      canonical_from_payload: false,
      oneview_initiated_by: oneviewInitiator?.actor_name || null,
      oneview_initiated_at: oneviewInitiator?.requested_at || null,
    });
  }

  return Object.freeze({
    ...base,
    oneview_initiated_by: oneviewInitiator?.actor_name || null,
    oneview_initiated_at: oneviewInitiator?.requested_at || null,
    origin: canonical ? "zabbix" : (oneviewInitiator ? "oneview" : base.origin || "zabbix"),
  });
}

export function buildCanonicalHistoryAckEvent(sourceAck, alertFields = {}) {
  if (!sourceAck?.acknowledged || !sourceAck.actor_name) return null;
  const eventType = sourceAck.canonical_from_payload ? "acknowledged" : "acknowledged";
  const title = sourceAck.origin === "oneview" ? "Reconhecimento via OneView" : "Reconhecimento na origem";
  const descriptionParts = [
    sourceAck.technical_account && sourceAck.author_username
      ? `Conta técnica (${sourceAck.author_username})`
      : sourceAck.actor_name,
  ];
  if (sourceAck.zabbix_userid) descriptionParts.push(`userid ${sourceAck.zabbix_userid}`);
  if (sourceAck.acknowledge_id) descriptionParts.push(`ACK ID ${sourceAck.acknowledge_id}`);
  if (sourceAck.oneview_initiated_by && sourceAck.origin === "zabbix") {
    descriptionParts.push(`solicitado por ${sourceAck.oneview_initiated_by} no OneView`);
  }

  return Object.freeze({
    id: `canonical-source-ack:${textValue(alertFields.id || alertFields.alert_id)}`,
    event_type: eventType,
    title,
    description: descriptionParts.join(" · "),
    previous_value: null,
    current_value: null,
    source_event_id: textValue(alertFields.source_event_id) || null,
    occurred_at: sourceAck.acknowledged_at,
    created_at: sourceAck.acknowledged_at,
    actor_name: sourceAck.actor_name,
    ack_actor_name: sourceAck.actor_name,
    ack_actor_unresolved: Boolean(sourceAck.author_unresolved),
    acknowledge_id: sourceAck.acknowledge_id,
    actor_type: sourceAck.technical_account ? "technical" : "operator",
    source: sourceAck.origin === "oneview" ? "OneView" : "Zabbix",
    origin: sourceAck.origin === "oneview" ? "oneview" : "zabbix",
    legacy: false,
    comment: sourceAck.comment || null,
    grouped_event_count: 1,
    canonical_source_ack: true,
  });
}
