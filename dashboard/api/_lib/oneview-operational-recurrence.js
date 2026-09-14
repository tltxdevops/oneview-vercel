/**
 * Recurrence for Links/Operadoras, keyed by operational subject triggers.
 * Reuses episode selection: a new DOWN counts only after the predecessor recovered.
 * Aggregates from already-loaded alert rows — no extra SQL.
 */

import { selectRecurrenceEpisodes } from "./oneview-recurrence.js";

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
export const OPERATIONAL_RECURRENT_MIN_24H = 2;
const RECENT_OCCURRENCE_LIMIT = 5;

function text(value) {
  return String(value || "").trim();
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function emptyOperationalRecurrence(recentLimit = 0) {
  return {
    occurrences_24h: 0,
    occurrences_7d: 0,
    last_failure_at: null,
    last_recovery_at: null,
    is_recurrent: false,
    ...(recentLimit > 0 ? { recent_episodes: [], total_recent_episodes: 0 } : {}),
  };
}

export function triggerIdentityKey(row, triggerId = row?.source_trigger_id) {
  const source = text(row?.data_source_id);
  const host = text(row?.source_host_id);
  const trigger = text(triggerId);
  if (!source || !host || !trigger) return null;
  return `${source}:${host}:${trigger}`;
}

export function indexAlertsByTriggerIdentity(alerts = []) {
  const index = new Map();
  for (const alert of alerts || []) {
    const key = triggerIdentityKey(alert);
    if (!key) continue;
    const current = index.get(key) || [];
    current.push(alert);
    index.set(key, current);
  }
  return index;
}

export function alertsForOperationalRow(row, alertIndex) {
  const collected = [];
  const seen = new Set();
  for (const triggerId of row?.trigger_ids || []) {
    const key = triggerIdentityKey(row, triggerId);
    if (!key) continue;
    for (const alert of alertIndex.get(key) || []) {
      const id = String(alert.id);
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(alert);
    }
  }
  return collected;
}

export function buildOperationalRecurrenceReadModel({ alerts = [], now = new Date(), recentLimit = 0 } = {}) {
  const empty = emptyOperationalRecurrence(recentLimit);
  const episodes = selectRecurrenceEpisodes(alerts, now);
  if (!episodes.length) return empty;

  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const window24h = nowMs - MS_24H;
  const window7d = nowMs - MS_7D;
  // A count belongs to the window of its logical episode start. An older
  // active episode does not become a new occurrence merely by crossing a window.
  const episodes24h = episodes.filter((episode) => episode.first_seen_at.getTime() >= window24h);
  const episodes7d = episodes.filter((episode) => episode.first_seen_at.getTime() >= window7d);
  const occurrences_24h = episodes24h.length;
  const occurrences_7d = episodes7d.length;
  const latest = episodes[episodes.length - 1];
  const lastRecovery = [...episodes].reverse().find((episode) => episode.resolved_at);
  const model = {
    occurrences_24h,
    occurrences_7d,
    last_failure_at: toIso(latest?.first_seen_at),
    last_recovery_at: toIso(lastRecovery?.resolved_at),
    is_recurrent: occurrences_24h >= OPERATIONAL_RECURRENT_MIN_24H,
  };
  if (recentLimit > 0) {
    // Counts and drawer timeline share this exact logical episode collection.
    model.total_recent_episodes = episodes7d.length;
    model.recent_episodes = episodes7d.slice(-recentLimit).reverse().map((episode) => ({
      started_at: toIso(episode.first_seen_at),
      resolved_at: toIso(episode.resolved_at),
      active: !episode.resolved_at,
      duration_seconds: episode.duration_seconds,
    }));
  }
  return model;
}

export function attachOperationalRecurrence(rows = [], alerts = [], now = new Date(), { recentLimit = 0 } = {}) {
  const index = indexAlertsByTriggerIdentity(alerts);
  for (const row of rows) {
    Object.assign(row, buildOperationalRecurrenceReadModel({
      alerts: alertsForOperationalRow(row, index),
      now,
      recentLimit,
    }));
  }
  return rows;
}
