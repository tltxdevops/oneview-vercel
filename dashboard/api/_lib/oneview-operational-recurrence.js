/**
 * Recurrence for Links/Operadoras, keyed by operational subject triggers.
 * Reuses episode selection: a new DOWN counts only after the predecessor recovered.
 * Aggregates from already-loaded alert rows — no extra SQL.
 */

import { selectRecurrenceEpisodes } from "./oneview-recurrence.js";

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * MS_24H;
export const OPERATIONAL_RECURRENT_MIN_24H = 2;
export const OPERATIONAL_RECENT_PREVIEW_LIMIT = 5;
export const OPERATIONAL_RECENT_DETAIL_LIMIT = Number.MAX_SAFE_INTEGER;

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

function episodeIncident(episode, incidentMatches) {
  if (!(incidentMatches instanceof Map)) return null;
  const incidents = new Map();
  for (const alertId of episode.alert_ids || []) {
    for (const incident of incidentMatches.get(String(alertId)) || []) {
      const key = text(incident?.sys_id) || text(incident?.number);
      if (key) incidents.set(key, incident);
    }
  }
  // Multiple explicit references are ambiguous. Do not guess which INC belongs
  // to the logical episode; the drawer will state that no INC was correlated.
  if (incidents.size !== 1) return null;
  const incident = [...incidents.values()][0];
  return {
    incident_number: text(incident?.number) || null,
    incident_sys_id: text(incident?.sys_id) || null,
    incident_state: text(incident?.state) || null,
  };
}

/** Evidence stays on the episode's own alerts. Never infer it from hostname. */
function episodeEvidence(episode, alertsById) {
  const triggerIds = new Set();
  const titles = new Set();
  const severities = new Set();
  for (const alertId of episode.alert_ids || []) {
    const alert = alertsById.get(String(alertId));
    if (!alert) continue;
    const triggerId = text(alert.source_trigger_id);
    const title = text(alert.problem_name || alert.trigger_description || alert.item_name);
    const severity = text(alert.severity);
    if (triggerId) triggerIds.add(triggerId);
    if (title) titles.add(title);
    if (severity) severities.add(severity);
  }
  return {
    source_trigger_ids: [...triggerIds],
    alert_titles: [...titles],
    severities: [...severities],
  };
}

export function buildOperationalRecurrenceReadModel({ alerts = [], now = new Date(), recentLimit = 0, incidentMatches = null } = {}) {
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
    const alertsById = new Map(alerts.map((alert) => [String(alert.id), alert]));
    model.recent_episodes = episodes7d.slice(-recentLimit).reverse().map((episode) => {
      const incident = episodeIncident(episode, incidentMatches);
      const evidence = episodeEvidence(episode, alertsById);
      return {
        started_at: toIso(episode.first_seen_at),
        resolved_at: toIso(episode.resolved_at),
        active: !episode.resolved_at,
        duration_seconds: episode.duration_seconds,
        incident_number: incident?.incident_number || null,
        incident_sys_id: incident?.incident_sys_id || null,
        incident_state: incident?.incident_state || null,
        ...evidence,
      };
    });
  }
  return model;
}

export function attachOperationalRecurrence(rows = [], alerts = [], now = new Date(), { recentLimit = 0, incidentMatches = null } = {}) {
  const index = indexAlertsByTriggerIdentity(alerts);
  for (const row of rows) {
    Object.assign(row, buildOperationalRecurrenceReadModel({
      alerts: alertsForOperationalRow(row, index),
      now,
      recentLimit,
      incidentMatches,
    }));
  }
  return rows;
}
