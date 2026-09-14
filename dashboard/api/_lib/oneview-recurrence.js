/**
 * OV-P0-87 — Recurrence read model (somente leitura).
 *
 * Identidade: data_source_id + source_host_id + source_trigger_id
 * Episódio novo só conta quando o predecessor tem resolved_at
 * e o novo first_seen_at é posterior a essa resolução.
 */

import { deriveAlertTemporalIntegrity } from "./oneview-temporal-integrity.js";

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
    previous_temporal_integrity: null,
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

/** Chave transportável para filtros: fonte + host + trigger, sem fallback por nome. */
export function buildRecurrenceKey(alert) {
  if (!hasRecurrenceIdentity(alert)) return null;
  return [alert.data_source_id, alert.source_host_id, alert.source_trigger_id]
    .map((value) => encodeURIComponent(nullableText(value)))
    .join("|");
}

export function parseRecurrenceKey(value) {
  const parts = String(value || "").split("|");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const [data_source_id, source_host_id, source_trigger_id] = parts.map((part) => decodeURIComponent(part).trim());
    if (!data_source_id || !source_host_id || !source_trigger_id) return null;
    return { data_source_id, source_host_id, source_trigger_id };
  } catch {
    return null;
  }
}

function durationSeconds(startedAt, resolvedAt, now) {
  const end = resolvedAt || toDate(now);
  if (!startedAt || !end || end.getTime() < startedAt.getTime()) return null;
  return Math.floor((end.getTime() - startedAt.getTime()) / 1000);
}

function mergeEpisode(episode, alert, now) {
  episode.alert_ids.push(alert.id);
  // A stale overlapping alias without recovery cannot erase an already-valid
  // recovery from the same logical outage. Keep the furthest valid endpoint.
  if (alert.resolved_at && (!episode.resolved_at || alert.resolved_at.getTime() > episode.resolved_at.getTime())) {
    episode.resolved_at = alert.resolved_at;
  }
  episode.duration_seconds = durationSeconds(episode.first_seen_at, episode.resolved_at, now);
  episode.temporal_integrity = episode.temporal_integrity || alert.temporal_integrity;
  return episode;
}

/**
 * Select logical episodes in chronological order.
 * Rows are already scoped to one real identity (trigger or operational subject).
 * Overlapping aliases/events are merged into one interval; a new episode starts
 * only after a valid recovery and a later failure. Window counts must use this
 * same returned collection, never raw alert rows.
 */
export function selectRecurrenceEpisodes(alerts = [], now = new Date()) {
  const sorted = [...alerts]
    .map((alert) => {
      const first_seen_at = toDate(alert?.first_seen_at);
      const rawResolvedAt = toDate(alert?.resolved_at);
      const temporal = deriveAlertTemporalIntegrity(alert, now);
      return {
        id: textValue(alert?.id),
        first_seen_at,
        // An inconsistent source clock is never a valid recovery boundary.
        resolved_at: temporal.temporal_integrity || !rawResolvedAt || !first_seen_at || rawResolvedAt.getTime() < first_seen_at.getTime()
          ? null
          : rawResolvedAt,
        duration_seconds: temporal.duration_seconds,
        temporal_integrity: temporal.temporal_integrity,
        acknowledged_at: toDate(alert?.acknowledged_source_at ?? alert?.acknowledged_at),
        acknowledged_by: nullableText(alert?.acknowledged_source_by ?? alert?.acknowledged_by),
      };
    })
    .filter((alert) => alert.id && alert.first_seen_at)
    .sort((left, right) => {
      const delta = left.first_seen_at.getTime() - right.first_seen_at.getTime();
      if (delta !== 0) return delta;
      return left.id.localeCompare(right.id);
    });

  const episodes = [];
  for (const alert of sorted) {
    if (!episodes.length) {
      episodes.push({ ...alert, alert_ids: [alert.id] });
      continue;
    }
    const predecessor = episodes[episodes.length - 1];
    if (!predecessor.resolved_at || alert.first_seen_at.getTime() <= predecessor.resolved_at.getTime()) {
      mergeEpisode(predecessor, alert, now);
    } else {
      episodes.push({ ...alert, alert_ids: [alert.id] });
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

  const episodes = selectRecurrenceEpisodes(pool, now);
  if (!episodes.length) return { ...empty };

  const nowMs = toDate(now)?.getTime() ?? Date.now();
  const window24h = nowMs - MS_24H;
  const window7d = nowMs - MS_7D;

  const recurrence_count_24h = episodes.filter((episode) => episode.first_seen_at.getTime() >= window24h).length;
  const recurrence_count_7d = episodes.filter((episode) => episode.first_seen_at.getTime() >= window7d).length;

  const currentIndex = episodes.findIndex((episode) => episode.alert_ids.includes(currentId));
  const previous = currentIndex > 0
    ? episodes[currentIndex - 1]
    : (currentIndex < 0
      ? episodes.filter((episode) => episode.first_seen_at.getTime() < currentFirstSeen.getTime()).at(-1) || null
      : null);

  return {
    recurrence_key: buildRecurrenceKey(current),
    recurrence_count_24h,
    recurrence_count_7d,
    previous_occurrence_at: previous ? toIso(previous.first_seen_at) : null,
    previous_recovery_at: previous ? toIso(previous.resolved_at) : null,
    previous_episode_id: previous?.id || null,
    previous_duration_seconds: previous ? previous.duration_seconds : null,
    previous_temporal_integrity: previous?.temporal_integrity || null,
    previous_acknowledged_at: previous ? toIso(previous.acknowledged_at) : null,
    previous_acknowledged_by: previous?.acknowledged_by || null,
    is_recurrent: recurrence_count_7d >= 2,
  };
}
