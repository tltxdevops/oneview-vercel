export const TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT = "source_clock_inconsistent";

function milliseconds(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Date.parse(String(value));
}

function recovered(alert) {
  const sourceStatus = String(alert?.status_source || "").trim().toLowerCase();
  const internalStatus = String(alert?.status_internal || "").trim().toLowerCase();
  return Boolean(alert?.resolved_at) || sourceStatus === "resolved" || ["resolved", "normalized"].includes(internalStatus);
}

/** Derives safe display/metric duration from raw source times, without repairing them. */
export function deriveAlertTemporalIntegrity(alert, now = Date.now()) {
  const firstSeenMs = milliseconds(alert?.first_seen_at);
  const resolvedMs = milliseconds(alert?.resolved_at);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  if (recovered(alert)) {
    if (!Number.isFinite(firstSeenMs) || !Number.isFinite(resolvedMs) || resolvedMs < firstSeenMs) {
      return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
    }
    return Object.freeze({ duration_seconds: Math.floor((resolvedMs - firstSeenMs) / 1000), temporal_integrity: null });
  }

  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs) || firstSeenMs > nowMs) {
    return Object.freeze({ duration_seconds: null, temporal_integrity: TEMPORAL_INTEGRITY_SOURCE_CLOCK_INCONSISTENT });
  }
  return Object.freeze({ duration_seconds: Math.floor((nowMs - firstSeenMs) / 1000), temporal_integrity: null });
}
