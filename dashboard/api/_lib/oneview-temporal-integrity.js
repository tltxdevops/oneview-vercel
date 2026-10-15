import { episodeStartMs } from "./oneview-operational-queue.js";

export const TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT = "source_clock_inconsistent";
export const TEMPORAL_INTEGRITY_RECOVERY_UNVERIFIED = "source_recovery_unverified";

function milliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Date.parse(String(value));
}

function recovered(alert) {
  const sourceStatus = String(alert?.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert?.status_internal || "").trim().toLowerCase();
  const reopenedMs = milliseconds(alert?.last_reopened_at);
  const resolvedMs = milliseconds(alert?.resolved_at);
  if (Number.isFinite(reopenedMs) && (!Number.isFinite(resolvedMs) || resolvedMs < reopenedMs)) return false;
  return Boolean(alert?.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

/**
 * Problem duration from the current episode start.
 * Active: now - start. Resolved: proven recovery - start.
 * ACK and suppression do not end or pause the interval.
 */
export function deriveAlertTemporalIntegrity(alert, now = Date.now()) {
  const startMs = episodeStartMs(alert);
  const resolvedMs = milliseconds(alert?.resolved_at);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (recovered(alert)) {
    if (!String(alert?.source_recovery_event_id || "").trim()) {
      return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_RECOVERY_UNVERIFIED });
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(resolvedMs) || resolvedMs < startMs) {
      return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
    }
    return Object.freeze({ duration_seconds: Math.floor((resolvedMs - startMs) / 1000), temporal_integrity: null });
  }

  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || startMs > nowMs) {
    return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
  }
  return Object.freeze({ duration_seconds: Math.floor((nowMs - startMs) / 1000), temporal_integrity: null });
}
