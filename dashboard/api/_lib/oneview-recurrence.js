/**
 * OV-P0-87 — Recurrence read model (somente leitura).
 *
 * Identidade: data_source_id + source_host_id + source_trigger_id
 * Episódio novo só conta quando o predecessor tem resolved_at
 * e o novo first_seen_at é posterior a essa resolução.
 */

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;

function textValue(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function nullableText(value) {
  const normalized = textValue(value);
  return normalized || null;
}

function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

export function emptyAlertRecurrenceReadModel() {
  return Object.freeze({
    recurrence_count_24h: 0,
    recurrence_count_7d: 0,
    previous_occurrence_at: null,
    previous_recovery_at: null,
    is_recurrent: false,
  });
}

export function hasRecurrenceIdentity(alert) {
  return Boolean(
    nullableText(alert?.data_source_id)
    && nullableText(alert?.source_host_id)
    && nullableText(alert?.source_trigger_id),
  );
}

/**
 * Seleciona episódios válidos (ordem cronológica).
 * O primeiro alerta da identidade conta; os seguintes só contam quando o
 * último episódio já tem resolved_at e o novo first_seen_at é posterior.
 */
export function selectRecurrenceEpisodes(alerts = []) {
  const sorted = [...alerts]
    .map((alert) => ({
      id: textValue(alert?.id),
      first_seen_at: toDate(alert?.first_seen_at),
      resolved_at: toDate(alert?.resolved_at),
    }))
    .filter((alert) => alert.id && alert.first_seen_at)
    .sort((left, right) => {
      const delta = left.first_seen_at.getTime() - right.first_seen_at.getTime();
      if (delta !== 0) return delta;
      return left.id.localeCompare(right.id);
    });

  const episodes = [];
  for (const alert of sorted) {
    if (!episodes.length) {
      episodes.push(alert);
      continue;
    }
    const predecessor = episodes[episodes.length - 1];
    if (
      predecessor.resolved_at
      && alert.first_seen_at.getTime() > predecessor.resolved_at.getTime()
    ) {
      episodes.push(alert);
    }
  }
  return episodes;
}

/**
 * @param {{ current: object, siblings?: object[], now?: Date|string|number }} input
 */
export function buildAlertRecurrenceReadModel({ current, siblings = [], now = new Date() } = {}) {
  const empty = emptyAlertRecurrenceReadModel();
  if (!current || !hasRecurrenceIdentity(current)) return { ...empty };

  const currentId = textValue(current.id);
  const currentFirstSeen = toDate(current.first_seen_at);
  if (!currentId || !currentFirstSeen) return { ...empty };

  const identityHost = nullableText(current.source_host_id);
  const identityTrigger = nullableText(current.source_trigger_id);
  const identitySource = nullableText(current.data_source_id);

  const pool = [];
  const seen = new Set();
  for (const candidate of [current, ...siblings]) {
    if (!candidate) continue;
    if (nullableText(candidate.data_source_id) && nullableText(candidate.data_source_id) !== identitySource) continue;
    if (nullableText(candidate.source_host_id) && nullableText(candidate.source_host_id) !== identityHost) continue;
    if (nullableText(candidate.source_trigger_id) && nullableText(candidate.source_trigger_id) !== identityTrigger) continue;
    // Siblings da query SQL já estão filtrados; current sempre entra.
    const id = textValue(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pool.push(candidate);
  }

  const episodes = selectRecurrenceEpisodes(pool);
  if (!episodes.length) return { ...empty };

  const nowMs = toDate(now)?.getTime() ?? Date.now();
  const window24h = nowMs - MS_24H;
  const window7d = nowMs - MS_7D;

  const recurrence_count_24h = episodes.filter((episode) => episode.first_seen_at.getTime() >= window24h).length;
  const recurrence_count_7d = episodes.filter((episode) => episode.first_seen_at.getTime() >= window7d).length;

  const currentIndex = episodes.findIndex((episode) => episode.id === currentId);
  const previous = currentIndex > 0
    ? episodes[currentIndex - 1]
    : (currentIndex < 0
      ? episodes.filter((episode) => episode.first_seen_at.getTime() < currentFirstSeen.getTime()).at(-1) || null
      : null);

  return {
    recurrence_count_24h,
    recurrence_count_7d,
    previous_occurrence_at: previous ? toIso(previous.first_seen_at) : null,
    previous_recovery_at: previous ? toIso(previous.resolved_at) : null,
    is_recurrent: recurrence_count_7d >= 2,
  };
}
